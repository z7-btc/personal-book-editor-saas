import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const database = new URL(process.env.DATABASE_URL || '');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname), 'Local PostgreSQL only');
assert.notEqual(process.env.NODE_ENV, 'production');
const configuredWebsiteId = process.env.PAYMENT_CENTER_WEBSITE_ID;
assert.ok(configuredWebsiteId, 'Use the configured local website binding for the fixture');
const websiteId: string = configuredWebsiteId;
process.env.FEATURE_PAYMENT_CENTER = 'false';
process.env.FEATURE_COMMISSION_BALANCE = 'false';
const { client } = await import('../../lib/db/drizzle');
const { getBillingHistory, BillingHistoryCursorError } = await import('../../lib/billing/history');
const { BillingAccessError } = await import('../../lib/billing/account');
const { personalSlug } = await import('../../lib/workspace/bootstrap');
type History = Awaited<ReturnType<typeof getBillingHistory>>;
type Method = 'stripe' | 'manual' | 'blockchain' | 'commission_balance';
type IntentStatus = 'pending' | 'submitting' | 'action_required' | 'unknown' | 'failed' | 'cancelled' | 'settled' | 'manual_review';
type Owner = { userId: string; organizationId: string; accountId: string };
type Intent = Owner & { id: string; centerOrderId: string; externalOrderId: string; method: Method; amount: string; currency: string; product: string };
type Evidence = { id: string; intent: Intent; providerSubscriptionId: string | null; start: Date; end: Date };
const runId = randomUUID();
const sensitive = `billing-private-${runId}`;
const owners: Owner[] = [];
const intentIds: string[] = [];
const evidenceIds: string[] = [];
const eventIds: string[] = [];
const now = new Date();
const past = new Date(now.getTime() - 86_400_000);
const future = new Date(now.getTime() + 29 * 86_400_000);
const originalFetch = globalThis.fetch;
let networkCalls = 0;
let checks = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error('History must not contact a payment provider or mail service');
}) as typeof fetch;

async function owner() {
  const userId = `billing-history-${runId}-${owners.length + 1}`;
  const organizationId = `billing-history-org-${randomUUID()}`;
  const accountId = `ba_history_${randomUUID()}`;
  const result = { userId, organizationId, accountId };
  owners.push(result);
  await client`INSERT INTO "user" (id, name, email) VALUES
    (${userId}, 'Local History Fixture', ${`${userId}@example.test`})`;
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Local Personal Billing', ${personalSlug(userId)}, now())`;
  await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${organizationId}, ${userId}, 'owner', now())`;
  await client`INSERT INTO billing_accounts (id, organization_id, external_billing_id, original_payer_user_id)
    VALUES (${accountId}, ${organizationId}, ${accountId}, ${userId})`;
  return result;
}
async function intent(actor: Owner, options: {
  method?: Method; status?: IntentStatus; amount?: string; currency?: string;
  accountId?: string; payerUserId?: string; product?: string; createdAt?: string;
} = {}): Promise<Intent> {
  const id = `pi_history_${randomUUID()}`;
  intentIds.push(id);
  const result = { ...actor, id, method: options.method || 'stripe',
    centerOrderId: `${sensitive}-order-${intentIds.length}`,
    externalOrderId: `${sensitive}-external-${intentIds.length}`,
    amount: options.amount || '15.00000000', currency: options.currency || 'USD', product: options.product || 'pro' };
  await client`INSERT INTO payment_intents
    (id, organization_id, billing_account_id, payer_user_id, request_key, product_code,
     price_interval, amount_decimal, currency, method, payment_action, status,
     external_order_id, idempotency_key, payment_center_order_id, last_error_code, created_at)
    VALUES (${id}, ${actor.organizationId}, ${options.accountId || actor.accountId},
      ${options.payerUserId || actor.userId}, ${randomUUID()}, ${result.product}, 'month',
      ${result.amount}, ${result.currency}, ${result.method},
      CASE ${result.method} WHEN 'stripe' THEN 'redirect'
        WHEN 'commission_balance' THEN 'commission_reserved'
        WHEN 'blockchain' THEN 'blockchain' WHEN 'binance_pay' THEN 'binance_pay'
        ELSE 'manual' END,
      ${options.status || 'pending'}::payment_intent_status, ${result.externalOrderId},
      ${`${sensitive}-key-${intentIds.length}`}, ${result.centerOrderId},
      ${`${sensitive}-raw-error`}, COALESCE(${options.createdAt || null}::timestamp, now()))`;
  return result;
}
async function receipt(order: Intent, options: {
  amount?: string; currency?: string; organizationId?: string; centerOrderId?: string;
  websiteId?: string; start?: Date; end?: Date; settledAt?: string;
} = {}): Promise<Evidence> {
  const id = `pe_history_${randomUUID()}`;
  const sourceEventId = randomUUID();
  evidenceIds.push(id); eventIds.push(sourceEventId);
  const providerSubscriptionId = order.method === 'stripe' ? `${sensitive}-subscription-${order.id}` : null;
  const result = { id, intent: order, providerSubscriptionId, start: options.start || past, end: options.end || future };
  await client`INSERT INTO payment_inbox (event_id, event_type, center_order_id,
    external_order_id, website_id, body_sha256, status)
    VALUES (${sourceEventId}, ${order.method === 'stripe' ? 'subscription.period_paid' : 'payment.succeeded'},
      ${order.centerOrderId}, ${order.externalOrderId}, ${websiteId}, ${'0'.repeat(64)}, 'processed')`;
  await client`INSERT INTO payment_evidence (id, website_id, organization_id, intent_id,
    evidence_key, source_event_id, center_order_id, provider_subscription_id,
    provider_invoice_id, provider_payment_id, amount_decimal, currency,
    settled_at, service_period_start, service_period_end)
    VALUES (${id}, ${options.websiteId || websiteId}, ${options.organizationId || order.organizationId},
      ${order.id}, ${`${sensitive}-proof-${evidenceIds.length}`}, ${sourceEventId},
      ${options.centerOrderId || order.centerOrderId}, ${providerSubscriptionId},
      ${order.method === 'stripe' ? `${sensitive}-invoice-${evidenceIds.length}` : null},
      ${`${sensitive}-provider-payment-${evidenceIds.length}`}, ${options.amount || order.amount},
      ${options.currency || order.currency}, COALESCE(${options.settledAt || null}::timestamptz, now()),
      ${result.start.toISOString()}::timestamptz, ${result.end.toISOString()}::timestamptz)`;
  return result;
}
async function grant(proof: Evidence, options: {
  organizationId?: string; method?: Method; product?: string; providerSubscriptionId?: string | null;
  start?: Date; end?: Date; status?: 'active' | 'reversed';
} = {}) {
  const id = `sg_history_${randomUUID()}`;
  await client`INSERT INTO subscription_grants (id, organization_id, evidence_id,
    product_code, payment_method, provider_subscription_id, period_start, period_end, status)
    VALUES (${id}, ${options.organizationId || proof.intent.organizationId}, ${proof.id},
      ${options.product || proof.intent.product}, ${options.method || proof.intent.method}::saas_payment_method,
      ${options.providerSubscriptionId === undefined ? proof.providerSubscriptionId : options.providerSubscriptionId},
      ${(options.start || proof.start).toISOString()}::timestamptz,
      ${(options.end || proof.end).toISOString()}::timestamptz, ${options.status || 'active'}::subscription_grant_status)`;
  return id;
}
async function reversal(proof: Evidence, type: 'subscription.period_refunded' | 'subscription.period_disputed') {
  const eventId = randomUUID();
  eventIds.push(eventId);
  await client`INSERT INTO payment_inbox (event_id, event_type, center_order_id,
    external_order_id, website_id, body_sha256, status)
    VALUES (${eventId}, ${type}, ${proof.intent.centerOrderId}, ${proof.intent.externalOrderId},
      ${websiteId}, ${'0'.repeat(64)}, 'processed')`;
  await client`UPDATE payment_evidence SET status = 'reversed', reversed_by_event_id = ${eventId} WHERE id = ${proof.id}`;
  await client`UPDATE subscription_grants SET status = 'reversed', reversed_at = now() WHERE evidence_id = ${proof.id}`;
}
function privacy(history: History, actor: Owner) {
  assert.deepEqual(Object.keys(history).sort(), ['asOf', 'orders', 'paymentEnabled', 'payments', 'subscription']);
  const serialized = JSON.stringify(history);
  for (const forbidden of [sensitive, actor.userId, actor.organizationId, actor.accountId,
    'providerSnapshot', 'checkoutUrl', 'apiKey', 'idempotencyKey', 'lastErrorCode', '@example.test']) {
    assert.ok(!serialized.includes(forbidden), 'History exposes only the public billing DTO');
  }
  assert.equal(history.paymentEnabled, false, 'Feature-off must disable new payment operations without hiding history');
}
async function history(actor: Owner, options: Parameters<typeof getBillingHistory>[1] = {}) {
  const result = await getBillingHistory(actor.userId, { now, ...options });
  privacy(result, actor);
  return result;
}

try {
  const empty = await owner();
  const initial = await history(empty);
  assert.equal(initial.subscription.state, 'none');
  assert.equal(initial.orders.items.length + initial.payments.items.length, 0);
  const [readOnlyBefore] = await client`SELECT updated_at FROM billing_accounts WHERE id = ${empty.accountId}`;
  await history(empty);
  const [readOnlyAfter] = await client`SELECT updated_at FROM billing_accounts WHERE id = ${empty.accountId}`;
  assert.deepEqual(readOnlyAfter, readOnlyBefore, 'Reading history cannot refresh a billing identity');
  checks++;

  const channels: Array<{ method: Method; amount: string; currency: string }> = [
    { method: 'stripe', amount: '9007199254740993.12345678', currency: 'USD' },
    { method: 'manual', amount: '123456789.00000000', currency: 'JPY' },
    { method: 'blockchain', amount: '1.12345678', currency: 'USDT' },
    { method: 'commission_balance', amount: '0.00000001', currency: 'USDT' },
  ];
  for (const channel of channels) {
    const actor = await owner();
    const order = await intent(actor, { ...channel, status: 'settled' });
    const proof = await receipt(order);
    await grant(proof);
    await client`INSERT INTO subscriptions (organization_id, status) VALUES (${actor.organizationId}, 'inactive')`;
    const result = await history(actor);
    assert.equal(result.subscription.state, 'active', 'Validated grants, not stale aggregate state, prove current access');
    assert.equal(result.subscription.method, channel.method);
    assert.equal(result.subscription.productCode, 'pro');
    assert.equal(result.orders.items[0].status, 'settled');
    assert.equal(result.orders.items[0].hasVerifiedPayment, true);
    assert.equal(result.payments.items[0].access, 'active');
    assert.equal(result.payments.items[0].method, channel.method);
    assert.equal(result.payments.items[0].amountDecimal, channel.amount, 'Never coerce exact decimal money into a JavaScript Number');
    assert.equal(result.payments.items[0].currency, channel.currency, 'Keep each actual currency without local conversion');
    checks++;
  }

  const progress = await owner();
  const progressOrder = await intent(progress);
  for (const status of ['pending', 'submitting', 'action_required', 'unknown', 'failed', 'cancelled', 'manual_review'] as const) {
    await client`UPDATE payment_intents SET status = ${status}::payment_intent_status WHERE id = ${progressOrder.id}`;
    const result = await history(progress);
    assert.equal(result.orders.items[0].status, status);
    assert.equal(result.orders.items[0].hasVerifiedPayment, false);
    assert.equal(result.subscription.state, 'none');
    assert.equal(result.payments.items.length, 0);
  }
  await client`UPDATE payment_intents SET status = 'settled' WHERE id = ${progressOrder.id}`;
  await client`INSERT INTO subscriptions (organization_id, product_code, payment_method, status, active_until)
    VALUES (${progress.organizationId}, 'pro', 'stripe', 'active', ${future.toISOString()}::timestamptz)`;
  const unproven = await history(progress);
  assert.equal(unproven.orders.items[0].status, 'awaiting_confirmation');
  assert.equal(unproven.orders.items[0].hasVerifiedPayment, false);
  assert.equal(unproven.subscription.state, 'none', 'Settled text and active aggregate without verified facts cannot grant access');
  checks++;

  for (const access of ['upcoming', 'expired'] as const) {
    const actor = await owner();
    const order = await intent(actor, { status: 'settled' });
    const proof = await receipt(order, access === 'upcoming'
      ? { start: new Date(now.getTime() + 86_400_000), end: future }
      : { start: new Date(now.getTime() - 30 * 86_400_000), end: past });
    await grant(proof);
    const result = await history(actor);
    assert.equal(result.payments.items[0].access, access);
    assert.equal(result.subscription.state, 'none');
    checks++;
  }

  const renewal = await owner();
  const recurring = await intent(renewal, { status: 'settled', amount: '15.00000000' });
  const oldProof = await receipt(recurring, { amount: '15.00000000',
    start: new Date(now.getTime() - 60 * 86_400_000), end: past });
  await grant(oldProof);
  await reversal(oldProof, 'subscription.period_refunded');
  const newProof = await receipt(recurring, { amount: '19.12345678' });
  await grant(newProof);
  const renewed = await history(renewal);
  assert.equal(renewed.orders.items.length, 1);
  assert.equal(renewed.payments.items.length, 2, 'Each invoice remains a separate historical payment');
  assert.equal(renewed.payments.items.find((item) => item.id === oldProof.id)?.status, 'refunded');
  assert.equal(renewed.payments.items.find((item) => item.id === oldProof.id)?.access, 'revoked');
  assert.equal(renewed.payments.items.find((item) => item.id === newProof.id)?.amountDecimal, '19.12345678');
  assert.equal(renewed.subscription.state, 'active', 'An old refund cannot erase a later valid paid period');
  checks++;

  const dispute = await owner();
  const disputedOrder = await intent(dispute, { status: 'settled' });
  const disputedProof = await receipt(disputedOrder);
  await grant(disputedProof);
  await reversal(disputedProof, 'subscription.period_disputed');
  const disputed = await history(dispute);
  assert.equal(disputed.payments.items[0].status, 'disputed');
  assert.equal(disputed.payments.items[0].access, 'revoked');
  assert.equal(disputed.subscription.state, 'none');
  checks++;

  const queuedReversal = await owner();
  const queuedOrder = await intent(queuedReversal, { status: 'settled' });
  const queuedProof = await receipt(queuedOrder);
  await grant(queuedProof);
  const pendingEvent = randomUUID();
  eventIds.push(pendingEvent);
  await client`INSERT INTO payment_inbox (event_id, event_type, center_order_id, external_order_id,
    website_id, body_sha256, status) VALUES (${pendingEvent}, 'subscription.period_disputed',
      ${queuedOrder.centerOrderId}, ${queuedOrder.externalOrderId}, ${websiteId}, ${'0'.repeat(64)}, 'manual_review')`;
  const queued = await history(queuedReversal);
  assert.equal(queued.payments.items[0].status, 'settled', 'An unverified queued dispute cannot be reported as a completed reversal');
  assert.equal(queued.subscription.state, 'active');
  checks++;

  for (const bad of ['missing', 'product', 'method', 'provider', 'period', 'organization'] as const) {
    const actor = await owner();
    const order = await intent(actor, { status: 'settled' });
    const proof = await receipt(order);
    if (bad !== 'missing') await grant(proof, {
      ...(bad === 'product' ? { product: 'other-plan' } : {}),
      ...(bad === 'method' ? { method: 'manual' as const } : {}),
      ...(bad === 'provider' ? { providerSubscriptionId: 'wrong-provider-binding' } : {}),
      ...(bad === 'period' ? { end: new Date(future.getTime() + 86_400_000) } : {}),
      ...(bad === 'organization' ? { organizationId: empty.organizationId } : {}),
    });
    const result = await history(actor);
    assert.equal(result.payments.items[0].access, 'review', `A ${bad} grant cannot establish access`);
    assert.equal(result.subscription.state, 'none');
    checks++;
  }

  for (const bad of ['account', 'payer', 'organization', 'order', 'currency', 'website'] as const) {
    const actor = await owner();
    const order = await intent(actor, { status: 'settled',
      ...(bad === 'account' ? { accountId: empty.accountId } : {}),
      ...(bad === 'payer' ? { payerUserId: empty.userId } : {}),
    });
    const proof = await receipt(order, {
      ...(bad === 'organization' ? { organizationId: empty.organizationId } : {}),
      ...(bad === 'order' ? { centerOrderId: 'wrong-order-binding' } : {}),
      ...(bad === 'currency' ? { currency: 'USDT' } : {}),
      ...(bad === 'website' ? { websiteId: randomUUID() } : {}),
    });
    await grant(proof);
    const result = await history(actor);
    assert.equal(result.payments.items.length, 0, `A ${bad} mismatch cannot be exposed as the user's verified payment`);
    assert.equal(result.subscription.state, 'none');
    if (bad === 'account' || bad === 'payer') assert.equal(result.orders.items.length, 0);
    else assert.equal(result.orders.items[0].hasVerifiedPayment, false);
    checks++;
  }

  const lostOwner = await owner();
  const lostOrder = await intent(lostOwner, { status: 'settled' });
  await grant(await receipt(lostOrder));
  await client`UPDATE billing_accounts SET original_payer_user_id = ${empty.userId} WHERE id = ${lostOwner.accountId}`;
  await assert.rejects(history(lostOwner), BillingAccessError, 'A transferred billing identity must not expose another original payer history');
  await client`UPDATE billing_accounts SET original_payer_user_id = ${lostOwner.userId} WHERE id = ${lostOwner.accountId}`;
  await client`UPDATE member SET role = 'member' WHERE user_id = ${lostOwner.userId} AND organization_id = ${lostOwner.organizationId}`;
  await assert.rejects(history(lostOwner), BillingAccessError, 'A non-owner member cannot read personal billing');
  checks++;

  const paginated = await owner();
  const pageIds: string[] = [];
  const paymentPageIds: string[] = [];
  for (let index = 1; index <= 7; index++) {
    const order = await intent(paginated, { status: 'settled', createdAt: `2026-10-04T12:00:00.12300${index}` });
    pageIds.push(order.id);
    const proof = await receipt(order, { settledAt: `2026-10-04T12:00:00.12300${index}Z` });
    paymentPageIds.push(proof.id);
    await grant(proof);
  }
  const seenOrders: string[] = [];
  const seenPayments: string[] = [];
  for (const section of ['orders', 'payments'] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await history(paginated, { section, cursor, limit: 2 });
      assert.equal(result[section === 'orders' ? 'payments' : 'orders'].items.length, 0);
      (section === 'orders' ? seenOrders : seenPayments).push(...result[section].items.map((item) => item.id));
      const next = result[section].nextCursor;
      if (!next) break;
      cursor = next;
    }
  }
  assert.deepEqual(new Set(seenOrders), new Set(pageIds));
  assert.equal(seenOrders.length, pageIds.length, 'Orders sharing millisecond DTO timestamps are neither duplicated nor omitted');
  assert.deepEqual(new Set(seenPayments), new Set(paymentPageIds));
  assert.equal(seenPayments.length, paymentPageIds.length);
  const firstPage = await history(paginated, { section: 'orders', limit: 2 });
  assert.ok(firstPage.orders.nextCursor);
  await assert.rejects(history(empty, { section: 'orders', cursor: firstPage.orders.nextCursor }), BillingHistoryCursorError,
    'A foreign cursor must not locate another account history anchor');
  await assert.rejects(history(paginated, { section: 'payments', cursor: firstPage.orders.nextCursor }), BillingHistoryCursorError);
  await assert.rejects(history(paginated, { section: 'orders', cursor: 'not-base64-json' }), BillingHistoryCursorError);
  checks++;

  assert.equal(networkCalls, 0);
  console.log(`Local billing history passed (${checks} fixture groups): four methods, exact currencies/amounts, verified access, payment states, refund/dispute periods, binding failures, private DTO, microsecond pagination and owner isolation. Feature-off history remains readable; no provider requests were sent.`);
} finally {
  globalThis.fetch = originalFetch;
  if (evidenceIds.length) {
    await client`DELETE FROM subscription_grants WHERE evidence_id IN ${client(evidenceIds)}`;
    await client`DELETE FROM payment_evidence WHERE id IN ${client(evidenceIds)}`;
  }
  if (intentIds.length) await client`DELETE FROM payment_intents WHERE id IN ${client(intentIds)}`;
  if (eventIds.length) await client`DELETE FROM payment_inbox WHERE event_id IN ${client(eventIds)}`;
  for (const actor of owners) {
    await client`DELETE FROM subscriptions WHERE organization_id = ${actor.organizationId}`;
    await client`DELETE FROM billing_accounts WHERE id = ${actor.accountId}`;
    await client`DELETE FROM organization WHERE id = ${actor.organizationId}`;
    await client`DELETE FROM "user" WHERE id = ${actor.userId}`;
  }
  await client.end({ timeout: 5 });
}
