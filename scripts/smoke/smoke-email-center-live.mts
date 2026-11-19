import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import postgres from 'postgres';

const emailConfig = dotenv.parse(readFileSync(resolve('..', 'email-center', '.env')));
assert.ok(emailConfig.POSTGRES_URL, 'Email Center local database is not configured');
const emailDb = postgres(emailConfig.POSTGRES_URL, { max: 1 });
const configuredKey = process.env.EMAIL_CENTER_API_KEY?.trim();
const configuredUrl = process.env.EMAIL_CENTER_URL?.trim();
assert.equal(Boolean(configuredKey), Boolean(configuredUrl),
  'Configure both EMAIL_CENTER_URL and EMAIL_CENTER_API_KEY or neither');
if (configuredKey) {
  assert.match(configuredKey, /^ec_test_[0-9a-f]{48}$/,
    'Live smoke requires a local Email Center test key');
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(configuredUrl!).hostname),
    'Live smoke must target local Email Center');
}
const temporaryApplication = !configuredKey;
const testKey = configuredKey || `ec_test_${randomBytes(24).toString('hex')}`;
process.env.FEATURE_EMAIL_CENTER = 'true';
process.env.EMAIL_CENTER_URL = configuredUrl || 'http://127.0.0.1:3100';
process.env.EMAIL_CENTER_API_KEY = testKey;

const { client } = await import('../../lib/db/drizzle');
const { runEmailContactSync } = await import('../../lib/email-center/worker');
const suffix = randomUUID();
const email = `saas-live-${suffix}@example.test`;
const changedEmail = `saas-changed-${suffix}@example.test`;
const base = process.env.APP_BASE_URL || 'http://localhost:3000';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname),
  'Live smoke must target local SaaS');
let id: string | null = null;
let applicationId: number | null = null;

async function syncOnce() {
  if (process.env.SMOKE_EMAIL_RUNNER !== 'cron') {
    return runEmailContactSync({ maxJobs: 1 });
  }
  assert.ok(process.env.CRON_SECRET, 'CRON_SECRET is needed for HTTP runner smoke');
  const response = await fetch(`${base}/api/internal/email-center/sync`, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    cache: 'no-store',
  });
  assert.equal(response.status, 200, `HTTP email runner failed: ${response.status}`);
  const body = await response.json() as {
    report: Awaited<ReturnType<typeof runEmailContactSync>>;
  };
  return body.report;
}

try {
  if (temporaryApplication) {
    const [application] = await emailDb`
      INSERT INTO applications (name, slug, description, api_key_prefix,
                                api_key_hash, widget_key)
      VALUES ('SaaS live integration smoke', ${`saas-live-${suffix}`},
              'Temporary local contract verification', ${testKey.slice(0, 12)},
              ${createHash('sha256').update(testKey).digest('hex')},
              ${`ec_pub_test_${suffix}`})
      RETURNING id
    `;
    applicationId = application.id;
  } else {
    const [application] = await emailDb`
      SELECT id FROM applications WHERE slug = 'saas-framework'
    `;
    assert.ok(application, 'Dedicated SaaS Framework application is missing');
    applicationId = application.id;
  }

  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({
      name: 'Live Contact Smoke', email, password: 'LocalSmokePass123!',
      preferredLocale: 'en', localeSource: 'browser_detected',
      marketingOptInRequested: true,
    }),
  });
  assert.equal(signup.status, 200, `SaaS registration failed: ${signup.status}`);
  const cookie = signup.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'SaaS registration did not create a session');
  const sessionResponse = await fetch(`${base}/api/auth/get-session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { user?: { id?: string; emailVerified?: boolean } };
  id = session.user?.id || null;
  assert.ok(id, 'Registered SaaS user is missing');
  assert.equal(session.user?.emailVerified, false);

  const first = await syncOnce();
  assert.equal(first.succeeded, 1, `Registration contact sync failed: ${JSON.stringify(first)}`);

  const [contact] = await emailDb`
    SELECT ca.external_user_id, ca.marketing_consent, ca.preferred_locale,
           c.normalized_email
    FROM contact_applications ca JOIN contacts c ON c.id = ca.contact_id
    WHERE ca.application_id = ${applicationId} AND ca.external_user_id = ${id}
  `;
  assert.equal(contact.external_user_id, id);
  assert.equal(contact.normalized_email, email);
  assert.equal(contact.marketing_consent, false);
  assert.equal(contact.preferred_locale, 'en');

  const preference = await fetch(`${base}/api/auth/update-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
    body: JSON.stringify({ preferredLocale: 'zh-CN', localeSource: 'user_selected' }),
  });
  assert.equal(preference.status, 200, `SaaS locale update failed: ${preference.status}`);
  const second = await syncOnce();
  assert.equal(second.succeeded, 1, `Preference contact sync failed: ${JSON.stringify(second)}`);
  const [updated] = await emailDb`
    SELECT preferred_locale, locale_source, marketing_consent
    FROM contact_applications
    WHERE application_id = ${applicationId} AND external_user_id = ${id}
  `;
  assert.equal(updated.preferred_locale, 'zh-CN');
  assert.equal(updated.locale_source, 'user_selected');
  assert.equal(updated.marketing_consent, false);

  await client`UPDATE "user" SET email_verified = true WHERE id = ${id}`;
  const verified = await syncOnce();
  assert.equal(verified.succeeded, 1, `Verified opt-in sync failed: ${JSON.stringify(verified)}`);
  const [optedIn] = await emailDb`
    SELECT marketing_consent FROM contact_applications
    WHERE application_id = ${applicationId} AND external_user_id = ${id}
  `;
  assert.equal(optedIn.marketing_consent, true);

  await client`UPDATE "user" SET marketing_opt_in_requested = false WHERE id = ${id}`;
  const optedOut = await syncOnce();
  assert.equal(optedOut.succeeded, 1, `Opt-out sync failed: ${JSON.stringify(optedOut)}`);
  const [revoked] = await emailDb`
    SELECT marketing_consent FROM contact_applications
    WHERE application_id = ${applicationId} AND external_user_id = ${id}
  `;
  assert.equal(revoked.marketing_consent, false);

  // This contract smoke does not require transactional email. The separate
  // smoke:account-settings:live verifies the actual two-inbox change workflow.
  await client`UPDATE "user" SET email = ${changedEmail}, email_verified = false
    WHERE id = ${id}`;
  const rebound = await syncOnce();
  assert.equal(rebound.succeeded, 1, `Email rebind sync failed: ${JSON.stringify(rebound)}`);
  const [oldAddress] = await emailDb`
    SELECT ca.external_user_id, ca.marketing_consent, ca.product_updates_enabled,
           ca.status
    FROM contact_applications ca JOIN contacts c ON c.id = ca.contact_id
    WHERE ca.application_id = ${applicationId} AND c.normalized_email = ${email}
  `;
  assert.equal(oldAddress.external_user_id, null);
  assert.equal(oldAddress.marketing_consent, false);
  assert.equal(oldAddress.product_updates_enabled, false);
  assert.equal(oldAddress.status, 'unsubscribed');
  const [newAddress] = await emailDb`
    SELECT ca.external_user_id, ca.marketing_consent
    FROM contact_applications ca JOIN contacts c ON c.id = ca.contact_id
    WHERE ca.application_id = ${applicationId} AND c.normalized_email = ${changedEmail}
  `;
  assert.equal(newAddress.external_user_id, id);
  assert.equal(newAddress.marketing_consent, false);

  const [ingestion] = await emailDb`
    SELECT count(*)::int AS count FROM ingestion_events
    WHERE application_id = ${applicationId}
      AND idempotency_key LIKE ${`saas:contact:${id}:%`}
  `;
  assert.equal(ingestion.count, 5);
  assert.equal((await syncOnce()).claimed, 0);
  console.log(`Real local Email Center registration, locale, consent and email rebind sync passed via ${process.env.SMOKE_EMAIL_RUNNER === 'cron' ? 'HTTP Cron' : 'CLI worker'}.`);
} finally {
  if (id) {
    await client`DELETE FROM organization WHERE id IN
      (SELECT organization_id FROM member WHERE user_id = ${id})`;
    await client`DELETE FROM "user" WHERE id = ${id}`;
  }
  if (applicationId !== null) {
    if (temporaryApplication) {
      await emailDb`DELETE FROM applications WHERE id = ${applicationId}`;
    } else {
      await emailDb`DELETE FROM ingestion_events
        WHERE application_id = ${applicationId}
          AND idempotency_key LIKE ${`saas:contact:${id}:%`}`;
    }
    await emailDb`DELETE FROM contacts WHERE normalized_email = ${email}`;
    await emailDb`DELETE FROM contacts WHERE normalized_email = ${changedEmail}`;
  }
  await emailDb.end({ timeout: 5 });
  await client.end({ timeout: 5 });
}
