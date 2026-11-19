import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import 'dotenv/config';

const base = 'http://localhost:3000';
if (process.env.NODE_ENV === 'production' || process.env.APP_BASE_URL !== base) {
  throw new Error('This smoke requires local SaaS only.');
}
if (process.env.TRANSACTIONAL_EMAIL_API_URL !== 'http://127.0.0.1:4871/emails' ||
    process.env.FEATURE_TRANSACTIONAL_EMAIL !== 'true' ||
    process.env.FEATURE_TURNSTILE === 'true') {
  console.error('[smoke:email-verification-live] blocked: the dev server must run with the mock transactional mail adapter (TRANSACTIONAL_EMAIL_API_URL=http://127.0.0.1:4871/emails, FEATURE_TRANSACTIONAL_EMAIL=true) and FEATURE_TURNSTILE=false so this smoke can sign up and read the confirmation link; the current .env is not configured that way.');
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const email = `saas-verify-${randomUUID()}@example.invalid`;
let userId: string | null = null;
try {
  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Mail verification smoke', email, password: 'LocalMailSmoke123!' }),
  });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const [account] = await sql`SELECT id, email_verified FROM "user" WHERE email = ${email}`;
  assert.equal(account?.email_verified, false);
  userId = account.id;

  const badCallback = await fetch(`${base}/api/auth/send-verification-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
    body: JSON.stringify({ email, callbackURL: 'https://wrong.example.invalid/' }),
  });
  assert.equal(badCallback.status, 403);
  const request = await fetch(`${base}/api/auth/send-verification-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
    body: JSON.stringify({ email, callbackURL: '/dashboard/activity' }),
  });
  assert.equal(request.status, 200, `Email request HTTP ${request.status}`);
  const delivery = await fetch('http://127.0.0.1:4871/latest');
  const capture = await delivery.json() as { mail: { to: string[]; text: string } | null };
  assert.deepEqual(capture.mail?.to, [email]);
  const link = capture.mail?.text.match(/https?:\/\/[^\s]+/)?.[0];
  assert.ok(link);
  const verifiedLink = new URL(link);
  assert.equal(verifiedLink.origin, base);
  assert.equal(verifiedLink.searchParams.get('callbackURL'), '/dashboard/general');
  const verify = await fetch(link, { redirect: 'manual' });
  assert.ok([302, 307].includes(verify.status), `Verification HTTP ${verify.status}`);
  const [confirmed] = await sql`SELECT email_verified FROM "user" WHERE id = ${userId}`;
  assert.equal(confirmed?.email_verified, true);
  const [outbox] = await sql`
    SELECT event_version FROM email_contact_outbox
    WHERE user_id = ${userId} ORDER BY event_version DESC LIMIT 1
  `;
  assert.ok(Number(outbox?.event_version) >= 2);
  console.log('Local link delivery, fixed callback, Better Auth verification and Email Center outbox passed.');
} finally {
  if (userId) {
    await sql`DELETE FROM organization WHERE id IN (
      SELECT organization_id FROM member WHERE user_id = ${userId}
    )`;
    await sql`DELETE FROM "user" WHERE id = ${userId}`;
  }
  await sql.end({ timeout: 5 });
}
