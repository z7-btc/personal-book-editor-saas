import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AC21 — paying with the commission balance uses the accepted two-phase
 * protocol: reserve / confirm / cancel, an unknown result, a charged balance
 * with no grant, a crash and concurrency all end in a same-ID recovery or an
 * auditable compensation. The capability stays closed until that holds.
 *
 * Real, isolated PostgreSQL per file. Only the Payment Center HTTP contract is
 * mocked (catalog + order + commission-state/confirm/cancel), so every
 * assertion below reads real rows written by the application code. The
 * feature-off half of "stays closed" is asserted in
 * tests/provider-policy.test.ts (FEATURE_COMMISSION_BALANCE unset there).
 */
const siteId = '00000000-0000-4000-8000-000000000001';
process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.FEATURE_COMMISSION_BALANCE = 'true';
process.env.APP_BASE_URL = 'https://app.example.test';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_API_KEY = 'vitest-center-key';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = siteId;
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'vitest-callback-signing-secret-0123456789';

const DAY = 86_400;
const nowSeconds = Math.floor(Date.now() / 1000);
const periodStart = nowSeconds - 2 * DAY;
const periodEnd = periodStart + 30 * DAY;

type CenterOrder = import('@/lib/payment-center/orders').CenterOrder;
type PaymentMethod = 'stripe' | 'manual' | 'blockchain' | 'commission_balance';
type Json = Record<string, unknown>;

const catalog = {
  website_id: siteId,
  site_code: 'saas-test',
  site_name: 'Vitest Site',
  methods: ['stripe', 'manual', 'commission_balance', 'blockchain'],
  unavailable_methods: {} as Record<string, string>,
  products: [{
    code: 'pro',
    name: 'Pro',
    description: null,
    prices: [
      { interval: 'month', amount: 15, amount_decimal: '15.00000000', currency: 'USD' },
      { interval: 'year', amount: 150, amount_decimal: '150.00000000', currency: 'USD' },
      { interval: 'one_time', amount: 5, amount_decimal: '5.00000000', currency: 'USD' },
    ],
  }],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });
}

type SpendStatus = 'missing' | 'reserved' | 'completed' | 'cancelled';

let spendStatus: SpendStatus = 'reserved';
let cancelResult: 'cancelled' | 'reserved' = 'cancelled';
let spendIdPatch: string | null = null;
let orderStatusPatch: CenterOrder['status'] | null = null;
const storedOrders = new Map<string, CenterOrder>();
let calls: Array<{ method: string; path: string; body: Json | null }> = [];

function commissionDetails(id: string) {
  return { commission_flow: 'two_phase', commission_spend_id: `PC_${id}` };
}

function orderFromRequest(request: Json, status: string): CenterOrder {
  const id = `center_${String(request.external_order_id)}`;
  return {
    id,
    website_id: siteId,
    external_order_id: String(request.external_order_id),
    idempotency_key: String(request.idempotency_key),
    payer_external_user_id: String(request.payer_external_user_id),
    billing_account_id: String(request.billing_account_id),
    payment_method: request.payment_method as CenterOrder['payment_method'],
    commission_flow: request.commission_flow as 'two_phase' | undefined,
    kind: request.kind as CenterOrder['kind'],
    status,
    amount_decimal: String(request.amount),
    currency: String(request.currency),
    product_code: String(request.product_code),
    recurrence_interval: String(request.recurrence_interval),
    metadata: request.metadata as Record<string, unknown>,
    ...(request.payment_method === 'commission_balance'
      ? { payment_details: commissionDetails(id), provider_payment_id: `PC_${id}` }
      : {}),
  } as CenterOrder;
}

/** Current Payment Center view of one commission order. */
function commissionState(order: CenterOrder) {
  const status = orderStatusPatch
    ?? (spendStatus === 'completed' ? 'paid'
      : spendStatus === 'cancelled' ? 'cancelled' : 'action_required');
  return {
    status: 'success',
    data: {
      order: { ...order, status },
      spend: spendStatus === 'missing' ? null : {
        external_spend_id: spendIdPatch ?? `PC_${order.id}`,
        status: spendStatus,
        currency: order.currency,
      },
      spend_status: spendStatus,
      ...(spendStatus === 'completed' ? { event_id: randomUUID() } : {}),
    },
  };
}

/** Mocked Payment Center: catalog, orders and the commission two-phase calls. */
const centerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = new URL(url).pathname;
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : null;
  calls.push({ method, path, body });

  if (path === '/api/payment-center/catalog') {
    return json({ status: 'success', data: catalog });
  }
  if (path === '/api/payment-center/orders' && method === 'POST' && body) {
    const order = orderFromRequest(body, 'action_required');
    storedOrders.set(order.external_order_id, order);
    return json({ status: 'success', data: { order, action: order.payment_details ?? {}, idempotent: false } });
  }
  const commission = /^\/api\/payment-center\/orders\/(.+)\/commission-(state|confirm|cancel)$/
    .exec(path);
  if (commission) {
    const order = storedOrders.get(decodeURIComponent(commission[1]!));
    if (!order) return new Response('', { status: 404 });
    if (commission[2] === 'confirm') spendStatus = 'completed';
    if (commission[2] === 'cancel') spendStatus = cancelResult;
    return json(commissionState(order));
  }
  const query = /^\/api\/payment-center\/orders\/(.+)$/.exec(path);
  if (query && method === 'GET') {
    const order = storedOrders.get(decodeURIComponent(query[1]!));
    if (!order) return new Response('', { status: 404 });
    return json({ status: 'success', data: { order } });
  }
  return new Response('', { status: 404 });
}) as typeof fetch;

function callsTo(action: string) {
  return calls.filter((call) => call.path.endsWith(action));
}

const scope: { userIds: string[]; organizationIds: string[]; intentIds: string[] } = {
  userIds: [], organizationIds: [], intentIds: [],
};

type Workspace = {
  userId: string; organizationId: string; billingAccountId: string; suffix: string;
};

type IntentRow = {
  id: string; organization_id: string; billing_account_id: string; payer_user_id: string;
  product_code: string; price_interval: string; amount_decimal: string; currency: string;
  method: PaymentMethod; external_order_id: string; idempotency_key: string;
};

let fixtures: typeof import('./support/fixtures');
let client: Sql;
let intents: typeof import('@/lib/billing/intents');
let submit: typeof import('@/lib/billing/submit');
let preparation: typeof import('@/lib/billing/commission-preparation');
let service: typeof import('@/lib/subscription/service');

beforeAll(async () => {
  fixtures = await import('./support/fixtures');
  client = await fixtures.getClient();
  intents = await import('@/lib/billing/intents');
  submit = await import('@/lib/billing/submit');
  preparation = await import('@/lib/billing/commission-preparation');
  service = await import('@/lib/subscription/service');
  // `preparePaymentIntent` loads the catalog through the module-level `fetch`,
  // so the mocked Payment Center has to own the global as well (no real host
  // named payments.example.test exists).
  vi.stubGlobal('fetch', centerFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await fixtures.cleanupFixtures(scope);
  await fixtures.closeClient();
});

beforeEach(() => {
  spendStatus = 'reserved';
  cancelResult = 'cancelled';
  spendIdPatch = null;
  orderStatusPatch = null;
  storedOrders.clear();
  calls = [];
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

async function seedIntent(workspace: Workspace, tag: string, options: {
  method: PaymentMethod; interval: string; status?: string; amount?: string;
}): Promise<string> {
  const intentId = fixtures.scopedId('intent', `${workspace.suffix}-${tag}`);
  const orderId = `center_${intentId}`;
  await client`INSERT INTO payment_intents
      (id, organization_id, billing_account_id, payer_user_id, request_key, product_code,
       price_interval, amount_decimal, currency, method, payment_action, status,
       external_order_id, idempotency_key, payment_center_order_id)
    VALUES (${intentId}, ${workspace.organizationId}, ${workspace.billingAccountId},
      ${workspace.userId}, ${randomUUID()}, 'pro', ${options.interval},
      ${options.amount ?? '15.00000000'}, 'USD', ${options.method},
      CASE ${options.method} WHEN 'stripe' THEN 'redirect'
        WHEN 'commission_balance' THEN 'commission_reserved'
        WHEN 'blockchain' THEN 'blockchain' WHEN 'binance_pay' THEN 'binance_pay'
        ELSE 'manual' END,
      ${options.status ?? 'pending'}, ${intentId}, ${intentId},
      ${(options.status ?? 'pending') === 'pending' ? null : orderId})`;
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

/** The commission order the Payment Center holds for this intent. */
function centerOrder(intent: IntentRow, overrides: Partial<CenterOrder> = {}): CenterOrder {
  const id = `center_${intent.id}`;
  return {
    id,
    website_id: siteId,
    external_order_id: intent.external_order_id,
    idempotency_key: intent.idempotency_key,
    payer_external_user_id: intent.payer_user_id,
    billing_account_id: intent.billing_account_id,
    payment_method: intent.method,
    commission_flow: 'two_phase',
    kind: 'one_time',
    status: 'action_required',
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
    payment_details: commissionDetails(id),
    provider_payment_id: `PC_${id}`,
    ...overrides,
  } as CenterOrder;
}

function storeOrder(intent: IntentRow, overrides: Partial<CenterOrder> = {}) {
  const order = centerOrder(intent, overrides);
  storedOrders.set(order.external_order_id, order);
  return order;
}

async function preparationRow(intentId: string) {
  const [row] = await client<{ status: string; center_order_id: string; spend_id: string }[]>`
    SELECT status, center_order_id, spend_id FROM commission_grant_preparations
    WHERE intent_id = ${intentId}`;
  return row;
}

async function preparationCount(organizationId: string) {
  const [row] = await client<{ count: number }[]>`
    SELECT COUNT(*)::integer AS count FROM commission_grant_preparations
    WHERE organization_id = ${organizationId}`;
  return row!.count;
}

async function intentState(intentId: string) {
  const [row] = await client<{
    status: string; last_error_code: string | null; payment_center_order_id: string | null;
    submission_lease_expires_at: Date | null;
  }[]>`SELECT status::text, last_error_code, payment_center_order_id, submission_lease_expires_at
    FROM payment_intents WHERE id = ${intentId}`;
  return row!;
}

async function grantCount(organizationId: string) {
  const [row] = await client<{ count: number }[]>`
    SELECT COUNT(*)::integer AS count FROM subscription_grants
    WHERE organization_id = ${organizationId}`;
  return row!.count;
}

/** Keeps a leftover open intent out of another test's reconciliation sweep. */
async function closeIntent(intentId: string) {
  await client`UPDATE payment_intents SET status = 'cancelled' WHERE id = ${intentId}`;
}

async function openCommissionIntent(workspace: Workspace) {
  const created = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
    requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
    currency: 'USD', method: 'commission_balance',
  });
  scope.intentIds.push(created.id);
  return created;
}

describe('two-phase commission balance (AC21)', () => {
  it('reserves, prepares and confirms one order id, granting nothing yet', async () => {
    const workspace = await seedWorkspace();
    const created = await openCommissionIntent(workspace);

    const result = await submit.submitPaymentIntent(created.id, workspace.userId, centerFetch);

    expect(result.status).toBe('action_required');
    const createdCalls = callsTo('/api/payment-center/orders');
    expect(createdCalls).toHaveLength(1);
    expect(createdCalls[0]!.body).toMatchObject({
      external_order_id: created.externalOrderId,
      idempotency_key: created.idempotencyKey,
      payment_method: 'commission_balance',
      commission_flow: 'two_phase',
    });
    const prepared = await preparationRow(created.id);
    expect(prepared?.status).toBe('confirmed');
    expect(prepared?.spend_id).toBe(`PC_center_${created.id}`);
    const state = await intentState(created.id);
    expect(state.status).toBe('action_required');
    expect(state.payment_center_order_id).toBe(`center_${created.id}`);
    // The entitlement itself only appears when the signed payment event is verified.
    expect(await grantCount(workspace.organizationId)).toBe(0);
    await closeIntent(created.id);
  });

  it('replays the same operation without creating a second order or preparation', async () => {
    const workspace = await seedWorkspace();
    const created = await openCommissionIntent(workspace);
    await submit.submitPaymentIntent(created.id, workspace.userId, centerFetch);
    const afterFirst = calls.length;

    const replay = await submit.submitPaymentIntent(created.id, workspace.userId, centerFetch);

    expect(replay.status).toBe('action_required');
    expect(callsTo('/api/payment-center/orders')).toHaveLength(1);
    expect(calls.slice(afterFirst).some((call) =>
      call.path.endsWith('/commission-confirm'))).toBe(true);
    expect(await preparationCount(workspace.organizationId)).toBe(1);
    expect((await preparationRow(created.id))?.status).toBe('confirmed');
    await closeIntent(created.id);
  });

  it('grants a prepared commission order and reverses it by the same key', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'fulfill', {
      method: 'commission_balance', interval: 'month',
    });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent, { status: 'paid' });
    await client`INSERT INTO commission_grant_preparations
        (intent_id, organization_id, center_order_id, spend_id, status)
      VALUES (${intentId}, ${workspace.organizationId}, ${order.id},
        ${`PC_${order.id}`}, 'confirmed')`;
    const eventId = randomUUID();
    await client`INSERT INTO payment_inbox
        (event_id, event_type, center_order_id, external_order_id, website_id, body_sha256, status)
      VALUES (${eventId}, 'payment.succeeded', ${order.id}, ${order.external_order_id},
        ${siteId}, ${'3'.repeat(64)}, 'pending')`;

    const granted = await service.fulfillSubscription({
      sourceEventId: eventId,
      intentId,
      providerPaymentId: `PC_${order.id}`,
      amountDecimal: intent.amount_decimal,
      currency: intent.currency,
      settledAt: periodStart,
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
      method: 'commission_balance',
      interval: 'month',
    }, order, new Date(nowSeconds * 1000));

    expect(granted.duplicate).toBe(false);
    expect(granted.subscription?.paymentMethod).toBe('commission_balance');
    const [evidence] = await client<{ evidence_key: string }[]>`
      SELECT evidence_key FROM payment_evidence WHERE organization_id = ${workspace.organizationId}`;
    expect(evidence!.evidence_key).toBe(`order:${order.id}`);

    const reversalId = randomUUID();
    const reversed = await service.reverseSubscriptionGrant(
      siteId, `order:${order.id}`, reversalId, new Date((nowSeconds + 1) * 1000));
    expect(reversed.subscription?.status).toBe('inactive');
    await expect(service.reverseSubscriptionGrant(
      siteId, `order:${order.id}`, randomUUID(), new Date((nowSeconds + 2) * 1000),
    )).rejects.toThrow('Payment was reversed by a different event');
    await expect(service.reverseSubscriptionGrant(
      siteId, `order:${order.id}`, reversalId, new Date((nowSeconds + 3) * 1000),
    )).resolves.toMatchObject({ duplicate: true });
  });

  it('refuses a reservation that does not belong to the order', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'mismatch', {
      method: 'commission_balance', interval: 'month', status: 'action_required',
    });
    const intent = await loadIntent(intentId);
    storeOrder(intent);
    await client`INSERT INTO commission_grant_preparations
        (intent_id, organization_id, center_order_id, spend_id, status)
      VALUES (${intentId}, ${workspace.organizationId}, ${`center_${intentId}`},
        ${`PC_center_${intentId}`}, 'prepared')`;
    spendIdPatch = 'PC_somebody_else';

    await expect(submit.submitPaymentIntent(intentId, workspace.userId, centerFetch))
      .rejects.toThrow('Commission reservation does not match the order');
    expect((await intentState(intentId)).status).toBe('action_required');
    expect(await grantCount(workspace.organizationId)).toBe(0);
    await closeIntent(intentId);
  });

  it('marks a refunded commission order for manual review instead of granting', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'refunded', {
      method: 'commission_balance', interval: 'month', status: 'action_required',
    });
    const intent = await loadIntent(intentId);
    storeOrder(intent);
    orderStatusPatch = 'refunded';

    await expect(submit.submitPaymentIntent(intentId, workspace.userId, centerFetch))
      .rejects.toThrow('Commission payment was refunded');
    const state = await intentState(intentId);
    expect(state.status).toBe('manual_review');
    expect(state.last_error_code).toBe('commission_refunded');
    expect(await grantCount(workspace.organizationId)).toBe(0);
  });
});

describe('auditable compensation for unknown outcomes (AC21)', () => {
  it('releases the remote reservation when the local grant cannot be prepared', async () => {
    const workspace = await seedWorkspace();
    const blocked = await seedIntent(workspace, 'blocked', {
      method: 'commission_balance', interval: 'month',
    });
    const intentId = await seedIntent(workspace, 'release', {
      method: 'commission_balance', interval: 'month', status: 'action_required',
    });
    const intent = await loadIntent(intentId);
    storeOrder(intent);
    // The workspace already promised its commission slot to another order.
    await client`INSERT INTO commission_grant_preparations
        (intent_id, organization_id, center_order_id, spend_id, status)
      VALUES (${blocked}, ${workspace.organizationId}, ${`center_${blocked}`},
        ${`PC_center_${blocked}`}, 'prepared')`;

    await expect(submit.submitPaymentIntent(intentId, workspace.userId, centerFetch))
      .rejects.toThrow('Commission grant could not be prepared');
    const state = await intentState(intentId);
    expect(state.status).toBe('failed');
    expect(state.last_error_code).toBe('grant_preparation_failed');
    expect(callsTo('/commission-cancel')).toHaveLength(1);
    expect(await preparationRow(intentId)).toBeUndefined();
    expect(await preparationCount(workspace.organizationId)).toBe(1);
  });

  it('keeps the intent reconcilable when the cancel result is unknown', async () => {
    const workspace = await seedWorkspace();
    const blocked = await seedIntent(workspace, 'blocked-unknown', {
      method: 'commission_balance', interval: 'month',
    });
    const intentId = await seedIntent(workspace, 'unknown-cancel', {
      method: 'commission_balance', interval: 'month', status: 'action_required',
    });
    const intent = await loadIntent(intentId);
    storeOrder(intent);
    await client`INSERT INTO commission_grant_preparations
        (intent_id, organization_id, center_order_id, spend_id, status)
      VALUES (${blocked}, ${workspace.organizationId}, ${`center_${blocked}`},
        ${`PC_center_${blocked}`}, 'prepared')`;
    cancelResult = 'reserved';

    await expect(submit.submitPaymentIntent(intentId, workspace.userId, centerFetch))
      .rejects.toThrow('Workspace has another prepared commission order');
    expect((await intentState(intentId)).status).toBe('action_required');
    expect(callsTo('/commission-cancel')).toHaveLength(1);

    // Once the blocker is gone the same intent is recovered under the same order.
    await client`DELETE FROM commission_grant_preparations WHERE intent_id = ${blocked}`;
    cancelResult = 'cancelled';
    const report = await submit.reconcileCommissionIntents(10, centerFetch);
    expect(report).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect((await preparationRow(intentId))?.status).toBe('confirmed');
    expect(await preparationCount(workspace.organizationId)).toBe(1);
    await closeIntent(intentId);
  });

  it('recovers a crash between reservation and confirmation', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'crash', {
      method: 'commission_balance', interval: 'month', status: 'submitting',
    });
    // `payment_intents.submission_lease_expires_at` is a naive `timestamp` and
    // `lib/billing/submit.ts` writes and compares it in UTC, so the fixture has
    // to expire the lease in UTC as well (the database session runs in
    // Asia/Shanghai, where a bare now() would land 8 hours in the future).
    await client`UPDATE payment_intents
      SET submission_lease_expires_at = (now() AT TIME ZONE 'UTC') - interval '5 minutes'
      WHERE id = ${intentId}`;
    const intent = await loadIntent(intentId);
    storeOrder(intent);
    await client`INSERT INTO commission_grant_preparations
        (intent_id, organization_id, center_order_id, spend_id, status)
      VALUES (${intentId}, ${workspace.organizationId}, ${`center_${intentId}`},
        ${`PC_center_${intentId}`}, 'prepared')`;
    spendStatus = 'completed';

    const report = await submit.reconcileCommissionIntents(10, centerFetch);

    expect(report).toEqual({ checked: 1, recovered: 1, failed: 0 });
    const state = await intentState(intentId);
    expect(state.status).toBe('action_required');
    expect(state.submission_lease_expires_at).toBeNull();
    expect((await preparationRow(intentId))?.status).toBe('confirmed');
    // Still no entitlement: only the verified payment event writes grants.
    expect(await grantCount(workspace.organizationId)).toBe(0);
    await closeIntent(intentId);
  });

  it('refuses to confirm a charged order that has no local preparation', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'no-preparation', {
      method: 'commission_balance', interval: 'month', status: 'unknown',
    });
    const intent = await loadIntent(intentId);
    storeOrder(intent);
    spendStatus = 'completed';

    const report = await submit.reconcileCommissionIntents(10, centerFetch);

    expect(report).toEqual({ checked: 1, recovered: 0, failed: 1 });
    expect((await intentState(intentId)).status).toBe('unknown');
    expect(await grantCount(workspace.organizationId)).toBe(0);
    expect(await preparationCount(workspace.organizationId)).toBe(0);
  });
});

describe('concurrent commission orders (AC21)', () => {
  it('prepares exactly one grant promise when workers race for one intent', async () => {
    const workspace = await seedWorkspace();
    const intentId = await seedIntent(workspace, 'race-one', {
      method: 'commission_balance', interval: 'month',
    });
    const intent = await loadIntent(intentId);
    const order = centerOrder(intent);

    const results = await Promise.all([
      preparation.prepareCommissionGrant(intentId, order),
      preparation.prepareCommissionGrant(intentId, order),
    ]);

    expect(new Set(results.map((row) => row.intentId))).toEqual(new Set([intentId]));
    expect(await preparationCount(workspace.organizationId)).toBe(1);
  });

  it('fails the second prepared commission order closed in one workspace', async () => {
    const workspace = await seedWorkspace();
    const firstId = await seedIntent(workspace, 'race-a', {
      method: 'commission_balance', interval: 'month',
    });
    const secondId = await seedIntent(workspace, 'race-b', {
      method: 'commission_balance', interval: 'month',
    });
    const firstOrder = centerOrder(await loadIntent(firstId));
    const secondOrder = centerOrder(await loadIntent(secondId));

    const results = await Promise.allSettled([
      preparation.prepareCommissionGrant(firstId, firstOrder),
      preparation.prepareCommissionGrant(secondId, secondOrder),
    ]);

    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((entry) => entry.status === 'rejected');
    expect(String((rejected as PromiseRejectedResult).reason)).toContain(
      'Workspace has another prepared commission order');
    expect(await preparationCount(workspace.organizationId)).toBe(1);
  });
});
