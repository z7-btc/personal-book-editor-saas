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

async function runCase(method: 'manual' | 'blockchain' | 'commission_balance') {
  const suffix = randomUUID();
  const userId = `prepaid-user-${suffix}`;
  const organizationId = `prepaid-org-${suffix}`;
  const accountId = `ba_prepaid_${suffix}`;
  const intentId = `pi_prepaid_${suffix}`;
  const centerOrderId = randomUUID();
  const eventId = randomUUID();
  const eventIds = [eventId];
  const siteId = process.env.PAYMENT_CENTER_WEBSITE_ID!;
  const settledAt = Math.floor(Date.now() / 1000) - 60;
  const paymentId = method === 'manual' ? `bank_${suffix}` :
    method === 'commission_balance' ? `PC_${centerOrderId}` :
      `0x${suffix.replaceAll('-', '').padEnd(64, 'a')}`;
  const paidAmount = method === 'blockchain' ? '15.12345600' : '15.00000000';
  const order = {
    id: centerOrderId, website_id: siteId,
    external_order_id: intentId, idempotency_key: intentId,
    payer_external_user_id: userId, billing_account_id: accountId,
    payment_method: method, kind: 'one_time', status: 'paid',
    amount_decimal: '15.00000000', currency: method === 'manual' ? 'USD' : 'USDT',
    product_code: 'pro', recurrence_interval: 'month',
    provider_subscription_id: null, provider_payment_id: paymentId,
    metadata: { organizationId, billingAccountId: accountId,
      payerUserId: userId, intentId },
    payment_details: method === 'blockchain'
      ? { confirmed_amount_decimal: paidAmount }
      : method === 'commission_balance'
        ? { commission_flow: 'two_phase', commission_spend_id: paymentId }
        : { type: 'manual' },
  };
  const proof = {
    contract_version: 1, evidence_complete: true,
    payment_method: method, recurrence_interval: 'month',
    provider_payment_id: paymentId, amount_paid_decimal: paidAmount,
    currency: order.currency, settled_at: settledAt,
    service_period_start: settledAt,
    service_period_end: settledAt + 30 * 86_400,
  };
  const event = { id: eventId, type: 'payment.succeeded', data: { order, ...proof } };
  const events = new Map<string, typeof event>([[eventId, event]]);
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-website-key');
    if (url.pathname.startsWith('/api/payment-center/events/')) {
      const found = events.get(url.pathname.split('/').at(-1)!);
      return found ? Response.json({ status: 'success', data: {
        event: found, delivery_status: 'delivered',
      } }) : new Response(null, { status: 404 });
    }
    assert.equal(url.pathname, `/api/payment-center/orders/${intentId}`);
    return Response.json({ status: 'success', data: { order } });
  }) as typeof fetch;

  try {
    await client`INSERT INTO "user" (id, name, email)
      VALUES (${userId}, 'Prepaid Test', ${`${userId}@example.test`})`;
    await client`INSERT INTO organization (id, name, slug, created_at)
      VALUES (${organizationId}, 'Prepaid Smoke', ${`prepaid-${suffix}`}, now())`;
    await client`INSERT INTO billing_accounts
      (id, organization_id, external_billing_id, original_payer_user_id)
      VALUES (${accountId}, ${organizationId}, ${accountId}, ${userId})`;
    await client`INSERT INTO payment_intents
      (id, organization_id, billing_account_id, payer_user_id, request_key,
       product_code, price_interval, amount_decimal, currency, method, payment_action,
       external_order_id, idempotency_key, status)
      VALUES (${intentId}, ${organizationId}, ${accountId}, ${userId},
        ${randomUUID()}, 'pro', 'month', '15.00000000', ${order.currency}, ${method},
        CASE ${method} WHEN 'commission_balance' THEN 'commission_reserved'
          WHEN 'blockchain' THEN 'blockchain' WHEN 'binance_pay' THEN 'binance_pay'
          ELSE 'manual' END,
        ${intentId}, ${intentId}, 'unknown')`;
    if (method === 'commission_balance') {
      await client`INSERT INTO commission_grant_preparations
        (intent_id, organization_id, center_order_id, spend_id)
        VALUES (${intentId}, ${organizationId}, ${centerOrderId}, ${paymentId})`;
    }

    assert.equal((await POST(signedRequest(event))).status, 202);
    assert.equal((await runPaymentInbox({ maxJobs: 1, send })).processed, 1);
    const [grant] = await client`SELECT grants.status, evidence.evidence_key,
        evidence.amount_decimal, evidence.provider_payment_id
      FROM subscription_grants AS grants
      JOIN payment_evidence AS evidence ON evidence.id = grants.evidence_id
      WHERE grants.organization_id = ${organizationId}`;
    assert.equal(grant.status, 'active');
    assert.equal(grant.evidence_key, `order:${centerOrderId}`);
    assert.equal(grant.amount_decimal, paidAmount);
    assert.equal(grant.provider_payment_id, paymentId);
    assert.equal((await POST(signedRequest(event))).status, 200);
    assert.equal((await runPaymentInbox({ maxJobs: 1, send })).claimed, 0);

    const wrongId = randomUUID();
    eventIds.push(wrongId);
    const wrong = { ...event, id: wrongId, data: { ...event.data,
      amount_paid_decimal: method === 'blockchain' ? '15.00000000' : '14' } };
    events.set(wrongId, wrong);
    assert.equal((await POST(signedRequest(wrong))).status, 202);
    assert.equal((await runPaymentInbox({ maxJobs: 1, send })).manualReview, 1);
    const [{ count }] = await client`SELECT count(*)::int AS count
      FROM subscription_grants WHERE organization_id = ${organizationId}`;
    assert.equal(count, 1);
  } finally {
    await client`DELETE FROM payment_inbox WHERE event_id IN ${client(eventIds)}`;
    await client`DELETE FROM subscription_grants WHERE organization_id = ${organizationId}`;
    await client`DELETE FROM payment_evidence WHERE organization_id = ${organizationId}`;
    await client`DELETE FROM subscriptions WHERE organization_id = ${organizationId}`;
    await client`DELETE FROM commission_grant_preparations WHERE organization_id = ${organizationId}`;
    await client`DELETE FROM payment_intents WHERE organization_id = ${organizationId}`;
    await client`DELETE FROM billing_accounts WHERE organization_id = ${organizationId}`;
    await client`DELETE FROM organization WHERE id = ${organizationId}`;
    await client`DELETE FROM "user" WHERE id = ${userId}`;
  }
}

try {
  await runCase('manual');
  await runCase('blockchain');
  await runCase('commission_balance');
  console.log('Manual, blockchain and commission settled-payment grants, replay and amount checks passed.');
} finally {
  await client.end({ timeout: 5 });
}
