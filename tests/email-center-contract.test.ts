import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanupFixtures, closeClient, createUserFixture, getClient, type FixtureScope,
} from './support/fixtures';

/**
 * Acceptance criteria 25, 26 and 29 — the integration contract between this
 * application and an independently deployed Email Center.
 *
 * The local Email Center is not running, so every network boundary is stubbed
 * and asserted: the exact request the SaaS side builds and what it accepts as a
 * receipt. Nothing here mocks this repository's own code.
 */
process.env.FEATURE_EMAIL_CENTER = 'true';
// The widget is its own capability: the loader renders nothing unless this is
// on, and a developer's `.env` used to be the only place it was set.
process.env.FEATURE_EMAIL_CENTER_WIDGET = 'true';
// This file asserts the Email Center contract, so the other two integrations are
// pinned off: with them enabled a developer's `.env` would add Payment Center
// calls to the readiness report and to `calls`. `lib/config.ts` snapshots the
// flags when the route is imported in `beforeAll`, so setting them here — before
// those dynamic imports — is enough.
process.env.FEATURE_PAYMENT_CENTER = 'false';
process.env.FEATURE_REFERRALS = 'false';

type ContactModule = typeof import('@/lib/email-center/contact');
type WorkerModule = typeof import('@/lib/email-center/worker');
type ReadyModule = typeof import('@/app/api/ready/route');
type WidgetModule = typeof import('@/components/email-center/widget-loader');

let contact: ContactModule;
let worker: WorkerModule;
let ready: ReadyModule;
let widget: WidgetModule;

const scope: FixtureScope = { userIds: [] };
const repoRoot = process.cwd();

type Call = { url: URL; init: RequestInit };
type Respond = (url: URL, init: RequestInit, index: number) => Response | Promise<Response>;

/** A fetch double that records every request the application builds. */
function spySend(respond: Respond) {
  const calls: Call[] = [];
  const send = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const request = init ?? {};
    calls.push({ url, init: request });
    return respond(url, request, calls.length - 1);
  }) as typeof fetch;
  return { calls, send };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headerOf(call: Call, name: string): string | null {
  return new Headers(call.init.headers ?? undefined).get(name);
}

function contactReceipt(applicationId = 9001): Response {
  return Response.json({ data: { contactApplicationId: applicationId } });
}

function verifyReceipt(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    data: { connected: true, applicationId: 42, capabilities: { contactReconciliation: 'v1' }, ...overrides },
  });
}

type OutboxRow = {
  id: string; event_version: number; status: string; attempt_count: number;
  occurred_at: Date; available_at: Date; last_error_code: string | null;
  reconcile_after: Date | null; occurred_ago: number;
};

async function latestOutbox(userId: string): Promise<OutboxRow> {
  const client = await getClient();
  const [row] = await client`
    SELECT id, event_version, status, attempt_count, occurred_at, available_at,
      last_error_code, reconcile_after,
      EXTRACT(EPOCH FROM (occurred_at - now()))::float8 AS occurred_ago
    FROM email_contact_outbox
    WHERE user_id = ${userId}
    ORDER BY event_version DESC
    LIMIT 1`;
  return row as OutboxRow;
}

/** The `ContactEvent` the runner would hand to the snapshot/probe helpers. */
async function eventOf(userId: string) {
  const row = await latestOutbox(userId);
  return {
    id: String(row.id),
    user_id: userId,
    event_version: Number(row.event_version),
    occurred_at: new Date(row.occurred_at),
  };
}

async function updateUser(userId: string, patch: {
  emailVerified?: boolean;
  marketingOptInRequested?: boolean;
  preferredLocale?: string;
  localeSource?: string;
}) {
  const client = await getClient();
  await client`
    UPDATE "user" SET
      email_verified = COALESCE(${patch.emailVerified ?? null}::boolean, email_verified),
      marketing_opt_in_requested =
        COALESCE(${patch.marketingOptInRequested ?? null}::boolean, marketing_opt_in_requested),
      preferred_locale = COALESCE(${patch.preferredLocale ?? null}::text, preferred_locale),
      locale_source = COALESCE(${patch.localeSource ?? null}::text, locale_source)
    WHERE id = ${userId}`;
}

async function createContact(options: {
  emailVerified?: boolean; marketingOptInRequested?: boolean;
  preferredLocale?: string; localeSource?: string;
} = {}) {
  const user = await createUserFixture({
    emailVerified: options.emailVerified,
    marketingOptInRequested: options.marketingOptInRequested,
  });
  scope.userIds!.push(user.userId);
  if (options.preferredLocale || options.localeSource) {
    await updateUser(user.userId, {
      preferredLocale: options.preferredLocale, localeSource: options.localeSource,
    });
  }
  return user;
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(repoRoot, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

function isClientComponent(source: string): boolean {
  return /^\s*['"]use client['"];/.test(source.split(/\r?\n/).slice(0, 3).join('\n'));
}

beforeAll(async () => {
  [contact, worker, ready, widget] = await Promise.all([
    import('@/lib/email-center/contact'),
    import('@/lib/email-center/worker'),
    import('@/app/api/ready/route'),
    import('@/components/email-center/widget-loader'),
  ]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // Keep tests independent: a row left retryable by one case must not be the
  // row a later case claims.
  const client = await getClient();
  await client`UPDATE email_contact_outbox
    SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
        reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL
    WHERE status IN ('pending', 'processing') OR reconcile_lease_owner IS NOT NULL`;
});

afterAll(async () => {
  await cleanupFixtures(scope);
  await closeClient();
});

describe('Email Center application readiness', () => {
  it('answers "reachable" only after a real verify call succeeds, never from configuration alone', async () => {
    const { calls, send } = spySend(() => verifyReceipt());
    vi.stubGlobal('fetch', send);

    const response = await ready.GET();
    const body = await response.json() as {
      status: string; database: string; modules: Record<string, string>;
    };

    expect(response.status).toBe(200);
    expect(new Headers(response.headers).get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({
      status: 'ready',
      database: 'ready',
      modules: { emailApplication: 'reachable', paymentCatalog: 'disabled', referralSite: 'disabled' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href)
      .toBe(new URL('/api/v1/integrations/verify', process.env.EMAIL_CENTER_URL).href);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.cache).toBe('no-store');
    expect(headerOf(calls[0], 'authorization')).toBe(`Bearer ${process.env.EMAIL_CENTER_API_KEY}`);
    // The readiness body is public: it may not carry the key it just used.
    expect(JSON.stringify(body)).not.toContain(String(process.env.EMAIL_CENTER_API_KEY));
  });

  const refused: Array<[string, () => Response]> = [
    ['the centre refuses the connection', () => { throw new Error('ECONNREFUSED'); }],
    ['the application key is rejected', () => new Response('', { status: 401 })],
    ['the application is not connected', () => verifyReceipt({ connected: false })],
    ['the answer carries no application id', () => verifyReceipt({ applicationId: null })],
    ['the centre does not support reconciliation', () => verifyReceipt({ capabilities: { contactReconciliation: 'v0' } })],
  ];

  it.each(refused)('reports "unreachable" when %s', async (_name, respond) => {
    const { send } = spySend(respond);
    vi.stubGlobal('fetch', send);

    const body = await (await ready.GET()).json() as { status: string; modules: Record<string, string> };

    expect(body.modules.emailApplication).toBe('unreachable');
    expect(body.status).toBe('ready'); // the Email Center is never a readiness dependency
  });

  it('reports "unconfigured" when the application key is missing, without calling the centre', async () => {
    const { calls, send } = spySend(() => verifyReceipt());
    vi.stubGlobal('fetch', send);
    vi.stubEnv('EMAIL_CENTER_API_KEY', '');

    const body = await (await ready.GET()).json() as { modules: Record<string, string> };

    expect(body.modules.emailApplication).toBe('unconfigured');
    expect(calls).toHaveLength(0);
  });
});

describe('server key and public widget key stay separate', () => {
  it('keeps the application API key out of every client component', async () => {
    const files = [
      ...await walk('app'), ...await walk('components'), ...await walk('lib'),
    ];
    const offenders: string[] = [];
    const clientFiles: string[] = [];
    for (const file of files) {
      const source = await readFile(join(repoRoot, file), 'utf8');
      if (!isClientComponent(source)) continue;
      clientFiles.push(file);
      if (/EMAIL_CENTER_API_KEY|EMAIL_CENTER_URL|RESEND_API_KEY/.test(source)) offenders.push(file);
      if (/NEXT_PUBLIC_[A-Z0-9_]*API_KEY/.test(source)) offenders.push(`${file} (server key exposed as NEXT_PUBLIC)`);
    }

    expect(offenders).toEqual([]);
    expect(clientFiles.length).toBeGreaterThan(0);
    // The runtime is the browser boundary; the loader that reads the server
    // variable and the application key is a server component.
    expect(clientFiles).toContain('components/email-center/widget-runtime.tsx');
    const loader = await readFile(join(repoRoot, 'components/email-center/widget-loader.tsx'), 'utf8');
    expect(isClientComponent(loader)).toBe(false);
    expect(loader).toContain('EMAIL_CENTER_URL');
    expect(loader).toContain('NEXT_PUBLIC_EMAIL_CENTER_WIDGET_KEY');
  });

  it('passes only the public widget key, the script URL and the locale into the widget runtime', async () => {
    const element = widget.EmailCenterWidget({ locale: 'zh-CN' }) as
      { props: { src: string; widgetKey: string; locale: string } } | null;
    if (!element) throw new Error('the widget must render while the public key is configured');

    expect(element.props.src)
      .toBe(new URL('/email-center-widget.js?v=3', process.env.EMAIL_CENTER_URL).href);
    expect(element.props.widgetKey).toBe(process.env.NEXT_PUBLIC_EMAIL_CENTER_WIDGET_KEY);
    expect(element.props.widgetKey).not.toBe(process.env.EMAIL_CENTER_API_KEY);
    // The page's language travels as `data-locale`; without it the Widget falls
    // back to `navigator.language` and a Chinese browser gets a Chinese form on
    // the English page.
    expect(element.props.locale).toBe('zh-CN');
    expect(JSON.stringify(element.props)).not.toContain(String(process.env.EMAIL_CENTER_API_KEY));

    const readme = await readFile(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('EMAIL_CENTER_URL');
    expect(readme).toContain('NEXT_PUBLIC_EMAIL_CENTER_WIDGET_KEY');
  });

  const widgetGaps: Array<[string, string, string]> = [
    ['the public key is missing', 'NEXT_PUBLIC_EMAIL_CENTER_WIDGET_KEY', ''],
    ['the centre URL is missing', 'EMAIL_CENTER_URL', ''],
    ['the centre URL is not http(s)', 'EMAIL_CENTER_URL', 'file:///tmp/email-center'],
    ['the centre URL is a script payload', 'EMAIL_CENTER_URL', 'javascript:alert(1)'],
  ];

  it.each(widgetGaps)('renders nothing, instead of failing the dashboard, when %s', (_name, key, value) => {
    vi.stubEnv(key, value);
    expect(widget.EmailCenterWidget({ locale: 'en' })).toBeNull();
  });
});

describe('contacts/upsert receives the registration, profile, language and consent state', () => {
  it('sends the trigger-created registration snapshot under a stable idempotency key', async () => {
    const user = await createContact({ emailVerified: true, marketingOptInRequested: true });
    const { calls, send } = spySend(() => contactReceipt());

    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, deadLetter: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href)
      .toBe(new URL('/api/v1/contacts/upsert', process.env.EMAIL_CENTER_URL).href);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');
    expect(headerOf(calls[0], 'authorization')).toBe(`Bearer ${process.env.EMAIL_CENTER_API_KEY}`);
    expect(headerOf(calls[0], 'content-type')).toContain('application/json');
    expect(headerOf(calls[0], 'idempotency-key')).toBe(`saas:contact:${user.userId}:v1`);

    const body = bodyOf(calls[0]);
    expect(body).toMatchObject({
      externalUserId: user.userId,
      email: user.email,
      name: 'Vitest Fixture',
      source: 'registration',
      preferredLocale: 'en',
      localeSource: 'fallback',
      marketingConsent: true,
      metadata: {},
    });
    expect(Object.keys(body).sort()).toEqual([
      'email', 'externalUserId', 'localeSource', 'marketingConsent', 'metadata', 'name',
      'occurredAt', 'preferredLocale', 'source',
    ]);
    // The application key authenticates the request; it never travels in the body.
    expect(JSON.stringify(body)).not.toContain(String(process.env.EMAIL_CENTER_API_KEY));

    const row = await latestOutbox(user.userId);
    expect(row.status).toBe('succeeded');
    expect(row.attempt_count).toBe(1);
    expect(row.occurred_ago).toBeLessThanOrEqual(0); // available immediately, not later
    const occurredAt = Date.parse(String(body.occurredAt));
    expect(Math.abs(occurredAt - new Date(row.occurred_at).getTime())).toBeLessThan(1_000);
    expect(Math.abs(occurredAt - Date.now())).toBeLessThan(30_000); // acceptance criterion 26 window
  });

  it('registers an opted-out contact with marketingConsent=false', async () => {
    const user = await createContact({ emailVerified: true, marketingOptInRequested: false });
    const { calls, send } = spySend(() => contactReceipt());

    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report.succeeded).toBe(1);
    expect(bodyOf(calls[0]).marketingConsent).toBe(false);
    expect((await latestOutbox(user.userId)).status).toBe('succeeded');
  });

  it('sends marketingConsent=false while the email is unverified and true once ownership is confirmed', async () => {
    const user = await createContact({ emailVerified: false, marketingOptInRequested: true });
    const first = spySend(() => contactReceipt());
    await worker.runEmailContactSync({ maxJobs: 1, send: first.send });
    expect(bodyOf(first.calls[0]).marketingConsent).toBe(false);
    expect(bodyOf(first.calls[0]).source).toBe('registration');

    await updateUser(user.userId, { emailVerified: true });
    const second = spySend(() => contactReceipt());
    const report = await worker.runEmailContactSync({ maxJobs: 1, send: second.send });

    expect(report.succeeded).toBe(1);
    const body = bodyOf(second.calls[0]);
    expect(body.marketingConsent).toBe(true);
    expect(body.source).toBe('api'); // the ownership change is not the registration
    expect(headerOf(second.calls[0], 'idempotency-key')).toBe(`saas:contact:${user.userId}:v2`);
  });

  it('carries the saved language and the source that decided it', async () => {
    await createContact({ preferredLocale: 'zh-CN', localeSource: 'switcher' });
    const { calls, send } = spySend(() => contactReceipt());

    await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(bodyOf(calls[0])).toMatchObject({ preferredLocale: 'zh-CN', localeSource: 'switcher' });
    // A user whose locale the application could not determine still reports the
    // fallback explicitly instead of dropping the field.
    const other = await createContact({ preferredLocale: 'fr-FR', localeSource: '' });
    const second = spySend(() => contactReceipt());
    await worker.runEmailContactSync({ maxJobs: 1, send: second.send });
    expect(bodyOf(second.calls[0])).toMatchObject({ preferredLocale: 'en', localeSource: 'fallback' });
    expect(other.userId).toBeTruthy();
  });

  it('numbers every profile change as a new monotonic event version', async () => {
    const user = await createContact();
    expect((await latestOutbox(user.userId)).event_version).toBe(1);

    await updateUser(user.userId, { preferredLocale: 'zh-CN', localeSource: 'cookie' });
    await updateUser(user.userId, { marketingOptInRequested: true });

    const rows = await (await getClient())`
      SELECT event_version FROM email_contact_outbox WHERE user_id = ${user.userId}
      ORDER BY event_version`;
    expect(rows.map((row) => Number(row.event_version))).toEqual([1, 2, 3]);

    const { calls, send } = spySend(() => contactReceipt());
    const report = await worker.runEmailContactSync({ maxJobs: 5, send });
    expect(report).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, deadLetter: 0 });
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0], 'idempotency-key')).toBe(`saas:contact:${user.userId}:v3`);

    const statuses = await (await getClient())`
      SELECT event_version, status FROM email_contact_outbox WHERE user_id = ${user.userId}
      ORDER BY event_version`;
    expect(statuses.map((row) => [Number(row.event_version), String(row.status)]))
      .toEqual([[1, 'superseded'], [2, 'superseded'], [3, 'succeeded']]);
  });

  it('refuses a 2xx answer that carries no receipt id for reconciliation', async () => {
    const user = await createContact();
    const { send } = spySend(() => Response.json({ data: {} }, { status: 201 }));

    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ succeeded: 0, retried: 1 });
    const row = await latestOutbox(user.userId);
    expect(row.status).toBe('pending');
    expect(row.last_error_code).toBe('NETWORK_OR_RESPONSE');
  });
});

describe('reconciliation queries the centre with the same key and snapshot', () => {
  async function probeWith(respond: Respond, userId: string) {
    const job = await eventOf(userId);
    const payload = await contact.contactSnapshot(job);
    if (!payload) throw new Error('the newest outbox version must have a snapshot');
    const { calls, send } = spySend(respond);
    const state = await contact.probeContact(job, payload, send);
    return { calls, payload, state };
  }

  it('asks by idempotency key and sends the snapshot the upsert would have sent', async () => {
    const user = await createContact({ emailVerified: true, marketingOptInRequested: true, preferredLocale: 'zh-CN' });
    const { calls, payload, state } = await probeWith((_url, init) => {
      const sent = JSON.parse(String(init.body)) as {
        idempotencyKey: string; contact: { marketingConsent: boolean };
      };
      return Response.json({ data: {
        applicationId: 42,
        idempotencyKey: sent.idempotencyKey,
        operation: { status: 'succeeded', requestMatches: true, contactApplicationId: 9001 },
        contact: {
          bindingMatches: true, profileMatches: true,
          marketingConsent: sent.contact.marketingConsent,
          marketingSuppressed: false, globalStatus: 'active',
        },
      } });
    }, user.userId);

    expect(state).toEqual({ state: 'confirmed', code: 'MATCHED' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href)
      .toBe(new URL('/api/v1/contacts/reconcile', process.env.EMAIL_CENTER_URL).href);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.cache).toBe('no-store');
    expect(headerOf(calls[0], 'authorization')).toBe(`Bearer ${process.env.EMAIL_CENTER_API_KEY}`);
    expect(headerOf(calls[0], 'idempotency-key')).toBeNull(); // the key is in the body, not a header
    const body = bodyOf(calls[0]);
    const latest = await latestOutbox(user.userId);
    expect(body.idempotencyKey).toBe(`saas:contact:${user.userId}:v${latest.event_version}`);
    expect(body.contact).toEqual(payload);
  });

  const probes: Array<[string, Record<string, unknown>, Record<string, unknown>, unknown]> = [
    ['the centre never received the change', { status: 'not_received', requestMatches: true, contactApplicationId: null }, {}, { state: 'notReceived', code: 'NOT_RECEIVED' }],
    ['another request reused the key', { status: 'succeeded', requestMatches: false, contactApplicationId: null }, {}, { state: 'conflict', code: 'IDEMPOTENCY_CONFLICT' }],
    ['the remote operation failed', { status: 'failed', requestMatches: true, contactApplicationId: null }, {}, { state: 'conflict', code: 'REMOTE_FAILED' }],
    ['the remote contact is bound elsewhere', { status: 'succeeded', requestMatches: true, contactApplicationId: 5 }, { bindingMatches: false }, { state: 'conflict', code: 'REMOTE_BINDING_MISMATCH' }],
    ['the remote contact was suppressed', { status: 'succeeded', requestMatches: true, contactApplicationId: 5 }, { marketingSuppressed: true }, { state: 'confirmed', code: 'AUTHORITY_SUPPRESSED' }],
    ['the remote preference differs', { status: 'succeeded', requestMatches: true, contactApplicationId: 5 }, { marketingConsent: true }, { state: 'confirmed', code: 'REMOTE_PREFERENCE_CHANGED' }],
    ['the remote operation is still processing', { status: 'processing', requestMatches: true, contactApplicationId: null }, {}, { state: 'unavailable', code: 'REMOTE_PROCESSING', permanent: false }],
  ];

  it.each(probes)('maps the reconcile answer when %s', async (_name, operation, contactPatch, expected) => {
    const user = await createContact({ emailVerified: false });
    const { state } = await probeWith((_url, init) => {
      const sent = JSON.parse(String(init.body)) as { idempotencyKey: string };
      return Response.json({ data: {
        applicationId: 42,
        idempotencyKey: sent.idempotencyKey,
        operation,
        contact: {
          bindingMatches: true, profileMatches: true, marketingConsent: false,
          marketingSuppressed: false, globalStatus: 'active', ...contactPatch,
        },
      } });
    }, user.userId);

    expect(state).toEqual(expected);
  });

  it('treats an unanswered, malformed or unfaithful probe as unavailable, not as success', async () => {
    const user = await createContact({ emailVerified: false });

    const offline = await probeWith(() => { throw new Error('ECONNREFUSED'); }, user.userId);
    expect(offline.state).toEqual({
      state: 'unavailable', code: 'RECONCILE_NETWORK_OR_RESPONSE', permanent: false,
    });

    const throttled = await probeWith(
      () => new Response('', { status: 429, headers: { 'retry-after': '30' } }), user.userId,
    );
    expect(throttled.state).toEqual({
      state: 'unavailable', code: 'RECONCILE_HTTP_429', permanent: false, retryAfter: '30',
    });

    const forbidden = await probeWith(() => new Response('', { status: 403 }), user.userId);
    expect(forbidden.state).toEqual({
      state: 'unavailable', code: 'RECONCILE_HTTP_403', permanent: true, retryAfter: null,
    });

    const malformed = await probeWith(() => Response.json({ data: { applicationId: 42 } }), user.userId);
    expect(malformed.state).toEqual({
      state: 'unavailable', code: 'INVALID_RECONCILE_RESPONSE', permanent: true,
    });

    const echoed = await probeWith((_url, _init) => Response.json({ data: {
      applicationId: 42,
      idempotencyKey: 'saas:contact:someone-else:v1',
      operation: { status: 'not_received', requestMatches: true, contactApplicationId: null },
      contact: null,
    } }), user.userId);
    expect(echoed.state).toEqual({
      state: 'unavailable', code: 'INVALID_RECONCILE_RESPONSE', permanent: true,
    });
  });

  it('keeps every send inside the batch budget it was given', async () => {
    const { send } = spySend(() => contactReceipt());
    const expired = contact.contactFetchWithin(send, Date.now() - 1);
    await expect(expired('http://127.0.0.1:3100/api/v1/contacts/upsert')).rejects
      .toThrowError('EMAIL_BATCH_BUDGET_EXPIRED');

    const user = await createContact();
    const empty = spySend(() => contactReceipt());
    const report = await worker.runEmailContactSync({ maxJobs: 25, maxMillis: 0, send: empty.send });
    expect(report.claimed).toBe(0);
    expect(empty.calls).toHaveLength(0);
    expect(user.userId).toBeTruthy();
  });
});

