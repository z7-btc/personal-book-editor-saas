/**
 * Payment Center -> SaaS order contract (plan AC 9, AC 17, AC 20).
 *
 * The live Payment Center (http://127.0.0.1:5000) is not running while this
 * suite executes, so every external HTTP call here is answered by a stub
 * Payment Center bound to loopback and the tests say so in their names.
 * Everything else is real: an isolated migrated PostgreSQL database, the real
 * server client, the real catalog use case and the real order request builder.
 *
 * `lib/config.ts` snapshots `features` when the module is first evaluated and
 * static imports are hoisted above this file's statements, so the environment
 * is set at module scope and every module under test is imported dynamically
 * from `beforeAll` (same working pattern as referral-contract.test.ts).
 */
process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_API_KEY ||= 'vitest-payment-center-api-key';
process.env.PAYMENT_CENTER_SITE_CODE ||= 'sf118b3fa313264a';
process.env.PAYMENT_CENTER_WEBSITE_ID ||= '544d8d48-a2a9-4a18-b3a8-4b4ceae7c387';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET ||=
  'vitest-callback-signing-secret-0123456789abcdef';
process.env.APP_BASE_URL ||= 'http://localhost:3000';

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PreparePaymentIntentInput } from '@/lib/billing/intents';
import type { CenterCreateOrderRequest, CenterOrder } from '@/lib/payment-center/orders';
import type { PrepaidPeriod } from '@/lib/subscription/service';
import {
  cleanupFixtures, closeClient, createOrganizationFixture, createUserFixture,
  getClient, scopedId, uniqueSuffix,
} from './support/fixtures';

const PRODUCT_CODE = 'vitest-plan';
const CURRENCY = 'USD';
/** The price the Payment Center catalog owns; never supplied by a browser. */
const CATALOG_AMOUNT = '37.50000000';
const WEBSITE_ID = () => process.env.PAYMENT_CENTER_WEBSITE_ID as string;

type SqlClient = Awaited<ReturnType<typeof getClient>>;
type OrdersModule = typeof import('@/lib/payment-center/orders');
type CatalogModule = typeof import('@/lib/payment-center/catalog');
type EmbedModule = typeof import('@/lib/payment-center/embed');
type IntentsModule = typeof import('@/lib/billing/intents');
type SubmitModule = typeof import('@/lib/billing/submit');
type SubscriptionsModule = typeof import('@/lib/payment-center/subscriptions');
type ServiceModule = typeof import('@/lib/subscription/service');

type Captured = { method: string; path: string; headers: Record<string, string>; body: string };
type StubReply = { status: number; body?: unknown; headers?: Record<string, string> };

let sql: SqlClient;
let orders: OrdersModule;
let catalog: CatalogModule;
let embed: EmbedModule;
let intents: IntentsModule;
let submit: SubmitModule;
let subscriptions: SubscriptionsModule;
let service: ServiceModule;

let server: ReturnType<typeof createServer>;
let captured: Captured[] = [];
let reply: (request: Captured, index: number) => StubReply = () => ({
  status: 404,
  body: { status: 'error', message: 'not stubbed' },
});

const userIds: string[] = [];
const organizationIds: string[] = [];
const intentIds: string[] = [];

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        }
        const seen: Captured = {
          method: request.method ?? 'GET',
          path: new URL(request.url ?? '/', 'http://stub.invalid').pathname,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        const index = captured.push(seen) - 1;
        const answer = reply(seen, index);
        response.writeHead(answer.status, {
          'content-type': 'application/json',
          ...answer.headers,
        });
        response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function catalogBody(overrides: { siteCode?: string; unavailable?: Record<string, string> } = {}) {
  return {
    website_id: WEBSITE_ID(),
    site_code: overrides.siteCode ?? process.env.PAYMENT_CENTER_SITE_CODE,
    site_name: 'Vitest SaaS',
    methods: ['stripe', 'manual', 'blockchain', 'commission_balance', 'binance_pay'],
    unavailable_methods: overrides.unavailable ?? {},
    products: [{
      code: PRODUCT_CODE,
      name: 'Vitest plan',
      description: null,
      prices: [{ interval: 'month', amount: 37.5, amount_decimal: CATALOG_AMOUNT, currency: CURRENCY }],
    }],
  };
}

function success(data: unknown): StubReply {
  return { status: 200, body: { status: 'success', data } };
}

function catalogOk(): StubReply {
  return success(catalogBody());
}

type StubRoutes = {
  /** GET /api/payment-center/catalog */
  catalog?: StubReply | (() => StubReply);
  /** GET /api/payment-center/orders/:id */
  order?: (id: string) => StubReply;
  /** POST /api/payment-center/orders */
  create?: (body: Record<string, unknown>) => StubReply;
  /** POST /api/payment-center/embed-token */
  embed?: (body: Record<string, unknown>) => StubReply;
};

function routes(stub: StubRoutes): (request: Captured) => StubReply {
  return (request) => {
    if (request.path === '/api/payment-center/catalog') {
      const answer = stub.catalog;
      if (answer) return typeof answer === 'function' ? answer() : answer;
    }
    if (request.method === 'POST' && request.path === '/api/payment-center/embed-token') {
      if (stub.embed) return stub.embed(JSON.parse(request.body || '{}') as Record<string, unknown>);
    }
    if (request.method === 'GET' && request.path.startsWith('/api/payment-center/orders/')) {
      if (stub.order) return stub.order(decodeURIComponent(request.path.split('/').at(-1) ?? ''));
    }
    if (request.method === 'POST' && request.path === '/api/payment-center/orders') {
      if (stub.create) return stub.create(JSON.parse(request.body || '{}') as Record<string, unknown>);
    }
    return { status: 404, body: { status: 'error', message: 'not stubbed' } };
  };
}

function orderBody(intent: {
  id: string; externalOrderId: string; idempotencyKey: string; payerUserId: string;
  billingAccountId: string; productCode: string; priceInterval: string;
  amountDecimal: string; currency: string; method: string; organizationId: string;
}, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const kind = intent.method === 'stripe' && ['month', 'year'].includes(intent.priceInterval)
    ? 'subscription' : 'one_time';
  return {
    id: randomUUID(),
    website_id: WEBSITE_ID(),
    external_order_id: intent.externalOrderId,
    idempotency_key: intent.idempotencyKey,
    payer_external_user_id: intent.payerUserId,
    billing_account_id: intent.billingAccountId,
    payment_method: intent.method,
    kind,
    status: 'action_required',
    amount_decimal: intent.amountDecimal,
    currency: intent.currency,
    product_code: intent.productCode,
    recurrence_interval: intent.priceInterval,
    metadata: {
      organizationId: intent.organizationId,
      billingAccountId: intent.billingAccountId,
      payerUserId: intent.payerUserId,
      intentId: intent.id,
    },
    ...overrides,
  };
}

/** A fresh owner + personal workspace for one test. */
async function freshWorkspace() {
  const user = await createUserFixture();
  const organization = await createOrganizationFixture({ userId: user.userId });
  userIds.push(user.userId);
  organizationIds.push(organization.organizationId);
  return { userId: user.userId, organizationId: organization.organizationId };
}

async function quote(organizationId: string, userId: string, method: 'stripe' | 'manual' | 'blockchain' | 'commission_balance' | 'binance_pay', extra: Record<string, unknown> = {}) {
  const intent = await intents.preparePaymentIntent(organizationId, userId, {
    requestKey: randomUUID(),
    productCode: PRODUCT_CODE,
    priceInterval: 'month',
    currency: CURRENCY,
    method,
    ...extra,
  } as unknown as PreparePaymentIntentInput);
  intentIds.push(intent.id);
  return intent;
}

beforeAll(async () => {
  const baseUrl = await startStub();
  process.env.PAYMENT_CENTER_BASE_URL = baseUrl;
  sql = await getClient();
  orders = await import('@/lib/payment-center/orders');
  catalog = await import('@/lib/payment-center/catalog');
  embed = await import('@/lib/payment-center/embed');
  intents = await import('@/lib/billing/intents');
  submit = await import('@/lib/billing/submit');
  subscriptions = await import('@/lib/payment-center/subscriptions');
  service = await import('@/lib/subscription/service');
});

afterAll(async () => {
  await cleanupFixtures({ userIds, organizationIds, intentIds });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeClient();
});

beforeEach(() => {
  captured = [];
  reply = () => ({ status: 404, body: { status: 'error', message: 'not stubbed' } });
});

describe('the migrated billing schema the contract depends on (AC 9)', () => {
  it('runs against an isolated database that carries every billing table and key index', async () => {
    const [database] = await sql<{ current_database: string }[]>`SELECT current_database()`;
    expect(database?.current_database).toMatch(/^saas_framework_test_/);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    expect(tables.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      'billing_accounts', 'payment_intents', 'commission_grant_preparations',
      'payment_inbox', 'payment_evidence', 'subscription_grants', 'subscriptions',
      'referral_withdrawal_intents',
    ]));

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'billing_accounts_organization_unique',
      'payment_intents_request_unique',
      'payment_intents_external_order_unique',
      'payment_intents_idempotency_unique',
      'payment_intents_center_order_unique',
      // One open checkout per channel: a card checkout left open must not stop
      // the buyer paying by crypto or commission balance.
      'payment_intents_one_open_checkout_per_channel',
      'payment_evidence_website_key_unique',
      'subscription_grants_evidence_unique',
      'payment_inbox_status_received_idx',
      'referral_withdrawal_user_request_unique',
    ]));
  });

  it('reads the catalog from the documented endpoint with the server key and refuses another website (AC 9)', async () => {
    reply = () => ({ status: 200, body: { status: 'success', data: catalogBody() } });
    const seen: RequestInit[] = [];
    const recorded: typeof fetch = async (input, init) => {
      seen.push(init ?? {});
      return fetch(input, init);
    };

    const parsed = await catalog.getPaymentCatalog(recorded);
    expect(parsed.products[0]?.prices[0]?.amount_decimal).toBe(CATALOG_AMOUNT);
    expect(captured.at(-1)).toMatchObject({
      method: 'GET',
      path: '/api/payment-center/catalog',
    });
    expect(captured.at(-1)?.headers['x-api-key']).toBe(process.env.PAYMENT_CENTER_API_KEY);
    expect(seen.at(-1)).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(seen.at(-1)?.signal).toBeInstanceOf(AbortSignal);

    reply = () => ({ status: 200, body: { status: 'success', data: catalogBody({ siteCode: 'other-site' }) } });
    await expect(catalog.getPaymentCatalog()).rejects.toThrow(
      'Payment Center catalog belongs to a different website',
    );
  });
});

describe('the order request the SaaS builds (AC 9, AC 17)', () => {
  it('posts the pinned product, price, payer, workspace and version snapshot to the documented endpoint (AC 9, 17)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    const request: CenterCreateOrderRequest = {
      external_order_id: scopedId('order', uniqueSuffix()),
      idempotency_key: scopedId('order', uniqueSuffix()),
      payer_external_user_id: userId,
      billing_account_id: `ba_${randomUUID().replaceAll('-', '')}`,
      payment_method: 'manual',
      kind: 'one_time',
      product_code: PRODUCT_CODE,
      recurrence_interval: 'one_time',
      amount: CATALOG_AMOUNT,
      currency: CURRENCY,
      catalog_currency: CURRENCY,
      callback_url: 'http://localhost:3000/api/payment-center/webhook',
      metadata: {
        organizationId,
        billingAccountId: `ba_${randomUUID().replaceAll('-', '')}`,
        payerUserId: userId,
        intentId: `pi_${randomUUID().replaceAll('-', '')}`,
      },
    };
    // `orderBody` is deliberately loose (`Record<string, unknown>`): it is the
    // wire body of a stub, and the real parser is what proves the shape. The
    // double assertion is the same convention this file already uses further
    // down for the fulfilment service, and it keeps `as any` out of the suite.
    const echo: CenterOrder = {
      ...orderBody({
        id: request.metadata.intentId, externalOrderId: request.external_order_id,
        idempotencyKey: request.idempotency_key, payerUserId: request.payer_external_user_id,
        billingAccountId: request.billing_account_id, productCode: request.product_code,
        priceInterval: request.recurrence_interval, amountDecimal: request.amount,
        currency: request.currency, method: request.payment_method,
        organizationId: request.metadata.organizationId,
      }),
      billing_account_id: request.billing_account_id,
      metadata: request.metadata,
    } as unknown as CenterOrder;
    reply = () => ({
      status: 200,
      body: { status: 'success', data: { order: echo, action: { instructions: 'bank transfer' }, idempotent: false } },
    });

    const created = await orders.createCenterOrder(request);
    expect(captured.at(-1)).toMatchObject({ method: 'POST', path: '/api/payment-center/orders' });
    expect(captured.at(-1)?.headers['x-api-key']).toBe(process.env.PAYMENT_CENTER_API_KEY);
    expect(captured.at(-1)?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(captured.at(-1)?.body ?? '{}')).toEqual(request);
    expect(created.order.id).toBe(echo.id);
    expect(created.action).toEqual({ instructions: 'bank transfer' });

    // The amount is validated before any call leaves the process.
    await expect(orders.createCenterOrder({ ...request, amount: '0.000000001' }))
      .rejects.toThrow();
    expect(captured.filter((item) => item.method === 'POST')).toHaveLength(1);
  });

  it('never lets a client amount or Price ID reach the stored quote or the order (AC 17)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });

    const intent = await quote(organizationId, userId, 'manual', {
      amount: '0.01000000',
      priceId: 'price_evil',
      amount_decimal: '0.01000000',
    });

    // The catalog owns the price; the browser-supplied numbers were dropped.
    expect(intent.amountDecimal).toBe(CATALOG_AMOUNT);
    expect(intent.currency).toBe(CURRENCY);
    const [row] = await sql<{ amount_decimal: string; currency: string }[]>`
      SELECT amount_decimal, currency FROM payment_intents WHERE id = ${intent.id}
    `;
    expect(row?.amount_decimal).toBe(CATALOG_AMOUNT);

    // There is no column a client amount or provider price could be stored in.
    const priceColumns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'payment_intents'
        AND (column_name LIKE '%price_id%' OR column_name LIKE '%priceid%'
          OR column_name LIKE '%requested%' OR column_name LIKE '%client%'
          OR column_name LIKE '%quantity%')
    `;
    expect(priceColumns).toHaveLength(0);
    const guards = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('payment_intents_amount_decimal_check', 'payment_intents_currency_check')
    `;
    expect(guards).toHaveLength(2);

    captured = [];
    reply = routes({
      catalog: catalogOk,
      order: () => ({ status: 404, body: { status: 'error' } }),
      create: () => success({ order: orderBody(intent), action: {}, idempotent: false }),
    });
    await submit.submitPaymentIntent(intent.id, userId);

    const orderPost = captured.find((item) => item.method === 'POST' && item.path === '/api/payment-center/orders');
    const sent = JSON.parse(orderPost?.body ?? '{}') as Record<string, unknown>;
    expect(sent.amount).toBe(CATALOG_AMOUNT);
    expect(sent.product_code).toBe(PRODUCT_CODE);
    expect(sent.catalog_currency).toBe(CURRENCY);
    expect(sent.callback_url).toBe('http://localhost:3000/api/payment-center/webhook');
    expect(orderPost?.body).not.toContain('price_evil');
    expect(orderPost?.body).not.toContain('0.01000000');
  });

  it('replays the stored external order id and idempotency key without creating a second order (AC 17)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });
    const intent = await quote(organizationId, userId, 'manual');
    expect(intent.externalOrderId).toBe(intent.id);
    expect(intent.idempotencyKey).toBe(intent.id);

    const order: Record<string, unknown> = { ...orderBody(intent), status: 'action_required' };
    captured = [];
    reply = routes({
      catalog: catalogOk,
      order: () => ({ status: 404, body: { status: 'error' } }),
      create: () => success({ order, action: {}, idempotent: false }),
    });
    const first = await submit.submitPaymentIntent(intent.id, userId);
    expect(first.status).toBe('action_required');
    expect(captured.filter((item) => item.method === 'POST')).toHaveLength(1);

    // Replay: the same order is queried back, and a POST would now fail loudly.
    captured = [];
    reply = routes({
      catalog: catalogOk,
      order: () => success({ order }),
      create: () => ({ status: 500, body: { status: 'error' } }),
    });
    const replayed = await submit.submitPaymentIntent(intent.id, userId);
    expect(replayed.order.id).toBe(order.id);
    expect(captured.filter((item) => item.method === 'POST')).toHaveLength(0);

    const rows = await sql<{ id: string; external_order_id: string; idempotency_key: string }[]>`
      SELECT id, external_order_id, idempotency_key FROM payment_intents
      WHERE organization_id = ${organizationId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_order_id).toBe(intent.externalOrderId);
    expect(rows[0]?.idempotency_key).toBe(intent.idempotencyKey);

    // The same request key returns the pinned quote, a different quote is refused.
    const same = await intents.preparePaymentIntent(organizationId, userId, {
      requestKey: intent.requestKey, productCode: PRODUCT_CODE,
      priceInterval: 'month', currency: CURRENCY, method: 'manual',
    });
    expect(same.id).toBe(intent.id);
    await expect(intents.preparePaymentIntent(organizationId, userId, {
      requestKey: intent.requestKey, productCode: PRODUCT_CODE,
      priceInterval: 'month', currency: 'EUR', method: 'manual',
    })).rejects.toThrow('Request key was already used for a different quote');
  });
});

describe('manual and on-chain delivery gating (AC 20)', () => {
  it('ships nothing for a submitted manual payment and grants only once the centre reports the order paid (AC 20)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });
    const intent = await quote(organizationId, userId, 'manual');

    const order = orderBody(intent, { status: 'action_required' });
    captured = [];
    reply = routes({
      catalog: catalogOk,
      order: () => ({ status: 404, body: { status: 'error' } }),
      create: () => success({
        order, action: { proof_instructions: 'upload the bank receipt' }, idempotent: false,
      }),
    });
    const submitted = await submit.submitPaymentIntent(intent.id, userId);
    expect(submitted.status).toBe('action_required');
    expect(JSON.stringify(submitted.action)).toContain('upload the bank receipt');

    // Submitting evidence is not a delivery: no evidence, no grant, no active period.
    const evidence = await sql<{ id: string }[]>`
      SELECT id FROM payment_evidence WHERE intent_id = ${intent.id}
    `;
    expect(evidence).toHaveLength(0);
    const grants = await sql<{ id: string }[]>`
      SELECT id FROM subscription_grants WHERE organization_id = ${organizationId}
    `;
    expect(grants).toHaveLength(0);
    expect(await service.hasUnexpiredPaidPeriod(organizationId)).toBe(false);

    const settledAt = Math.floor(Date.now() / 1000) - 60;
    const period: PrepaidPeriod = {
      sourceEventId: randomUUID(), intentId: intent.id,
      providerPaymentId: `PC_${String(order.id)}`, amountDecimal: CATALOG_AMOUNT,
      currency: CURRENCY, settledAt,
      servicePeriodStart: settledAt, servicePeriodEnd: settledAt + 30 * 86_400,
      method: 'manual', interval: 'month',
    };
    // Approval is the gate: an unpaid order can never be fulfilled.
    await expect(service.fulfillSubscription(period, order as unknown as CenterOrder))
      .rejects.toThrow('Payment Center order is not paid');
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${organizationId}`)
      .toHaveLength(0);

    // The centre approves the same order; the same evidence now grants exactly one period.
    const paid = {
      ...order,
      status: 'paid',
      payment_details: { confirmed_amount_decimal: CATALOG_AMOUNT },
      provider_payment_id: `PC_${String(order.id)}`,
    } as unknown as CenterOrder;
    const fulfilled = await service.fulfillSubscription(period, paid);
    expect(fulfilled.duplicate).toBe(false);
    const after = await sql<{ id: string; status: string }[]>`
      SELECT id, status::text AS status FROM subscription_grants WHERE organization_id = ${organizationId}
    `;
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('active');
    expect(await service.hasUnexpiredPaidPeriod(organizationId)).toBe(true);
  });

  it('ships nothing while the chain is still being detected and refuses new on-chain orders when monitoring is down (AC 20)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });
    const intent = await quote(organizationId, userId, 'blockchain');

    const order = orderBody(intent, {
      status: 'action_required',
      // The buyer picked USDT, so the centre order settles in USDT while the
      // catalogue quote stays USD.
      currency: 'USDT',
      payment_details: { chain_status: 'detecting', deposit_address: '0x1111111111111111111111111111111111111111' },
    });
    captured = [];
    reply = routes({
      catalog: catalogOk,
      order: () => ({ status: 404, body: { status: 'error' } }),
      create: () => success({ order, action: order.payment_details, idempotent: false }),
    });
    const submitted = await submit.submitPaymentIntent(
      intent.id, userId, fetch, { blockchain: 'BSC', currency: 'USDT' },
    );
    expect(submitted.status).toBe('action_required');
    expect(submitted.order.status).toBe('action_required');
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${organizationId}`)
      .toHaveLength(0);
    expect(await sql`SELECT id FROM payment_evidence WHERE intent_id = ${intent.id}`).toHaveLength(0);

    const settledAt = Math.floor(Date.now() / 1000) - 60;
    await expect(service.fulfillSubscription({
      sourceEventId: randomUUID(), intentId: intent.id,
      providerPaymentId: 'PC_chain_detecting', amountDecimal: CATALOG_AMOUNT,
      currency: CURRENCY, settledAt,
      servicePeriodStart: settledAt, servicePeriodEnd: settledAt + 30 * 86_400,
      method: 'blockchain', interval: 'month',
    }, order as unknown as CenterOrder)).rejects.toThrow();
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${organizationId}`)
      .toHaveLength(0);

    // Monitoring unavailable: a new on-chain quote is refused outright.
    const other = await freshWorkspace();
    reply = routes({
      catalog: () => success(catalogBody({ unavailable: { blockchain: 'chain monitoring unavailable' } })),
    });
    await expect(quote(other.organizationId, other.userId, 'blockchain'))
      .rejects.toThrow('Payment method is unavailable');

    // An order that is only pending is re-quoted before the centre is called.
    const pending = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status::text AS status, last_error_code FROM payment_intents WHERE id = ${intent.id}
    `;
    expect(pending).toHaveLength(1);
    await sql`
      UPDATE payment_intents SET status = 'pending', payment_center_order_id = NULL,
        submission_lease_expires_at = NULL WHERE id = ${intent.id}
    `;
    captured = [];
    reply = routes({
      catalog: () => success(catalogBody({ unavailable: { blockchain: 'chain monitoring unavailable' } })),
      order: () => ({ status: 404, body: { status: 'error' } }),
    });
    await expect(submit.submitPaymentIntent(intent.id, userId))
      .rejects.toThrow('Stored quote is no longer available');
    expect(captured.filter((item) => item.path === '/api/payment-center/orders')).toHaveLength(0);
    const closed = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status::text AS status, last_error_code FROM payment_intents WHERE id = ${intent.id}
    `;
    expect(closed[0]?.status).toBe('failed');
    expect(closed[0]?.last_error_code).toBe('quote_changed');
  });
});

describe('the embedded widget contract (AC 9, AC 17)', () => {
  it('mints the embed session server-side with the website key and never sends that key to a browser (AC 9)', async () => {
    reply = routes({ embed: () => success({ token: 'embed-session-token', expires_in: 600 }) });

    const token = await embed.createEmbedToken('payer-42');
    expect(captured.at(-1)).toMatchObject({ method: 'POST', path: '/api/payment-center/embed-token' });
    expect(captured.at(-1)?.headers['x-api-key']).toBe(process.env.PAYMENT_CENTER_API_KEY);
    expect(JSON.parse(captured.at(-1)?.body ?? '{}')).toEqual({ external_user_id: 'payer-42' });
    expect(token).toEqual({ token: 'embed-session-token', expires_in: 600 });

    // The public half of the binding carries the identifiers the browser needs
    // and nothing else: the API key and the callback secret stay server-side.
    expect(Object.keys(embed.paymentCenterPublicConfig()).sort()).toEqual(['baseUrl', 'siteCode']);
    expect(embed.paymentCenterPublicConfig().siteCode).toBe(process.env.PAYMENT_CENTER_SITE_CODE);

    reply = routes({ embed: () => ({ status: 502, body: { status: 'error' } }) });
    await expect(embed.createEmbedToken('payer-42'))
      .rejects.toThrow('Payment Center embed token returned HTTP 502');

    reply = routes({ embed: () => success({ token: '', expires_in: 0 }) });
    await expect(embed.createEmbedToken('payer-42'))
      .rejects.toThrow('Payment Center embed token response is invalid');
  });

  it('pins the catalogue currency while carrying the chain asset the buyer picked (AC 17)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });
    const intent = await quote(organizationId, userId, 'blockchain');

    captured = [];
    reply = routes({
      catalog: catalogOk,
      order: () => ({ status: 404, body: { status: 'error' } }),
      create: () => success({
        order: orderBody(intent, { currency: 'USDT' }),
        action: { type: 'blockchain', deposit_address: '0x2222222222222222222222222222222222222222' },
        idempotent: false,
      }),
    });

    const submitted = await submit.submitPaymentIntent(
      intent.id, userId, fetch, { blockchain: 'BSC', currency: 'USDT' },
    );
    const sent = JSON.parse(
      captured.find((item) => item.method === 'POST' && item.path === '/api/payment-center/orders')?.body ?? '{}',
    ) as Record<string, unknown>;

    // The plan is priced in USD; the buyer settles it in USDT on the chain they
    // chose. The price the centre checks is still the catalogue's USD price.
    expect(sent).toMatchObject({
      payment_method: 'blockchain',
      currency: 'USDT',
      catalog_currency: CURRENCY,
      blockchain: 'BSC',
      amount: CATALOG_AMOUNT,
      recurrence_interval: 'month',
      kind: 'one_time',
    });
    expect(submitted.status).toBe('action_required');
    expect(submitted.order.currency).toBe('USDT');
  });

  it('pins the catalogue currency while carrying the Binance Pay asset the buyer picked (AC 17)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });
    const intent = await quote(organizationId, userId, 'binance_pay');

    captured = [];
    reply = routes({
      catalog: catalogOk,
      order: () => ({ status: 404, body: { status: 'error' } }),
      create: () => success({
        order: orderBody(intent, { currency: 'USDT' }),
        action: { type: 'binance_pay', receive_link: 'https://app.binance.com/payment/secpay?token=stub' },
        idempotent: false,
      }),
    });

    const submitted = await submit.submitPaymentIntent(
      intent.id, userId, fetch, { currency: 'USDT' },
    );
    const sent = JSON.parse(
      captured.find((item) => item.method === 'POST' && item.path === '/api/payment-center/orders')?.body ?? '{}',
    ) as Record<string, unknown>;

    // Binance Pay has no chain: only the chosen asset travels, and the price the
    // centre checks is still the catalogue's USD price.
    expect(sent).toMatchObject({
      payment_method: 'binance_pay',
      currency: 'USDT',
      catalog_currency: CURRENCY,
      amount: CATALOG_AMOUNT,
      recurrence_interval: 'month',
      kind: 'one_time',
    });
    expect(sent).not.toHaveProperty('blockchain');
    expect(submitted.status).toBe('action_required');
    expect(submitted.order.currency).toBe('USDT');
  });

  it('refuses a Binance Pay resume that lost the buyer asset selection (AC 17)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });
    const intent = await quote(organizationId, userId, 'binance_pay');

    captured = [];
    reply = routes({ catalog: catalogOk, order: () => ({ status: 404, body: { status: 'error' } }) });
    await expect(submit.submitPaymentIntent(intent.id, userId))
      .rejects.toThrow('Checkout must be restarted from the pricing page');
    expect(captured.filter((item) => item.path === '/api/payment-center/orders')).toHaveLength(0);

    const [row] = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status::text AS status, last_error_code FROM payment_intents WHERE id = ${intent.id}
    `;
    expect(row?.status).toBe('failed');
    expect(row?.last_error_code).toBe('payment_selection_missing');
  });

  it('refuses a blockchain resume that lost the buyer chain and asset selection (AC 17)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });
    const intent = await quote(organizationId, userId, 'blockchain');

    captured = [];
    reply = routes({ catalog: catalogOk, order: () => ({ status: 404, body: { status: 'error' } }) });
    await expect(submit.submitPaymentIntent(intent.id, userId))
      .rejects.toThrow('Checkout must be restarted from the pricing page');
    expect(captured.filter((item) => item.path === '/api/payment-center/orders')).toHaveLength(0);

    const [row] = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status::text AS status, last_error_code FROM payment_intents WHERE id = ${intent.id}
    `;
    expect(row?.status).toBe('failed');
    expect(row?.last_error_code).toBe('payment_selection_missing');
  });

  it('still refuses a crypto-denominated order for a card payment (AC 17)', async () => {
    const { userId, organizationId } = await freshWorkspace();
    reply = routes({ catalog: catalogOk });
    const intent = await quote(organizationId, userId, 'stripe');

    captured = [];
    reply = routes({
      catalog: catalogOk,
      order: () => ({ status: 404, body: { status: 'error' } }),
      create: () => success({
        order: orderBody(intent, { currency: 'USDT' }),
        action: { checkout_url: 'https://checkout.stripe.test/session' },
        idempotent: false,
      }),
    });

    await expect(submit.submitPaymentIntent(intent.id, userId)).rejects.toThrow();
    const [row] = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status::text AS status, last_error_code FROM payment_intents WHERE id = ${intent.id}
    `;
    expect(row?.status).toBe('manual_review');
    expect(row?.last_error_code).toBe('order_mismatch');
  });
});

describe('subscription control contract (AC 9)', () => {
  it('delegates auto-renew to the centre by billing account and refuses another account receipt (AC 9)', async () => {
    const accountId = `ba_${randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${randomUUID().replaceAll('-', '')}`;
    const receipt = {
      order_id: randomUUID(), website_id: WEBSITE_ID(),
      billing_account_id: accountId, provider_subscription_id: subscriptionId,
      status: 'active', cancel_at_period_end: true, current_period_end: 1_800_000_000,
    };
    reply = () => ({ status: 200, body: { status: 'success', data: receipt } });

    await subscriptions.setCenterAutoRenew(accountId, subscriptionId, true);
    expect(captured.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/payment-center/subscriptions/by-account/${accountId}/${subscriptionId}/auto-renew`,
    });
    expect(captured.at(-1)?.headers['x-api-key']).toBe(process.env.PAYMENT_CENTER_API_KEY);
    expect(JSON.parse(captured.at(-1)?.body ?? '{}')).toEqual({ enabled: true });

    await subscriptions.queryCenterSubscription(accountId, subscriptionId);
    expect(captured.at(-1)).toMatchObject({
      method: 'GET',
      path: `/api/payment-center/subscriptions/by-account/${accountId}/${subscriptionId}`,
    });

    reply = () => ({
      status: 200,
      body: { status: 'success', data: { ...receipt, billing_account_id: 'ba_someone_else' } },
    });
    await expect(subscriptions.queryCenterSubscription(accountId, subscriptionId))
      .rejects.toThrow('Payment Center subscription belongs to another account');
  });
});
