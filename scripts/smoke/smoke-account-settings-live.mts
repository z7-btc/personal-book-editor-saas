import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import postgres from 'postgres';

const base = process.env.APP_BASE_URL || 'http://localhost:3000';
const center = process.env.EMAIL_CENTER_URL!;
const mock = 'http://127.0.0.1:4871';
for (const url of [base, center, process.env.DATABASE_URL!]) {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'Local services only');
}
assert.equal(process.env.TRANSACTIONAL_EMAIL_API_URL, `${mock}/emails`, 'Run with the mock mail adapter');
assert.equal(process.env.FEATURE_TRANSACTIONAL_EMAIL, 'true', 'Enable transactional email only in the local test process');
assert.notEqual(process.env.FEATURE_TURNSTILE, 'true', 'This smoke runs without a production Turnstile widget');
assert.match(process.env.EMAIL_CENTER_API_KEY || '', /^ec_test_[0-9a-f]{48}$/, 'Dedicated local test key required');
const emailConfig = dotenv.parse(readFileSync(resolve('..', 'email-center', '.env')));
assert.ok(['localhost', '127.0.0.1'].includes(new URL(emailConfig.POSTGRES_URL).hostname));
const emailDb = postgres(emailConfig.POSTGRES_URL, { max: 1 });
const { client } = await import('../../lib/db/drizzle');
const { runEmailContactSync } = await import('../../lib/email-center/worker');
const suffix = randomUUID();
const oldEmail = `saas-account-${suffix}@example.test`;
const newEmail = `saas-account-new-${suffix}@example.test`;
const limitedEmail = `saas-account-limit-${suffix}@example.test`;
const password = 'LocalAccountSmoke123!';
const userIds: string[] = [];
let ip = 1;
let applicationId: number | null = null;

function cookies(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}
function post(path: string, body: unknown, cookie = '', origin: string | null = base) {
  return fetch(`${base}/api/auth/${path}`, {
    method: 'POST', redirect: 'manual', headers: {
      'Content-Type': 'application/json', Cookie: cookie,
      'x-forwarded-for': `2001:db8:${suffix.slice(0, 4)}:${(ip++).toString(16)}::1`,
      ...(origin ? { Origin: origin } : {}),
    }, body: JSON.stringify(body),
  });
}
async function signup(email: string) {
  const response = await post('sign-up/email', {
    email, name: 'Account Smoke', password, preferredLocale: 'en',
    localeSource: 'browser_detected', marketingOptInRequested: true,
  });
  assert.equal(response.status, 200, `Signup HTTP ${response.status}`);
  const payload = await response.json() as { user: { id: string } };
  userIds.push(payload.user.id);
  return { id: payload.user.id, cookie: cookies(response) };
}
async function lastLink(to: string) {
  const response = await fetch(`${mock}/latest`);
  const capture = await response.json() as { mail: { to: string[]; text: string } };
  assert.deepEqual(capture.mail.to, [to]);
  const link = capture.mail.text.match(/https?:\/\/[^\s]+/)?.[0];
  assert.ok(link);
  const parsed = new URL(link);
  assert.equal(parsed.origin, base);
  assert.equal(parsed.pathname, '/api/auth/verify-email');
  assert.equal(parsed.searchParams.get('callbackURL'), '/dashboard/general');
  return link;
}
async function click(link: string, cookie = '') {
  const response = await fetch(link, { redirect: 'manual', headers: { Cookie: cookie } });
  assert.ok([302, 307].includes(response.status), `Confirmation HTTP ${response.status}`);
  return response;
}
async function confirm(email: string, cookie: string) {
  assert.equal((await post('send-verification-email', { email, callbackURL: '/dashboard/general' }, cookie)).status, 200);
  await click(await lastLink(email), cookie);
}
async function canonicalUser(id: string) {
  const [user] = await client`SELECT email, email_verified, name, preferred_locale,
    locale_source, marketing_opt_in_requested FROM "user" WHERE id = ${id}`;
  return user;
}
async function remoteContact(id: string) {
  const [row] = await emailDb`
    SELECT c.id AS contact_id, c.email, ca.external_user_id, ca.marketing_consent,
      ca.marketing_suppressed_at, ca.preferred_locale, ca.locale_source, c.name
    FROM contact_applications ca JOIN contacts c ON c.id = ca.contact_id
    WHERE ca.application_id = ${applicationId} AND ca.external_user_id = ${id}
  `;
  return row;
}
async function sync() {
  const result = await runEmailContactSync({ maxJobs: 100 });
  assert.equal(result.retried + result.deadLetter, 0, `Contact sync failed: ${JSON.stringify(result)}`);
  assert.ok(result.succeeded >= 1);
}
async function sessionFor(cookie: string) {
  const response = await fetch(`${base}/api/auth/get-session`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return response.json();
}
async function unsubscribeToken(contactId: number) {
  // Execute the authority's helper with its own tsconfig so @/ aliases resolve
  // within Email Center. Capture the token privately; never print it.
  const result = await promisify(execFile)(process.execPath, [
    '--import', pathToFileURL(resolve('node_modules', 'tsx', 'dist', 'loader.mjs')).href,
    '--input-type=module', '-e',
    "const mod=await import('./lib/security.ts'); const security=mod.default||mod; process.stdout.write(security.createUnsubscribeToken(JSON.parse(process.argv[1])));",
    JSON.stringify({ contactId, applicationId, scope: 'marketing' }),
  ], { cwd: resolve('..', 'email-center'), timeout: 15_000,
    env: { ...process.env, UNSUBSCRIBE_SECRET: emailConfig.UNSUBSCRIBE_SECRET } });
  return result.stdout;
}

try {
  const [application] = await emailDb`SELECT id FROM applications WHERE slug = 'saas-framework'`;
  assert.ok(application, 'Dedicated SaaS application required');
  applicationId = application.id;
  const user = await signup(oldEmail);
  const request = (body: unknown, cookie = user.cookie, origin: string | null = base) =>
    post('account/request-email-change', body, cookie, origin);
  assert.equal((await request({ newEmail, password })).status, 403, 'Unconfirmed address must be protected');
  await sync();
  assert.equal((await remoteContact(user.id)).marketing_consent, false, 'Unconfirmed user cannot opt in');

  assert.equal((await post('update-user', {
    name: 'Updated Account', preferredLocale: 'zh-CN', localeSource: 'user_selected',
    marketingOptInRequested: false,
  }, user.cookie)).status, 200);
  await sync();
  const settings = await remoteContact(user.id);
  assert.equal(settings.name, 'Updated Account');
  assert.equal(settings.preferred_locale, 'zh-CN');
  assert.equal(settings.locale_source, 'user_selected');
  assert.equal(settings.marketing_consent, false);

  await confirm(oldEmail, user.cookie);
  assert.equal((await canonicalUser(user.id)).email_verified, true);
  assert.equal((await post('update-user', { marketingOptInRequested: true }, user.cookie)).status, 200);
  await sync();
  const subscribed = await remoteContact(user.id);
  assert.equal(subscribed.marketing_consent, true);
  const unsubscribe = await unsubscribeToken(subscribed.contact_id);
  const unsubscribeResponse = await fetch(`${center}/api/v1/unsubscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: unsubscribe }),
  });
  assert.equal(unsubscribeResponse.status, 200, 'Actual Email Center unsubscribe must succeed');
  assert.equal((await post('update-user', { name: 'After Unsubscribe', marketingOptInRequested: true }, user.cookie)).status, 200);
  await sync();
  assert.equal((await remoteContact(user.id)).marketing_consent, false, 'Profile save cannot override unsubscribe');
  assert.ok((await remoteContact(user.id)).marketing_suppressed_at);

  assert.equal((await request({ newEmail, password }, '')).status, 401, 'Session required');
  assert.equal((await request({ newEmail, password }, user.cookie, 'https://evil.invalid')).status, 403);
  assert.equal((await request({ newEmail, password }, user.cookie, null)).status, 403);
  assert.equal((await request({ newEmail, password: 'wrong-password' })).status, 400, 'Password proof required');
  assert.equal((await canonicalUser(user.id)).email, oldEmail);
  const [initialSession] = await client`SELECT id, created_at FROM "session" WHERE user_id = ${user.id}`;
  await client`UPDATE "session" SET created_at = ${new Date(Date.now() - 16 * 60_000).toISOString()}::timestamp WHERE id = ${initialSession.id}`;
  assert.equal((await request({ newEmail, password })).status, 403, 'Fresh sign-in required');
  const originalCreatedAt = initialSession.created_at instanceof Date ? initialSession.created_at.toISOString() : String(initialSession.created_at);
  await client`UPDATE "session" SET created_at = ${originalCreatedAt}::timestamp WHERE id = ${initialSession.id}`;
  assert.equal((await request({ newEmail, password, callbackURL: 'https://evil.invalid' })).status, 403);
  assert.equal((await request({ newEmail, password })).status, 200);
  assert.equal((await canonicalUser(user.id)).email, oldEmail, 'Request must not change the email');
  const oldApproval = await lastLink(oldEmail);
  await click(oldApproval, user.cookie);
  assert.equal((await canonicalUser(user.id)).email, oldEmail, 'Current-email approval alone is insufficient');
  assert.equal((await remoteContact(user.id)).email, oldEmail, 'Pending email cannot be rebound');
  const newConfirmation = await lastLink(newEmail);
  const secondLogin = await post('sign-in/email', { email: oldEmail, password });
  assert.equal(secondLogin.status, 200);
  const result = await click(newConfirmation); // The new inbox may be opened without a session.
  const changed = await canonicalUser(user.id);
  assert.equal(changed.email, newEmail);
  assert.equal(changed.email_verified, true);
  assert.equal(changed.preferred_locale, 'zh-CN');
  const [{ count }] = await client`SELECT count(*)::int AS count FROM "session" WHERE user_id = ${user.id}`;
  assert.equal(count, 0, 'All old and in-flight verification sessions must be revoked');
  assert.equal(await sessionFor(user.cookie), null);
  assert.equal(await sessionFor(cookies(secondLogin)), null);
  if (cookies(result)) assert.equal(await sessionFor(cookies(result)), null);
  await click(newConfirmation);
  assert.equal((await canonicalUser(user.id)).email, newEmail, 'Token replay cannot perform a second change');
  assert.equal((await post('sign-in/email', { email: oldEmail, password })).status, 401);
  const newLogin = await post('sign-in/email', { email: newEmail, password });
  assert.equal(newLogin.status, 200);
  assert.equal((await sessionFor(cookies(newLogin))).user.id, user.id, 'Canonical identity must remain stable');

  await sync();
  const rebound = await remoteContact(user.id);
  assert.equal(rebound.email, newEmail);
  assert.equal(rebound.marketing_consent, false, 'Suppression must follow the changed address');
  assert.ok(rebound.marketing_suppressed_at);
  assert.equal(rebound.preferred_locale, 'zh-CN');
  const [oldBinding] = await emailDb`
    SELECT ca.external_user_id, ca.marketing_consent, ca.product_updates_enabled, ca.status
    FROM contact_applications ca JOIN contacts c ON c.id = ca.contact_id
    WHERE ca.application_id = ${applicationId} AND c.normalized_email = ${oldEmail}
  `;
  assert.equal(oldBinding.external_user_id, null);
  assert.equal(oldBinding.marketing_consent, false);
  assert.equal(oldBinding.product_updates_enabled, false);
  assert.equal(oldBinding.status, 'unsubscribed');

  assert.equal((await fetch(`${mock}/fail-next`, { method: 'POST' })).status, 200);
  const failedDelivery = await request({ newEmail: oldEmail, password }, cookies(newLogin));
  assert.equal(failedDelivery.status, 200, 'Native email flow keeps a neutral receipt on delivery failure');
  assert.equal((await canonicalUser(user.id)).email, newEmail, 'Mail failure cannot mutate the account');

  const limited = await signup(limitedEmail);
  await confirm(limitedEmail, limited.cookie);
  const occupied = await request({ newEmail: limitedEmail, password }, cookies(newLogin));
  assert.equal(occupied.status, 200, 'Occupied email must receive the same neutral receipt');
  await lastLink(limitedEmail); // No approval was sent to the changing account.
  assert.equal((await canonicalUser(user.id)).email, newEmail);
  const attempts = await Promise.all(Array.from({ length: 5 }, () => post('account/request-email-change', {
    newEmail: `limit-target-${suffix}@example.test`, password: 'wrong-password',
  }, limited.cookie)));
  for (const response of attempts) assert.equal(response.status, 400);
  const sixth = await post('account/request-email-change', { newEmail, password }, limited.cookie);
  assert.equal(sixth.status, 429, 'IP rotation cannot bypass the account limit');
  assert.equal(sixth.headers.get('cache-control'), 'no-store');
  assert.ok(Number(sixth.headers.get('retry-after')) > 0);
  assert.equal((await canonicalUser(limited.id)).email, limitedEmail);
  const [budget] = await client`SELECT count FROM "rateLimit" WHERE key = ${`account-email-change:${limited.id}`}`;
  assert.equal(budget.count, 5, 'Concurrent attempts must consume an atomic shared budget');
  console.log('Account preferences, two-inbox email change, password/fresh-session/origin gates, revoked sessions, token replay, neutral occupied-address receipt, delivery failure, per-account concurrency limit and real Email Center suppression/rebind passed.');
} finally {
  for (const id of userIds) {
    await client`DELETE FROM organization WHERE id IN (SELECT organization_id FROM member WHERE user_id = ${id})`;
    await client`DELETE FROM "user" WHERE id = ${id}`;
    await client`DELETE FROM "rateLimit" WHERE key = ${`account-email-change:${id}`}`;
    if (applicationId) await emailDb`DELETE FROM ingestion_events WHERE application_id = ${applicationId} AND idempotency_key LIKE ${`saas:contact:${id}:%`}`;
  }
  await emailDb`DELETE FROM contacts WHERE normalized_email IN ${emailDb([oldEmail, newEmail, limitedEmail])}`;
  await emailDb.end({ timeout: 5 });
  await client.end({ timeout: 5 });
}
