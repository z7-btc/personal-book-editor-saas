import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_API_KEY = 'mock-website-key';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'mock-callback-secret-longer-than-32-bytes';

const { client } = await import('../../lib/db/drizzle');
const { preparePaymentIntent, PaymentIntentConflict, PaymentOptionUnavailable } =
  await import('../../lib/billing/intents');
const { BillingAccessError } = await import('../../lib/billing/account');
const suffix = randomUUID();
const ownerId = `intent-owner-${suffix}`;
const memberId = `intent-member-${suffix}`;
const organizationId = `intent-org-${suffix}`;
let amount = '15.00000000';
let catalogCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  catalogCalls++;
  assert.equal(new URL(String(input)).pathname, '/api/payment-center/catalog');
  assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-website-key');
  return Response.json({
    status: 'success',
    data: {
      website_id: '00000000-0000-4000-8000-000000000001',
      site_code: 'saas-test', site_name: 'SaaS Test',
      methods: ['stripe', 'manual', 'blockchain', 'commission_balance'],
      unavailable_methods: { blockchain: 'monitor_unavailable' },
      products: [{ code: 'pro', name: 'Pro', description: null, prices: [
        { interval: 'month', amount: Number(amount), amount_decimal: amount, currency: 'USD' },
      ] }],
    },
  });
}) as typeof fetch;

try {
  await client`INSERT INTO "user" (id, name, email) VALUES
    (${ownerId}, 'Intent Owner', ${`${ownerId}@example.test`}),
    (${memberId}, 'Intent Member', ${`${memberId}@example.test`})`;
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Intent Smoke', ${`intent-${suffix}`}, now())`;
  await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${organizationId}, ${ownerId}, 'owner', now()),
           (${randomUUID()}, ${organizationId}, ${memberId}, 'member', now())`;

  const input = {
    requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
    currency: 'USD', method: 'manual' as const,
  } satisfies Parameters<typeof preparePaymentIntent>[2];
  const [first, duplicate] = await Promise.all([
    preparePaymentIntent(organizationId, ownerId, input),
    preparePaymentIntent(organizationId, ownerId, input),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.amountDecimal, '15.00000000');
  assert.equal(first.status, 'pending');
  assert.equal(first.externalOrderId, first.id);
  assert.equal(first.idempotencyKey, first.id);

  amount = '17.00000000';
  const priorCalls = catalogCalls;
  const retried = await preparePaymentIntent(organizationId, ownerId, input);
  assert.equal(retried.id, first.id);
  assert.equal(retried.amountDecimal, '15.00000000');
  assert.equal(catalogCalls, priorCalls, 'A replay must use its stored quote');

  await assert.rejects(preparePaymentIntent(organizationId, ownerId,
    { ...input, productCode: 'another' }), PaymentIntentConflict);
  await assert.rejects(preparePaymentIntent(organizationId, memberId,
    { ...input, requestKey: randomUUID() }), BillingAccessError);
  await assert.rejects(preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID(), method: 'commission_balance' }),
    PaymentOptionUnavailable);

  const next = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID() });
  assert.equal(next.amountDecimal, '17.00000000');
  const [{ count }] = await client`SELECT count(*)::int AS count FROM payment_intents
    WHERE organization_id = ${organizationId}`;
  assert.equal(count, 2);

  await client`UPDATE payment_intents SET status = 'action_required' WHERE id = ${first.id}`;
  const resumed = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID() });
  assert.equal(resumed.id, first.id,
    'A second tab must resume the existing open checkout');
  await assert.rejects(client`UPDATE payment_intents SET status = 'submitting'
    WHERE id = ${next.id}`);
  console.log('Payment intent quote, authorization, replay and open-checkout guard passed.');
} finally {
  globalThis.fetch = originalFetch;
  await client`DELETE FROM payment_intents WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM billing_accounts WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM organization WHERE id = ${organizationId}`;
  await client`DELETE FROM "user" WHERE id IN (${ownerId}, ${memberId})`;
  await client.end({ timeout: 5 });
}
