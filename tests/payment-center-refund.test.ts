/**
 * Plan AC 15 / AC 19 — Payment Center → SaaS reversal contract.
 *
 * AC 15: every settled payment / invoice creates its own reversible grant, and a
 * historical refund or dispute reverses ONLY the period it belongs to, never the
 * later valid renewal.
 * AC 19: Stripe first payment, renewal, zero amount, failure, cancellation,
 * partial refund, full refund and dispute are handled per period payment ID and
 * billing period.
 *
 * Only the Payment Center HTTP boundary is mocked: every call the SaaS makes is
 * answered by an INJECTED `send` stub, so no request leaves the machine, while
 * every write under test is a real row in the test PostgreSQL database
 * (`payment_evidence`, `subscription_grants`, `subscriptions`, `payment_inbox`).
 */
process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL ||= 'http://127.0.0.1:5000';
process.env.PAYMENT_CENTER_API_KEY ||= 'vitest-payment-center-api-key';
process.env.PAYMENT_CENTER_SITE_CODE ||= 'sf118b3fa313264a';
process.env.PAYMENT_CENTER_WEBSITE_ID ||= '544d8d48-a2a9-4a18-b3a8-4b4ceae7c387';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET ||= 'vitest-callback-signing-secret-0123456789abcdef';

import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CenterOrder } from '@/lib/payment-center/orders';
import {
  cleanupFixtures,
  closeClient,
  createOrganizationFixture,
  createUserFixture,
  getClient,
  scopedId,
  uniqueSuffix,
} from './support/fixtures';

const SIGNING_SECRET = process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET as string;
const WEBSITE_ID = process.env.PAYMENT_CENTER_WEBSITE_ID as string;
const PRODUCT_CODE = 'vitest-plan';
const AMOUNT = '37.50000000';
const CURRENCY = 'USD';
const SUBSCRIPTION_ID = `sub_${'a1b2c3d4'.repeat(4)}`;
const DAY_SECONDS = 86_400;

type Method = 'stripe' | 'manual' | 'blockchain' | 'commission_balance';
type Interval = 'one_time' | 'month' | 'year';
type Send = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type SqlClient = Awaited<ReturnType<typeof getClient>>;
type RouteModule = typeof import('@/app/api/payment-center/webhook/route');
type InboxModule = typeof import('@/lib/payment-center/inbox-worker');
type AccountModule = typeof import('@/lib/billing/account');
type PreparationModule = typeof import('@/lib/billing/commission-preparation');

type Fixture = {
  userId: string;
  organizationId: string;
  billingAccountId: string;
  intentId: string;
  externalOrderId: string;
  centerOrderId: string;
  method: Method;
  priceInterval: Interval;
  amountDecimal: string;
  currency: string;
};

type Workspace = Pick<Fixture, 'userId' | 'organizationId' | 'billingAccountId'>;

type CallbackBody = {
  id: string;
  type: string;
  data: { order: CenterOrder } & Record<string, unknown>;
};

/** One settled invoice period, as the Payment Center reports it. */
type Period = {
  contract_version: number;
  evidence_complete: boolean;
  provider_invoice_id: string;
  provider_subscription_id: string;
  provider_payment_id: string;
  amount_paid_decimal: string;
  currency: string;
  settled_at: number;
  service_period_start: number;
  service_period_end: number;
};

/** A prepaid (manual / blockchain / commission balance) period. */
type PrepaidPeriod = {
  contract_version: number;
  evidence_complete: boolean;
  payment_method: Method;
  recurrence_interval: Interval;
  provider_payment_id: string;
  amount_paid_decimal: string;
  currency: string;
  settled_at: number;
  service_period_start: number;
  service_period_end: number;
};

type RefundEvidence = {
  contract_version: number;
  evidence_complete: boolean;
  provider_invoice_id: string;
  provider_payment_id: string;
  amount_refunded_decimal: string;
  currency: string;
};

type DisputeEvidence = Omit<RefundEvidence, 'amount_refunded_decimal'> & {
  amount_disputed_decimal: string;
  dispute_status: string;
};

type CommissionRefund = {
  provider_payment_id: string;
  amount_refunded_decimal: string;
  currency: string;
  original_event_id: string;
};

let sql: SqlClient;
let route: RouteModule;
let inbox: InboxModule;
let billing: AccountModule;
let preparation: PreparationModule;

const userIds: string[] = [];
const organizationIds: string[] = [];
const intentIds: string[] = [];

/** Creates a workspace (or reuses one) plus its payment intent row. */
async function seedIntent(options: {
  method?: Method;
  priceInterval?: Interval;
  status?: string;
  amountDecimal?: string;
  workspace?: Workspace;
} = {}): Promise<Fixture> {
  const method = options.method ?? 'stripe';
  const priceInterval = options.priceInterval ?? 'month';
  const amountDecimal = options.amountDecimal ?? AMOUNT;

  let workspace = options.workspace;
  if (!workspace) {
    const user = await createUserFixture();
    const organization = await createOrganizationFixture({ userId: user.userId });
    userIds.push(user.userId);
    organizationIds.push(organization.organizationId);
    const account = await billing.ensureBillingAccount(organization.organizationId, user.userId);
    workspace = {
      userId: user.userId,
      organizationId: organization.organizationId,
      billingAccountId: account.id,
    };
  }

  const intentId = `pi_${randomUUID().replaceAll('-', '')}`;
  const externalOrderId = scopedId('order', uniqueSuffix());
  const centerOrderId = randomUUID();
  await sql`
    INSERT INTO payment_intents (
      id, organization_id, billing_account_id, payer_user_id, request_key,
      product_code, price_interval, amount_decimal, currency, method, payment_action,
      status, external_order_id, idempotency_key, payment_center_order_id
    ) VALUES (
      ${intentId}, ${workspace.organizationId}, ${workspace.billingAccountId}, ${workspace.userId},
      ${randomUUID()}, ${PRODUCT_CODE}, ${priceInterval}, ${amountDecimal}, ${CURRENCY}, ${method},
      CASE ${method} WHEN 'stripe' THEN 'redirect'
        WHEN 'commission_balance' THEN 'commission_reserved'
        WHEN 'blockchain' THEN 'blockchain' WHEN 'binance_pay' THEN 'binance_pay'
        ELSE 'manual' END,
      ${options.status ?? 'pending'}, ${externalOrderId}, ${externalOrderId}, ${centerOrderId}
    )
  `;
  intentIds.push(intentId);

  return {
    ...workspace,
    intentId,
    externalOrderId,
    centerOrderId,
    method,
    priceInterval,
    amountDecimal,
    currency: CURRENCY,
  };
}

/** The Payment Center order snapshot the SaaS expects for this intent. */
function centerOrderFor(fixture: Fixture, overrides: Partial<CenterOrder> = {}): CenterOrder {
  const base: CenterOrder = {
    id: fixture.centerOrderId,
    website_id: WEBSITE_ID,
    external_order_id: fixture.externalOrderId,
    idempotency_key: fixture.externalOrderId,
    payer_external_user_id: fixture.userId,
    billing_account_id: fixture.billingAccountId,
    payment_method: fixture.method,
    kind: fixture.method === 'stripe'
      && (fixture.priceInterval === 'month' || fixture.priceInterval === 'year')
      ? 'subscription'
      : 'one_time',
    status: 'paid',
    amount_decimal: fixture.amountDecimal,
    currency: fixture.currency,
    product_code: PRODUCT_CODE,
    recurrence_interval: fixture.priceInterval,
    provider_subscription_id: fixture.method === 'stripe' ? SUBSCRIPTION_ID : null,
    provider_payment_id: `PC_${fixture.centerOrderId}`,
    metadata: {
      organizationId: fixture.organizationId,
      billingAccountId: fixture.billingAccountId,
      payerUserId: fixture.userId,
      intentId: fixture.intentId,
    },
  };
  return { ...base, ...overrides };
}

function periodFor(startOffsetDays: number, overrides: Partial<Period> = {}): Period {
  const unique = randomUUID().replaceAll('-', '');
  const settledAt = Math.floor(Date.now() / 1000) + startOffsetDays * DAY_SECONDS;
  const base: Period = {
    contract_version: 1,
    evidence_complete: true,
    provider_invoice_id: `in_${unique}`,
    provider_subscription_id: SUBSCRIPTION_ID,
    provider_payment_id: `PC_${unique}`,
    amount_paid_decimal: AMOUNT,
    currency: CURRENCY,
    settled_at: settledAt,
    service_period_start: settledAt,
    service_period_end: settledAt + 30 * DAY_SECONDS,
  };
  return { ...base, ...overrides };
}

function prepaidFor(fixture: Fixture, overrides: Partial<PrepaidPeriod> = {}): PrepaidPeriod {
  const settledAt = Math.floor(Date.now() / 1000) - 60;
  const base: PrepaidPeriod = {
    contract_version: 1,
    evidence_complete: true,
    payment_method: fixture.method,
    recurrence_interval: fixture.priceInterval,
    provider_payment_id: `PC_${fixture.centerOrderId}`,
    amount_paid_decimal: fixture.amountDecimal,
    currency: fixture.currency,
    settled_at: settledAt,
    service_period_start: settledAt,
    service_period_end: settledAt + 30 * DAY_SECONDS,
  };
  return { ...base, ...overrides };
}

function refundFor(period: Period, overrides: Partial<RefundEvidence> = {}): RefundEvidence {
  const base: RefundEvidence = {
    contract_version: 1,
    evidence_complete: true,
    provider_invoice_id: period.provider_invoice_id,
    provider_payment_id: period.provider_payment_id,
    amount_refunded_decimal: period.amount_paid_decimal,
    currency: period.currency,
  };
  return { ...base, ...overrides };
}

function disputeFor(period: Period, overrides: Partial<DisputeEvidence> = {}): DisputeEvidence {
  const base: DisputeEvidence = {
    contract_version: 1,
    evidence_complete: true,
    provider_invoice_id: period.provider_invoice_id,
    provider_payment_id: period.provider_payment_id,
    amount_disputed_decimal: period.amount_paid_decimal,
    currency: period.currency,
    dispute_status: 'lost',
  };
  return { ...base, ...overrides };
}

function commissionRefundFor(fixture: Fixture, overrides: Partial<CommissionRefund> = {}): CommissionRefund {
  const base: CommissionRefund = {
    provider_payment_id: `PC_${fixture.centerOrderId}`,
    amount_refunded_decimal: fixture.amountDecimal,
    currency: fixture.currency,
    original_event_id: randomUUID(),
  };
  return { ...base, ...overrides };
}

function callbackBody(fixture: Fixture, options: {
  eventId?: string;
  type?: string;
  order?: Partial<CenterOrder>;
  data?: Record<string, unknown>;
}): CallbackBody {
  return {
    id: options.eventId ?? randomUUID(),
    type: options.type ?? 'subscription.period_paid',
    data: {
      order: centerOrderFor(fixture, options.order),
      ...(options.data ?? {}),
    },
  };
}

function signedHeaders(raw: Uint8Array, eventId: string, at = Math.floor(Date.now() / 1000), key = SIGNING_SECRET) {
  const signature = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${at}.`, 'ascii'), Buffer.from(raw)]))
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-payment-center-timestamp': String(at),
    'x-payment-center-signature': `sha256=${signature}`,
    'x-payment-center-event': eventId,
  };
}

/** Delivers a signed raw-body callback to the real webhook route. */
async function deliver(body: CallbackBody) {
  const raw = new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8'));
  const request = new Request('http://localhost:3000/api/payment-center/webhook', {
    method: 'POST',
    headers: signedHeaders(raw, body.id),
    body: Buffer.from(raw),
  });
  const response = await route.POST(request);
  return { response, raw, body };
}

function envelope(body: CallbackBody) {
  return { status: 'success', data: { event: body, delivery_status: 'delivered' } };
}

function orderEnvelope(order: CenterOrder) {
  return { status: 'success', data: { order } };
}

function commissionEnvelope(data: unknown) {
  return { status: 'success', data };
}

/** Injected `send`: the only mocked boundary (Payment Center HTTP). */
function centerStub(options: { event?: unknown; order?: unknown; commission?: unknown } = {}) {
  const calls: string[] = [];
  const send: Send = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes('/api/payment-center/events/')) {
      return options.event ? Response.json(options.event) : new Response(null, { status: 404 });
    }
    if (url.includes('/commission-state')) {
      return options.commission
        ? Response.json(options.commission)
        : new Response(null, { status: 404 });
    }
    return options.order ? Response.json(options.order) : new Response(null, { status: 404 });
  };
  return { send, calls };
}

async function inboxRows(eventId: string) {
  return sql<{ status: string; last_error_code: string | null; attempt_count: number }[]>`
    SELECT status::text AS status, last_error_code, attempt_count
    FROM payment_inbox WHERE event_id = ${eventId}
  `;
}

async function evidenceRows(intentId: string) {
  return sql<{
    evidence_key: string;
    status: string;
    reversed_by_event_id: string | null;
    amount_decimal: string;
  }[]>`
    SELECT evidence_key, status::text AS status, reversed_by_event_id, amount_decimal::text AS amount_decimal
    FROM payment_evidence WHERE intent_id = ${intentId} ORDER BY service_period_start
  `;
}

async function grantRows(organizationId: string) {
  return sql<{ status: string; evidence_id: string; period_start: Date; period_end: Date }[]>`
    SELECT status::text AS status, evidence_id, period_start, period_end
    FROM subscription_grants WHERE organization_id = ${organizationId} ORDER BY period_start
  `;
}

async function subscriptionRow(organizationId: string) {
  const [row] = await sql<{ status: string; active_until: Date | null }[]>`
    SELECT status::text AS status, active_until FROM subscriptions WHERE organization_id = ${organizationId}
  `;
  return row;
}

/** Parks every other inbox row so a worker run claims exactly the events under test. */
async function parkOtherEvents(...keep: string[]) {
  await sql`
    UPDATE payment_inbox SET available_at = now() + interval '1 hour'
    WHERE event_id::text <> ALL(${keep}::text[])
  `;
}

/** Makes a row claimable again (as if it had never been processed). */
async function requeue(eventId: string) {
  await sql`
    UPDATE payment_inbox
    SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
        attempt_count = 0, last_error_code = NULL, available_at = now()
    WHERE event_id = ${eventId}
  `;
  await parkOtherEvents(eventId);
}

/** Delivers a settled period and lets the worker grant it through the real path. */
async function grantPeriod(fixture: Fixture, period: Period, eventId = randomUUID()) {
  const body = callbackBody(fixture, { eventId, type: 'subscription.period_paid', data: period });
  const receipt = await deliver(body);
  expect(receipt.response.status).toBe(202);
  // The route already tried to fulfil the delivery against a closed centre, so
  // put the row back in the queue for the worker run this helper measures.
  await requeue(eventId);
  const stub = centerStub({ event: envelope(body), order: orderEnvelope(centerOrderFor(fixture)) });
  const report = await inbox.runPaymentInbox({ send: stub.send });
  expect(report).toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });
  return { eventId, body, stub };
}

/** Delivers a reversal event and runs the worker over it. */
async function reversePeriod(fixture: Fixture, options: {
  data: Record<string, unknown>;
  type?: string;
  order?: Partial<CenterOrder>;
  eventId?: string;
  commission?: unknown;
}) {
  const eventId = options.eventId ?? randomUUID();
  const body = callbackBody(fixture, {
    eventId,
    type: options.type ?? 'subscription.period_refunded',
    order: options.order,
    data: options.data,
  });
  const receipt = await deliver(body);
  expect(receipt.response.status).toBe(202);
  // Same as `grantPeriod`: the inline fast path has already run, so requeue.
  await requeue(eventId);
  const stub = centerStub({
    event: envelope(body),
    order: orderEnvelope(centerOrderFor(fixture, options.order)),
    commission: options.commission,
  });
  const report = await inbox.runPaymentInbox({ send: stub.send });
  return { eventId, body, report, stub };
}

beforeAll(async () => {
  sql = await getClient();
  route = await import('@/app/api/payment-center/webhook/route');
  inbox = await import('@/lib/payment-center/inbox-worker');
  billing = await import('@/lib/billing/account');
  preparation = await import('@/lib/billing/commission-preparation');
});

afterAll(async () => {
  await cleanupFixtures({ userIds, organizationIds, intentIds });
  await closeClient();
});

beforeEach(() => {
  process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = SIGNING_SECRET;
  process.env.PAYMENT_CENTER_API_KEY ||= 'vitest-payment-center-api-key';
  // The callback route fulfils each delivery through the global fetch; without a
  // stub a test would call whatever centre happens to be listening on this machine.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('vitest: no outbound fetch was stubbed for this test');
  }) as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('period refunds and disputes (Payment Center HTTP stubbed, database writes real)', () => {
  it('reverses only the refunded period while the later renewal stays active', async () => {
    const earlier = await seedIntent();
    const earlierPeriod = periodFor(-31);
    await grantPeriod(earlier, earlierPeriod);

    // The renewal is a new order for the same workspace, so it is seeded after
    // the earlier intent stopped being an open checkout.
    const renewal = await seedIntent({
      workspace: {
        userId: earlier.userId,
        organizationId: earlier.organizationId,
        billingAccountId: earlier.billingAccountId,
      },
    });
    const currentPeriod = periodFor(-1);
    await grantPeriod(renewal, currentPeriod);

    const before = await grantRows(earlier.organizationId);
    expect(before.map((row) => row.status)).toEqual(['active', 'active']);

    const reversal = await reversePeriod(earlier, { data: refundFor(earlierPeriod) });
    expect(reversal.report).toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });

    const after = await grantRows(earlier.organizationId);
    expect(after.map((row) => row.status)).toEqual(['reversed', 'active']);

    const earlierEvidence = await evidenceRows(earlier.intentId);
    expect(earlierEvidence[0]).toMatchObject({
      evidence_key: `invoice:${earlierPeriod.provider_invoice_id}`,
      status: 'reversed',
      reversed_by_event_id: reversal.eventId,
    });

    // The renewal's own grant and evidence are untouched.
    expect(await evidenceRows(renewal.intentId)).toMatchObject([
      { evidence_key: `invoice:${currentPeriod.provider_invoice_id}`, status: 'settled', reversed_by_event_id: null },
    ]);
    expect(await grantRows(renewal.organizationId)).toHaveLength(2);

    const subscription = await subscriptionRow(earlier.organizationId);
    expect(subscription?.status).toBe('active');
    expect(subscription?.active_until ? new Date(subscription.active_until).getTime() : null)
      .toBe(currentPeriod.service_period_end * 1000);
  });

  it('deactivates the workspace when the current period is refunded and is idempotent on redelivery', async () => {
    const fixture = await seedIntent();
    const currentPeriod = periodFor(-1);
    await grantPeriod(fixture, currentPeriod);
    expect((await subscriptionRow(fixture.organizationId))?.status).toBe('active');

    const reversal = await reversePeriod(fixture, { data: refundFor(currentPeriod) });
    expect(reversal.report).toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });
    expect(await evidenceRows(fixture.intentId)).toMatchObject([
      { status: 'reversed', reversed_by_event_id: reversal.eventId },
    ]);
    expect((await grantRows(fixture.organizationId)).map((row) => row.status)).toEqual(['reversed']);

    const subscription = await subscriptionRow(fixture.organizationId);
    expect(subscription?.status).toBe('inactive');
    expect(subscription?.active_until).toBeNull();

    // Redelivering the very same reversal event is answered from stored evidence:
    // it is processed again without creating or reversing anything twice.
    await requeue(reversal.eventId);
    const replay = await inbox.runPaymentInbox({ send: reversal.stub.send });
    expect(replay).toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });
    expect(await grantRows(fixture.organizationId)).toHaveLength(1);
    expect(await evidenceRows(fixture.intentId)).toMatchObject([
      { status: 'reversed', reversed_by_event_id: reversal.eventId },
    ]);
    expect((await subscriptionRow(fixture.organizationId))?.status).toBe('inactive');
  });

  it('holds a partial refund for review instead of reversing the period', async () => {
    const fixture = await seedIntent();
    const currentPeriod = periodFor(-1);
    await grantPeriod(fixture, currentPeriod);

    const reversal = await reversePeriod(fixture, {
      data: refundFor(currentPeriod, { amount_refunded_decimal: '10.00000000' }),
    });
    expect(reversal.report).toMatchObject({ claimed: 1, processed: 0, retried: 0, manualReview: 1 });
    expect((await inboxRows(reversal.eventId))[0]).toMatchObject({
      status: 'manual_review',
      last_error_code: 'reversal_grant_conflict',
    });

    expect(await evidenceRows(fixture.intentId)).toMatchObject([
      { status: 'settled', reversed_by_event_id: null },
    ]);
    expect((await grantRows(fixture.organizationId)).map((row) => row.status)).toEqual(['active']);
    expect((await subscriptionRow(fixture.organizationId))?.status).toBe('active');
  });

  it('holds a refund that names a different period payment for review', async () => {
    const fixture = await seedIntent();
    const currentPeriod = periodFor(-1);
    await grantPeriod(fixture, currentPeriod);

    const reversal = await reversePeriod(fixture, {
      data: refundFor(currentPeriod, { provider_payment_id: `PC_${randomUUID().replaceAll('-', '')}` }),
    });
    expect(reversal.report).toMatchObject({ claimed: 1, processed: 0, manualReview: 1 });
    expect((await inboxRows(reversal.eventId))[0]).toMatchObject({ last_error_code: 'reversal_grant_conflict' });
    expect((await grantRows(fixture.organizationId)).map((row) => row.status)).toEqual(['active']);
    expect(await evidenceRows(fixture.intentId)).toMatchObject([{ status: 'settled' }]);
  });

  it('refuses a second, different reversal event for an already reversed period', async () => {
    const fixture = await seedIntent();
    const currentPeriod = periodFor(-1);
    await grantPeriod(fixture, currentPeriod);

    const firstReversal = await reversePeriod(fixture, { data: refundFor(currentPeriod) });
    expect(firstReversal.report).toMatchObject({ processed: 1 });

    const secondReversal = await reversePeriod(fixture, { data: refundFor(currentPeriod) });
    expect(secondReversal.report).toMatchObject({ claimed: 1, processed: 0, manualReview: 1 });
    expect((await inboxRows(secondReversal.eventId))[0]).toMatchObject({
      last_error_code: 'reversal_grant_conflict',
    });

    // The original reversal stays the recorded one.
    expect(await evidenceRows(fixture.intentId)).toMatchObject([
      { status: 'reversed', reversed_by_event_id: firstReversal.eventId },
    ]);
    expect(await grantRows(fixture.organizationId)).toHaveLength(1);
  });

  it('reverses a lost dispute and refuses a dispute that was not lost', async () => {
    const fixture = await seedIntent();
    const currentPeriod = periodFor(-1);
    await grantPeriod(fixture, currentPeriod);

    const won = await reversePeriod(fixture, {
      type: 'subscription.period_disputed',
      data: disputeFor(currentPeriod, { dispute_status: 'won' }),
    });
    expect(won.report).toMatchObject({ claimed: 1, processed: 0, manualReview: 1 });
    expect((await inboxRows(won.eventId))[0]).toMatchObject({ last_error_code: 'reversal_evidence_incomplete' });
    expect((await grantRows(fixture.organizationId)).map((row) => row.status)).toEqual(['active']);

    const lost = await reversePeriod(fixture, {
      type: 'subscription.period_disputed',
      data: disputeFor(currentPeriod),
    });
    expect(lost.report).toMatchObject({ claimed: 1, processed: 1, manualReview: 0 });
    expect((await grantRows(fixture.organizationId)).map((row) => row.status)).toEqual(['reversed']);
    expect(await evidenceRows(fixture.intentId)).toMatchObject([
      { status: 'reversed', reversed_by_event_id: lost.eventId },
    ]);
    expect((await subscriptionRow(fixture.organizationId))?.status).toBe('inactive');
  });

  it('holds a reversal for review when the invoice was never settled', async () => {
    const fixture = await seedIntent();
    const currentPeriod = periodFor(-1);
    await grantPeriod(fixture, currentPeriod);

    // A different invoice of the same subscription that this workspace never had granted.
    const neverSettled = periodFor(-1);
    const reversal = await reversePeriod(fixture, { data: refundFor(neverSettled) });
    expect(reversal.report).toMatchObject({ claimed: 1, processed: 0, manualReview: 1 });
    expect((await inboxRows(reversal.eventId))[0]).toMatchObject({ last_error_code: 'reversal_grant_conflict' });

    expect(await evidenceRows(fixture.intentId)).toMatchObject([{ status: 'settled' }]);
    expect((await grantRows(fixture.organizationId)).map((row) => row.status)).toEqual(['active']);
    expect((await subscriptionRow(fixture.organizationId))?.status).toBe('active');
  });

  it('never creates a grant for a zero-amount settled period', async () => {
    const fixture = await seedIntent();
    const zeroPeriod = periodFor(-1, { amount_paid_decimal: '0.00000000' });
    const eventId = randomUUID();
    const body = callbackBody(fixture, { eventId, type: 'subscription.period_paid', data: zeroPeriod });
    expect((await deliver(body)).response.status).toBe(202);
    await requeue(eventId);

    const stub = centerStub({ event: envelope(body), order: orderEnvelope(centerOrderFor(fixture)) });
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, processed: 0, retried: 0, manualReview: 1 });
    expect((await inboxRows(eventId))[0]).toMatchObject({ last_error_code: 'grant_conflict' });

    expect(await evidenceRows(fixture.intentId)).toHaveLength(0);
    expect(await grantRows(fixture.organizationId)).toHaveLength(0);
    expect(await subscriptionRow(fixture.organizationId)).toBeUndefined();
  });

  it('does not grant a period reported for a cancelled order', async () => {
    const fixture = await seedIntent();
    const currentPeriod = periodFor(-1);
    const eventId = randomUUID();
    const body = callbackBody(fixture, { eventId, type: 'subscription.period_paid', data: currentPeriod });
    expect((await deliver(body)).response.status).toBe(202);
    await requeue(eventId);

    const stub = centerStub({
      event: envelope(body),
      order: orderEnvelope(centerOrderFor(fixture, { status: 'cancelled' })),
    });
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, processed: 0, retried: 0, manualReview: 1 });
    expect((await inboxRows(eventId))[0]).toMatchObject({ last_error_code: 'order_not_payable' });

    expect(await evidenceRows(fixture.intentId)).toHaveLength(0);
    expect(await grantRows(fixture.organizationId)).toHaveLength(0);
  });

  it('reverses a commission-paid period only once the center confirms the spend was cancelled', async () => {
    const fixture = await seedIntent({ method: 'commission_balance', status: 'action_required' });
    const actionRequired = centerOrderFor(fixture, {
      status: 'action_required',
      payment_details: { commission_flow: 'two_phase', commission_spend_id: `PC_${fixture.centerOrderId}` },
    });
    await preparation.prepareCommissionGrant(fixture.intentId, actionRequired);

    const prepaid = prepaidFor(fixture);
    const grantEventId = randomUUID();
    // A commission-paid order is created with the two-phase flow, so the centre
    // reports that flow back on every snapshot of it — including the paid one the
    // grant is settled from. `assertOrderMatchesIntent` checks it, so a snapshot
    // without it is not this order.
    const paidOrder = centerOrderFor(fixture, {
      payment_details: { commission_flow: 'two_phase', commission_spend_id: `PC_${fixture.centerOrderId}` },
    });
    const grantBody = callbackBody(fixture, {
      eventId: grantEventId, type: 'payment.succeeded', order: paidOrder, data: prepaid,
    });
    expect((await deliver(grantBody)).response.status).toBe(202);
    await requeue(grantEventId);
    const paidStub = centerStub({ event: envelope(grantBody), order: orderEnvelope(paidOrder) });
    expect(await inbox.runPaymentInbox({ send: paidStub.send }))
      .toMatchObject({ claimed: 1, processed: 1, manualReview: 0 });
    expect(await evidenceRows(fixture.intentId)).toMatchObject([
      { evidence_key: `order:${fixture.centerOrderId}`, status: 'settled' },
    ]);

    const refundOrder: Partial<CenterOrder> = {
      status: 'refunded',
      payment_details: { commission_flow: 'two_phase', commission_spend_id: `PC_${fixture.centerOrderId}` },
    };
    const spend = (status: 'reserved' | 'cancelled') => ({
      external_spend_id: `PC_${fixture.centerOrderId}`,
      status,
      currency: fixture.currency,
    });
    const refund = commissionRefundFor(fixture, { original_event_id: grantEventId });

    // The center still reports the spend as reserved: nothing is reversed yet.
    const unverified = await reversePeriod(fixture, {
      type: 'payment.refunded',
      data: refund,
      order: refundOrder,
      commission: commissionEnvelope({
        order: centerOrderFor(fixture, refundOrder),
        spend: spend('reserved'),
        spend_status: 'reserved',
      }),
    });
    expect(unverified.report).toMatchObject({ claimed: 1, processed: 0, manualReview: 1 });
    expect((await inboxRows(unverified.eventId))[0]).toMatchObject({
      last_error_code: 'commission_refund_unverified',
    });
    expect((await grantRows(fixture.organizationId)).map((row) => row.status)).toEqual(['active']);

    // Once the spend is cancelled the same event reverses the grant.
    await requeue(unverified.eventId);
    const verified = centerStub({
      event: envelope(unverified.body),
      order: orderEnvelope(centerOrderFor(fixture, refundOrder)),
      commission: commissionEnvelope({
        order: centerOrderFor(fixture, refundOrder),
        spend: spend('cancelled'),
        spend_status: 'cancelled',
      }),
    });
    expect(await inbox.runPaymentInbox({ send: verified.send }))
      .toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });
    expect((await grantRows(fixture.organizationId)).map((row) => row.status)).toEqual(['reversed']);
    expect(await evidenceRows(fixture.intentId)).toMatchObject([
      { status: 'reversed', reversed_by_event_id: unverified.eventId },
    ]);
    expect((await subscriptionRow(fixture.organizationId))?.status).toBe('inactive');
  });
});
