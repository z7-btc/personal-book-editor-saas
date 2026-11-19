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
const { preparePaymentIntent } = await import('../../lib/billing/intents');
const { fulfillSubscription } = await import('../../lib/subscription/service');

const DAY = 86_400_000;
const suffix = randomUUID();
const userId = `prorate-user-${suffix}`;
const organizationId = `prorate-org-${suffix}`;
const accountId = `ba_prorate_${suffix}`;
const intentId = `pi_prorate_${suffix}`;
const siteId = process.env.PAYMENT_CENTER_WEBSITE_ID!;
const now = new Date();

// The catalog the prepared switch reads: starter $29/mo, pro $99/mo.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  assert.equal(new URL(String(input)).pathname, '/api/payment-center/catalog');
  return Response.json({
    status: 'success',
    data: {
      website_id: siteId, site_code: 'saas-test', site_name: 'SaaS Test',
      methods: ['stripe', 'manual', 'blockchain', 'commission_balance'],
      unavailable_methods: {},
      products: [
        { code: 'starter', name: 'Starter', prices: [
          { interval: 'month', amount: 29, amount_decimal: '29.00000000', currency: 'USD' },
        ] },
        { code: 'pro', name: 'Pro', prices: [
          { interval: 'month', amount: 99, amount_decimal: '99.00000000', currency: 'USD' },
        ] },
      ],
    },
  });
}) as typeof fetch;

try {
  await client`INSERT INTO "user" (id, name, email) VALUES
    (${userId}, 'Prorate Test', ${`${userId}@example.test`})`;
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Prorate Smoke', ${`prorate-${suffix}`}, now())`;
  await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${organizationId}, ${userId}, 'owner', now())`;
  await client`INSERT INTO billing_accounts
    (id, organization_id, external_billing_id, original_payer_user_id)
    VALUES (${accountId}, ${organizationId}, ${accountId}, ${userId})`;
  await client`INSERT INTO payment_intents
    (id, organization_id, billing_account_id, payer_user_id, request_key,
     product_code, price_interval, amount_decimal, currency, method, payment_action,
     external_order_id, idempotency_key, status)
    VALUES (${intentId}, ${organizationId}, ${accountId}, ${userId},
      ${randomUUID()}, 'starter', 'month', '29.00000000', 'USD', 'stripe', 'redirect',
      ${intentId}, ${intentId}, 'unknown')`;

  // A settled starter grant that still has 60 days to run.
  const startSec = Math.floor(now.getTime() / 1000);
  const endSec = startSec + 60 * 86_400;
  const order = {
    id: randomUUID(), website_id: siteId, external_order_id: intentId,
    idempotency_key: intentId, payer_external_user_id: userId,
    billing_account_id: accountId, payment_method: 'stripe' as const,
    kind: 'subscription' as const, status: 'paid',
    amount_decimal: '29.00000000', currency: 'USD',
    product_code: 'starter', recurrence_interval: 'month',
    provider_subscription_id: `sub_${suffix}`,
    metadata: { organizationId, billingAccountId: accountId,
      payerUserId: userId, intentId },
  };
  const settled = await fulfillSubscription({
    sourceEventId: randomUUID(), intentId,
    providerInvoiceId: `inv_first_${suffix}`,
    providerSubscriptionId: `sub_${suffix}`, providerPaymentId: null,
    amountDecimal: '29.00000000', currency: 'USD',
    settledAt: startSec, servicePeriodStart: startSec, servicePeriodEnd: endSec,
  }, order, now);
  assert.equal(settled.duplicate, false);
  assert.equal(settled.subscription?.productCode, 'starter');

  // The buyer switches to pro at checkout. The remaining 60 days are scaled by
  // 29/99, so the prorated period end is now + floor(60 * 29 / 99) = 17 days.
  const before = Date.now();
  const intent = await preparePaymentIntent(organizationId, userId, {
    requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
    currency: 'USD', method: 'stripe',
  });
  assert.ok(intent.proratedPeriodEnd, 'a plan switch must be priced at checkout');
  const convertedDays = Math.floor(intent.proratedPeriodEnd.getTime() / DAY)
    - Math.floor(before / DAY);
  assert.equal(convertedDays, 17,
    `expected ~17 prorated days from 29/99 of 60 remaining (got ${convertedDays})`);
  const endOfSwitch = intent.proratedPeriodEnd.getTime();
  assert.ok(endOfSwitch < endSec * 1000,
    'the prorated end must be earlier than the old plan would have run');

  console.log('Plan-switch proration is priced at checkout and stored on the intent.');
} finally {
  globalThis.fetch = originalFetch;
  await client`DELETE FROM payment_inbox WHERE external_order_id = ${intentId}`;
  await client`DELETE FROM subscription_grants WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM payment_evidence WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM subscriptions WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM payment_intents WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM billing_accounts WHERE id = ${accountId}`;
  await client`DELETE FROM member WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM organization WHERE id = ${organizationId}`;
  await client`DELETE FROM "user" WHERE id = ${userId}`;
  await client.end({ timeout: 5 });
}
