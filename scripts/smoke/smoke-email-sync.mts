import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.FEATURE_EMAIL_CENTER = 'true';
process.env.EMAIL_CENTER_URL = 'http://127.0.0.1:39999';
process.env.EMAIL_CENTER_API_KEY = 'local-mock-only';

const { client } = await import('../../lib/db/drizzle');
const { runEmailContactSync } = await import('../../lib/email-center/worker');
const id = `email-smoke-${randomUUID()}`;
const firstId = `${id}-first`;
const secondId = `${id}-second`;

try {
  const [{ count }] = await client`SELECT count(*)::int AS count FROM "user"`;
  if (count !== 0) {
    console.error(`[smoke:email-sync] blocked: the local SaaS database already holds ${count} user row(s) and this smoke asserts global counts, so it only runs against an empty database. Use a fresh database (npm run db:local:up && npm run db:migrate) or skip this suite.`);
    process.exit(2);
  }

  await client`
    INSERT INTO "user" (id, name, email, marketing_opt_in_requested,
                        preferred_locale, locale_source)
    VALUES (${firstId}, 'Email Smoke', ${`${firstId}@example.test`}, true,
            'en', 'browser_detected')
  `;
  await client`UPDATE "user" SET preferred_locale = 'zh-CN',
    locale_source = 'user_selected' WHERE id = ${firstId}`;

  const sent: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  let receiptQueries = 0;
  const sendOk = (async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname === '/api/v1/contacts/reconcile') {
      receiptQueries++;
      const request = JSON.parse(String(init?.body)) as { idempotencyKey: string };
      return Response.json({ data: {
        applicationId: 1, idempotencyKey: request.idempotencyKey,
        operation: { status: 'not_received', requestMatches: false, contactApplicationId: null },
        contact: null,
      } });
    }
    sent.push({
      body: JSON.parse(String(init?.body)),
      key: new Headers(init?.headers).get('idempotency-key'),
    });
    return Response.json({ data: { contactApplicationId: 42 } }, { status: 201 });
  }) as typeof fetch;

  const first = await runEmailContactSync({ maxJobs: 1, send: sendOk });
  assert.equal(first.succeeded, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.externalUserId, firstId);
  assert.equal(sent[0].body.preferredLocale, 'zh-CN');
  assert.equal(sent[0].body.marketingConsent, false,
    'An unverified email must not activate the saved opt-in');
  assert.equal(sent[0].key, `saas:contact:${firstId}:v2`);
  const firstEvents = await client`
    SELECT event_version, status FROM email_contact_outbox
    WHERE user_id = ${firstId} ORDER BY event_version
  `;
  assert.deepEqual(firstEvents.map(({ event_version, status }) => [event_version, status]),
    [[1, 'superseded'], [2, 'succeeded']]);

  await client`
    INSERT INTO "user" (id, name, email) VALUES
      (${secondId}, 'Retry Smoke', ${`${secondId}@example.test`})
  `;
  const sendUnavailable = (async () =>
    new Response(null, { status: 503, headers: { 'Retry-After': '1' } })) as typeof fetch;
  const failed = await runEmailContactSync({ maxJobs: 1, send: sendUnavailable });
  assert.equal(failed.retried, 1);
  await client`UPDATE email_contact_outbox SET available_at = now()
    WHERE user_id = ${secondId} AND status = 'pending'`;
  const recovered = await runEmailContactSync({ maxJobs: 1, send: sendOk });
  assert.equal(recovered.succeeded, 1);
  assert.equal(receiptQueries, 1, 'A retry must establish that the authority did not receive the original operation');
  const [secondEvent] = await client`
    SELECT status, attempt_count FROM email_contact_outbox WHERE user_id = ${secondId}
  `;
  assert.equal(secondEvent.status, 'succeeded');
  assert.equal(secondEvent.attempt_count, 2);
  assert.equal(sent.at(-1)?.key, `saas:contact:${secondId}:v1`);
  console.log('Contact outbox ordering, consent gate and retry recovery passed.');
} finally {
  await client`DELETE FROM "user" WHERE id IN (${firstId}, ${secondId})`;
  await client.end({ timeout: 5 });
}
