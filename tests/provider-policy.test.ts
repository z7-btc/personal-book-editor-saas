import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AC13/AC14 — the subscription is bound to the caller's own personal billing
 * space, every checkout is pinned by server-side identity, and switching the
 * payment channel fails closed by default.
 *
 * Real, isolated PostgreSQL per file. Only the Payment Center HTTP contract is
 * mocked (catalog + order endpoints): the tests assert against the SQL rows the
 * application writes and the exact request bodies it sends.
 *
 * Deviation recorded for the Lead: the plan's `planVersion` pin does not exist
 * in this repository (payment_intents has no plan_version column and the order
 * metadata schema is strict on four keys). The equivalent behaviour that IS
 * implemented is the stored quote: `submitPaymentIntent` re-validates the
 * captured amount against the live catalog and fails the intent closed when the
 * price moved, which is what 'captured quote' below asserts.
 */
const siteId = '00000000-0000-4000-8000-000000000001';
process.env.FEATURE_PAYMENT_CENTER = 'true';
// This file asserts the closed-by-default channel, so the flag is pinned off
// here instead of inherited from the developer's `.env`: with it on, the run
// exercises a different behaviour. `lib/config.ts` snapshots the matrix when it
// is first evaluated, which is why the pin has to sit above the dynamic imports.
process.env.FEATURE_COMMISSION_BALANCE = 'false';
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
  }, {
    // A plan a third of the price, so a switch out of Pro converts each remaining
    // day into three and the exchange is unmistakable in the assertions.
    code: 'starter',
    name: 'Starter',
    description: null,
    prices: [
      { interval: 'month', amount: 5, amount_decimal: '5.00000000', currency: 'USD' },
      { interval: 'year', amount: 50, amount_decimal: '50.00000000', currency: 'USD' },
    ],
  }],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });
}

let unavailableMethods: Record<string, string> = {};
let priceOverrides: Record<string, string> = {};
let orderPatch: Partial<CenterOrder> | null = null;
const storedOrders = new Map<string, CenterOrder>();
let calls: Array<{ method: string; path: string; body: Json | null }> = [];

function orderFromRequest(request: Json, status: string): CenterOrder {
  return {
    id: `center_${String(request.external_order_id)}`,
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
    ...(request.payment_method === 'stripe'
      ? { provider_subscription_id: `sub_${String(request.external_order_id)}` }
      : { provider_payment_id: `pay_${String(request.external_order_id)}` }),
  };
}

/** Mocked Payment Center: catalog, order creation and order query only. */
const centerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = new URL(url).pathname;
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Json : null;
  calls.push({ method, path, body });

  if (path === '/api/payment-center/catalog') {
    return json({
      status: 'success',
      data: {
        ...catalog,
        unavailable_methods: unavailableMethods,
        products: catalog.products.map((product) => ({
          ...product,
          prices: product.prices.map((price) => ({
            ...price,
            amount_decimal: priceOverrides[`${product.code}:${price.interval}:${price.currency}`]
              ?? price.amount_decimal,
          })),
        })),
      },
    });
  }
  if (path === '/api/payment-center/orders' && method === 'POST' && body) {
    const order = { ...orderFromRequest(body, 'action_required'), ...(orderPatch ?? {}) };
    storedOrders.set(order.external_order_id, order);
    return json({ status: 'success', data: { order, action: {}, idempotent: false } });
  }
  const query = /^\/api\/payment-center\/orders\/(.+)$/.exec(path);
  if (query && method === 'GET') {
    const order = storedOrders.get(decodeURIComponent(query[1]!));
    if (!order) return new Response('', { status: 404 });
    return json({ status: 'success', data: { order: { ...order, ...(orderPatch ?? {}) } } });
  }
  return new Response('', { status: 404 });
}) as typeof fetch;

function orderCalls() {
  return calls.filter((call) => call.method === 'POST' && call.path === '/api/payment-center/orders');
}

const scope: { userIds: string[]; organizationIds: string[]; intentIds: string[] } = {
  userIds: [], organizationIds: [], intentIds: [],
};

type Workspace = {
  userId: string; organizationId: string; billingAccountId: string; suffix: string;
};

let fixtures: typeof import('./support/fixtures');
let billing: typeof import('@/lib/billing/account');
let intents: typeof import('@/lib/billing/intents');
let submit: typeof import('@/lib/billing/submit');
let service: typeof import('@/lib/subscription/service');
let controls: typeof import('@/lib/billing/subscription-controls');
let client: Sql;

beforeAll(async () => {
  fixtures = await import('./support/fixtures');
  client = await fixtures.getClient();
  billing = await import('@/lib/billing/account');
  intents = await import('@/lib/billing/intents');
  submit = await import('@/lib/billing/submit');
  service = await import('@/lib/subscription/service');
  controls = await import('@/lib/billing/subscription-controls');
  vi.stubGlobal('fetch', centerFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await fixtures.cleanupFixtures(scope);
  await fixtures.closeClient();
});

beforeEach(() => {
  unavailableMethods = {};
  priceOverrides = {};
  orderPatch = null;
  storedOrders.clear();
  calls = [];
});

async function seedWorkspace(): Promise<Workspace> {
  const user = await fixtures.createUserFixture();
  scope.userIds.push(user.userId);
  const organization = await fixtures.createOrganizationFixture({ userId: user.userId });
  scope.organizationIds.push(organization.organizationId);
  return {
    userId: user.userId,
    organizationId: organization.organizationId,
    billingAccountId: '',
    suffix: user.suffix,
  };
}

function quote(interval: 'one_time' | 'month' | 'year' = 'month') {
  return {
    requestKey: randomUUID(),
    productCode: 'pro',
    priceInterval: interval,
    currency: 'USD',
    method: 'stripe' as const,
  };
}

async function intentRows(organizationId: string) {
  return client<{
    id: string; status: string; billing_account_id: string; payer_user_id: string;
    payment_center_order_id: string | null; last_error_code: string | null;
    amount_decimal: string;
  }[]>`SELECT id, status::text, billing_account_id, payer_user_id, payment_center_order_id,
      last_error_code, amount_decimal
    FROM payment_intents WHERE organization_id = ${organizationId} ORDER BY created_at`;
}

async function grantCount(organizationId: string) {
  const [row] = await client<{ count: number }[]>`
    SELECT COUNT(*)::integer AS count FROM subscription_grants
    WHERE organization_id = ${organizationId}`;
  return row!.count;
}

/** Opens a paid Stripe period through the same command the webhook uses. */
async function openStripePeriod(workspace: Workspace) {
  const created = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
    requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
    currency: 'USD', method: 'stripe',
  });
  scope.intentIds.push(created.id);
  const order = {
    ...orderFromRequest({
      external_order_id: created.externalOrderId,
      idempotency_key: created.idempotencyKey,
      payer_external_user_id: workspace.userId,
      billing_account_id: created.billingAccountId,
      payment_method: 'stripe',
      kind: 'subscription',
      amount: created.amountDecimal,
      currency: created.currency,
      product_code: created.productCode,
      recurrence_interval: created.priceInterval,
      metadata: {
        organizationId: workspace.organizationId,
        billingAccountId: created.billingAccountId,
        payerUserId: workspace.userId,
        intentId: created.id,
      },
    }, 'paid'),
    provider_subscription_id: `sub_${created.id}`,
  } as CenterOrder;
  await service.fulfillSubscription({
    sourceEventId: randomUUID(),
    intentId: created.id,
    providerInvoiceId: `INV-${created.id}`,
    providerSubscriptionId: `sub_${created.id}`,
    providerPaymentId: null,
    amountDecimal: created.amountDecimal,
    currency: created.currency,
    settledAt: periodStart,
    servicePeriodStart: periodStart,
    servicePeriodEnd: periodEnd,
  }, order, new Date(nowSeconds * 1000));
  workspace.billingAccountId = created.billingAccountId;
  return created;
}

describe('billing identity is the personal workspace, pinned server-side (AC13)', () => {
  it('issues one stable billing account per workspace under concurrent calls', async () => {
    const workspace = await seedWorkspace();
    const accounts = await Promise.all(Array.from({ length: 5 }, () =>
      billing.ensureBillingAccount(workspace.organizationId, workspace.userId)));

    expect(new Set(accounts.map((account) => account.id)).size).toBe(1);
    expect(accounts[0]!.originalPayerUserId).toBe(workspace.userId);
    const [row] = await client<{ count: number; external_billing_id: string }[]>`
      SELECT COUNT(*)::integer AS count, MIN(external_billing_id) AS external_billing_id
      FROM billing_accounts WHERE organization_id = ${workspace.organizationId}`;
    expect(row!.count).toBe(1);
    expect(row!.external_billing_id).toBe(accounts[0]!.id);
  });

  it('refuses billing for a member who is not the owner, and for a stranger', async () => {
    const workspace = await seedWorkspace();
    const member = await fixtures.createUserFixture();
    scope.userIds.push(member.userId);
    await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
      VALUES (${fixtures.scopedId('member', member.suffix)}, ${workspace.organizationId},
        ${member.userId}, 'member', now())`;
    const stranger = await fixtures.createUserFixture();
    scope.userIds.push(stranger.userId);

    await expect(billing.ensureBillingAccount(workspace.organizationId, member.userId))
      .rejects.toThrow('Personal billing requires the account owner');
    await expect(billing.ensureBillingAccount(workspace.organizationId, stranger.userId))
      .rejects.toThrow('Personal billing requires the account owner');
    await expect(intents.preparePaymentIntent(workspace.organizationId, stranger.userId, quote()))
      .rejects.toThrow('Personal billing requires the account owner');
    const [row] = await client<{ count: number }[]>`
      SELECT COUNT(*)::integer AS count FROM billing_accounts
      WHERE organization_id = ${workspace.organizationId}`;
    expect(row!.count).toBe(0);
  });

  it('ignores a browser-supplied billing account or payer and uses the caller own row', async () => {
    const workspace = await seedWorkspace();
    const other = await seedWorkspace();
    const forged = await billing.ensureBillingAccount(other.organizationId, other.userId);

    const created = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      ...quote(),
      billingAccountId: forged.id,
      payerUserId: other.userId,
      metadata: { billingAccountId: forged.id },
    } as never);
    scope.intentIds.push(created.id);

    expect(created.billingAccountId).not.toBe(forged.id);
    expect(created.payerUserId).toBe(workspace.userId);
    const [row] = await client<{ billing_account_id: string; payer_user_id: string }[]>`
      SELECT billing_account_id, payer_user_id FROM payment_intents WHERE id = ${created.id}`;
    expect(row!.payer_user_id).toBe(workspace.userId);
    expect(row!.billing_account_id).not.toBe(forged.id);
    // The order contract itself is strict: a foreign billing account cannot pass.
    const order = orderFromRequest({
      external_order_id: created.externalOrderId,
      idempotency_key: created.idempotencyKey,
      payer_external_user_id: workspace.userId,
      billing_account_id: forged.id,
      payment_method: 'stripe',
      kind: 'subscription',
      amount: created.amountDecimal,
      currency: created.currency,
      product_code: created.productCode,
      recurrence_interval: created.priceInterval,
      metadata: {
        organizationId: workspace.organizationId,
        billingAccountId: created.billingAccountId,
        payerUserId: workspace.userId,
        intentId: created.id,
      },
    }, 'action_required');
    const orders = await import('@/lib/payment-center/orders');
    expect(() => orders.assertOrderMatchesIntent(created, order)).toThrow(
      'Payment Center order does not match the stored intent',
    );
  });
});

describe('four channels, one pinned order contract (AC14)', () => {
  it.each(['stripe', 'manual', 'blockchain'] as const)(
    'creates the %s checkout with the pinned billing identity',
    async (method) => {
      const workspace = await seedWorkspace();
      const created = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
        ...quote(), method,
      });
      scope.intentIds.push(created.id);
      const settlement = method === 'blockchain' ? { blockchain: 'BSC', currency: 'USDT' } : undefined;
      const result = await submit.submitPaymentIntent(
        created.id, workspace.userId, centerFetch, settlement,
      );
      expect(result.status).toBe('action_required');

      const posted = orderCalls();
      expect(posted).toHaveLength(1);
      expect(posted[0]!.body).toMatchObject({
        payer_external_user_id: workspace.userId,
        billing_account_id: created.billingAccountId,
        payment_method: method,
        kind: method === 'stripe' ? 'subscription' : 'one_time',
        recurrence_interval: 'month',
        amount: '15.00000000',
        // The plan is priced in USD. Only the chain channel settles a different
        // asset, and it names both the asset and the network the buyer picked.
        currency: method === 'blockchain' ? 'USDT' : 'USD',
        catalog_currency: 'USD',
        ...(method === 'blockchain' ? { blockchain: 'BSC' } : {}),
      });
      expect(Object.keys(posted[0]!.body!.metadata as Json).sort()).toEqual(
        ['billingAccountId', 'intentId', 'organizationId', 'payerUserId']);
      const [row] = await intentRows(workspace.organizationId);
      expect(row!.status).toBe('action_required');
      expect(row!.payment_center_order_id).toBe(`center_${created.externalOrderId}`);
    },
  );

  it('turns a tampered order into manual review instead of a benefit', async () => {
    const workspace = await seedWorkspace();
    const created = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, quote());
    scope.intentIds.push(created.id);
    orderPatch = { billing_account_id: 'ba_foreign' };

    await expect(submit.submitPaymentIntent(created.id, workspace.userId, centerFetch))
      .rejects.toThrow('Payment Center order does not match the stored intent');
    const [row] = await intentRows(workspace.organizationId);
    expect(row!.status).toBe('manual_review');
    expect(row!.last_error_code).toBe('order_mismatch');
    expect(await grantCount(workspace.organizationId)).toBe(0);
  });

  it('fails closed when the captured quote no longer matches the catalog', async () => {
    const workspace = await seedWorkspace();
    const created = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, quote());
    scope.intentIds.push(created.id);
    priceOverrides['pro:month:USD'] = '20.00000000';

    await expect(submit.submitPaymentIntent(created.id, workspace.userId, centerFetch))
      .rejects.toThrow('Stored quote is no longer available');
    const [row] = await intentRows(workspace.organizationId);
    expect(row!.status).toBe('failed');
    expect(row!.last_error_code).toBe('quote_changed');
    expect(orderCalls()).toHaveLength(0);
  });

  it('resumes the one open checkout and locks only that channel', async () => {
    const workspace = await seedWorkspace();
    const first = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, quote());
    scope.intentIds.push(first.id);
    await submit.submitPaymentIntent(first.id, workspace.userId, centerFetch);

    // The same channel with the same quote resumes the checkout already open.
    const sameQuote = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, quote());
    expect(sameQuote.id).toBe(first.id);

    // A buyer who opened a card checkout and changed their mind must still be
    // able to pay by crypto: the unpaid-order lock is per channel, not per
    // workspace.
    const blockchain = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
      currency: 'USD', method: 'blockchain',
    });
    scope.intentIds.push(blockchain.id);
    expect(blockchain.method).toBe('blockchain');
    expect(blockchain.id).not.toBe(first.id);

    // Within a channel the rule is unchanged: once that channel has an open
    // order, a second quote on it is refused.
    await submit.submitPaymentIntent(blockchain.id, workspace.userId, centerFetch,
      { blockchain: 'BSC', currency: 'USDT' });
    await expect(intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'year',
      currency: 'USD', method: 'blockchain',
    })).rejects.toThrow('Workspace already has a pending checkout');
    expect(await intentRows(workspace.organizationId)).toHaveLength(2);
  });

  it('keeps the default channel when the catalog marks a method unavailable', async () => {
    const workspace = await seedWorkspace();
    unavailableMethods = { blockchain: 'maintenance' };
    await expect(intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      ...quote(), method: 'blockchain',
    })).rejects.toThrow('Payment method is unavailable');
    await expect(intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      ...quote(), productCode: 'missing',
    })).rejects.toThrow('Selected catalog price is unavailable');
    await expect(intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      ...quote(), method: 'commission_balance',
    })).rejects.toThrow('Payment method is unavailable');
  });
});

describe('a running period no longer blocks another channel (AC14)', () => {
  it('quotes and submits a second channel while a period is unexpired', async () => {
    const workspace = await seedWorkspace();
    await openStripePeriod(workspace);

    // The same plan bought again, this time by crypto. It is a continuation — the
    // span is stitched onto the running period at fulfilment, see
    // `subscription-grants.test.ts` — not a second sale of the same time, so it is
    // quoted and submitted like any other order instead of being turned away.
    const quoted = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
      currency: 'USD', method: 'blockchain',
    });
    scope.intentIds.push(quoted.id);
    expect(quoted.method).toBe('blockchain');

    const manual = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
      currency: 'USD', method: 'manual',
    });
    scope.intentIds.push(manual.id);
    const submitted = await submit.submitPaymentIntent(manual.id, workspace.userId, centerFetch);
    expect(submitted.status).toBe('action_required');

    // Submitted is not paid: the grant only appears once the centre confirms the
    // money moved, so the running period is still the only one.
    expect(await grantCount(workspace.organizationId)).toBe(1);
  });

  it('prices the exchange when a prepaid channel takes over the plan', async () => {
    const workspace = await seedWorkspace();
    await openStripePeriod(workspace);

    // Leaving Pro for Starter, paid by crypto. Pro is worth three times as much
    // per day, so the ~28 days left convert into ~84 days of Starter. Pricing it
    // at checkout is what lets fulfilment grant the converted span without
    // re-reading the catalogue.
    const switched = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'starter', priceInterval: 'month',
      currency: 'USD', method: 'blockchain',
    });
    scope.intentIds.push(switched.id);
    const now = Date.now();
    expect(switched.proratedPeriodEnd).toBeInstanceOf(Date);
    expect(switched.proratedPeriodEnd!.getTime()).toBeGreaterThan(now + 83 * DAY * 1000);
    expect(switched.proratedPeriodEnd!.getTime()).toBeLessThan(now + 85 * DAY * 1000);
  });

  it('still finds the live Stripe subscription behind a newer prepaid purchase', async () => {
    const workspace = await seedWorkspace();
    const opened = await openStripePeriod(workspace);

    // A prepaid top-up of the same plan becomes the workspace's newest grant, so
    // the aggregate row flips to `manual` with no subscription id — while the
    // Stripe mandate carries on charging. Reading the aggregate would lose it,
    // and the billing page's auto-renew switch depends on finding it.
    const topUp = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
      currency: 'USD', method: 'manual',
    });
    scope.intentIds.push(topUp.id);
    const order = orderFromRequest({
      external_order_id: topUp.externalOrderId,
      idempotency_key: topUp.idempotencyKey,
      payer_external_user_id: workspace.userId,
      billing_account_id: topUp.billingAccountId,
      payment_method: 'manual',
      kind: 'one_time',
      amount: topUp.amountDecimal,
      currency: topUp.currency,
      product_code: topUp.productCode,
      recurrence_interval: topUp.priceInterval,
      metadata: {
        organizationId: workspace.organizationId,
        billingAccountId: topUp.billingAccountId,
        payerUserId: workspace.userId,
        intentId: topUp.id,
      },
    }, 'paid');
    await service.fulfillSubscription({
      sourceEventId: randomUUID(),
      intentId: topUp.id,
      providerPaymentId: `pay_${topUp.externalOrderId}`,
      amountDecimal: topUp.amountDecimal,
      currency: topUp.currency,
      settledAt: nowSeconds,
      servicePeriodStart: nowSeconds,
      servicePeriodEnd: nowSeconds + 30 * DAY,
      method: 'manual',
      interval: 'month',
    }, order);

    const [aggregate] = await client<{ payment_method: string | null;
      provider_subscription_id: string | null }[]>`
      SELECT payment_method, provider_subscription_id FROM subscriptions
      WHERE organization_id = ${workspace.organizationId}`;
    expect(aggregate!.payment_method).toBe('manual');
    expect(aggregate!.provider_subscription_id).toBeNull();

    const binding = await controls.getAuthorizedStripeSubscription(
      workspace.organizationId, workspace.userId);
    expect(binding?.providerSubscriptionId).toBe(`sub_${opened.id}`);
    expect(binding?.productCode).toBe('pro');
  });

  it('still allows a one-time purchase while a paid period is active', async () => {
    const workspace = await seedWorkspace();
    await openStripePeriod(workspace);
    const created = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'one_time',
      currency: 'USD', method: 'manual',
    });
    scope.intentIds.push(created.id);
    expect(created.priceInterval).toBe('one_time');
  });

  it('allows a Stripe renewal while a paid period is active', async () => {
    const workspace = await seedWorkspace();
    await openStripePeriod(workspace);

    // The buyer pays again from the pricing page while access is still running:
    // the new subscription continues the period instead of being turned away.
    const renewal = await intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
      currency: 'USD', method: 'stripe',
    });
    scope.intentIds.push(renewal.id);
    expect(renewal.method).toBe('stripe');
  });

  it('refuses a one-time card checkout before any order can take money', async () => {
    const workspace = await seedWorkspace();
    await expect(intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'one_time',
      currency: 'USD', method: 'stripe',
    })).rejects.toThrow('One-time checkout is not available for redirect payment');
    // Nothing was quoted, nothing reached the centre: a card order that cannot be
    // fulfilled must never be created.
    expect(await intentRows(workspace.organizationId)).toHaveLength(0);
    expect(orderCalls()).toHaveLength(0);
  });

  it('keeps commission_balance closed until the flag is on', async () => {
    const workspace = await seedWorkspace();
    // Assert the snapshot the code really reads, not the raw variable: a
    // developer who turns the flag on in `.env` must not be able to make this
    // file assert one thing while the product does another.
    const { features } = await import('@/lib/config');
    expect(features.commissionBalance).toBe(false);
    await expect(intents.preparePaymentIntent(workspace.organizationId, workspace.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
      currency: 'USD', method: 'commission_balance',
    })).rejects.toThrow('Payment method is unavailable');
  });
});

describe('a refused checkout names the dead end it hit (AC13)', () => {
  /**
   * A refusal used to be one sentence covering two unrelated dead ends — "you
   * already have a paid period or another unpaid order" — which sent people
   * hunting for an unpaid order that did not exist. Buying on top of a running
   * period is no longer a refusal at all; a channel already holding an unpaid
   * order still is, and the route needs a code to say so.
   */
  it('names the channel that is already holding an unpaid order', async () => {
    const busy = await seedWorkspace();
    const open = await intents.preparePaymentIntent(busy.organizationId, busy.userId, quote());
    scope.intentIds.push(open.id);
    await submit.submitPaymentIntent(open.id, busy.userId, centerFetch);
    await expect(intents.preparePaymentIntent(busy.organizationId, busy.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'year',
      currency: 'USD', method: 'stripe',
    })).rejects.toMatchObject({ code: 'pending_checkout' });

    // The lock is per channel, never per workspace: the unpaid card order must
    // not stand in the way of paying by crypto instead.
    const other = await intents.preparePaymentIntent(busy.organizationId, busy.userId, {
      requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
      currency: 'USD', method: 'blockchain',
    });
    scope.intentIds.push(other.id);
    expect(other.method).toBe('blockchain');
  });
});
