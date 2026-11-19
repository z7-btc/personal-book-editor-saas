/**
 * Payment Center -> SaaS callback contract and inbox worker (plan AC 18, AC 30).
 *
 * Every Payment Center HTTP call in this file is served by an injected `send`
 * stub (the live centre at http://127.0.0.1:5000 is not running while the suite
 * executes) and each test name says so. The callback signature, the durable
 * inbox rows, the lease handling and the grant are all real and run against the
 * isolated migrated PostgreSQL database.
 *
 * `lib/config.ts` snapshots `features` at module evaluation, so the feature flag
 * is set here at module scope and every module under test is imported
 * dynamically from `beforeAll`.
 */
process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL ||= 'http://127.0.0.1:5000';
process.env.PAYMENT_CENTER_API_KEY ||= 'vitest-payment-center-api-key';
process.env.PAYMENT_CENTER_SITE_CODE ||= 'sf118b3fa313264a';
process.env.PAYMENT_CENTER_WEBSITE_ID ||= '544d8d48-a2a9-4a18-b3a8-4b4ceae7c387';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET ||=
  'vitest-callback-signing-secret-0123456789abcdef';

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupFixtures, closeClient, createOrganizationFixture, createUserFixture,
  getClient, scopedId, uniqueSuffix,
} from './support/fixtures';

const SIGNING_SECRET = process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET as string;
const PRODUCT_CODE = 'vitest-plan';
const AMOUNT = '37.50000000';
const CURRENCY = 'USD';
const SHA_PATTERN = '0123456789abcdef'.repeat(4);
const SUBSCRIPTION_ID = `sub_${'a1b2c3d4'.repeat(4)}`;

type SqlClient = Awaited<ReturnType<typeof getClient>>;
type WebhookModule = typeof import('@/lib/payment-center/webhook');
type RouteModule = typeof import('@/app/api/payment-center/webhook/route');
type InboxModule = typeof import('@/lib/payment-center/inbox-worker');

let sql: SqlClient;
let webhook: WebhookModule;
let route: RouteModule;
let inbox: InboxModule;

const userIds: string[] = [];
const organizationIds: string[] = [];
const intentIds: string[] = [];

type Fixture = {
  userId: string;
  organizationId: string;
  billingAccountId: string;
  intentId: string;
  externalOrderId: string;
  centerOrderId: string;
  method: string;
  priceInterval: string;
  amountDecimal: string;
  currency: string;
};

const secret = () => process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET ?? SIGNING_SECRET;
const websiteId = () => process.env.PAYMENT_CENTER_WEBSITE_ID as string;

/** Seeds an owner, a workspace, a billing account and a payable intent. */
async function seedIntent(
  method: 'stripe' | 'manual' | 'blockchain' | 'commission_balance',
  options: { priceInterval?: string; status?: string; centerOrderId?: string | null } = {},
): Promise<Fixture> {
  const user = await createUserFixture();
  const organization = await createOrganizationFixture({ userId: user.userId });
  userIds.push(user.userId);
  organizationIds.push(organization.organizationId);
  const account = await import('@/lib/billing/account').then((module) =>
    module.ensureBillingAccount(organization.organizationId, user.userId));
  const intentId = `pi_${randomUUID().replaceAll('-', '')}`;
  const externalOrderId = scopedId('order', uniqueSuffix());
  const centerOrderId = options.centerOrderId ?? randomUUID();
  const priceInterval = options.priceInterval ?? 'month';
  await sql`
    INSERT INTO payment_intents (
      id, organization_id, billing_account_id, payer_user_id, request_key,
      product_code, price_interval, amount_decimal, currency, method, payment_action,
      status, external_order_id, idempotency_key, payment_center_order_id
    ) VALUES (
      ${intentId}, ${organization.organizationId}, ${account.id}, ${user.userId}, ${randomUUID()},
      ${PRODUCT_CODE}, ${priceInterval}, ${AMOUNT}, ${CURRENCY}, ${method},
      CASE ${method} WHEN 'stripe' THEN 'redirect'
        WHEN 'commission_balance' THEN 'commission_reserved'
        WHEN 'blockchain' THEN 'blockchain' WHEN 'binance_pay' THEN 'binance_pay'
        ELSE 'manual' END,
      ${options.status ?? 'pending'},
      ${externalOrderId}, ${externalOrderId}, ${centerOrderId}
    )
  `;
  intentIds.push(intentId);
  return {
    userId: user.userId,
    organizationId: organization.organizationId,
    billingAccountId: account.id,
    intentId,
    externalOrderId,
    centerOrderId,
    method,
    priceInterval,
    amountDecimal: AMOUNT,
    currency: CURRENCY,
  };
}

function centerOrderFor(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    id: fixture.centerOrderId,
    website_id: websiteId(),
    external_order_id: fixture.externalOrderId,
    idempotency_key: fixture.externalOrderId,
    payer_external_user_id: fixture.userId,
    billing_account_id: fixture.billingAccountId,
    payment_method: fixture.method,
    kind: fixture.method === 'stripe' && fixture.priceInterval !== 'one_time'
      ? 'subscription' : 'one_time',
    status: 'paid',
    amount_decimal: fixture.amountDecimal,
    currency: fixture.currency,
    product_code: PRODUCT_CODE,
    recurrence_interval: fixture.priceInterval,
    provider_subscription_id: SUBSCRIPTION_ID,
    provider_payment_id: `PC_${fixture.centerOrderId}`,
    metadata: {
      organizationId: fixture.organizationId,
      billingAccountId: fixture.billingAccountId,
      payerUserId: fixture.userId,
      intentId: fixture.intentId,
    },
    ...overrides,
  };
}

function callbackBody(
  fixture: Fixture,
  options: { eventId: string; type: string; order?: Record<string, unknown>; data?: Record<string, unknown> },
): Record<string, unknown> {
  return {
    id: options.eventId,
    type: options.type,
    data: { order: centerOrderFor(fixture, options.order), ...options.data },
  };
}

function periodData(overrides: Record<string, unknown> = {}) {
  const settledAt = Math.floor(Date.now() / 1000) - 120;
  const unique = randomUUID().replaceAll('-', '');
  return {
    contract_version: 1,
    evidence_complete: true,
    // Evidence is keyed `invoice:<id>` per website, so every period must be unique.
    provider_invoice_id: `in_${unique}`,
    provider_subscription_id: SUBSCRIPTION_ID,
    provider_payment_id: `PC_${unique}`,
    amount_paid_decimal: AMOUNT,
    currency: CURRENCY,
    settled_at: settledAt,
    service_period_start: settledAt,
    service_period_end: settledAt + 30 * 86_400,
    ...overrides,
  };
}

function signedHeaders(raw: string, eventId: string, at = Math.floor(Date.now() / 1000), key = secret()) {
  const signature = createHmac('sha256', key)
    .update(`${at}.`)
    .update(Buffer.from(raw, 'utf8'))
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-payment-center-timestamp': String(at),
    'x-payment-center-signature': `sha256=${signature}`,
    'x-payment-center-event': eventId,
  };
}

async function deliver(body: unknown, options: { eventId?: string; raw?: string; key?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(body);
  const eventId = options.eventId ?? (body as { id: string }).id;
  const request = new Request('http://localhost:3000/api/payment-center/webhook', {
    method: 'POST',
    headers: signedHeaders(raw, eventId, Math.floor(Date.now() / 1000), options.key ?? secret()),
    body: raw,
  });
  const response = await route.POST(request);
  return { response, raw, payload: await response.json() as Record<string, unknown> };
}

function envelope(body: unknown) {
  return { status: 'success', data: { event: body, delivery_status: 'delivered' } };
}

/** `/api/payment-center/orders/:id` answers with `data.order`, not `data.event`. */
function orderEnvelope(order: unknown) {
  return { status: 'success', data: { order } };
}

type CenterStubOptions = {
  event?: unknown | (() => unknown);
  order?: unknown | (() => unknown);
  onCall?: (url: string) => Promise<void> | void;
};

/** Injected Payment Center transport: the centre is an external network here. */
function centerStub(options: CenterStubOptions) {
  const calls: string[] = [];
  const pick = (value: unknown | (() => unknown)) =>
    (typeof value === 'function' ? (value as () => unknown)() : value);
  const send = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    await options.onCall?.(url);
    if (url.includes('/api/payment-center/events/')) {
      return options.event ? Response.json(pick(options.event)) : new Response(null, { status: 404 });
    }
    return options.order ? Response.json(pick(options.order)) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return { send, calls };
}

async function inboxRows(eventId: string) {
  return sql<{ status: string; attempt_count: number; last_error_code: string | null; lease_owner: string | null }[]>`
    SELECT status::text AS status, attempt_count, last_error_code, lease_owner
    FROM payment_inbox WHERE event_id = ${eventId}
  `;
}

async function insertInboxRow(options: {
  eventId: string; externalOrderId: string; centerOrderId?: string; eventType?: string;
  status?: string; attemptCount?: number; leaseOwner?: string | null;
  leaseExpiresInSeconds?: number | null; availableInSeconds?: number;
}) {
  await sql`
    INSERT INTO payment_inbox (
      event_id, event_type, center_order_id, external_order_id, website_id,
      body_sha256, status, attempt_count, available_at
    ) VALUES (
      ${options.eventId}, ${options.eventType ?? 'subscription.period_paid'},
      ${options.centerOrderId ?? randomUUID()}, ${options.externalOrderId}, ${websiteId()},
      ${SHA_PATTERN}, ${options.status ?? 'pending'}, ${options.attemptCount ?? 0},
      now() + make_interval(secs => ${options.availableInSeconds ?? 0})
    )
  `;
  if (options.leaseOwner !== undefined || options.leaseExpiresInSeconds != null) {
    await sql`
      UPDATE payment_inbox
      SET lease_owner = ${options.leaseOwner ?? null},
          lease_expires_at = now() + make_interval(secs => ${options.leaseExpiresInSeconds ?? 0})
      WHERE event_id = ${options.eventId}
    `;
  }
}

/** Parks every other inbox row so a worker run claims exactly the events under test. */
async function parkOtherEvents(...keep: string[]) {
  await sql`
    UPDATE payment_inbox SET available_at = now() + interval '1 hour'
    WHERE event_id::text <> ALL(${keep}::text[])
  `;
}

/**
 * Puts one row back in the queue. The callback route now fulfils what it just
 * received, so a delivered row is usually `processed` (or parked with a retry
 * backoff); a worker test needs it claimable again.
 */
async function releaseInboxRow(eventId: string) {
  await sql`
    UPDATE payment_inbox
    SET status = 'pending', attempt_count = 0, last_error_code = NULL,
        lease_owner = NULL, lease_expires_at = NULL, available_at = now()
    WHERE event_id = ${eventId}
  `;
}

/** Every outbound call is stubbed per test; an unstubbed fetch would reach the real centre. */
function failClosedFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('vitest: no outbound fetch was stubbed for this test');
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  sql = await getClient();
  webhook = await import('@/lib/payment-center/webhook');
  route = await import('@/app/api/payment-center/webhook/route');
  inbox = await import('@/lib/payment-center/inbox-worker');
});

afterAll(async () => {
  await cleanupFixtures({ userIds, organizationIds, intentIds });
  await closeClient();
});

beforeEach(() => {
  process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = SIGNING_SECRET;
  process.env.PAYMENT_CENTER_API_KEY ||= 'vitest-payment-center-api-key';
  // The route fulfils each delivery through the global fetch; without a stub a
  // test would call whatever centre happens to be listening on this machine.
  vi.stubGlobal('fetch', failClosedFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function syntheticBody(eventId: string, orderId = randomUUID()) {
  return {
    id: eventId,
    type: 'payment.succeeded',
    data: {
      order: {
        id: orderId,
        external_order_id: scopedId('order', uniqueSuffix()),
        website_id: websiteId(),
      },
    },
  };
}

describe('the callback signature and replay window (AC 18)', () => {
  it('rejects a signature computed over different raw bytes even when the JSON means the same (AC 18)', () => {
    const body = syntheticBody(randomUUID());
    const signedRaw = JSON.stringify(body);
    const tampered = JSON.stringify({
      ...body,
      data: { order: { ...body.data.order, external_order_id: scopedId('order', uniqueSuffix()) } },
    });
    const headers = new Headers(signedHeaders(signedRaw, body.id));

    expect(webhook.verifyPaymentWebhook(Buffer.from(signedRaw, 'utf8'), headers)).toMatchObject({
      eventId: body.id,
      eventType: 'payment.succeeded',
    });
    expect(() => webhook.verifyPaymentWebhook(Buffer.from(tampered, 'utf8'), headers))
      .toThrow('Callback signature does not match');
  });

  it('accepts a timestamp 300 seconds away and rejects 301 seconds in either direction (AC 18)', () => {
    const body = syntheticBody(randomUUID());
    const raw = JSON.stringify(body);
    const now = Math.floor(Date.now() / 1000);

    for (const at of [now - 300, now + 300]) {
      const headers = new Headers(signedHeaders(raw, body.id, at));
      expect(webhook.verifyPaymentWebhook(Buffer.from(raw, 'utf8'), headers, now).eventId).toBe(body.id);
    }
    for (const at of [now - 301, now + 301]) {
      const headers = new Headers(signedHeaders(raw, body.id, at));
      expect(() => webhook.verifyPaymentWebhook(Buffer.from(raw, 'utf8'), headers, now))
        .toThrow('Callback timestamp is outside the allowed window');
    }
    const malformed = new Headers({ ...signedHeaders(raw, body.id, now), 'x-payment-center-timestamp': '1234' });
    expect(() => webhook.verifyPaymentWebhook(Buffer.from(raw, 'utf8'), malformed, now))
      .toThrow('Callback timestamp is outside the allowed window');
  });

  it('binds the event ID header to the signed body and bounds the callback size (AC 18)', () => {
    const body = syntheticBody(randomUUID());
    const raw = JSON.stringify(body);
    const wrongHeader = new Headers(signedHeaders(raw, randomUUID()));
    expect(() => webhook.verifyPaymentWebhook(Buffer.from(raw, 'utf8'), wrongHeader))
      .toThrow('Callback event ID or order is invalid');

    expect(() => webhook.verifyPaymentWebhook(new Uint8Array(), new Headers(signedHeaders(raw, body.id))))
      .toThrow('Invalid callback size');
    expect(() => webhook.verifyPaymentWebhook(new Uint8Array(65_537), new Headers()))
      .toThrow('Invalid callback size');
    expect(() => webhook.verifyPaymentWebhook(Buffer.from('{not json', 'utf8'),
      new Headers(signedHeaders('{not json', body.id)))).toThrow('Invalid callback JSON');
    expect(() => webhook.verifyPaymentWebhook(Buffer.from(raw, 'utf8'),
      new Headers({ ...signedHeaders(raw, body.id), 'x-payment-center-signature': 'sha256=nothex' })))
      .toThrow('Invalid callback signature format');
  });

  it('fails closed when the signing secret is missing or too short (AC 18)', async () => {
    const body = syntheticBody(randomUUID());
    const raw = JSON.stringify(body);
    const saved = process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET;
    try {
      delete process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET;
      expect(() => webhook.verifyPaymentWebhook(Buffer.from(raw, 'utf8'),
        new Headers(signedHeaders(raw, body.id, Math.floor(Date.now() / 1000), saved as string))))
        .toThrow('Signing secret is unavailable');

      const shortKey = 'vitest-short';
      process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = shortKey;
      expect(() => webhook.verifyPaymentWebhook(Buffer.from(raw, 'utf8'),
        new Headers(signedHeaders(raw, body.id, Math.floor(Date.now() / 1000), shortKey))))
        .toThrow('Signing secret is unavailable');

      const response = await route.POST(new Request('http://localhost:3000/api/payment-center/webhook', {
        method: 'POST', headers: signedHeaders(raw, body.id), body: raw,
      }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'payment_unavailable' });
    } finally {
      process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = saved;
    }
  });
});

describe('durable receipt of a callback (AC 18, AC 30)', () => {
  it('acknowledges a valid callback with a durable row and answers an identical duplicate with 200 (AC 18, AC 30)', async () => {
    const fixture = await seedIntent('stripe');
    const eventId = randomUUID();
    const body = callbackBody(fixture, { eventId, type: 'subscription.period_paid', data: periodData() });

    const first = await deliver(body);
    expect(first.response.status).toBe(202);
    expect(first.payload).toMatchObject({ received: true, outcome: 'queued' });
    expect(first.response.headers.get('cache-control')).toBe('no-store');

    const [row] = await sql<{
      status: string; event_type: string; external_order_id: string; center_order_id: string;
      website_id: string; body_sha256: string; attempt_count: number; lease_owner: string | null;
    }[]>`
      SELECT status::text AS status, event_type, external_order_id, center_order_id, website_id,
             body_sha256, attempt_count, lease_owner
      FROM payment_inbox WHERE event_id = ${eventId}
    `;
    expect(row).toMatchObject({
      status: 'pending',
      event_type: 'subscription.period_paid',
      external_order_id: fixture.externalOrderId,
      center_order_id: fixture.centerOrderId,
      website_id: websiteId(),
      body_sha256: createHash('sha256').update(first.raw).digest('hex'),
      // The delivery is fulfilled inline, so it was claimed once; the centre is
      // unreachable in this test, so the row stays queued as the retry backstop.
      attempt_count: 1,
      lease_owner: null,
    });
    // Nothing shipped: the fast path could not reach the centre.
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${fixture.organizationId}`)
      .toHaveLength(0);

    const duplicate = await deliver(body);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.payload).toMatchObject({ received: true, outcome: 'queued' });
    expect(await sql`SELECT event_id FROM payment_inbox WHERE event_id = ${eventId}`).toHaveLength(1);
  });

  it('refuses the same event ID carrying a different body without overwriting the receipt (AC 18)', async () => {
    const fixture = await seedIntent('stripe');
    const eventId = randomUUID();
    const body = callbackBody(fixture, { eventId, type: 'subscription.period_paid', data: periodData() });
    const first = await deliver(body);
    expect(first.response.status).toBe(202);

    const other = callbackBody(fixture, {
      eventId, type: 'subscription.period_paid',
      data: periodData({ amount_paid_decimal: '1.00000000' }),
    });
    const second = await deliver(other);
    expect(second.response.status).toBe(409);
    expect(second.payload).toMatchObject({ error: 'event_conflict' });

    const [row] = await sql<{ body_sha256: string; status: string }[]>`
      SELECT body_sha256, status::text AS status FROM payment_inbox WHERE event_id = ${eventId}
    `;
    expect(row?.body_sha256).toBe(createHash('sha256').update(first.raw).digest('hex'));
    expect(row?.status).toBe('pending');
  });

  it('quarantines an unknown order, recovers it by order query, and holds a conflicting order for review (AC 18)', async () => {
    const fixture = await seedIntent('stripe');
    const unknownOrderId = scopedId('order', uniqueSuffix());
    const quarantinedId = randomUUID();
    const unknownBody = callbackBody(
      { ...fixture, externalOrderId: unknownOrderId },
      { eventId: quarantinedId, type: 'subscription.period_paid', data: periodData() },
    );
    const quarantined = await deliver(unknownBody);
    expect(quarantined.response.status).toBe(202);
    expect((await inboxRows(quarantinedId))[0]?.status).toBe('quarantined');

    // The quarantined event stays claimable and is held only until the intent exists.
    await parkOtherEvents(quarantinedId);
    const stub = centerStub({
      event: envelope(unknownBody),
      order: orderEnvelope(centerOrderFor({ ...fixture, externalOrderId: unknownOrderId })),
    });
    const firstPass = await inbox.runPaymentInbox({ send: stub.send });
    expect(firstPass).toMatchObject({ claimed: 1, retried: 1, manualReview: 0 });
    expect((await inboxRows(quarantinedId))[0]).toMatchObject({
      status: 'pending', last_error_code: 'intent_not_found',
    });

    // A conflicting centre order for a known intent must never auto-deliver.
    const conflictId = randomUUID();
    const conflictBody = callbackBody(
      { ...fixture, centerOrderId: randomUUID() },
      { eventId: conflictId, type: 'subscription.period_paid', data: periodData() },
    );
    expect((await deliver(conflictBody)).response.status).toBe(202);
    expect((await inboxRows(conflictId))[0]?.status).toBe('manual_review');
  });

  it('refuses a callback for another website, an oversized one and a misconfigured centre (AC 18)', async () => {
    const fixture = await seedIntent('stripe');
    const foreign = callbackBody(fixture, {
      eventId: randomUUID(), type: 'subscription.period_paid',
      order: { website_id: '11111111-2222-4333-8444-555555555555' },
      data: periodData(),
    });
    const wrongWebsite = await deliver(foreign);
    expect(wrongWebsite.response.status).toBe(403);
    expect(wrongWebsite.payload).toMatchObject({ error: 'wrong_website' });

    const oversizedRaw = JSON.stringify({ id: randomUUID(), padding: 'x'.repeat(70_000) });
    const oversized = await route.POST(new Request('http://localhost:3000/api/payment-center/webhook', {
      method: 'POST',
      headers: {
        ...signedHeaders(oversizedRaw, randomUUID()),
        'content-length': String(Buffer.byteLength(oversizedRaw)),
      },
      body: oversizedRaw,
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: 'callback_too_large' });

    // Without a declared length the streamed read still refuses the same body.
    const streamed = await route.POST(new Request('http://localhost:3000/api/payment-center/webhook', {
      method: 'POST', headers: signedHeaders(oversizedRaw, randomUUID()), body: oversizedRaw,
    }));
    expect(streamed.status).toBe(400);
    expect(await streamed.json()).toMatchObject({ error: 'invalid_callback' });

    const saved = process.env.PAYMENT_CENTER_API_KEY;
    try {
      delete process.env.PAYMENT_CENTER_API_KEY;
      const body = callbackBody(fixture, {
        eventId: randomUUID(), type: 'subscription.period_paid', data: periodData(),
      });
      const response = await deliver(body);
      expect(response.response.status).toBe(503);
      expect(response.payload).toMatchObject({ error: 'payment_unavailable' });
    } finally {
      process.env.PAYMENT_CENTER_API_KEY = saved;
    }
  });
});

describe('the inbox worker: delivery, leases and budgets (AC 18, AC 30)', () => {
  it('grants one period for a settled renewal and never grants it twice (AC 18, AC 30)', async () => {
    const fixture = await seedIntent('stripe');
    const eventId = randomUUID();
    const period = periodData();
    const body = callbackBody(fixture, { eventId, type: 'subscription.period_paid', data: period });
    expect((await deliver(body)).response.status).toBe(202);

    await parkOtherEvents(eventId);
    await releaseInboxRow(eventId);
    const stub = centerStub({ event: envelope(body), order: orderEnvelope(centerOrderFor(fixture)) });
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });

    expect(await sql<{ evidence_key: string; status: string }[]>`
      SELECT evidence_key, status::text AS status FROM payment_evidence WHERE intent_id = ${fixture.intentId}
    `).toMatchObject([{ evidence_key: `invoice:${period.provider_invoice_id}`, status: 'settled' }]);
    expect(await sql<{ status: string }[]>`
      SELECT status::text AS status FROM subscription_grants WHERE organization_id = ${fixture.organizationId}
    `).toMatchObject([{ status: 'active' }]);
    expect(await sql<{ status: string }[]>`
      SELECT status::text AS status FROM subscriptions WHERE organization_id = ${fixture.organizationId}
    `).toMatchObject([{ status: 'active' }]);
    expect(await sql<{ status: string; payment_center_order_id: string | null }[]>`
      SELECT status::text AS status, payment_center_order_id FROM payment_intents WHERE id = ${fixture.intentId}
    `).toMatchObject([{ status: 'settled', payment_center_order_id: fixture.centerOrderId }]);
    expect((await inboxRows(eventId))[0]).toMatchObject({ status: 'processed', lease_owner: null });

    // Nothing left to claim.
    expect(await inbox.runPaymentInbox({ send: stub.send })).toMatchObject({ claimed: 0 });

    // A redelivery of the same period is answered from the stored evidence.
    await sql`
      UPDATE payment_inbox SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
        available_at = now() WHERE event_id = ${eventId}
    `;
    const replay = await inbox.runPaymentInbox({ send: stub.send });
    expect(replay).toMatchObject({ claimed: 1, processed: 1 });
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${fixture.organizationId}`)
      .toHaveLength(1);
    expect(await sql`SELECT id FROM payment_evidence WHERE intent_id = ${fixture.intentId}`).toHaveLength(1);
    expect((await inboxRows(eventId))[0]?.status).toBe('processed');
  });

  it('fulfils a card payment inside the delivery itself, with no worker run (AC 18)', async () => {
    const fixture = await seedIntent('stripe');
    const notificationId = randomUUID();
    const periodId = randomUUID();
    const notification = callbackBody(fixture, { eventId: notificationId, type: 'payment.succeeded' });
    const period = callbackBody(fixture, {
      eventId: periodId, type: 'subscription.period_paid', data: periodData(),
    });

    let currentEvent: unknown = null;
    const stub = centerStub({
      event: () => currentEvent,
      order: orderEnvelope(centerOrderFor(fixture)),
      onCall: (url) => {
        const queried = /\/api\/payment-center\/events\/([^/?]+)/.exec(url)?.[1];
        if (queried === notificationId) currentEvent = envelope(notification);
        if (queried === periodId) currentEvent = envelope(period);
      },
    });
    // The callback route fulfils each delivery through the global fetch.
    vi.stubGlobal('fetch', stub.send);

    // The money notification arrives first and the period is still in flight, so
    // it waits instead of failing the workspace into manual review.
    const first = await deliver(notification);
    expect(first.response.status).toBe(202);
    expect(first.payload).toMatchObject({ received: true, outcome: 'queued' });
    expect((await inboxRows(notificationId))[0]).toMatchObject({
      status: 'pending', last_error_code: 'awaiting_period_event',
    });
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${fixture.organizationId}`)
      .toHaveLength(0);

    // The fulfilment event grants the subscription inside the delivery itself:
    // no scheduler, no worker and no `npm run reconcile` are involved.
    const second = await deliver(period);
    expect(second.response.status).toBe(202);
    expect(second.payload).toMatchObject({ received: true, outcome: 'processed' });
    expect((await inboxRows(periodId))[0]).toMatchObject({ status: 'processed' });
    expect(await sql<{ status: string }[]>`
      SELECT status::text AS status FROM subscription_grants WHERE organization_id = ${fixture.organizationId}
    `).toMatchObject([{ status: 'active' }]);
    expect(await sql<{ status: string }[]>`
      SELECT status::text AS status FROM subscriptions WHERE organization_id = ${fixture.organizationId}
    `).toMatchObject([{ status: 'active' }]);
    expect(await sql<{ status: string }[]>`
      SELECT status::text AS status FROM payment_intents WHERE id = ${fixture.intentId}
    `).toMatchObject([{ status: 'settled' }]);
    expect(await sql`SELECT id FROM payment_evidence WHERE intent_id = ${fixture.intentId}`).toHaveLength(1);

    // The notification is recognised and closed once the period has been granted.
    await parkOtherEvents(notificationId, periodId);
    await sql`UPDATE payment_inbox SET available_at = now() WHERE event_id = ${notificationId}`;
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });
    expect((await inboxRows(notificationId))[0]).toMatchObject({
      status: 'processed', last_error_code: null,
    });

    // The notification repeated the payment: it granted nothing of its own.
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${fixture.organizationId}`)
      .toHaveLength(1);
    expect(await sql`SELECT id FROM payment_evidence WHERE intent_id = ${fixture.intentId}`).toHaveLength(1);
  });

  it('still reports a card payment whose fulfilment event never arrives (AC 18, AC 30)', async () => {
    const fixture = await seedIntent('stripe');
    const notificationId = randomUUID();
    const notification = callbackBody(fixture, { eventId: notificationId, type: 'payment.succeeded' });
    expect((await deliver(notification)).response.status).toBe(202);
    await parkOtherEvents(notificationId);
    await releaseInboxRow(notificationId);
    await sql`UPDATE payment_inbox SET attempt_count = 7 WHERE event_id = ${notificationId}`;

    const stub = centerStub({
      event: envelope(notification),
      order: orderEnvelope(centerOrderFor(fixture)),
    });
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, processed: 0, retried: 0, manualReview: 1 });
    expect((await inboxRows(notificationId))[0]).toMatchObject({
      status: 'manual_review', last_error_code: 'awaiting_period_event',
    });
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${fixture.organizationId}`)
      .toHaveLength(0);
  });

  it('retires the intent when the centre retires the order (AC 18, AC 30)', async () => {
    // A card checkout page that timed out, a lapsed amount lock, a released
    // reservation: the centre says the order can never be paid. An intent left
    // open here would keep showing a purchase that cannot complete — and would
    // hold that channel's slot against the buyer's very next attempt.
    const fixture = await seedIntent('stripe', { status: 'action_required' });
    const eventId = randomUUID();
    const body = callbackBody(fixture, {
      eventId, type: 'payment.expired',
      order: { status: 'expired' },
      data: { reason: 'stripe_session_expired' },
    });
    expect((await deliver(body)).response.status).toBe(202);
    await parkOtherEvents(eventId);
    await releaseInboxRow(eventId);

    const stub = centerStub({
      event: envelope(body),
      order: orderEnvelope(centerOrderFor(fixture, { status: 'expired' })),
    });
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });
    expect((await inboxRows(eventId))[0]).toMatchObject({
      status: 'processed', last_error_code: null,
    });
    expect(await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status::text AS status, last_error_code FROM payment_intents WHERE id = ${fixture.intentId}
    `).toMatchObject([{ status: 'failed', last_error_code: 'order_expired' }]);
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${fixture.organizationId}`)
      .toHaveLength(0);
  });

  it('never closes a grant on an expiry notice the centre contradicts (AC 18)', async () => {
    const fixture = await seedIntent('stripe', { status: 'action_required' });
    const eventId = randomUUID();
    const body = callbackBody(fixture, {
      eventId, type: 'payment.expired', order: { status: 'expired' },
    });
    expect((await deliver(body)).response.status).toBe(202);
    await parkOtherEvents(eventId);
    await releaseInboxRow(eventId);

    // The centre only emits this once an order is genuinely unpayable, so an
    // order that still reads as live means the two sides disagree. Nothing is
    // written on a contradiction: a human looks.
    const stub = centerStub({
      event: envelope(body),
      order: orderEnvelope(centerOrderFor(fixture, { status: 'action_required' })),
    });
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, processed: 0, retried: 0, manualReview: 1 });
    expect((await inboxRows(eventId))[0]).toMatchObject({
      status: 'manual_review', last_error_code: 'order_expired_unverified',
    });
    expect(await sql<{ status: string }[]>`
      SELECT status::text AS status FROM payment_intents WHERE id = ${fixture.intentId}
    `).toMatchObject([{ status: 'action_required' }]);
  });

  it('keeps a settled intent settled when an expiry notice arrives late (AC 18)', async () => {
    // The money was taken and the access was granted. A notice that arrives
    // afterwards must close itself and change nothing — an expiry is not a
    // reversal, and only the refund path may take access away.
    const fixture = await seedIntent('stripe', { status: 'settled' });
    const eventId = randomUUID();
    const body = callbackBody(fixture, {
      eventId, type: 'payment.expired', order: { status: 'expired' },
    });
    expect((await deliver(body)).response.status).toBe(202);
    await parkOtherEvents(eventId);
    await releaseInboxRow(eventId);

    const stub = centerStub({
      event: envelope(body),
      order: orderEnvelope(centerOrderFor(fixture, { status: 'expired' })),
    });
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, processed: 1, retried: 0, manualReview: 0 });
    expect(await sql<{ status: string }[]>`
      SELECT status::text AS status FROM payment_intents WHERE id = ${fixture.intentId}
    `).toMatchObject([{ status: 'settled' }]);
  });

  it('commits the business change and the completed marker in one transaction (AC 30)', async () => {
    const fixture = await seedIntent('stripe');
    const eventId = randomUUID();
    const body = callbackBody(fixture, { eventId, type: 'subscription.period_paid', data: periodData() });
    expect((await deliver(body)).response.status).toBe(202);
    await parkOtherEvents(eventId);
    await releaseInboxRow(eventId);

    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION vitest_block_grant() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'vitest simulated grant failure';
      END; $$ LANGUAGE plpgsql;
    `);
    await sql.unsafe(`
      CREATE TRIGGER vitest_block_grant BEFORE INSERT ON subscription_grants
        FOR EACH ROW EXECUTE FUNCTION vitest_block_grant();
    `);
    try {
      // The trigger is armed: any grant insert inside the worker's transaction aborts.
      await expect(sql`
        INSERT INTO subscription_grants (
          id, organization_id, evidence_id, product_code, payment_method,
          provider_subscription_id, period_start, period_end
        ) VALUES (
          ${'sg_' + randomUUID().replaceAll('-', '')}, ${fixture.organizationId},
          ${'pe_' + randomUUID().replaceAll('-', '')}, ${PRODUCT_CODE}, 'stripe',
          ${SUBSCRIPTION_ID}, now(), now() + interval '30 days'
        )
      `).rejects.toThrow(/vitest simulated grant failure/);

      const stub = centerStub({ event: envelope(body), order: orderEnvelope(centerOrderFor(fixture)) });
      const report = await inbox.runPaymentInbox({ send: stub.send });
      expect((await inboxRows(eventId))[0]).toMatchObject({
        last_error_code: 'center_or_database_unavailable',
      });
      expect(report).toMatchObject({ claimed: 1, processed: 0, retried: 1 });
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS vitest_block_grant ON subscription_grants');
      await sql.unsafe('DROP FUNCTION IF EXISTS vitest_block_grant()');
    }

    // The grant, its evidence, the intent transition and the completed marker all
    // rolled back together; the event is still pending for a later attempt.
    // `fulfillSubscription` writes the evidence row before the grant row, so an
    // empty evidence table proves a write that already happened was rolled back.
    expect(await sql`SELECT id FROM subscription_grants WHERE organization_id = ${fixture.organizationId}`)
      .toHaveLength(0);
    expect(await sql`SELECT id FROM payment_evidence WHERE intent_id = ${fixture.intentId}`).toHaveLength(0);
    expect(await sql<{ status: string }[]>`
      SELECT status::text AS status FROM payment_intents WHERE id = ${fixture.intentId}
    `).toMatchObject([{ status: 'pending' }]);
    expect((await inboxRows(eventId))[0]).toMatchObject({
      status: 'pending', attempt_count: 1, last_error_code: 'center_or_database_unavailable',
    });
  });

  it('reclaims an expired lease and leaves a live lease alone (AC 30)', async () => {
    const expiredId = randomUUID();
    const liveId = randomUUID();
    await insertInboxRow({
      eventId: expiredId, externalOrderId: scopedId('order', uniqueSuffix()),
      status: 'processing', attemptCount: 1, leaseOwner: 'vitest-crashed-runner',
      leaseExpiresInSeconds: -1,
    });
    await insertInboxRow({
      eventId: liveId, externalOrderId: scopedId('order', uniqueSuffix()),
      status: 'processing', attemptCount: 1, leaseOwner: 'vitest-live-runner',
      leaseExpiresInSeconds: 600,
    });
    await parkOtherEvents(expiredId, liveId);

    const report = await inbox.runPaymentInbox({ maxJobs: 5, send: centerStub({}).send });
    expect(report.claimed).toBe(1);
    expect((await inboxRows(expiredId))[0]).toMatchObject({
      status: 'pending', attempt_count: 2, last_error_code: 'event_not_found', lease_owner: null,
    });
    expect((await inboxRows(liveId))[0]).toMatchObject({
      status: 'processing', attempt_count: 1, lease_owner: 'vitest-live-runner',
    });
  });

  it('backs off with bounded jitter, then dead-letters the event at the attempt cap (AC 30)', async () => {
    const eventId = randomUUID();
    await insertInboxRow({ eventId, externalOrderId: scopedId('order', uniqueSuffix()) });
    await parkOtherEvents(eventId);

    const bases = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 2_560_000];
    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const report = await inbox.runPaymentInbox({ send: centerStub({}).send });
      expect(report).toMatchObject({ claimed: 1, retried: 1 });
      const [row] = await sql<{ delay_ms: number }[]>`
        SELECT EXTRACT(EPOCH FROM (available_at - now())) * 1000 AS delay_ms
        FROM payment_inbox WHERE event_id = ${eventId}
      `;
      delays.push(Number(row?.delay_ms ?? 0));
      await sql`UPDATE payment_inbox SET available_at = now() WHERE event_id = ${eventId}`;
    }
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(delays[2]).toBeGreaterThan(delays[1] as number);
    for (const delay of delays) {
      // 5s doubling base plus at most 2s of jitter, capped at one hour.
      const distance = Math.min(...[...bases, 3_600_000].map((base) => Math.abs(base - delay)));
      expect(distance).toBeLessThanOrEqual(2_050);
      expect(delay).toBeLessThanOrEqual(3_600_000 + 2_050);
    }

    await sql`
      UPDATE payment_inbox SET attempt_count = 7, status = 'pending', available_at = now(),
        lease_owner = NULL, lease_expires_at = NULL WHERE event_id = ${eventId}
    `;
    const capped = await inbox.runPaymentInbox({ send: centerStub({}).send });
    expect(capped).toMatchObject({ claimed: 1, retried: 0, manualReview: 1 });
    expect((await inboxRows(eventId))[0]).toMatchObject({
      status: 'manual_review', attempt_count: 8, last_error_code: 'event_not_found', lease_owner: null,
    });
  });

  it('stops at the batch budget and at the time budget (AC 30)', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const eventId of ids) {
      await insertInboxRow({ eventId, externalOrderId: scopedId('order', uniqueSuffix()) });
    }
    await parkOtherEvents(...ids);

    const batch = await inbox.runPaymentInbox({ maxJobs: 2, send: centerStub({}).send });
    expect(batch.claimed).toBe(2);
    const mine = await sql<{ event_id: string; attempt_count: number }[]>`
      SELECT event_id, attempt_count FROM payment_inbox WHERE event_id::text = ANY(${ids}::text[])
      ORDER BY received_at, event_id
    `;
    expect(mine.filter((row) => row.attempt_count === 0)).toHaveLength(1);

    await parkOtherEvents(...ids);
    await sql`UPDATE payment_inbox SET available_at = now(), attempt_count = 0, status = 'pending'
      WHERE event_id::text = ANY(${ids}::text[])`;
    const slow = centerStub({ onCall: () => new Promise((resolve) => setTimeout(resolve, 300)) });
    const timed = await inbox.runPaymentInbox({ maxMillis: 200, send: slow.send });
    expect(timed.claimed).toBe(1);
    expect(slow.calls.length).toBe(1);
  });

  it('holds no inbox row lock while the centre is being called (AC 30)', async () => {
    const eventId = randomUUID();
    await insertInboxRow({ eventId, externalOrderId: scopedId('order', uniqueSuffix()) });
    await parkOtherEvents(eventId);

    let observed: string | undefined;
    let probeError: unknown;
    const stub = centerStub({
      onCall: async () => {
        try {
          await sql.begin(async (tx) => {
            const rows = await tx<{ status: string }[]>`
              SELECT status::text AS status FROM payment_inbox
              WHERE event_id = ${eventId} FOR UPDATE NOWAIT
            `;
            observed = rows[0]?.status;
          });
        } catch (error) {
          probeError = error;
        }
      },
    });
    const report = await inbox.runPaymentInbox({ send: stub.send });
    expect(report).toMatchObject({ claimed: 1, retried: 1 });
    // The claim committed before HTTP, so another transaction can lock the row.
    expect(probeError).toBeUndefined();
    expect(observed).toBe('processing');
  });
});
