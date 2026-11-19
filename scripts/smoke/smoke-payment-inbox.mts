import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_API_KEY = 'mock-website-key';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'local-test-secret-longer-than-thirty-two-bytes';

const { client } = await import('../../lib/db/drizzle');
const { POST } = await import('../../app/api/payment-center/webhook/route');
const { runPaymentInbox } = await import('../../lib/payment-center/inbox-worker');
const suffix = randomUUID();
const userId = `inbox-user-${suffix}`;
const organizationId = `inbox-org-${suffix}`;
const accountId = `ba_inbox_${suffix}`;
const intentId = `pi_inbox_${suffix}`;
const centerOrderId = randomUUID();
const subscriptionId = `sub_${suffix}`;
const nowSeconds = Math.floor(Date.now() / 1000);
const siteId = process.env.PAYMENT_CENTER_WEBSITE_ID;
const eventId = randomUUID();
const order = {
  id: centerOrderId, website_id: siteId,
  external_order_id: intentId, idempotency_key: intentId,
  payer_external_user_id: userId, billing_account_id: accountId,
  payment_method: 'stripe', kind: 'subscription', status: 'paid',
  amount_decimal: '15.00000000', currency: 'USD',
  product_code: 'pro', recurrence_interval: 'month',
  provider_subscription_id: subscriptionId,
  metadata: { organizationId, billingAccountId: accountId,
    payerUserId: userId, intentId },
};
const evidence = {
  contract_version: 1, evidence_complete: true,
  provider_invoice_id: `in_${suffix}`,
  provider_subscription_id: subscriptionId,
  provider_payment_id: `pi_remote_${suffix}`,
  amount_paid_decimal: '15', currency: 'USD',
  settled_at: nowSeconds - 60,
  service_period_start: nowSeconds - 86_400,
  service_period_end: nowSeconds + 29 * 86_400,
};
const event = { id: eventId, type: 'subscription.period_paid',
  data: { order, ...evidence } };
const eventIds = [eventId];

function signedRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256',
    process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET!)
    .update(`${timestamp}.${body}`).digest('hex');
  return new Request('https://saas.example.test/api/payment-center/webhook', {
    method: 'POST', body,
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-Center-Timestamp': timestamp,
      'X-Payment-Center-Signature': `sha256=${signature}`,
      'X-Payment-Center-Event': (payload as { id: string }).id,
    },
  });
}

type MockEvent = {
  id: string;
  type: string;
  data: { order: typeof order } & Record<string, unknown>;
};
const events = new Map<string, MockEvent>([[eventId, event]]);
const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-website-key');
  if (url.pathname.startsWith('/api/payment-center/events/')) {
    const id = url.pathname.split('/').at(-1)!;
    const found = events.get(id);
    return found ? Response.json({ status: 'success', data: {
      event: found, delivery_status: 'delivered',
    } }) : new Response(null, { status: 404 });
  }
  assert.equal(url.pathname, `/api/payment-center/orders/${intentId}`);
  return Response.json({ status: 'success', data: { order } });
}) as typeof fetch;

try {
  await client`INSERT INTO "user" (id, name, email)
    VALUES (${userId}, 'Inbox Test', ${`${userId}@example.test`})`;
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Inbox Smoke', ${`inbox-${suffix}`}, now())`;
  await client`INSERT INTO billing_accounts
    (id, organization_id, external_billing_id, original_payer_user_id)
    VALUES (${accountId}, ${organizationId}, ${accountId}, ${userId})`;
  await client`INSERT INTO payment_intents
    (id, organization_id, billing_account_id, payer_user_id, request_key,
     product_code, price_interval, amount_decimal, currency, method, payment_action,
     external_order_id, idempotency_key, status)
    VALUES (${intentId}, ${organizationId}, ${accountId}, ${userId},
      ${randomUUID()}, 'pro', 'month', '15.00000000', 'USD', 'stripe', 'redirect',
      ${intentId}, ${intentId}, 'unknown')`;

  assert.equal((await POST(signedRequest(event))).status, 202);
  const report = await runPaymentInbox({ maxJobs: 1, send });
  assert.deepEqual(report, { claimed: 1, processed: 1, retried: 0, manualReview: 0 });
  const [stored] = await client`SELECT status, lease_owner FROM payment_inbox
    WHERE event_id = ${eventId}`;
  assert.equal(stored.status, 'processed');
  assert.equal(stored.lease_owner, null);
  const [{ count: grants }] = await client`SELECT count(*)::int AS count
    FROM subscription_grants WHERE organization_id = ${organizationId}`;
  assert.equal(grants, 1);
  assert.equal((await POST(signedRequest(event))).status, 200);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).claimed, 0);

  const nextInvoiceId = `in_next_${suffix}`;
  const nextPaymentId = `pi_next_${suffix}`;
  const nextEventId = randomUUID();
  eventIds.push(nextEventId);
  const nextPeriod = { ...event, id: nextEventId, data: { ...event.data,
    provider_invoice_id: nextInvoiceId,
    provider_payment_id: nextPaymentId,
    service_period_start: evidence.service_period_end,
    service_period_end: evidence.service_period_end + 30 * 86_400,
  } };
  events.set(nextEventId, nextPeriod);
  assert.equal((await POST(signedRequest(nextPeriod))).status, 202);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).processed, 1);

  const delayedEventId = randomUUID();
  eventIds.push(delayedEventId);
  const delayed = { ...event, id: delayedEventId };
  assert.equal((await POST(signedRequest(delayed))).status, 202);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).retried, 1);
  const [waiting] = await client`SELECT status, last_error_code FROM payment_inbox
    WHERE event_id = ${delayedEventId}`;
  assert.equal(waiting.status, 'pending');
  assert.equal(waiting.last_error_code, 'event_not_found');
  events.set(delayedEventId, delayed);
  await client`UPDATE payment_inbox SET available_at = now()
    WHERE event_id = ${delayedEventId}`;
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).processed, 1);

  const wrongRefundId = randomUUID();
  eventIds.push(wrongRefundId);
  const refundData = {
    contract_version: 1, evidence_complete: true,
    provider_invoice_id: evidence.provider_invoice_id,
    provider_payment_id: evidence.provider_payment_id,
    amount_refunded_decimal: '15', currency: 'USD',
  };
  const wrongRefund = { id: wrongRefundId, type: 'subscription.period_refunded',
    data: { order, ...refundData, amount_refunded_decimal: '14' } };
  events.set(wrongRefundId, wrongRefund);
  assert.equal((await POST(signedRequest(wrongRefund))).status, 202);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).manualReview, 1);
  const [stillActive] = await client`SELECT status FROM subscription_grants
    WHERE organization_id = ${organizationId}`;
  assert.equal(stillActive.status, 'active');

  const refundId = randomUUID();
  eventIds.push(refundId);
  const refund = { id: refundId, type: 'subscription.period_refunded',
    data: { order, ...refundData } };
  events.set(refundId, refund);
  assert.equal((await POST(signedRequest(refund))).status, 202);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).processed, 1);
  const [reversed] = await client`SELECT status FROM subscription_grants
    WHERE organization_id = ${organizationId} AND period_start < ${new Date(evidence.service_period_end * 1000).toISOString()}::timestamptz`;
  assert.equal(reversed.status, 'reversed');
  const [later] = await client`SELECT status FROM subscription_grants
    WHERE organization_id = ${organizationId} AND period_start = ${new Date(evidence.service_period_end * 1000).toISOString()}::timestamptz`;
  assert.equal(later.status, 'active');
  assert.equal((await POST(signedRequest(refund))).status, 200);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).claimed, 0);

  const disputeId = randomUUID();
  eventIds.push(disputeId);
  const dispute = { id: disputeId, type: 'subscription.period_disputed',
    data: { order, contract_version: 1, evidence_complete: true,
      provider_invoice_id: nextInvoiceId, provider_payment_id: nextPaymentId,
      amount_disputed_decimal: '15', currency: 'USD', dispute_status: 'lost' } };
  events.set(disputeId, dispute);
  assert.equal((await POST(signedRequest(dispute))).status, 202);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).processed, 1);
  const [{ count: reversedCount }] = await client`SELECT count(*)::int AS count
    FROM subscription_grants WHERE organization_id = ${organizationId} AND status = 'reversed'`;
  assert.equal(reversedCount, 2);

  const mismatchEventId = randomUUID();
  eventIds.push(mismatchEventId);
  const mismatch = { ...event, id: mismatchEventId, data: {
    ...event.data,
    order: { ...order, metadata: { ...order.metadata,
      billingAccountId: 'another-account' } },
  } };
  events.set(mismatchEventId, mismatch);
  assert.equal((await POST(signedRequest(mismatch))).status, 202);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).manualReview, 1);
  const [mismatched] = await client`SELECT status, last_error_code FROM payment_inbox
    WHERE event_id = ${mismatchEventId}`;
  assert.equal(mismatched.status, 'manual_review');
  assert.equal(mismatched.last_error_code, 'event_order_intent_mismatch');

  const badEventId = randomUUID();
  eventIds.push(badEventId);
  const incomplete = { ...event, id: badEventId,
    data: { ...event.data, evidence_complete: false } };
  events.set(badEventId, incomplete);
  assert.equal((await POST(signedRequest(incomplete))).status, 202);
  assert.equal((await runPaymentInbox({ maxJobs: 1, send })).manualReview, 1);
  const [bad] = await client`SELECT status, last_error_code FROM payment_inbox
    WHERE event_id = ${badEventId}`;
  assert.equal(bad.status, 'manual_review');
  assert.equal(bad.last_error_code, 'period_evidence_incomplete');
  const [{ count: afterBad }] = await client`SELECT count(*)::int AS count
    FROM subscription_grants WHERE organization_id = ${organizationId}`;
  assert.equal(afterBad, 2);
  console.log('Signed callback, period grants, precise refund and lost-dispute reversals passed.');
} finally {
  await client`DELETE FROM payment_inbox WHERE event_id IN ${client(eventIds)}`;
  await client`DELETE FROM subscription_grants WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM payment_evidence WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM subscriptions WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM payment_intents WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM billing_accounts WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM organization WHERE id = ${organizationId}`;
  await client`DELETE FROM "user" WHERE id = ${userId}`;
  await client.end({ timeout: 5 });
}
