import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_API_KEY = 'mock-website-key';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'local-test-secret-longer-than-thirty-two-bytes';

const { POST } = await import('../../app/api/payment-center/webhook/route');
const { client } = await import('../../lib/db/drizzle');
const unique = randomUUID();
const userId = `webhook-user-${unique}`;
const organizationId = `webhook-org-${unique}`;
const accountId = `ba_webhook_${unique}`;
const externalOrderId = `pi_webhook_${unique}`;
const centerOrderId = randomUUID();
const url = 'https://saas.example.test/api/payment-center/webhook';

function signedRequest(event: unknown, options: {
  timestamp?: string; signature?: string; headerEventId?: string;
} = {}) {
  const body = JSON.stringify(event);
  const timestamp = options.timestamp || String(Math.floor(Date.now() / 1000));
  const signature = options.signature || `sha256=${createHmac('sha256',
    process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET!)
    .update(`${timestamp}.${body}`).digest('hex')}`;
  return new Request(url, { method: 'POST', body, headers: {
    'Content-Type': 'application/json',
    'X-Payment-Center-Timestamp': timestamp,
    'X-Payment-Center-Signature': signature,
    'X-Payment-Center-Event': options.headerEventId || (event as { id: string }).id,
  } });
}

function callback(eventId: string, orderId = centerOrderId,
  reference = externalOrderId, websiteId = process.env.PAYMENT_CENTER_WEBSITE_ID) {
  return { id: eventId, type: 'payment.succeeded', data: { order: {
    id: orderId, external_order_id: reference, website_id: websiteId,
    amount_decimal: '15.00000000', status: 'paid',
  } } };
}

try {
  await client`INSERT INTO "user" (id, name, email)
    VALUES (${userId}, 'Webhook Test', ${`${userId}@example.test`})`;
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Webhook Test', ${`webhook-${unique}`}, now())`;
  await client`INSERT INTO billing_accounts
    (id, organization_id, external_billing_id, original_payer_user_id)
    VALUES (${accountId}, ${organizationId}, ${accountId}, ${userId})`;
  await client`INSERT INTO payment_intents
    (id, organization_id, billing_account_id, payer_user_id, request_key,
     product_code, price_interval, amount_decimal, currency, method, payment_action,
     external_order_id, idempotency_key)
    VALUES (${externalOrderId}, ${organizationId}, ${accountId}, ${userId},
      ${randomUUID()}, 'pro', 'month', '15.00000000', 'USD', 'stripe', 'redirect',
      ${externalOrderId}, ${externalOrderId})`;

  const knownId = randomUUID();
  const known = callback(knownId);
  assert.equal((await POST(signedRequest(known))).status, 202);
  assert.equal((await POST(signedRequest(known))).status, 200);
  const [stored] = await client`SELECT status, body_sha256 FROM payment_inbox
    WHERE event_id = ${knownId}`;
  assert.equal(stored.status, 'pending');
  assert.match(stored.body_sha256, /^[0-9a-f]{64}$/);
  assert.equal((await POST(signedRequest({ ...known, type: 'payment.refunded' }))).status, 409);

  const unknownId = randomUUID();
  assert.equal((await POST(signedRequest(callback(unknownId,
    centerOrderId, `missing-${unique}`)))).status, 202);
  const [unknown] = await client`SELECT status FROM payment_inbox WHERE event_id = ${unknownId}`;
  assert.equal(unknown.status, 'quarantined');

  const mismatchId = randomUUID();
  await client`UPDATE payment_intents SET payment_center_order_id = ${randomUUID()}
    WHERE id = ${externalOrderId}`;
  assert.equal((await POST(signedRequest(callback(mismatchId)))).status, 202);
  const [mismatch] = await client`SELECT status FROM payment_inbox WHERE event_id = ${mismatchId}`;
  assert.equal(mismatch.status, 'manual_review');

  assert.equal((await POST(signedRequest(callback(randomUUID()),
    { signature: 'sha256=' + '0'.repeat(64) }))).status, 400);
  assert.equal((await POST(signedRequest(callback(randomUUID()),
    { timestamp: String(Math.floor(Date.now() / 1000) - 301) }))).status, 400);
  assert.equal((await POST(signedRequest(callback(randomUUID()),
    { headerEventId: randomUUID() }))).status, 400);
  assert.equal((await POST(signedRequest(callback(randomUUID(), centerOrderId,
    externalOrderId, '00000000-0000-4000-8000-000000000002')))).status, 403);

  const [{ count }] = await client`SELECT count(*)::int AS count FROM payment_inbox
    WHERE external_order_id = ${externalOrderId} OR external_order_id = ${`missing-${unique}`}`;
  assert.equal(count, 3, 'Invalid signatures and wrong websites must not be stored');
  console.log('Signed Payment Center webhook, replay and quarantine checks passed.');
} finally {
  await client`DELETE FROM payment_inbox WHERE external_order_id = ${externalOrderId}
    OR external_order_id = ${`missing-${unique}`}`;
  await client`DELETE FROM payment_intents WHERE id = ${externalOrderId}`;
  await client`DELETE FROM billing_accounts WHERE id = ${accountId}`;
  await client`DELETE FROM organization WHERE id = ${organizationId}`;
  await client`DELETE FROM "user" WHERE id = ${userId}`;
  await client.end({ timeout: 5 });
}
