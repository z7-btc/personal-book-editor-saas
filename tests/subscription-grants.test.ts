import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * AC14/AC15 — one base subscription per workspace, one reversible grant per
 * settled period, and provider switching that fails closed.
 *
 * Everything here runs against a real, isolated PostgreSQL database (one clone
 * per test file, see tests/support/database.ts). No network is stubbed: the
 * Payment Center order is a signed-in-lifecycle value that the worker fetches
 * under a row lock, and `lib/subscription/service.ts` is the only writer of
 * grants/evidence, so the assertions read the real rows back.
 */
const siteId = '00000000-0000-4000-8000-000000000001';
// Settlement is the Payment Center's; with the capability off nothing fulfils
// the period, so the cancellation these tests assert is never reached.
process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_WEBSITE_ID = siteId;

const DAY = 86_400;
const nowSeconds = Math.floor(Date.now() / 1000);
const periodOneStart = nowSeconds - 2 * DAY;
const periodOneEnd = periodOneStart + 30 * DAY;
const periodTwoStart = periodOneEnd;
const periodTwoEnd = periodTwoStart + 30 * DAY;
/** Service clock inside the second period, so a later settlement is not "in the future". */
const periodTwoNow = new Date((periodTwoStart + 60) * 1000);

const scope: { userIds: string[]; organizationIds: string[]; intentIds: string[] } = {
  userIds: [],
  organizationIds: [],
  intentIds: [],
};

type CenterOrder = import('@/lib/payment-center/orders').CenterOrder;
type PaymentMethod =
  'stripe' | 'manual' | 'blockchain' | 'commission_balance' | 'binance_pay';

type Workspace = {
  userId: string;
  organizationId: string;
  billingAccountId: string;
  suffix: string;
};

type IntentRow = {
  id: string;
  organization_id: string;
  billing_account_id: string;
  payer_user_id: string;
  product_code: string;
  price_interval: string;
  amount_decimal: string;
  currency: string;
  method: PaymentMethod;
  external_order_id: string;
  idempotency_key: string;
};

let fixtures: typeof import('./support/fixtures');
let service: typeof import('@/lib/subscription/service');
let client: Sql;

beforeAll(async () => {
  fixtures = await import('./support/fixtures');
  client = await fixtures.getClient();
  service = await import('@/lib/subscription/service');
});

afterAll(async () => {
  await fixtures.cleanupFixtures(scope);
  await fixtures.closeClient();
});

async function seedWorkspace(): Promise<Workspace> {
  const user = await fixtures.createUserFixture();
  scope.userIds.push(user.userId);
  const organization = await fixtures.createOrganizationFixture({ userId: user.userId });
  scope.organizationIds.push(organization.organizationId);
  const billingAccountId = `vitest-ba-${user.suffix}`;
  await client`INSERT INTO billing_accounts
      (id, organization_id, external_billing_id, original_payer_user_id)
    VALUES (${billingAccountId}, ${organization.organizationId}, ${billingAccountId}, ${user.userId})`;
  return {
    userId: user.userId,
    organizationId: organization.organizationId,
    billingAccountId,
    suffix: user.suffix,
  };
}

async function seedIntent(
  workspace: Workspace,
  tag: string,
  options: { method: PaymentMethod; interval: string; amount?: string; productCode?: string },
): Promise<string> {
  const intentId = fixtures.scopedId('intent', `${workspace.suffix}-${tag}`);
  await client`INSERT INTO payment_intents
      (id, organization_id, billing_account_id, payer_user_id, request_key, product_code,
       price_interval, amount_decimal, currency, method, payment_action, status,
       external_order_id, idempotency_key)
    VALUES (${intentId}, ${workspace.organizationId}, ${workspace.billingAccountId},
      ${workspace.userId}, ${randomUUID()}, ${options.productCode ?? 'pro'},
      ${options.interval}, ${options.amount ?? '15.00000000'}, 'USD', ${options.method},
      CASE ${options.method} WHEN 'stripe' THEN 'redirect'
        WHEN 'commission_balance' THEN 'commission_reserved'
        WHEN 'blockchain' THEN 'blockchain' WHEN 'binance_pay' THEN 'binance_pay'
        ELSE 'manual' END,
      'pending', ${intentId}, ${intentId})`;
  scope.intentIds.push(intentId);
  return intentId;
}

async function loadIntent(intentId: string): Promise<IntentRow> {
  const [row] = await client<IntentRow[]>`SELECT id, organization_id, billing_account_id,
      payer_user_id, product_code, price_interval, amount_decimal, currency, method,
      external_order_id, idempotency_key
    FROM payment_intents WHERE id = ${intentId}`;
  if (!row) throw new Error(`intent fixture ${intentId} is missing`);
  return row;
}

/** The order the Payment Center would have stored for this intent. */
function centerOrder(intent: IntentRow, overrides: Partial<CenterOrder> = {}): CenterOrder {
  const prepaid = intent.method !== 'stripe';
  return {
    id: `center_${intent.id}`,
    website_id: siteId,
    external_order_id: intent.external_order_id,
    idempotency_key: intent.idempotency_key,
    payer_external_user_id: intent.payer_user_id,
    billing_account_id: intent.billing_account_id,
    payment_method: intent.method,
    kind: prepaid ? 'one_time' : 'subscription',
    status: 'paid',
    amount_decimal: intent.amount_decimal,
    currency: intent.currency,
    product_code: intent.product_code,
    recurrence_interval: intent.price_interval,
    metadata: {
      organizationId: intent.organization_id,
      billingAccountId: intent.billing_account_id,
      payerUserId: intent.payer_user_id,
      intentId: intent.id,
    },
    ...(prepaid
      ? { provider_payment_id: `vitest-pay-${intent.id}` }
      : { provider_subscription_id: `sub_${intent.id}` }),
    ...(intent.method === 'commission_balance'
      ? { payment_details: { commission_flow: 'two_phase' } }
      : {}),
    ...overrides,
  } as CenterOrder;
}

/** A pending inbox row, exactly what the webhook inserts before it processes. */
async function seedInbox(eventId: string, order: CenterOrder) {
  await client`INSERT INTO payment_inbox
      (event_id, event_type, center_order_id, external_order_id, website_id, body_sha256, status)
    VALUES (${eventId}, 'subscription.period_paid', ${order.id}, ${order.external_order_id},
      ${siteId}, ${'0'.repeat(64)}, 'pending')`;
}

function settledPeriod(intent: IntentRow, start: number, options: {
  invoice: string;
  eventId?: string;
  amountDecimal?: string;
  servicePeriodEnd?: number;
}) {
  return {
    sourceEventId: options.eventId ?? randomUUID(),
    intentId: intent.id,
    providerInvoiceId: options.invoice,
    providerSubscriptionId: `sub_${intent.id}`,
    providerPaymentId: null,
    amountDecimal: options.amountDecimal ?? intent.amount_decimal,
    currency: intent.currency,
    settledAt: start,
    servicePeriodStart: start,
    servicePeriodEnd: options.servicePeriodEnd ?? start + 30 * DAY,
  };
}

function prepaidPeriod(intent: IntentRow, start: number, options: { eventId?: string } = {}) {
  return {
    sourceEventId: options.eventId ?? randomUUID(),
    intentId: intent.id,
    providerPaymentId: `vitest-pay-${intent.id}`,
    amountDecimal: intent.amount_decimal,
    currency: intent.currency,
    settledAt: start,
    servicePeriodStart: start,
    servicePeriodEnd: start + 30 * DAY,
    method: intent.method as 'manual' | 'blockchain' | 'commission_balance',
    interval: intent.price_interval as 'one_time' | 'month' | 'year',
  };
}

async function rowCounts(organizationId: string) {
  const [row] = await client<{ grants: number; evidence: number; subscriptions: number }[]>`
    SELECT (SELECT COUNT(*)::integer FROM subscription_grants
              WHERE organization_id = ${organizationId}) AS grants,
           (SELECT COUNT(*)::integer FROM payment_evidence
              WHERE organization_id = ${organizationId}) AS evidence,
           (SELECT COUNT(*)::integer FROM subscriptions
              WHERE organization_id = ${organizationId}) AS subscriptions`;
  return row!;
}

async function servicePeriod(intentId: string) {
  const [row] = await client<{
    status: string; payment_center_order_id: string | null; last_error_code: string | null;
  }[]>`SELECT status::text, payment_center_order_id, last_error_code
    FROM payment_intents WHERE id = ${intentId}`;
  return row!;
}

async function inboxStatus(eventId: string) {
  const [row] = await client<{ status: string }[]>`
    SELECT status::text FROM payment_inbox WHERE event_id = ${eventId}`;
  return row?.status;
}

async function subscription(organizationId: string) {
  const [row] = await client<{
    status: string; product_code: string | null; payment_method: string | null;
    active_until: Date | null; version: number;
  }[]>`SELECT status::text, product_code, payment_method, active_until, version
    FROM subscriptions WHERE organization_id = ${organizationId}`;
  return row!;
}

describe('one base subscription per workspace (AC14)', () => {
  it('grants the first settled invoice once and opens the aggregate row', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'first', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    const eventId = randomUUID();
    await seedInbox(eventId, order);

    const result = await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-FIRST', eventId }),
      order,
      new Date(nowSeconds * 1000),
    );

    expect(result.duplicate).toBe(false);
    expect(result.status).toBe('settled');
    expect(result.subscription?.status).toBe('active');
    expect(result.subscription?.version).toBe(1);
    expect(result.subscription?.activeUntil?.getTime()).toBe(periodOneEnd * 1000);
    expect(await rowCounts(workspace.organizationId)).toEqual({
      grants: 1, evidence: 1, subscriptions: 1,
    });
    const saved = await servicePeriod(intentId);
    expect(saved.status).toBe('settled');
    expect(saved.payment_center_order_id).toBe(order.id);
    expect(await inboxStatus(eventId)).toBe('processed');
  });

  it('keeps one base subscription row across two paid periods', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'two', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-ONE' }),
      order,
      new Date(nowSeconds * 1000),
    );
    const renewal = await service.fulfillSubscription(
      settledPeriod(intent, periodTwoStart, { invoice: 'INV-TWO' }),
      order,
      periodTwoNow,
    );

    expect(renewal.subscription?.activeUntil?.getTime()).toBe(periodTwoEnd * 1000);
    const counts = await rowCounts(workspace.organizationId);
    expect(counts.grants).toBe(2);
    expect(counts.subscriptions).toBe(1);
  });

  it('continues a running subscription when a fresh Stripe purchase arrives', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'cont-first', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-CONT-1' }),
      centerOrder(intent),
      new Date(nowSeconds * 1000),
    );

    // A buyer paying again from the pricing page: Payment Center opens a brand
    // new subscription whose period starts at the payment moment, i.e. inside
    // the period already granted.
    const secondId = await seedIntent(workspace, 'cont-second', { method: 'stripe', interval: 'month' });
    const second = await loadIntent(secondId);
    const continued = await service.fulfillSubscription(
      settledPeriod(second, nowSeconds, { invoice: 'INV-CONT-2' }),
      centerOrder(second),
      new Date(nowSeconds * 1000),
    );

    // It no longer collides: it is stitched onto the end of the running period.
    // The aggregate reports the *latest* unexpired period end — a buyer who paid
    // twice sees the extra month immediately, not a "current period" that looks
    // unchanged.
    expect(continued.subscription?.activeUntil?.getTime()).toBe(periodTwoEnd * 1000);
    const [grant] = await client<{ period_start: string; period_end: string }[]>`
      SELECT period_start::text, period_end::text FROM subscription_grants
      WHERE organization_id = ${workspace.organizationId} AND provider_subscription_id = ${`sub_${secondId}`}`;
    expect(Math.floor(new Date(grant!.period_start).getTime() / 1000)).toBe(periodOneEnd);
    expect(Math.floor(new Date(grant!.period_end).getTime() / 1000)).toBe(periodTwoEnd);
    // The evidence carries the same shifted span, so billing history still joins.
    const [evidence] = await client<{ service_period_start: string }[]>`
      SELECT service_period_start::text FROM payment_evidence
      WHERE organization_id = ${workspace.organizationId} AND provider_subscription_id = ${`sub_${secondId}`}`;
    expect(Math.floor(new Date(evidence!.service_period_start).getTime() / 1000)).toBe(periodOneEnd);
    // Once the first period elapses, the continuation takes over.
    const [flipped] = await client<{ status: string; active_until: string }[]>`
      SELECT status, active_until::text FROM subscriptions
      WHERE organization_id = ${workspace.organizationId}`;
    await service.refreshWorkspaceSubscription(workspace.organizationId, periodTwoNow);
    const [after] = await client<{ active_until: string }[]>`
      SELECT active_until::text FROM subscriptions
      WHERE organization_id = ${workspace.organizationId}`;
    expect(flipped!.status).toBe('active');
    expect(Math.floor(new Date(after!.active_until).getTime() / 1000)).toBe(periodTwoEnd);
  });

  it('lets a Stripe purchase switch plans while access is still running', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'switch-first', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-SW-1' }),
      centerOrder(intent),
      new Date(nowSeconds * 1000),
    );

    const upgradeId = await seedIntent(workspace, 'switch-second', {
      method: 'stripe', interval: 'month', productCode: 'premium', amount: '45.00000000',
    });
    const upgrade = await loadIntent(upgradeId);
    await service.fulfillSubscription(
      settledPeriod(upgrade, nowSeconds, { invoice: 'INV-SW-2' }),
      centerOrder(upgrade),
      new Date(nowSeconds * 1000),
    );

    // The new plan's grant is stitched onto the running access, not overlapping
    // it: it starts at the first period's end and runs a full month.
    const [grant] = await client<{ product_code: string; period_start: string; period_end: string }[]>`
      SELECT product_code, period_start::text, period_end::text FROM subscription_grants
      WHERE organization_id = ${workspace.organizationId} AND product_code = 'premium'`;
    expect(Math.floor(new Date(grant!.period_start).getTime() / 1000)).toBe(periodOneEnd);
    expect(Math.floor(new Date(grant!.period_end).getTime() / 1000)).toBe(periodTwoEnd);
    // The aggregate flips to the new plan once the first period elapses.
    await service.refreshWorkspaceSubscription(workspace.organizationId, periodTwoNow);
    const [after] = await client<{ product_code: string; active_until: string }[]>`
      SELECT product_code, active_until::text FROM subscriptions
      WHERE organization_id = ${workspace.organizationId}`;
    expect(after!.product_code).toBe('premium');
    expect(Math.floor(new Date(after!.active_until).getTime() / 1000)).toBe(periodTwoEnd);
  });

  it('honours a checkout-time proration when switching plans mid-subscription', async () => {
    // starter ($15/mo) has run for ~28 of its 30 days: 2 days remain. Switching
    // to premium ($45/mo) scales those 2 days by 15/45 = 0.666…, giving 1 day
    // (Math.ceil(2)=2 remain at checkout, Math.floor(2*15/45)=0 → the intent
    // would drop it; use a larger remaining window instead to keep it simple).
    // Here the first period still has ~28 days left, so the ratio is meaningful.
    const workspace = await seedWorkspace();
    const firstId = await seedIntent(workspace, 'prorate-first', { method: 'stripe', interval: 'month' });
    const first = await loadIntent(firstId);
    await service.fulfillSubscription(
      settledPeriod(first, periodOneStart, { invoice: 'INV-PR-1' }),
      centerOrder(first),
      new Date(nowSeconds * 1000),
    );

    // The upgrade is priced at checkout: the intent carries the *converted* slice
    // — how far the remaining starter days reach once scaled by 15/45 — which
    // here is 10 days measured from settlement. It is deliberately not the end of
    // the new access: the buyer is also paying for a whole premium month, and
    // fulfilment adds the centre's period and this slice together.
    const upgradeId = await seedIntent(workspace, 'prorate-second', {
      method: 'stripe', interval: 'month', productCode: 'premium', amount: '45.00000000',
    });
    await client`UPDATE payment_intents SET prorated_period_end = ${new Date((nowSeconds + 10 * DAY) * 1000).toISOString()} WHERE id = ${upgradeId}`;
    const upgrade = await loadIntent(upgradeId);
    const now = new Date(nowSeconds * 1000);
    const result = await service.fulfillSubscription(
      settledPeriod(upgrade, nowSeconds, { invoice: 'INV-PR-2' }),
      centerOrder(upgrade),
      now,
    );

    // Only the new (prorated) grant stays active; the superseded starter grant
    // is reversed rather than stacking on top of it.
    const grants = await client<{ product_code: string; status: string; period_end: string }[]>`
      SELECT product_code, status::text, period_end::text FROM subscription_grants
      WHERE organization_id = ${workspace.organizationId} ORDER BY period_start`;
    expect(grants).toHaveLength(2);
    expect(grants.map((row) => row.status)).toEqual(['reversed', 'active']);
    expect(grants[1]!.product_code).toBe('premium');
    // A full 30-day premium month the buyer just paid for, plus the 10 days their
    // starter remainder converted into. Dropping either half shortchanges them.
    expect(Math.floor(new Date(grants[1]!.period_end).getTime() / 1000)).toBe(nowSeconds + 40 * DAY);
    expect(result.subscription?.productCode).toBe('premium');
    expect(result.subscription?.activeUntil?.getTime()).toBe((nowSeconds + 40 * DAY) * 1000);
  });

  it('cancels the superseded subscription when a plan switch reverses its grant', async () => {
    const workspace = await seedWorkspace();
    const firstId = await seedIntent(workspace, 'switch-cancel-first', { method: 'stripe', interval: 'month' });
    const first = await loadIntent(firstId);
    await service.fulfillSubscription(
      settledPeriod(first, periodOneStart, { invoice: 'INV-SC-1' }),
      centerOrder(first),
      new Date(nowSeconds * 1000),
    );

    // The switch reverses the superseded grant at fulfilment, before anything
    // can cancel its subscription. The old subscription must still be found —
    // by the period it has not yet used, not by a status that no longer says
    // active — or it keeps billing in parallel with the new plan.
    const upgradeId = await seedIntent(workspace, 'switch-cancel-second', {
      method: 'stripe', interval: 'month', productCode: 'premium', amount: '45.00000000',
    });
    // `prorated_period_end` carries the converted slice's reach from settlement,
    // not the new access's end date — fulfilment adds the centre's own period.
    await client`UPDATE payment_intents SET prorated_period_end = ${new Date((nowSeconds + 10 * DAY) * 1000).toISOString()} WHERE id = ${upgradeId}`;
    const upgrade = await loadIntent(upgradeId);
    await service.fulfillSubscription(
      settledPeriod(upgrade, nowSeconds, { invoice: 'INV-SC-2' }),
      centerOrder(upgrade),
      new Date(nowSeconds * 1000),
    );

    const controls = await import('@/lib/billing/subscription-controls');
    const called: string[] = [];
    const send = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const match = /\/by-account\/([^/]+)\/([^/]+)\/auto-renew$/.exec(url.pathname);
      called.push(decodeURIComponent(match![2]!));
      return Response.json({
        status: 'success',
        data: {
          order_id: randomUUID(), website_id: siteId,
          billing_account_id: decodeURIComponent(match![1]!),
          provider_subscription_id: decodeURIComponent(match![2]!),
          status: 'active', cancel_at_period_end: true, current_period_end: periodTwoEnd,
        },
      });
    }) as typeof fetch;

    const cancelled = await controls.cancelSupersededAutoRenew(
      workspace.organizationId, `sub_${upgradeId}`, send);
    expect(cancelled).toEqual([`sub_${firstId}`]);
    expect(called).toEqual([`sub_${firstId}`]);

    // Once the superseded period has elapsed it drops out of the sweep, so a
    // long-reversed grant is never re-cancelled on every later renewal.
    const after = await controls.cancelSupersededAutoRenew(
      workspace.organizationId, `sub_${upgradeId}`, send,
      new Date((periodOneEnd + 11 * DAY) * 1000));
    expect(after).toEqual([]);
    expect(called).toEqual([`sub_${firstId}`]);
  });

  it('cancels the superseded subscription’s auto-renew, keeping the newest', async () => {
    const workspace = await seedWorkspace();
    const firstId = await seedIntent(workspace, 'supersede-first', { method: 'stripe', interval: 'month' });
    const first = await loadIntent(firstId);
    await service.fulfillSubscription(
      settledPeriod(first, periodOneStart, { invoice: 'INV-SUP-1' }),
      centerOrder(first),
      new Date(nowSeconds * 1000),
    );
    // A second, later subscription: it continues the first and becomes the keeper.
    const secondId = await seedIntent(workspace, 'supersede-second', { method: 'stripe', interval: 'month' });
    const second = await loadIntent(secondId);
    await service.fulfillSubscription(
      settledPeriod(second, nowSeconds, { invoice: 'INV-SUP-2' }),
      centerOrder(second),
      new Date(nowSeconds * 1000),
    );

    const controls = await import('@/lib/billing/subscription-controls');
    const called: { accountId: string; subscriptionId: string; enabled: boolean }[] = [];
    const send = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const match = /\/by-account\/([^/]+)\/([^/]+)\/auto-renew$/.exec(url.pathname);
      const body = JSON.parse(String(init?.body ?? '{}')) as { enabled: boolean };
      called.push({ accountId: decodeURIComponent(match![1]!), subscriptionId: decodeURIComponent(match![2]!), enabled: body.enabled });
      return Response.json({
        status: 'success',
        data: {
          order_id: randomUUID(), website_id: siteId,
          billing_account_id: decodeURIComponent(match![1]!),
          provider_subscription_id: decodeURIComponent(match![2]!),
          status: 'active', cancel_at_period_end: !body.enabled, current_period_end: periodTwoEnd,
        },
      });
    }) as typeof fetch;

    const cancelled = await controls.cancelSupersededAutoRenew(
      workspace.organizationId, `sub_${secondId}`, send);

    // Exactly the older subscription is turned off; the new one is never touched.
    expect(cancelled).toEqual([`sub_${firstId}`]);
    expect(called).toEqual([{
      accountId: workspace.billingAccountId, subscriptionId: `sub_${firstId}`, enabled: false,
    }]);
  });

  it('replays the same invoice without a second grant or a version bump', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'replay', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    const first = await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-REPLAY' }),
      order,
      new Date(nowSeconds * 1000),
    );
    const replayEvent = randomUUID();
    await seedInbox(replayEvent, order);
    const replay = await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-REPLAY', eventId: replayEvent }),
      order,
      new Date(nowSeconds * 1000),
    );

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.evidenceId).toBe(first.evidenceId);
    const counts = await rowCounts(workspace.organizationId);
    expect(counts.grants).toBe(1);
    expect(counts.evidence).toBe(1);
    expect((await subscription(workspace.organizationId)).version).toBe(1);
    expect(await inboxStatus(replayEvent)).toBe('processed');
  });

  it('serializes two concurrent fulfillments of one invoice into a single grant', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'race', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    const now = new Date(nowSeconds * 1000);

    const results = await Promise.all([
      service.fulfillSubscription(
        settledPeriod(intent, periodOneStart, { invoice: 'INV-RACE' }), order, now),
      service.fulfillSubscription(
        settledPeriod(intent, periodOneStart, { invoice: 'INV-RACE' }), order, now),
    ]);

    expect(results.filter((entry) => entry.duplicate === false)).toHaveLength(1);
    expect(results.filter((entry) => entry.duplicate === true)).toHaveLength(1);
    const counts = await rowCounts(workspace.organizationId);
    expect(counts.grants).toBe(1);
    expect(counts.evidence).toBe(1);
    expect(counts.subscriptions).toBe(1);
  });

  it('refuses to reuse one invoice key for a different period', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'reuse', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-REUSE' }),
      order,
      new Date(nowSeconds * 1000),
    );

    await expect(service.fulfillSubscription(
      settledPeriod(intent, periodTwoStart, { invoice: 'INV-REUSE' }),
      order,
      periodTwoNow,
    )).rejects.toThrow('Invoice evidence was already used differently');
    expect((await rowCounts(workspace.organizationId)).grants).toBe(1);
  });

  it('rejects drifted orders before writing any benefit', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'drift', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const now = new Date(nowSeconds * 1000);

    await expect(service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-DRIFT' }),
      centerOrder(intent, { status: 'pending' }),
      now,
    )).rejects.toThrow('Payment Center order is not paid');

    await expect(service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-DRIFT' }),
      centerOrder(intent, { amount_decimal: '99.00000000' }),
      now,
    )).rejects.toThrow('Payment Center order does not match the stored intent');

    await expect(service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-DRIFT' }),
      centerOrder(intent, { provider_subscription_id: 'sub_somebody_else' }),
      now,
    )).rejects.toThrow('Subscription evidence does not match the paid order');

    expect(await rowCounts(workspace.organizationId)).toEqual({
      grants: 0, evidence: 0, subscriptions: 0,
    });
  });

  it('refreshes only the aggregates that drifted, then reports nothing due', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'refresh', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-REFRESH' }),
      order,
      new Date(nowSeconds * 1000),
    );

    const afterExpiry = new Date((periodOneEnd + DAY) * 1000);
    expect(await service.refreshDueSubscriptions(100, afterExpiry)).toBeGreaterThanOrEqual(1);
    const refreshed = await subscription(workspace.organizationId);
    expect(refreshed.status).toBe('inactive');
    expect(refreshed.version).toBe(2);
    expect(await service.refreshDueSubscriptions(100, afterExpiry)).toBe(0);
  });
});

describe('reversible period grants (AC15)', () => {
  it('reverses only the refunded period and keeps the later renewal', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'refund', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-R1' }),
      order,
      new Date(nowSeconds * 1000),
    );
    await service.fulfillSubscription(
      settledPeriod(intent, periodTwoStart, { invoice: 'INV-R2' }),
      order,
      periodTwoNow,
    );

    const reversalId = randomUUID();
    await client`INSERT INTO payment_inbox
        (event_id, event_type, center_order_id, external_order_id, website_id, body_sha256, status)
      VALUES (${reversalId}, 'payment.refunded', ${order.id}, ${order.external_order_id},
        ${siteId}, ${'1'.repeat(64)}, 'pending')`;
    const result = await service.reverseSubscriptionGrant(
      siteId,
      'invoice:INV-R1',
      reversalId,
      periodTwoNow,
    );

    expect(result.duplicate).toBe(false);
    // Only the second period is still covered, so the aggregate stays active.
    expect(result.subscription?.status).toBe('active');
    expect(result.subscription?.activeUntil?.getTime()).toBe(periodTwoEnd * 1000);
    const grants = await client<{ status: string; period_start: Date }[]>`
      SELECT status::text, period_start FROM subscription_grants
      WHERE organization_id = ${workspace.organizationId} ORDER BY period_start`;
    expect(grants.map((row) => row.status)).toEqual(['reversed', 'active']);
    expect(await inboxStatus(reversalId)).toBe('processed');

    // A redelivery carries the same event id, so the same inbox row is reused.
    const replay = await service.reverseSubscriptionGrant(
      siteId, 'invoice:INV-R1', reversalId, periodTwoNow);
    expect(replay.duplicate).toBe(true);
    expect(await inboxStatus(reversalId)).toBe('processed');
    const [inboxRows] = await client<{ count: number }[]>`
      SELECT COUNT(*)::integer AS count FROM payment_inbox
      WHERE center_order_id = ${order.id} AND event_type = 'payment.refunded'`;
    expect(inboxRows!.count).toBe(1);

    await expect(service.reverseSubscriptionGrant(
      siteId, 'invoice:INV-R1', randomUUID(), periodTwoNow,
    )).rejects.toThrow('Payment was reversed by a different event');
  });

  it('marks the aggregate inactive when the only paid period is reversed', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'refund-only', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-ONLY' }),
      order,
      new Date(nowSeconds * 1000),
    );
    const result = await service.reverseSubscriptionGrant(
      siteId, 'invoice:INV-ONLY', randomUUID(), new Date(nowSeconds * 1000 + 1));

    expect(result.subscription?.status).toBe('inactive');
    expect(result.subscription?.activeUntil).toBeNull();
  });

  it('refuses a refund whose amount does not match the original period', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'refund-guard', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    await service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-GUARD' }),
      order,
      new Date(nowSeconds * 1000),
    );

    await expect(service.reverseSubscriptionGrant(
      siteId, 'invoice:INV-GUARD', randomUUID(), new Date(nowSeconds * 1000 + 1), {
        intentId,
        centerOrderId: order.id,
        providerPaymentId: 'pay_other',
        amountDecimal: intent.amount_decimal,
        currency: intent.currency,
      },
    )).rejects.toThrow('Refund does not match the original invoice payment');
    await expect(service.reverseSubscriptionGrant(
      siteId, 'invoice:missing', randomUUID(), new Date(nowSeconds * 1000 + 1),
    )).rejects.toThrow('Original payment evidence is missing');
    await expect(service.reverseSubscriptionGrant(
      siteId, 'invoice:INV-GUARD', 'not-a-uuid', new Date(nowSeconds * 1000 + 1),
    )).rejects.toThrow('Reversal event ID is invalid');
  });
});

describe('prepaid channels and provider switching (AC14)', () => {
  it('appends a prepaid renewal for the same plan', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'prepaid', { method: 'manual', interval: 'month' });
    const intent = await loadIntent(intentId);
    const first = await service.fulfillSubscription(
      prepaidPeriod(intent, periodOneStart), centerOrder(intent), new Date(nowSeconds * 1000));

    // Each prepaid purchase is its own Payment Center order and intent: the
    // settled intent pins the order that paid for it.
    const renewalIntentId = await seedIntent(workspace, 'prepaid-renewal', {
      method: 'manual', interval: 'month',
    });
    const renewalIntent = await loadIntent(renewalIntentId);
    const renewal = await service.fulfillSubscription(
      prepaidPeriod(renewalIntent, periodTwoStart), centerOrder(renewalIntent), periodTwoNow);

    expect(first.subscription?.paymentMethod).toBe('manual');
    expect(renewal.subscription?.activeUntil?.getTime()).toBe(periodTwoEnd * 1000);
    expect((await rowCounts(workspace.organizationId)).grants).toBe(2);
  });

  it('stitches a prepaid purchase made inside a running period onto its end', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'overlap', { method: 'manual', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    await service.fulfillSubscription(
      prepaidPeriod(intent, periodOneStart), order, new Date(nowSeconds * 1000));

    // A second month bought while the first is still running. The centre derives
    // every prepaid span from the moment of payment, so it begins inside the
    // period already granted; it is moved to start where that one ends rather
    // than refused — or worse, granted on top of it.
    const secondIntentId = await seedIntent(workspace, 'overlap-second', {
      method: 'manual', interval: 'month',
    });
    const secondIntent = await loadIntent(secondIntentId);
    const second = await service.fulfillSubscription(
      prepaidPeriod(secondIntent, periodOneStart + 10 * DAY), centerOrder(secondIntent),
      new Date((periodOneStart + 10 * DAY + 60) * 1000),
    );
    expect(second.subscription?.activeUntil?.getTime()).toBe((periodOneStart + 60 * DAY) * 1000);
    // Same plan: whatever subscription is paying for it keeps renewing by design,
    // so the caller must not cancel anything.
    expect(second.planSwitched).toBe(false);

    // One prepaid order can never be stretched over a second period.
    await expect(service.fulfillSubscription(
      prepaidPeriod(intent, periodTwoStart), order, periodTwoNow,
    )).rejects.toThrow('Invoice evidence was already used differently');
    expect((await rowCounts(workspace.organizationId)).grants).toBe(2);
  });

  it('grants a Binance Pay period settled in the chosen asset', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'binance-pay', {
      method: 'binance_pay', interval: 'month',
    });
    const intent = await loadIntent(intentId);

    // The catalogue quote is USD; the buyer pays the unique USDT amount the
    // centre allocated (a few ten-thousandths above the quote).
    const granted = await service.fulfillSubscription({
      sourceEventId: randomUUID(),
      intentId: intent.id,
      providerPaymentId: 'binance-order-123',
      amountDecimal: '15.00370000',
      currency: 'USDT',
      settledAt: periodOneStart,
      servicePeriodStart: periodOneStart,
      servicePeriodEnd: periodOneEnd,
      method: 'binance_pay',
      interval: 'month',
    }, centerOrder(intent, {
      currency: 'USDT',
      provider_payment_id: 'binance-order-123',
      payment_details: {
        paid_amount_decimal: '15.00370000',
        paid_currency: 'USDT',
      },
    }), new Date(periodOneStart * 1000));

    expect(granted.subscription?.paymentMethod).toBe('binance_pay');
    const [evidence] = await client<{ amount_decimal: string; currency: string }[]>`
      SELECT amount_decimal, currency FROM payment_evidence
      WHERE intent_id = ${intent.id}`;
    expect(evidence).toEqual({ amount_decimal: '15.00370000', currency: 'USDT' });
  });

  it('converts a prepaid plan switch and reports it as one', async () => {
    const workspace = await seedWorkspace();
    const starterId = await seedIntent(workspace, 'switch-prepaid-first', {
      method: 'manual', interval: 'month',
    });
    const starter = await loadIntent(starterId);
    await service.fulfillSubscription(
      prepaidPeriod(starter, periodOneStart), centerOrder(starter),
      new Date(nowSeconds * 1000));

    // Leaving the plan by paying through a different prepaid channel. Checkout has
    // already converted the unused time — 10 days, here — and the new grant adds
    // it to the whole month the centre just sold them.
    const proId = await seedIntent(workspace, 'switch-prepaid-second', {
      method: 'blockchain', interval: 'month', productCode: 'premium',
      amount: '45.00000000',
    });
    await client`UPDATE payment_intents
      SET prorated_period_end = ${new Date((nowSeconds + 10 * DAY) * 1000).toISOString()}
      WHERE id = ${proId}`;
    const pro = await loadIntent(proId);
    const switched = await service.fulfillSubscription(
      prepaidPeriod(pro, nowSeconds),
      centerOrder(pro, { payment_details: { confirmed_amount_decimal: pro.amount_decimal } }),
      new Date(nowSeconds * 1000));

    // This is the signal the worker cancels the old subscription on: it pays for
    // a plan the workspace has just left.
    expect(switched.planSwitched).toBe(true);
    const grants = await client<{ product_code: string; status: string; period_end: string }[]>`
      SELECT product_code, status::text, period_end::text FROM subscription_grants
      WHERE organization_id = ${workspace.organizationId} ORDER BY period_start`;
    expect(grants.map((row) => row.status)).toEqual(['reversed', 'active']);
    expect(grants[1]!.product_code).toBe('premium');
    expect(Math.floor(new Date(grants[1]!.period_end).getTime() / 1000))
      .toBe(nowSeconds + 40 * DAY);
    expect(switched.subscription?.paymentMethod).toBe('blockchain');
  });

  it('gives each provider its own period when two channels race', async () => {
    const workspace = await seedWorkspace();
    const stripeIntentId = await seedIntent(workspace, 'switch-stripe', {
      method: 'stripe', interval: 'month',
    });
    const manualIntentId = await seedIntent(workspace, 'switch-manual', {
      method: 'manual', interval: 'month',
    });
    const stripeIntent = await loadIntent(stripeIntentId);
    const manualIntent = await loadIntent(manualIntentId);
    const now = new Date(nowSeconds * 1000);

    const results = await Promise.allSettled([
      service.fulfillSubscription(
        settledPeriod(stripeIntent, periodOneStart, { invoice: 'INV-SWITCH' }),
        centerOrder(stripeIntent), now),
      service.fulfillSubscription(
        prepaidPeriod(manualIntent, periodOneStart), centerOrder(manualIntent), now),
    ]);

    // Both are paid for, so both are honoured. The workspace lock serialises
    // them, and whichever lands second is stitched onto the first rather than
    // overlapping it — two months bought, two months granted.
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(2);
    const grants = await client<{ period_start: string; period_end: string }[]>`
      SELECT period_start::text, period_end::text FROM subscription_grants
      WHERE organization_id = ${workspace.organizationId} ORDER BY period_start`;
    expect(grants).toHaveLength(2);
    const start = (row: { period_start: string }) =>
      Math.floor(new Date(row.period_start).getTime() / 1000);
    const end = (row: { period_end: string }) =>
      Math.floor(new Date(row.period_end).getTime() / 1000);
    expect(start(grants[1]!)).toBe(end(grants[0]!));
    expect(end(grants[1]!)).toBe(periodOneStart + 60 * DAY);
  });

  it('refuses a commission grant that was never prepared', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'commission', {
      method: 'commission_balance', interval: 'month',
    });
    const intent = await loadIntent(intentId);
    await expect(service.fulfillSubscription(
      prepaidPeriod(intent, periodOneStart), centerOrder(intent), new Date(nowSeconds * 1000),
    )).rejects.toThrow('Commission grant was not prepared before payment');
    expect((await rowCounts(workspace.organizationId)).grants).toBe(0);
  });

  it('rejects an expired service period and a future settlement', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'window', { method: 'stripe', interval: 'month' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    const now = new Date(nowSeconds * 1000);

    await expect(service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-W1', servicePeriodEnd: periodOneStart }),
      order, now,
    )).rejects.toThrow('Service period is invalid');
    await expect(service.fulfillSubscription(
      settledPeriod(intent, periodOneStart, { invoice: 'INV-W2', servicePeriodEnd: periodOneStart + 400 * DAY }),
      order, now,
    )).rejects.toThrow('Service period is invalid');
    await expect(service.fulfillSubscription(
      { ...settledPeriod(intent, periodOneStart, { invoice: 'INV-W3' }), settledAt: nowSeconds + 3_600 },
      order, now,
    )).rejects.toThrow('Settlement time is in the future');
  });
});

describe('buyout purchases (one_time)', () => {
  // The Payment Center stamps year 9999 as the end of a buyout period; that is
  // how a permanent grant travels through a contract made of timestamps.
  const PERMANENT_END = 253402300799;

  it('grants a settled buyout as a period that never lapses', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'buyout', { method: 'manual', interval: 'one_time' });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);
    const eventId = randomUUID();
    await seedInbox(eventId, order);

    const result = await service.fulfillSubscription({
      ...prepaidPeriod(intent, periodOneStart, { eventId }),
      interval: 'one_time',
      servicePeriodEnd: PERMANENT_END,
    }, order, new Date(nowSeconds * 1000));

    expect(result.duplicate).toBe(false);
    expect(result.status).toBe('settled');
    const [grant] = await client<{ period_end: string }[]>`
      SELECT period_end::text FROM subscription_grants
      WHERE organization_id = ${workspace.organizationId}`;
    expect(Math.floor(new Date(grant!.period_end).getTime() / 1000)).toBe(PERMANENT_END);
    expect(result.subscription?.activeUntil?.getTime()).toBe(PERMANENT_END * 1000);
  });

  it('refuses a one-time order whose period is not permanent', async () => {
    // A centre bug selling a month as a buyout must not become a grant.
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'buyout-short', {
      method: 'manual', interval: 'one_time',
    });
    const intent = await loadIntent(intentId);
    await expect(service.fulfillSubscription({
      ...prepaidPeriod(intent, periodOneStart),
      interval: 'one_time',
    }, centerOrder(intent), new Date(nowSeconds * 1000)))
      .rejects.toThrow('Service period is invalid');
    expect((await rowCounts(workspace.organizationId)).grants).toBe(0);
  });
});
