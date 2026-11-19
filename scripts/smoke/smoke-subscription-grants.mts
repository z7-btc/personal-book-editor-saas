import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
const siteId = process.env.PAYMENT_CENTER_WEBSITE_ID;
assert.ok(siteId, 'The fixture website ID must be set');

const { client } = await import('../../lib/db/drizzle');
const { fulfillSubscription, reverseSubscriptionGrant,
  refreshDueSubscriptions, SubscriptionConflict } =
  await import('../../lib/subscription/service');
const suffix = randomUUID();
const userId = `grant-user-${suffix}`;
const organizationId = `grant-org-${suffix}`;
const accountId = `ba_grant_${suffix}`;
const intentId = `pi_grant_${suffix}`;
const centerOrderId = randomUUID();
const invoiceOne = `in_first_${suffix}`;
const invoiceTwo = `in_second_${suffix}`;
const subscriptionId = `sub_${suffix}`;
const nowSeconds = Math.floor(Date.now() / 1000);
const startOne = nowSeconds - 86_400;
const endOne = nowSeconds + 29 * 86_400;
const endTwo = endOne + 30 * 86_400;
const order = {
  id: centerOrderId,
  website_id: siteId,
  external_order_id: intentId, idempotency_key: intentId,
  payer_external_user_id: userId, billing_account_id: accountId,
  payment_method: 'stripe' as const, kind: 'subscription' as const,
  status: 'paid', amount_decimal: '15.00000000', currency: 'USD',
  product_code: 'pro', recurrence_interval: 'month',
  provider_subscription_id: subscriptionId,
  metadata: { organizationId, billingAccountId: accountId,
    payerUserId: userId, intentId },
};
const eventIds: string[] = [];

async function inbox(eventId: string) {
  eventIds.push(eventId);
  await client`INSERT INTO payment_inbox (event_id, event_type, center_order_id,
    external_order_id, website_id, body_sha256, status)
    VALUES (${eventId}, 'subscription.period_paid', ${centerOrderId}, ${intentId},
      ${siteId}, ${'0'.repeat(64)}, 'pending')`;
}

function period(eventId: string, invoiceId: string, start: number, end: number) {
  return {
    sourceEventId: eventId, intentId,
    providerInvoiceId: invoiceId,
    providerSubscriptionId: subscriptionId,
    providerPaymentId: `pi_${invoiceId}`,
    amountDecimal: '15.00000000', currency: 'USD',
    settledAt: nowSeconds - 60,
    servicePeriodStart: start, servicePeriodEnd: end,
  };
}

try {
  await client`INSERT INTO "user" (id, name, email)
    VALUES (${userId}, 'Grant Test', ${`${userId}@example.test`})`;
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Grant Smoke', ${`grant-${suffix}`}, now())`;
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

  const firstEvent = randomUUID();
  await inbox(firstEvent);
  const first = await fulfillSubscription(period(firstEvent, invoiceOne, startOne, endOne), order);
  assert.equal(first.duplicate, false);
  assert.equal(first.subscription?.status, 'active');
  const [firstState] = await client`SELECT version, active_until FROM subscriptions
    WHERE organization_id = ${organizationId}`;
  assert.equal(firstState.version, 1);
  assert.equal(Math.floor(new Date(firstState.active_until).getTime() / 1000), endOne);

  const replayEvent = randomUUID();
  await inbox(replayEvent);
  const replay = await fulfillSubscription(period(replayEvent, invoiceOne, startOne, endOne), order);
  assert.equal(replay.duplicate, true);
  const [replayState] = await client`SELECT version FROM subscriptions
    WHERE organization_id = ${organizationId}`;
  assert.equal(replayState.version, 1);
  const [replayInbox] = await client`SELECT status FROM payment_inbox
    WHERE event_id = ${replayEvent}`;
  assert.equal(replayInbox.status, 'processed');

  const renewalEvent = randomUUID();
  await inbox(renewalEvent);
  await fulfillSubscription(period(renewalEvent, invoiceTwo, endOne, endTwo), order);
  const [{ count: beforeRefund }] = await client`SELECT count(*)::int AS count
    FROM subscription_grants WHERE organization_id = ${organizationId}
      AND status = 'active'`;
  assert.equal(beforeRefund, 2);
  const reversalEvent = randomUUID();
  const reversed = await reverseSubscriptionGrant(
    siteId, `invoice:${invoiceOne}`, reversalEvent);
  assert.equal(reversed.duplicate, false);
  // The refunded invoice was the first period; the renewal that continues from
  // its end is still unexpired, so the workspace stays active.
  assert.equal(reversed.subscription?.status, 'active');
  assert.equal((await reverseSubscriptionGrant(
    siteId, `invoice:${invoiceOne}`, reversalEvent)).duplicate,
    true);
  await assert.rejects(reverseSubscriptionGrant(
    siteId, `invoice:${invoiceOne}`, randomUUID()),
    SubscriptionConflict);
  const [{ count: laterGrant }] = await client`SELECT count(*)::int AS count
    FROM subscription_grants WHERE organization_id = ${organizationId}
      AND status = 'active'`;
  assert.equal(laterGrant, 1, 'An old refund must not revoke a later paid period');

  const futureNow = new Date((endOne + 60) * 1000);
  // The aggregate already reports the latest period end, so there is nothing
  // left to refresh once the first period elapses.
  assert.equal(await refreshDueSubscriptions(100, futureNow), 0);
  const [future] = await client`SELECT status, active_until FROM subscriptions
    WHERE organization_id = ${organizationId}`;
  assert.equal(future.status, 'active');
  assert.equal(Math.floor(new Date(future.active_until).getTime() / 1000), endTwo);
  // A later Stripe purchase opens a second subscription. It must NOT be granted
  // the same span as the one already running: it is stitched onto the end of the
  // workspace's current access, and the older subscription's renewal is turned
  // off so the buyer is not billed twice.
  const competingIntentId = `pi_competing_${suffix}`;
  await client`INSERT INTO payment_intents
    (id, organization_id, billing_account_id, payer_user_id, request_key,
     product_code, price_interval, amount_decimal, currency, method, payment_action,
     external_order_id, idempotency_key, status)
    VALUES (${competingIntentId}, ${organizationId}, ${accountId}, ${userId},
      ${randomUUID()}, 'pro', 'month', '15.00000000', 'USD', 'stripe', 'redirect',
      ${competingIntentId}, ${competingIntentId}, 'unknown')`;
  const competingSubscriptionId = `sub_competing_${suffix}`;
  const continued = await fulfillSubscription({
    ...period(randomUUID(), `in_competing_${suffix}`, endOne, endTwo),
    intentId: competingIntentId,
    providerSubscriptionId: competingSubscriptionId,
  }, {
    ...order,
    id: randomUUID(), external_order_id: competingIntentId,
    idempotency_key: competingIntentId,
    provider_subscription_id: competingSubscriptionId,
    metadata: { ...order.metadata, intentId: competingIntentId },
  }, new Date((endOne + 60) * 1000));
  assert.equal(continued.duplicate, false);
  const [competingGrant] = await client`SELECT period_start, period_end
    FROM subscription_grants WHERE organization_id = ${organizationId}
      AND provider_subscription_id = ${competingSubscriptionId}`;
  assert.equal(Math.floor(new Date(competingGrant.period_start).getTime() / 1000), endTwo,
    'A later purchase continues after the current period, never overlapping it');
  assert.equal(Math.floor(new Date(competingGrant.period_end).getTime() / 1000), endTwo + 30 * 86_400);
  const [{ count: evidenceCount }] = await client`SELECT count(*)::int AS count
    FROM payment_evidence WHERE organization_id = ${organizationId}`;
  assert.equal(evidenceCount, 3);
  console.log('Independent grants, invoice replay, historical reversal, renewal recompute and Stripe continuation passed.');
} finally {
  await client`DELETE FROM payment_inbox WHERE external_order_id = ${intentId}`;
  await client`DELETE FROM subscription_grants WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM payment_evidence WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM subscriptions WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM payment_intents WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM billing_accounts WHERE id = ${accountId}`;
  await client`DELETE FROM organization WHERE id = ${organizationId}`;
  await client`DELETE FROM "user" WHERE id = ${userId}`;
  await client.end({ timeout: 5 });
}
