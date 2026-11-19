import 'dotenv/config';
import assert from 'node:assert/strict';

process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_API_KEY = 'mock-website-key';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'mock-callback-secret-longer-than-32-bytes';

const { createCenterOrder, queryCenterOrder, assertOrderMatchesIntent } =
  await import('../../lib/payment-center/orders');
const { queryCenterEvent } = await import('../../lib/payment-center/events');

const intent = {
  id: 'pi_contract', externalOrderId: 'pi_contract', idempotencyKey: 'pi_contract',
  organizationId: 'org_1', billingAccountId: 'ba_1', payerUserId: 'user_1',
  productCode: 'pro', priceInterval: 'month', amountDecimal: '15.00000000',
  currency: 'USD', method: 'stripe' as const,
};
const payload = {
  external_order_id: intent.externalOrderId,
  idempotency_key: intent.idempotencyKey,
  payer_external_user_id: intent.payerUserId,
  billing_account_id: intent.billingAccountId,
  payment_method: intent.method,
  kind: 'subscription' as const,
  product_code: intent.productCode,
  recurrence_interval: 'month' as const,
  amount: intent.amountDecimal,
  currency: intent.currency,
  catalog_currency: intent.currency,
  callback_url: 'https://saas.example.test/api/payment-center/webhook',
  success_url: 'https://saas.example.test/dashboard?checkout=returned',
  cancel_url: 'https://saas.example.test/pricing?checkout=cancelled',
  metadata: {
    organizationId: intent.organizationId, billingAccountId: intent.billingAccountId,
    payerUserId: intent.payerUserId, intentId: intent.id,
  },
};
const order = {
  id: '11111111-1111-4111-8111-111111111111',
  website_id: process.env.PAYMENT_CENTER_WEBSITE_ID,
  external_order_id: intent.externalOrderId,
  idempotency_key: intent.idempotencyKey,
  payer_external_user_id: intent.payerUserId,
  billing_account_id: intent.billingAccountId,
  payment_method: intent.method,
  kind: payload.kind,
  status: 'action_required',
  amount_decimal: '15', currency: intent.currency,
  product_code: intent.productCode,
  recurrence_interval: intent.priceInterval,
  metadata: payload.metadata,
};

let createCalls = 0;
let queryCalls = 0;
const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://payments.example.test');
  assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-website-key');
  assert.equal(init?.cache, 'no-store');
  if (init?.method === 'POST') {
    createCalls++;
    assert.equal(url.pathname, '/api/payment-center/orders');
    assert.deepEqual(JSON.parse(String(init.body)), payload);
    return Response.json({ status: 'success', data: {
      order, action: { type: 'stripe_checkout', url: 'https://checkout.example.test' },
      idempotent: false, reused: false,
    } }, { status: 201 });
  }
  queryCalls++;
  assert.equal(url.pathname, `/api/payment-center/orders/${intent.externalOrderId}`);
  return Response.json({ status: 'success', data: { order, manual_submission: null } });
}) as typeof fetch;

const created = await createCenterOrder(payload, send);
assert.equal(createCalls, 1);
assertOrderMatchesIntent(intent, created.order);
const queried = await queryCenterOrder(intent.externalOrderId, send);
assert.equal(queryCalls, 1);
assert.ok(queried);
assertOrderMatchesIntent(intent, queried);

for (const changed of [
  { website_id: '00000000-0000-4000-8000-000000000002' },
  { external_order_id: 'another-order' },
  { payer_external_user_id: 'another-user' },
  { billing_account_id: 'another-account' },
  { amount_decimal: '15.00000001' },
  { currency: 'EUR' },
  { recurrence_interval: 'year' },
  { metadata: { ...order.metadata, organizationId: 'another-workspace' } },
  { metadata: { ...order.metadata, billingAccountId: 'another-account' } },
]) {
  assert.throws(() => assertOrderMatchesIntent(intent, { ...created.order, ...changed }),
    /does not match/);
}
assert.equal(await queryCenterOrder(intent.externalOrderId,
  (async () => new Response(null, { status: 404 })) as typeof fetch), null);
await assert.rejects(createCenterOrder({ ...payload, amount: '15.000000001' }, send));
assert.equal(createCalls, 1, 'Invalid money must be rejected before HTTP');
const eventId = '22222222-2222-4222-8222-222222222222';
const event = { id: eventId, type: 'payment.succeeded', data: { order } };
const eventSend = (async (input: RequestInfo | URL, init?: RequestInit) => {
  assert.equal(new URL(String(input)).pathname, `/api/payment-center/events/${eventId}`);
  assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-website-key');
  return Response.json({ status: 'success', data: {
    event, delivery_status: 'delivered',
  } });
}) as typeof fetch;
assert.equal((await queryCenterEvent(eventId, eventSend))?.id, eventId);
await assert.rejects(queryCenterEvent(eventId,
  (async () => Response.json({ status: 'success', data: {
    event: { ...event, id: '33333333-3333-4333-8333-333333333333' },
    delivery_status: 'delivered',
  } })) as typeof fetch), /another website or ID/);
console.log('Payment Center order HTTP and immutable intent matching passed.');
