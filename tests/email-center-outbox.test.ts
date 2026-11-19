// Outbox delivery, leasing and reconciliation for the Email Center (AC 26, 27, 30).
//
// The Email Center itself lives in another application: every test here stubs
// only that HTTP boundary (a spy `send`) and asserts what the SaaS side builds,
// what it persists, and how it recovers — against the real PostgreSQL database.
process.env.FEATURE_EMAIL_CENTER = 'true';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupFixtures,
  closeClient,
  createUserFixture,
  getClient,
} from './support/fixtures';

type WorkerModule = typeof import('@/lib/email-center/worker');
type ReconcileModule = typeof import('@/lib/email-center/reconcile');

type ContactBody = {
  externalUserId: string;
  email: string;
  name: string;
  source: string;
  occurredAt: string;
  preferredLocale: string;
  localeSource: string;
  marketingConsent: boolean;
  metadata: Record<string, unknown>;
};

type ProbeBody = { idempotencyKey: string; contact: ContactBody };

type RemoteContact = {
  bindingMatches: boolean;
  profileMatches: boolean;
  marketingConsent: boolean;
  marketingSuppressed: boolean;
  globalStatus: 'active' | 'bounced' | 'complained' | 'suppressed';
};

type SendCall = { url: string; init: RequestInit };
type Respond = (url: string, init: RequestInit) => Response | Promise<Response>;

let worker: WorkerModule;
let reconcile: ReconcileModule;
// `FixtureScope.userIds` is optional, so the array is declared by its own type
// instead of by that interface: every call site below reads `scope.userIds`
// directly, and a definite `string[]` keeps that read total without spreading a
// non-null assertion over the whole file. The object stays assignable to
// `FixtureScope`, which is all `cleanupFixtures` needs.
const scope = { userIds: [] as string[] };

beforeAll(async () => {
  [worker, reconcile] = await Promise.all([
    import('@/lib/email-center/worker'),
    import('@/lib/email-center/reconcile'),
  ]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // Deleting the fixture users cascades to their outbox rows, so no pending,
  // leased or dead-lettered row can leak into the next case.
  const userIds = scope.userIds.splice(0);
  if (userIds.length > 0) await cleanupFixtures({ userIds });
});

afterAll(async () => {
  await cleanupFixtures(scope);
  await closeClient();
});

/* ------------------------------------------------------------------ helpers */

function parseBody<T>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body)) as T;
}

function spySend(respond: Respond): { calls: SendCall[]; send: typeof fetch } {
  const calls: SendCall[] = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as unknown as typeof fetch;
  return { calls, send };
}

function headerOf(call: SendCall, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

function upserts(calls: SendCall[]): SendCall[] {
  return calls.filter((call) => call.url.includes('/api/v1/contacts/upsert'));
}

function upsertBody(call: SendCall): ContactBody {
  return parseBody<ContactBody>(call.init);
}

function contactReceipt(applicationId = 9001, status = 200): Response {
  return Response.json({ data: { contactApplicationId: applicationId } }, { status });
}

function remoteContact(sent: ProbeBody, overrides: Partial<RemoteContact> = {}): RemoteContact {
  return {
    bindingMatches: true,
    profileMatches: true,
    marketingConsent: sent.contact.marketingConsent,
    marketingSuppressed: false,
    globalStatus: 'active',
    ...overrides,
  };
}

/** Answers a reconcile probe, echoing the idempotency key the SaaS side sent. */
function probe(build: (sent: ProbeBody) => Record<string, unknown>): Respond {
  return (_url, init) => {
    const sent = parseBody<ProbeBody>(init);
    return Response.json({
      data: { applicationId: 42, idempotencyKey: sent.idempotencyKey, ...build(sent) },
    });
  };
}

/** Routes probe traffic to one answer and upsert traffic to another. */
function emailCentre(probeAnswer: Respond, upsertAnswer: Respond = () => contactReceipt()): Respond {
  return (url, init) =>
    url.includes('/api/v1/contacts/reconcile') ? probeAnswer(url, init) : upsertAnswer(url, init);
}

const answered = (
  status: 'not_received' | 'processing' | 'succeeded' | 'failed',
  extra: { requestMatches?: boolean; contactApplicationId?: number | null } = {},
  contact: (sent: ProbeBody) => RemoteContact | null = () => null,
) =>
  probe((sent) => ({
    operation: {
      status,
      requestMatches: extra.requestMatches ?? true,
      contactApplicationId:
        extra.contactApplicationId === undefined
          ? status === 'succeeded'
            ? 9001
            : null
          : extra.contactApplicationId,
    },
    contact: contact(sent),
  }));

const confirmed = () => answered('succeeded', {}, (sent) => remoteContact(sent));
const notReceived = () => answered('not_received');
const stillProcessing = () => answered('processing');
const remoteFailed = () => answered('failed');
const idempotencyConflict = () =>
  answered('succeeded', { requestMatches: false }, (sent) => remoteContact(sent));

type OutboxState = {
  status: string;
  attempt_count: number;
  last_error_code: string | null;
  last_reconcile_code: string | null;
  lease_owner: string | null;
  reconcile_lease_owner: string | null;
  available_in: number | null;
  reconcile_in: number | null;
};

async function outboxState(userId: string): Promise<OutboxState | undefined> {
  const client = await getClient();
  const rows = await client<OutboxState[]>`
    SELECT status::text AS status, attempt_count, last_error_code, last_reconcile_code,
      lease_owner, reconcile_lease_owner,
      EXTRACT(EPOCH FROM (available_at - now()))::float8 AS available_in,
      EXTRACT(EPOCH FROM (reconcile_after - now()))::float8 AS reconcile_in
    FROM email_contact_outbox
    WHERE user_id = ${userId}
    ORDER BY event_version DESC
    LIMIT 1`;
  return rows[0];
}

async function eventVersion(userId: string): Promise<number> {
  const client = await getClient();
  const rows = await client<{ event_version: number }[]>`
    SELECT event_version FROM email_contact_outbox
    WHERE user_id = ${userId} ORDER BY event_version DESC LIMIT 1`;
  return Number(rows[0]?.event_version ?? 0);
}

async function versionRows(userId: string): Promise<Array<[number, string]>> {
  const client = await getClient();
  const rows = await client<{ event_version: number; status: string }[]>`
    SELECT event_version, status::text AS status FROM email_contact_outbox
    WHERE user_id = ${userId} ORDER BY event_version`;
  return rows.map((row) => [Number(row.event_version), String(row.status)]);
}

async function setUser(
  userId: string,
  patch: {
    emailVerified?: boolean;
    marketingOptInRequested?: boolean;
    preferredLocale?: string;
    localeSource?: string;
  },
): Promise<void> {
  const client = await getClient();
  await client`
    UPDATE "user" SET
      email_verified = COALESCE(${patch.emailVerified ?? null}::boolean, email_verified),
      marketing_opt_in_requested = COALESCE(${patch.marketingOptInRequested ?? null}::boolean, marketing_opt_in_requested),
      preferred_locale = COALESCE(${patch.preferredLocale ?? null}::text, preferred_locale),
      locale_source = COALESCE(${patch.localeSource ?? null}::text, locale_source)
    WHERE id = ${userId}`;
}

async function parkAs(
  userId: string,
  state: {
    status: string;
    attemptCount: number;
    availableIn?: number;
    leaseOwner?: string | null;
    leaseIn?: number | null;
    reconcileLeaseOwner?: string | null;
    reconcileLeaseIn?: number | null;
    reconcileAfterIn?: number | null;
    lastReconcileCode?: string | null;
  },
): Promise<void> {
  const client = await getClient();
  await client`
    UPDATE email_contact_outbox SET
      status = ${state.status}::email_outbox_status,
      attempt_count = ${state.attemptCount},
      available_at = now() + ${`${state.availableIn ?? 0} seconds`}::interval,
      lease_owner = ${state.leaseOwner ?? null},
      lease_expires_at = ${
        state.leaseIn == null ? null : client`now() + ${`${state.leaseIn} seconds`}::interval`
      },
      reconcile_lease_owner = ${state.reconcileLeaseOwner ?? null},
      reconcile_lease_expires_at = ${
        state.reconcileLeaseIn == null
          ? null
          : client`now() + ${`${state.reconcileLeaseIn} seconds`}::interval`
      },
      reconcile_after = ${
        state.reconcileAfterIn == null
          ? null
          : client`now() + ${`${state.reconcileAfterIn} seconds`}::interval`
      },
      last_reconcile_code = ${state.lastReconcileCode ?? null}
    WHERE user_id = ${userId}`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/* ------------------------------------------------------------ backoff policy */

describe('retry policy', () => {
  it('backs off exponentially with jitter when the centre is unavailable', () => {
    const samples = Array.from({ length: 24 }, () => worker.retryDelayMs(1, null));
    for (const delay of samples) {
      expect(delay).toBeGreaterThanOrEqual(5_000);
      expect(delay).toBeLessThan(7_000);
    }
    // Jitter: identical delays would synchronise every client onto one instant.
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it('grows the window per attempt and then flattens at the ceiling', () => {
    for (const [attempt, floor] of [[1, 5_000], [2, 10_000], [3, 20_000], [4, 40_000], [8, 640_000]] as const) {
      const delay = worker.retryDelayMs(attempt, null);
      expect(delay).toBeGreaterThanOrEqual(floor);
      expect(delay).toBeLessThan(floor + 2_000);
    }
    // Attempt 9+ is capped by the exponent, never growing without bound.
    expect(worker.retryDelayMs(20, null)).toBeLessThan(1_280_000 + 2_000);
  });

  it('honours Retry-After in seconds and caps it, but ignores nonsense values', () => {
    expect(worker.retryDelayMs(3, '2')).toBe(2_000);
    // A capped request never delays a runner for more than an hour.
    expect(worker.retryDelayMs(3, '99999')).toBe(3_600_000);
    // Zero and a past HTTP-date carry no instruction: exponential backoff applies.
    for (const retryAfter of ['0', new Date(Date.now() - 60_000).toUTCString(), 'soon']) {
      const delay = worker.retryDelayMs(2, retryAfter);
      expect(delay).toBeGreaterThanOrEqual(10_000);
      expect(delay).toBeLessThan(12_000);
    }
    const future = worker.retryDelayMs(2, new Date(Date.now() + 7_000).toUTCString());
    expect(future).toBeGreaterThan(4_000);
    expect(future).toBeLessThanOrEqual(7_000);
  });
});

/* ------------------------------------------------------------- delivery pass */

describe('outbox delivery', () => {
  it('registers opted-in and opted-out contacts alike, in one pass, within 30 seconds', async () => {
    const optedIn = await createUserFixture({ emailVerified: true, marketingOptInRequested: true });
    const optedOut = await createUserFixture({ emailVerified: true, marketingOptInRequested: false });
    const unverified = await createUserFixture({ emailVerified: false, marketingOptInRequested: true });
    scope.userIds.push(optedIn.userId, optedOut.userId, unverified.userId);

    const { calls, send } = spySend(() => contactReceipt());
    const report = await worker.runEmailContactSync({ maxJobs: 10, send });

    expect(report).toMatchObject({ claimed: 3, succeeded: 3, retried: 0, deadLetter: 0 });
    const bodies = upserts(calls).map(upsertBody);
    const byUser = new Map(bodies.map((body) => [body.externalUserId, body]));

    // An opt-out is a decision, not an error: the contact is still registered.
    expect(byUser.get(optedIn.userId)?.marketingConsent).toBe(true);
    expect(byUser.get(optedOut.userId)?.marketingConsent).toBe(false);
    // Consent is only claimed once ownership of the address is proven.
    expect(byUser.get(unverified.userId)?.marketingConsent).toBe(false);
    for (const body of bodies) expect(body.source).toBe('registration');

    // Delivery must not wait for a human: every event is queued and claimed now.
    for (const body of bodies) {
      expect(Number.isNaN(Date.parse(body.occurredAt))).toBe(false);
      expect(Date.now() - Date.parse(body.occurredAt)).toBeLessThan(30_000);
    }
  });

  it('carries the chosen language and where it came from', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await setUser(user.userId, { preferredLocale: 'zh-CN', localeSource: 'switcher' });

    const { calls, send } = spySend(() => contactReceipt());
    await worker.runEmailContactSync({ maxJobs: 1, send });

    const body = upsertBody(upserts(calls)[0]);
    expect(body.preferredLocale).toBe('zh-CN');
    expect(body.localeSource).toBe('switcher');
    expect(body.externalUserId).toBe(user.userId);
    expect(body.email).toBe(user.email);
    expect(body.metadata).toEqual({});
  });

  it('syncs the original consent choice as soon as ownership is confirmed', async () => {
    const user = await createUserFixture({ emailVerified: false, marketingOptInRequested: true });
    scope.userIds.push(user.userId);

    const first = spySend(() => contactReceipt());
    await worker.runEmailContactSync({ maxJobs: 1, send: first.send });
    expect(upsertBody(upserts(first.calls)[0]).marketingConsent).toBe(false);

    await setUser(user.userId, { emailVerified: true });
    const second = spySend(() => contactReceipt());
    await worker.runEmailContactSync({ maxJobs: 1, send: second.send });

    const body = upsertBody(upserts(second.calls)[0]);
    expect(headerOf(upserts(second.calls)[0], 'idempotency-key')).toBe(`saas:contact:${user.userId}:v2`);
    expect(body.source).toBe('api');
    expect(body.marketingConsent).toBe(true);
  });

  it('never blocks on a centre outage: the queue holds the work, the user row is untouched', async () => {
    const user = await createUserFixture({ emailVerified: true, marketingOptInRequested: true });
    scope.userIds.push(user.userId);

    const { send } = spySend(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3100');
    });
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });
    expect(report).toMatchObject({ claimed: 1, retried: 1, deadLetter: 0 });

    const state = await outboxState(user.userId);
    expect(state?.status).toBe('pending');
    expect(state?.last_error_code).toBe('NETWORK_OR_RESPONSE');

    const client = await getClient();
    const [row] = await client<{ email: string; email_verified: boolean }[]>`
      SELECT email, email_verified FROM "user" WHERE id = ${user.userId}`;
    expect(row?.email).toBe(user.email);
    expect(row?.email_verified).toBe(true);
  });

  it('budgets a pass by job count so a long backlog cannot starve other runners', async () => {
    const users = await Promise.all([
      createUserFixture({ emailVerified: true }),
      createUserFixture({ emailVerified: true }),
      createUserFixture({ emailVerified: true }),
    ]);
    scope.userIds.push(...users.map((user) => user.userId));

    const { calls, send } = spySend(() => contactReceipt());
    const report = await worker.runEmailContactSync({ maxJobs: 2, send });

    expect(report).toMatchObject({ claimed: 2, succeeded: 2 });
    expect(upserts(calls)).toHaveLength(2);
    const left = await Promise.all(users.map((user) => outboxState(user.userId)));
    expect(left.filter((state) => state?.status === 'pending')).toHaveLength(1);
  });

  it('retries with the same idempotency key so the centre can deduplicate', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);

    const failing = spySend(() => new Response('', { status: 503 }));
    await worker.runEmailContactSync({ maxJobs: 1, send: failing.send });
    expect(String((await outboxState(user.userId))?.status)).toBe('pending');

    const client = await getClient();
    await client`UPDATE email_contact_outbox SET available_at = now() WHERE user_id = ${user.userId}`;

    const retry = spySend(emailCentre(notReceived(), () => contactReceipt()));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send: retry.send });

    expect(report).toMatchObject({ claimed: 1, succeeded: 1, deadLetter: 0 });
    expect(headerOf(upserts(retry.calls)[0], 'idempotency-key')).toBe(
      headerOf(upserts(failing.calls)[0], 'idempotency-key'),
    );
    const state = await outboxState(user.userId);
    expect(state?.attempt_count).toBe(2);
    expect(state?.status).toBe('succeeded');
  });

  it('supersedes an abandoned older attempt instead of rolling back a newer choice', async () => {
    const user = await createUserFixture({ emailVerified: true, marketingOptInRequested: true });
    scope.userIds.push(user.userId);
    // A first attempt died mid-flight, still leased, before the user changed mind.
    await parkAs(user.userId, {
      status: 'processing',
      attemptCount: 1,
      leaseOwner: 'vitest-crashed-runner',
      leaseIn: -30,
    });
    await setUser(user.userId, { marketingOptInRequested: false });

    const { calls, send } = spySend(() => contactReceipt());
    const report = await worker.runEmailContactSync({ maxJobs: 5, send });

    expect(report).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(upserts(calls)).toHaveLength(1);
    expect(headerOf(upserts(calls)[0], 'idempotency-key')).toBe(`saas:contact:${user.userId}:v2`);
    expect(upsertBody(upserts(calls)[0]).marketingConsent).toBe(false);
    expect(await versionRows(user.userId)).toEqual([[1, 'superseded'], [2, 'succeeded']]);
  });
});

/* ------------------------------------------------------- leases and reclaiming */

describe('leases', () => {
  it('releases the row lock before the HTTP call and holds only a 30 second lease', async () => {
    const user = await createUserFixture({ emailVerified: true, marketingOptInRequested: true });
    scope.userIds.push(user.userId);

    const gate = deferred<Response>();
    const started = deferred<void>();
    let calls = 0;
    const send = (async () => {
      calls += 1;
      started.resolve();
      return gate.promise;
    }) as unknown as typeof fetch;

    const running = worker.runEmailContactSync({ maxJobs: 1, send });
    await started.promise;

    const state = await outboxState(user.userId);
    expect(state?.status).toBe('processing');
    expect(state?.lease_owner).toMatch(/^[0-9a-f-]{36}$/);
    expect(state?.attempt_count).toBe(1);
    // Claiming does not schedule anything: a row that is being processed is not
    // also waiting for a future attempt.
    expect(Number(state?.available_in)).toBeLessThanOrEqual(0);
    // The claim's transaction is over: a competing writer can take the row now.
    const client = await getClient();
    await client.begin(async (tx) => {
      await tx`SELECT 1 FROM email_contact_outbox WHERE user_id = ${user.userId} FOR UPDATE NOWAIT`;
    });

    const [leased] = await client<{ lease_in: number }[]>`
      SELECT EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS lease_in
      FROM email_contact_outbox WHERE user_id = ${user.userId}`;
    expect(Number(leased?.lease_in)).toBeGreaterThan(25);
    expect(Number(leased?.lease_in)).toBeLessThanOrEqual(30);

    gate.resolve(contactReceipt());
    const report = await running;
    expect(report).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(calls).toBe(1);
    expect((await outboxState(user.userId))?.lease_owner).toBeNull();
  });

  it('reclaims a lease abandoned by a crashed runner once it expires', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, {
      status: 'processing',
      attemptCount: 1,
      leaseOwner: 'vitest-crashed-runner',
      leaseIn: -1,
      availableIn: -1,
    });

    const { calls, send } = spySend(emailCentre(notReceived(), () => contactReceipt()));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, deadLetter: 0 });
    const state = await outboxState(user.userId);
    expect(state?.status).toBe('succeeded');
    expect(state?.attempt_count).toBe(2);
    expect(state?.lease_owner).toBeNull();
    // A reclaiming runner verifies before it re-sends: probe first, then upsert.
    expect(calls).toHaveLength(2);
  });

  it('will not touch a row another runner is still working on', async () => {
    const live = await createUserFixture({ emailVerified: true });
    const leasedForReconcile = await createUserFixture({ emailVerified: true });
    scope.userIds.push(live.userId, leasedForReconcile.userId);
    await parkAs(live.userId, {
      status: 'processing',
      attemptCount: 1,
      leaseOwner: 'vitest-live-runner',
      leaseIn: 25,
    });
    await parkAs(leasedForReconcile.userId, {
      status: 'pending',
      attemptCount: 0,
      availableIn: -1,
      reconcileLeaseOwner: 'vitest-reconciler',
      reconcileLeaseIn: 20,
    });

    const { calls, send } = spySend(() => contactReceipt());
    const report = await worker.runEmailContactSync({ maxJobs: 5, send });

    expect(report.claimed).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await outboxState(live.userId))?.lease_owner).toBe('vitest-live-runner');
  });

  it('clears a reconcile lease that expired, so delivery resumes', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, {
      status: 'pending',
      attemptCount: 1,
      availableIn: -1,
      reconcileLeaseOwner: 'vitest-dead-reconciler',
      reconcileLeaseIn: -1,
    });

    const { send } = spySend(emailCentre(notReceived(), () => contactReceipt()));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, succeeded: 1 });
    expect((await outboxState(user.userId))?.reconcile_lease_owner).toBeNull();
  });
});

/* ------------------------------------------------- retries, retry-after, dead letters */

describe('failure handling', () => {
  it('honours Retry-After from the centre instead of its own backoff', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);

    const { send } = spySend(() => new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, retried: 1, deadLetter: 0 });
    const state = await outboxState(user.userId);
    expect(state?.status).toBe('pending');
    expect(state?.last_error_code).toBe('HTTP_429');
    expect(Number(state?.available_in)).toBeGreaterThan(28);
    expect(Number(state?.available_in)).toBeLessThan(32);
  });

  it('waits before retrying a server error and records why', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);

    const { send } = spySend(() => new Response('', { status: 503 }));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });
    expect(report).toMatchObject({ claimed: 1, retried: 1 });

    const state = await outboxState(user.userId);
    expect(state?.last_error_code).toBe('HTTP_503');
    expect(Number(state?.available_in)).toBeGreaterThan(4.5);
    expect(Number(state?.available_in)).toBeLessThan(7.5);
    // The backoff and the reconcile schedule agree for a retryable row.
    expect(Number(state?.reconcile_in)).toBeGreaterThan(4.5);
  });

  it('dead-letters a permanently rejected payload and stops reconciling it', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);

    const { send } = spySend(() => new Response('', { status: 422 }));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });
    expect(report).toMatchObject({ claimed: 1, deadLetter: 1, retried: 0 });

    const state = await outboxState(user.userId);
    expect(state?.status).toBe('dead_letter');
    expect(state?.last_error_code).toBe('HTTP_422');
    expect(state?.reconcile_in).toBeNull();
    expect(state?.lease_owner).toBeNull();
  });

  it('keeps verifying a dead letter that has no permanent verdict', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, { status: 'pending', attemptCount: 7, availableIn: -1 });

    const { send } = spySend(() => {
      throw new Error('fetch failed');
    });
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, deadLetter: 1, retried: 0 });
    const state = await outboxState(user.userId);
    expect(state?.attempt_count).toBe(8);
    expect(state?.last_error_code).toBe('RECONCILE_NETWORK_OR_RESPONSE');
    // Transient: keep asking the centre whether the contact actually arrived.
    expect(Number(state?.reconcile_in)).toBeGreaterThan(55);
  });

  it('gives up on the eighth delivery attempt', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, { status: 'pending', attemptCount: 7, availableIn: -1 });

    const { calls, send } = spySend(
      emailCentre(notReceived(), () => new Response('', { status: 500 })),
    );
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, deadLetter: 1, retried: 0 });
    const state = await outboxState(user.userId);
    expect(state?.attempt_count).toBe(8);
    expect(state?.status).toBe('dead_letter');
    expect(state?.last_error_code).toBe('HTTP_500');
    expect(calls[1]?.url).toContain('/api/v1/contacts/upsert');
  });

  it('treats an unverified receipt as a failure, not as delivery', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);

    // 201 without the application id the centre is supposed to return.
    const { send } = spySend(() => Response.json({ data: {} }, { status: 201 }));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
    expect((await outboxState(user.userId))?.last_error_code).toBe('NETWORK_OR_RESPONSE');
  });
});

/* ------------------------------------------- reconciliation and manual retries */

describe('reconciliation', () => {
  it('records a verified record without re-asserting a suppressed consent', async () => {
    const user = await createUserFixture({ emailVerified: true, marketingOptInRequested: true });
    scope.userIds.push(user.userId);
    // The delivery worker only ever claims a `pending` row (or one whose lease
    // expired) with a previous attempt, which is the state a retry is in: the
    // probe below is what a second attempt starts with. A terminal row is the
    // reconcile pass's business, not this worker's.
    await parkAs(user.userId, {
      status: 'pending',
      attemptCount: 1,
      availableIn: -1,
    });

    const { calls, send } = spySend(
      emailCentre(
        answered('succeeded', {}, (sent) =>
          remoteContact(sent, { marketingConsent: false, marketingSuppressed: true }),
        ),
      ),
    );
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, reconciled: 1, succeeded: 0 });
    // Only the probe ran: the worker did not re-assert the local choice and
    // overwrite the centre's unsubscribe.
    expect(upserts(calls)).toHaveLength(0);
    expect(calls).toHaveLength(1);
    const state = await outboxState(user.userId);
    expect(state?.status).toBe('succeeded');
    expect(state?.last_error_code).toBeNull();
    expect(state?.reconcile_lease_owner).toBeNull();

    const client = await getClient();
    const [row] = await client<{ marketing_opt_in_requested: boolean }[]>`
      SELECT marketing_opt_in_requested FROM "user" WHERE id = ${user.userId}`;
    expect(row?.marketing_opt_in_requested).toBe(true);
  });

  it('waits for an operation the centre is still processing instead of sending it twice', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, { status: 'pending', attemptCount: 1, availableIn: -1 });

    const { calls, send } = spySend(emailCentre(stillProcessing(), () => contactReceipt()));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    // The centre is working on this idempotency key right now, so the answer is
    // neither a success nor a reason to send the same payload again: the row is
    // only re-scheduled and the worker comes back to ask.
    expect(report).toMatchObject({ claimed: 1, retried: 1, succeeded: 0, reconciled: 0 });
    expect(upserts(calls)).toHaveLength(0);
    const state = await outboxState(user.userId);
    expect(state?.status).toBe('pending');
    expect(state?.last_reconcile_code).toBe('REMOTE_PROCESSING');
    expect(Number(state?.available_in)).toBeGreaterThan(0);
  });

  it('dead-letters a conflicting remote record instead of guessing', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, { status: 'pending', attemptCount: 1, availableIn: -1 });

    const { send } = spySend(emailCentre(idempotencyConflict()));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    expect(report).toMatchObject({ claimed: 1, deadLetter: 1, reconciled: 0 });
    const state = await outboxState(user.userId);
    expect(state?.status).toBe('dead_letter');
    expect(state?.reconcile_in).toBeNull();
  });

  it('treats a permanently failed remote operation as final and does not re-ask', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, { status: 'pending', attemptCount: 1, availableIn: -1 });

    const { calls, send } = spySend(emailCentre(remoteFailed()));
    const report = await worker.runEmailContactSync({ maxJobs: 1, send });

    // The centre answered that the operation it was asked to perform failed:
    // retrying the same idempotency key would replay a rejected request, so the
    // row stops here and waits for a human rather than spending the next seven
    // attempts on an answer that cannot change.
    expect(report).toMatchObject({ claimed: 1, deadLetter: 1, retried: 0, reconciled: 0 });
    const state = await outboxState(user.userId);
    expect(state?.status).toBe('dead_letter');
    expect(state?.last_error_code).toBe('REMOTE_FAILED');
    expect(state?.last_reconcile_code).toBe('REMOTE_FAILED');
    // No further reconcile is scheduled: the verdict is permanent, so nothing
    // would be different next hour.
    expect(state?.reconcile_in).toBeNull();
    // Only the probe ran: a failed operation is not re-submitted behind the
    // centre's back.
    expect(upserts(calls)).toHaveLength(0);
  });

  it('does not reconcile a row whose newer version exists', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, { status: 'succeeded', attemptCount: 1, reconcileAfterIn: -1 });
    await setUser(user.userId, { preferredLocale: 'zh-CN' });

    const { calls, send } = spySend(emailCentre(confirmed()));
    const report = await reconcile.runEmailContactReconcile({ maxJobs: 5, send });

    expect(report.checked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('reports what a reconcile pass found instead of silently repairing', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, { status: 'succeeded', attemptCount: 2, reconcileAfterIn: -1 });

    const { send } = spySend(emailCentre(confirmed()));
    const report = await reconcile.runEmailContactReconcile({ maxJobs: 5, send });

    expect(report).toEqual({
      checked: 1, confirmed: 1, notReceived: 0, conflicts: 0, unreachable: 0, superseded: 0,
    });
    const state = await outboxState(user.userId);
    expect(state?.status).toBe('succeeded');
    expect(state?.reconcile_lease_owner).toBeNull();
    expect(Number(state?.reconcile_in)).toBeGreaterThan(3_500);
  });

  it('fails closed when the Email Center is not configured', async () => {
    vi.stubEnv('EMAIL_CENTER_API_KEY', '');
    await expect(reconcile.runEmailContactReconcile({ maxJobs: 1 })).rejects.toThrowError(
      /emailCenter is unavailable/,
    );
  });

  it('refuses a forced query without the original user and version', async () => {
    await expect(reconcile.runEmailContactReconcile({ force: true })).rejects.toThrowError(
      'A forced query requires the original user ID and event version.',
    );
  });

  it('keeps a permanently rejected contact out of routine work but reachable on demand', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    const rejected = spySend(() => new Response('', { status: 422 }));
    await worker.runEmailContactSync({ maxJobs: 1, send: rejected.send });
    expect(String((await outboxState(user.userId))?.status)).toBe('dead_letter');

    const routine = spySend(emailCentre(confirmed()));
    const routineReport = await reconcile.runEmailContactReconcile({ maxJobs: 5, send: routine.send });
    expect(routineReport.checked).toBe(0);
    expect(routine.calls).toHaveLength(0);

    // Manual review can always ask the centre about one exact event.
    const forced = spySend(emailCentre(notReceived()));
    const forcedReport = await reconcile.runEmailContactReconcile({
      force: true,
      userId: user.userId,
      eventVersion: await eventVersion(user.userId),
      send: forced.send,
    });
    expect(forcedReport.checked).toBe(1);
    const state = await outboxState(user.userId);
    expect(state?.last_reconcile_code).toBe('NOT_RECEIVED');
    expect(state?.reconcile_lease_owner).toBeNull();
  });

  it('requeues an event the centre confirms it never received', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, {
      status: 'dead_letter',
      attemptCount: 1,
      reconcileAfterIn: -1,
      lastReconcileCode: 'NOT_RECEIVED',
    });

    const { send } = spySend(emailCentre(notReceived()));
    const result = await reconcile.requeueEmailContact(
      user.userId,
      await eventVersion(user.userId),
      { send },
    );

    expect(result).toMatchObject({ action: 'requeued' });
    // The report is what the decision was made on, and it is handed back so a
    // caller can record why the extra send was granted.
    expect(result.report).toMatchObject({ checked: 1, notReceived: 1, confirmed: 0 });
    const state = await outboxState(user.userId);
    expect(state?.status).toBe('pending');
    expect(state?.last_reconcile_code).toBe('MANUAL_RETRY_REQUESTED');
    expect(Number(state?.available_in)).toBeLessThanOrEqual(0.5);
  });

  it('does not requeue an event that is not a known miss', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, {
      status: 'dead_letter',
      attemptCount: 1,
      reconcileAfterIn: -1,
      lastReconcileCode: 'HTTP_422',
    });

    const { send } = spySend(emailCentre(notReceived()));
    const result = await reconcile.requeueEmailContact(
      user.userId,
      await eventVersion(user.userId),
      { send },
    );

    // The centre now says it never received the operation, but the row's own
    // verdict was a permanent client rejection: the probe must not be allowed to
    // overwrite that verdict into a licence to resend the same rejected payload.
    expect(result).toMatchObject({ action: 'not_requeued' });
    expect(result.report.notReceived).toBe(1);
    expect(String((await outboxState(user.userId))?.status)).toBe('dead_letter');
  });

  it('reports an already delivered contact instead of sending it again', async () => {
    const user = await createUserFixture({ emailVerified: true });
    scope.userIds.push(user.userId);
    await parkAs(user.userId, { status: 'succeeded', attemptCount: 1, reconcileAfterIn: -1 });

    const { calls, send } = spySend(emailCentre(notReceived()));
    const result = await reconcile.requeueEmailContact(
      user.userId,
      await eventVersion(user.userId),
      { send },
    );

    expect(result).toMatchObject({ action: 'not_requeued' });
    expect(upserts(calls)).toHaveLength(0);
  });
});
