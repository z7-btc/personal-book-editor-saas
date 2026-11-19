import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * AC11/AC12 — the personal bootstrap aggregate and the invite first touch.
 *
 * Concurrent or failing bootstrap must still end in exactly one personal
 * workspace, one invite code, one attribution and one external referral user
 * per side, and the two sync jobs have to recover independently. The invite
 * claim is signed and guarded, and the local attribution mirror can never be
 * rewritten.
 *
 * Real, isolated PostgreSQL per file. Only the Payment Center referral API is
 * mocked (network boundary, no host named payments.example.test exists); every
 * assertion reads real rows written by the application code or by the database
 * triggers installed by the migrations. The ticket-level guards (expiry, tamper,
 * self-referral, pre-existing account) are already covered by
 * tests/referral-contract.test.ts, so this file adds the concurrency,
 * immutability and aggregate halves.
 */
const siteId = '00000000-0000-4000-8000-000000000001';
process.env.FEATURE_REFERRALS = 'true';
// The overview's fifth call is the catalog, made with the checkout's key; with
// the Payment Center capability off that call never happens and the assertion
// below sees four keys instead of five.
process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.APP_BASE_URL = 'https://app.example.test';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = siteId;
process.env.PAYMENT_CENTER_REFERRAL_API_KEY = 'vitest-referral-key';

type Json = Record<string, unknown>;
type OutboxRow = {
  id: number; event_version: number; status: string; attempt_count: number;
  last_error_code: string | null;
};

const scope: { userIds: string[]; organizationIds: string[] } = {
  userIds: [], organizationIds: [],
};
let fixtures: typeof import('./support/fixtures');
let client: Sql;
let bootstrap: typeof import('@/lib/workspace/bootstrap');
let invite: typeof import('@/lib/referrals/invite');
let worker: typeof import('@/lib/referrals/worker');
let overview: typeof import('@/lib/referrals/overview');

beforeAll(async () => {
  fixtures = await import('./support/fixtures');
  client = await fixtures.getClient();
  bootstrap = await import('@/lib/workspace/bootstrap');
  invite = await import('@/lib/referrals/invite');
  worker = await import('@/lib/referrals/worker');
  overview = await import('@/lib/referrals/overview');
});

afterAll(async () => {
  await fixtures.cleanupFixtures(scope);
  await fixtures.closeClient();
});

/** A user exactly as registration leaves it: profile and outbox come from triggers. */
async function seedUser(tag: string) {
  const user = await fixtures.createUserFixture({
    suffix: fixtures.uniqueSuffix(), emailVerified: true,
  });
  scope.userIds.push(user.userId);
  void tag;
  return user;
}

async function profileOf(userId: string) {
  const [row] = await client<{ invite_code: string; sync_version: number }[]>`
    SELECT invite_code, sync_version FROM referral_profiles WHERE user_id = ${userId}`;
  if (!row) throw new Error(`referral profile for ${userId} is missing`);
  return row;
}

async function ticketFor(inviterUserId: string, code: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return invite.signInviteTicket({
    code, inviterUserId, issuedAt, expiresAt: issuedAt + 86_400,
  });
}

async function outboxRows(userId: string) {
  return client<OutboxRow[]>`SELECT id, event_version, status::text AS status, attempt_count,
      last_error_code FROM referral_user_outbox
    WHERE user_id = ${userId} ORDER BY event_version`;
}

async function attributionRows(userId: string) {
  return client<{ inviter_user_id: string; invite_code: string; bound_at: string }[]>`
    SELECT inviter_user_id, invite_code, bound_at FROM referral_attributions
    WHERE user_id = ${userId}`;
}

/**
 * The worker leases every pending job in the database, so tests that drive it
 * retire the jobs of users created by earlier tests first.
 */
async function parkOtherJobs(keep: string[]) {
  await client`UPDATE referral_user_outbox SET status = 'superseded'
    WHERE status = 'pending' AND user_id <> ALL(${keep}::text[])`;
}

type UpsertCall = { path: string; apiKey: string | null; body: Json };
type RemoteCall = { path: string; search: string; apiKey: string | null };
let upserts: UpsertCall[] = [];
let remoteCalls: RemoteCall[] = [];
let failingUserIds = new Set<string>();

/** Remote referral figures served by the mocked Payment Center (AC31). */
let summaryInviteCount = 5;
let summaryPatch: Json = {};
let ledgerRows: Json[] = [];
let withdrawalRows: Json[] = [];

function ledgerRow(index: number): Json {
  return {
    id: `led_${index}`, website_id: siteId, currency: 'USDT', entry_type: 'commission',
    created_at: '2026-01-01T00:00:00.000Z', amount_decimal: '1.50000000',
    balance_after_decimal: '12.50000000',
  };
}

function withdrawalRow(index: number, remoteUserId: string): Json {
  return {
    id: `wd_${index}`, website_id: siteId, referral_user_id: remoteUserId, currency: 'USDT',
    status: 'sending', requested_at: '2026-01-02T00:00:00.000Z', amount_decimal: '20.00000000',
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function summaryPayload(userId: string): Json {
  return {
    exists: true,
    user: { id: `remote_${userId}`, external_user_id: userId, website_id: siteId },
    balance: {
      currency: 'USDT',
      available_amount_decimal: '12.50000000',
      verified_available_amount_decimal: '10.00000000',
      pending_amount_decimal: '0.00000000',
      pending_commission_amount_decimal: '2.50000000',
      withdrawn_amount_decimal: '3.00000000',
      total_earned_decimal: '18.00000000',
    },
    invite_count: summaryInviteCount,
    order_count: 4,
    tier: { name: 'Silver', code: 'silver' },
    next_tier: { name: 'Gold', min_order_count: 10 },
    effective_rates: [{ channel: '__personal_default__', commission_rate: 0.25 }],
    maintenance_mode: true,
    withdrawal_enabled: false,
    withdrawal_minimum_amount_decimal: '25.00000000',
    commission_term_months: 12,
    ...summaryPatch,
  };
}

/** Mocked Payment Center referral API: upsert plus overview reads. */
const centerSend = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url).pathname;
  const headers = new Headers(init?.headers);
  const apiKey = headers.get('x-api-key');
  if (path.endsWith('/users/upsert')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as Json;
    upserts.push({ path, apiKey, body });
    const externalUserId = String(body.external_user_id);
    if (failingUserIds.has(externalUserId)) {
      return jsonResponse({ error: 'unavailable' }, 503);
    }
    const referredBy = body.referred_by_external_user_id;
    return jsonResponse({
      data: {
        user: {
          id: `remote_${externalUserId}`,
          website_id: siteId,
          external_user_id: externalUserId,
          invite_code: body.invite_code,
          username: body.username,
          referred_by_id: referredBy ? `remote_inviter_${String(referredBy)}` : null,
        },
      },
    });
  }
  remoteCalls.push({ path, search: new URL(url).search, apiKey });
  const userMatch = path.match(/^\/api\/referral-center\/users\/([^/]+)\/(summary|ledger)$/);
  if (userMatch) {
    const userId = decodeURIComponent(userMatch[1]!);
    if (userMatch[2] === 'summary') {
      return jsonResponse({ status: 'success', data: summaryPayload(userId) });
    }
    return jsonResponse({ status: 'success', data: { currency: 'USDT', ledger: ledgerRows } });
  }
  if (path === '/api/referral-center/withdrawals') {
    return jsonResponse({
      status: 'success', data: { currency: 'USDT', withdrawals: withdrawalRows },
    });
  }
  return jsonResponse({ error: 'not found' }, 404);
}) as unknown as typeof fetch;

describe('personal bootstrap aggregate (AC11)', () => {
  it('creates one workspace, member, invite code and sync job under concurrent bootstrap', async () => {
    const user = await seedUser('bootstrap-race');

    const results = await Promise.all([
      bootstrap.ensurePersonalWorkspace(user.userId, 'First'),
      bootstrap.ensurePersonalWorkspace(user.userId, 'Second'),
      bootstrap.ensurePersonalWorkspace(user.userId, 'Third'),
      bootstrap.ensurePersonalWorkspace(user.userId, 'Fourth'),
    ]);

    // Every racing bootstrap has to converge on the personal workspace of this
    // user, not create a second one.
    const organizationIds = [...new Set(results.map((row) => row.id))];
    expect(organizationIds).toHaveLength(1);
    const organizationId = organizationIds[0]!;
    scope.organizationIds.push(organizationId);

    const slug = bootstrap.personalSlug(user.userId);
    const [counts] = await client<{
      organizations: number; members: number; owners: number; profiles: number;
    }[]>`SELECT
        (SELECT COUNT(*)::integer FROM organization WHERE slug = ${slug}) AS organizations,
        (SELECT COUNT(*)::integer FROM member WHERE organization_id = ${organizationId})
          AS members,
        (SELECT COUNT(*)::integer FROM member WHERE organization_id = ${organizationId}
          AND role = 'owner') AS owners,
        (SELECT COUNT(*)::integer FROM referral_profiles WHERE user_id = ${user.userId})
          AS profiles`;
    expect(counts).toEqual({ organizations: 1, members: 1, owners: 1, profiles: 1 });

    const profile = await profileOf(user.userId);
    expect(profile.invite_code).toMatch(/^[0-9A-Z]{8}$/);
    expect(profile.sync_version).toBe(1);

    // The aggregate also owns exactly one recoverable referral sync job.
    const jobs = await outboxRows(user.userId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ event_version: 1, status: 'pending', attempt_count: 0 });
  });

  it('keeps concurrent bootstraps of two users in separate workspaces', async () => {
    const owner = await seedUser('personal-a');
    const other = await seedUser('personal-b');

    const [first, second] = await Promise.all([
      bootstrap.ensurePersonalWorkspace(owner.userId, 'Owner'),
      bootstrap.ensurePersonalWorkspace(other.userId, 'Other'),
    ]);
    scope.organizationIds.push(first.id, second.id);

    expect(first.id).not.toBe(second.id);
    const [isolation] = await client<{ owner_workspace: number; other_workspace: number }[]>`
      SELECT
        (SELECT COUNT(*)::integer FROM member WHERE organization_id = ${first.id}
          AND user_id = ${owner.userId}) AS owner_workspace,
        (SELECT COUNT(*)::integer FROM member WHERE organization_id = ${first.id}
          AND user_id = ${other.userId}) AS other_workspace`;
    expect(isolation).toEqual({ owner_workspace: 1, other_workspace: 0 });

    const ownerProfile = await profileOf(owner.userId);
    const otherProfile = await profileOf(other.userId);
    // A shared code would merge two users into one referral identity.
    expect(ownerProfile.invite_code).not.toBe(otherProfile.invite_code);
  });
});

describe('invite first touch (AC12)', () => {
  it('binds the first touch only when two inviters claim one invitee concurrently', async () => {
    const invitee = await seedUser('invitee-race');
    const first = await seedUser('inviter-first');
    const second = await seedUser('inviter-second');
    const firstProfile = await profileOf(first.userId);
    const secondProfile = await profileOf(second.userId);
    const firstTicket = await ticketFor(first.userId, firstProfile.invite_code);
    const secondTicket = await ticketFor(second.userId, secondProfile.invite_code);

    const [firstOutcome, secondOutcome] = await Promise.all([
      invite.claimInvite(invitee.userId, firstTicket),
      invite.claimInvite(invitee.userId, secondTicket),
    ]);

    // The user row lock in claimInvite serializes the two claims: one wins the
    // first touch, the other can never overwrite it.
    expect([firstOutcome, secondOutcome].sort()).toEqual(['claimed', 'conflict']);
    const rows = await attributionRows(invitee.userId);
    expect(rows).toHaveLength(1);
    const winner = firstOutcome === 'claimed' ? first : second;
    const winnerProfile = firstOutcome === 'claimed' ? firstProfile : secondProfile;
    expect(rows[0]).toMatchObject({
      inviter_user_id: winner.userId, invite_code: winnerProfile.invite_code,
    });

    // Repeat claims are idempotent for the winner and refused for the loser.
    const loserTicket = firstOutcome === 'claimed' ? secondTicket : firstTicket;
    expect(await invite.claimInvite(invitee.userId, loserTicket)).toBe('conflict');
    expect(await invite.claimInvite(invitee.userId, winner === first ? firstTicket : secondTicket))
      .toBe('already_claimed');
    const after = await attributionRows(invitee.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.bound_at).toBe(rows[0]!.bound_at);

    // A new attribution schedules exactly one new version, so the external
    // referral user learns the inviter without duplicating the event.
    const profile = await profileOf(invitee.userId);
    expect(profile.sync_version).toBe(2);
    const jobs = await outboxRows(invitee.userId);
    expect(jobs.map((row) => [row.event_version, row.status])).toEqual([
      [1, 'pending'], [2, 'pending'],
    ]);
  });

  it('refuses a self-referral in the database as well', async () => {
    const user = await seedUser('self');
    const profile = await profileOf(user.userId);
    await expect(client`INSERT INTO referral_attributions
        (user_id, inviter_user_id, invite_code)
      VALUES (${user.userId}, ${user.userId}, ${profile.invite_code})`)
      .rejects.toThrow(/referral_attributions_not_self_check/);
    expect(await attributionRows(user.userId)).toHaveLength(0);
  });

  it('never lets the attribution mirror be rewritten', async () => {
    const invitee = await seedUser('invitee-immutable');
    const inviter = await seedUser('inviter-immutable');
    const other = await seedUser('inviter-other');
    const inviterProfile = await profileOf(inviter.userId);
    const otherProfile = await profileOf(other.userId);
    expect(await invite.claimInvite(invitee.userId,
      await ticketFor(inviter.userId, inviterProfile.invite_code))).toBe('claimed');
    const [bound] = await attributionRows(invitee.userId);

    await expect(client`UPDATE referral_attributions
        SET inviter_user_id = ${other.userId}, invite_code = ${otherProfile.invite_code}
      WHERE user_id = ${invitee.userId}`)
      .rejects.toThrow(/referral attribution is immutable/);

    // The code in an attribution is a historical record, so a mismatch with the
    // inviter's current code is allowed (0027 reissues codes). What must never
    // pass is naming an inviter that has no referral profile at all.
    const third = await seedUser('invitee-mismatch');
    await expect(client`INSERT INTO referral_attributions
        (user_id, inviter_user_id, invite_code)
      VALUES (${third.userId}, ${randomUUID()}, ${inviterProfile.invite_code})`)
      .rejects.toThrow(/referral inviter does not exist/);

    const after = await attributionRows(invitee.userId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      inviter_user_id: inviter.userId,
      invite_code: inviterProfile.invite_code,
      bound_at: bound!.bound_at,
    });
    expect(await attributionRows(third.userId)).toHaveLength(0);
  });
});

describe('referral user sync (AC11)', () => {
  it('syncs inviter and invitee independently and recovers the failed one', async () => {
    const invitee = await seedUser('sync-invitee');
    const inviter = await seedUser('sync-inviter');
    const inviterProfile = await profileOf(inviter.userId);
    expect(await invite.claimInvite(invitee.userId,
      await ticketFor(inviter.userId, inviterProfile.invite_code))).toBe('claimed');
    await parkOtherJobs([invitee.userId, inviter.userId]);

    upserts = [];
    failingUserIds = new Set([invitee.userId]);
    const firstRun = await worker.runReferralUserSync({
      maxJobs: 10, maxMillis: 10_000, send: centerSend,
    });

    // The invitee's newest version fails, the inviter's job still succeeds, and
    // the obsolete first version is retired instead of being sent.
    expect(firstRun).toEqual({ claimed: 2, succeeded: 1, retried: 1,
      deadLetter: 0, superseded: 0 });
    expect(upserts.map((call) => call.path))
      .toEqual(['/api/referral-center/users/upsert', '/api/referral-center/users/upsert']);
    expect(upserts.every((call) => call.apiKey === 'vitest-referral-key')).toBe(true);
    const inviteeCall = upserts.find((call) => call.body.external_user_id === invitee.userId);
    const inviterCall = upserts.find((call) => call.body.external_user_id === inviter.userId);
    // The inviter travels by id: their invite code can be reissued, their id cannot.
    expect(inviteeCall!.body.referred_by_external_user_id).toBe(inviter.userId);
    expect(inviterCall!.body.referred_by_external_user_id).toBeUndefined();

    let jobs = await outboxRows(invitee.userId);
    const failed = jobs.at(-1)!;
    expect(failed).toMatchObject({ event_version: 2, status: 'pending', attempt_count: 1,
      last_error_code: 'HTTP_503' });
    expect((await outboxRows(inviter.userId)).map((row) => row.status)).toEqual(['succeeded']);

    // Recovery: the same job id is retried once the external service is back.
    await client`UPDATE referral_user_outbox SET available_at = now()
      WHERE user_id = ${invitee.userId}`;
    failingUserIds = new Set();
    upserts = [];
    const secondRun = await worker.runReferralUserSync({
      maxJobs: 10, maxMillis: 10_000, send: centerSend,
    });
    expect(secondRun).toEqual({ claimed: 1, succeeded: 1, retried: 0,
      deadLetter: 0, superseded: 0 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.body).toMatchObject({
      external_user_id: invitee.userId,
      invite_code: (await profileOf(invitee.userId)).invite_code,
      referred_by_external_user_id: inviter.userId,
    });
    jobs = await outboxRows(invitee.userId);
    expect(jobs.at(-1)).toMatchObject({ id: failed.id, status: 'succeeded',
      attempt_count: 2, last_error_code: null });
  });

  it('sends only the newest version after two renames', async () => {
    const user = await seedUser('renamed');
    await client`UPDATE "user" SET name = 'First Name' WHERE id = ${user.userId}`;
    await client`UPDATE "user" SET name = 'Second Name' WHERE id = ${user.userId}`;
    await parkOtherJobs([user.userId]);

    upserts = [];
    failingUserIds = new Set();
    const report = await worker.runReferralUserSync({
      maxJobs: 10, maxMillis: 10_000, send: centerSend,
    });

    expect(report).toMatchObject({ claimed: 1, succeeded: 1, deadLetter: 0 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.body).toMatchObject({
      external_user_id: user.userId, username: 'Second Name',
    });
    const profile = await profileOf(user.userId);
    const jobs = await outboxRows(user.userId);
    const succeeded = jobs.filter((row) => row.status === 'succeeded');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.event_version).toBe(profile.sync_version);
    expect(jobs.some((row) => row.status === 'pending')).toBe(false);
  });

  it('dead-letters a binding mismatch instead of trusting the response', async () => {
    const user = await seedUser('binding-mismatch');
    await parkOtherJobs([user.userId]);
    const wrongBinding = (async () => new Response(JSON.stringify({
      data: { user: { id: 'remote_other', website_id: siteId,
        external_user_id: 'somebody-else', invite_code: 'SF00000000000000000000000000000000' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const report = await worker.runReferralUserSync({
      maxJobs: 5, maxMillis: 10_000, send: wrongBinding,
    });

    expect(report).toEqual({ claimed: 1, succeeded: 0, retried: 0,
      deadLetter: 1, superseded: 0 });
    const [job] = await outboxRows(user.userId);
    expect(job).toMatchObject({ status: 'dead_letter', last_error_code: 'BINDING_MISMATCH' });
  });
});

describe('referral overview authority (AC31)', () => {
  beforeEach(() => {
    upserts = [];
    remoteCalls = [];
    failingUserIds = new Set();
    summaryInviteCount = 5;
    summaryPatch = {};
    ledgerRows = [];
    withdrawalRows = [];
  });

  /** A user whose referral identity the Payment Center has confirmed. */
  async function syncedInviter(tag: string) {
    const inviter = await seedUser(tag);
    await parkOtherJobs([inviter.userId]);
    expect(await worker.runReferralUserSync({ maxJobs: 5, send: centerSend }))
      .toMatchObject({ succeeded: 1 });
    return inviter;
  }

  it('publishes the Payment Center figures and lists invitees from the local mirror', async () => {
    const inviter = await seedUser('overview-inviter');
    const invitees = [await seedUser('overview-a'), await seedUser('overview-b')];
    const code = (await profileOf(inviter.userId)).invite_code;
    for (const invitee of invitees) {
      expect(await invite.claimInvite(invitee.userId, await ticketFor(inviter.userId, code)))
        .toBe('claimed');
    }

    // Until the referral user is confirmed externally the page stays empty
    // instead of showing unconfirmed local guesses.
    expect(await overview.getReferralOverview(inviter.userId, 0, 0, 0, centerSend))
      .toEqual({ state: 'syncing' });
    expect(remoteCalls).toHaveLength(0);

    await parkOtherJobs([inviter.userId]);
    expect(await worker.runReferralUserSync({ maxJobs: 5, send: centerSend }))
      .toMatchObject({ succeeded: 1 });
    ledgerRows = [ledgerRow(1), ledgerRow(2)];
    withdrawalRows = [withdrawalRow(1, `remote_${inviter.userId}`)];

    const result = await overview.getReferralOverview(inviter.userId, 0, 0, 0, centerSend);
    if (result.state !== 'ready') throw new Error('overview did not become ready');

    // Balance, ledger and withdrawal state are the Payment Center's figures.
    expect(result.balance).toEqual({
      available: '12.50000000', verifiedAvailable: '10.00000000', pending: '2.50000000',
      withdrawn: '3.00000000', earned: '18.00000000',
    });
    expect(result.ledger).toEqual([
      { id: 'led_1', type: 'commission', amount: '1.50000000', balanceAfter: '12.50000000',
        currency: 'USDT', at: '2026-01-01T00:00:00.000Z' },
      { id: 'led_2', type: 'commission', amount: '1.50000000', balanceAfter: '12.50000000',
        currency: 'USDT', at: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(result.withdrawals).toEqual([{
      id: 'wd_1', status: 'sending', amount: '20.00000000', currency: 'USDT',
      at: '2026-01-02T00:00:00.000Z',
    }]);
    // 第五个（目录）调用走的是**收银台**那把 Key，返佣 Key 只负责前面四个接口。
    expect(remoteCalls.map((call) => call.apiKey))
      .toEqual(['vitest-referral-key', 'vitest-referral-key', 'vitest-referral-key',
        'vitest-referral-key', process.env.PAYMENT_CENTER_API_KEY]);
    expect(remoteCalls.map((call) => call.path)).toEqual([
      `/api/referral-center/users/${inviter.userId}/summary`,
      `/api/referral-center/users/${inviter.userId}/ledger`,
      '/api/referral-center/withdrawals',
      '/api/referral-center/tiers',
      '/api/payment-center/catalog',
    ]);
    // 目录在这份桩里不存在（404），渠道清单退回"读不到"，页面不整块空掉。
    expect(result.enabledChannels).toBeNull();
    expect(remoteCalls[1]!.search).toContain('limit=21');
    expect(remoteCalls[2]!.search).toContain(`external_user_id=${inviter.userId}`);
    // This stub has no ladder endpoint, so the call 404s and the card degrades to
    // an empty list rather than taking the balance down with it. The populated
    // ladder is pinned in tests/referral-ui.test.ts.
    expect(result.tiers).toEqual([]);
    expect(result.commissionTermMonths).toBe(12);

    // The external count stays authoritative, the invitee list is the local
    // immutable mirror, and the difference is surfaced instead of hidden.
    expect(result.inviteCount).toBe(5);
    expect(result.inviteSyncPending).toBe(true);
    expect(result.invitations.map((row) => row.id).sort())
      .toEqual(invitees.map((invitee) => invitee.userId).sort());
    expect(result.invitations.map((row) => row.email))
      .toEqual(invitees.map((invitee) => `${invitee.email[0]}***@${invitee.email.split('@')[1]}`));
    expect(result.inviteCode).toBe(code);
    expect(result.tier).toBe('Silver');
    expect(result.nextTier).toEqual({ name: 'Gold', minOrderCount: 10 });
    expect(result.rates).toEqual([{ channel: '__personal_default__', rate: 0.25,
      source: null, ruleName: null, cookieDays: null }]);
    expect(result.maintenance).toBe(true);
    expect(result.withdrawalEnabled).toBe(false);
    expect(result.withdrawalMinimum).toBe('25.00000000');
    expect(Object.keys(result)).not.toContain('total');
    expect(result.invitationsHaveMore).toBe(false);
    expect(result.ledgerHasMore).toBe(false);
    expect(result.withdrawalsHaveMore).toBe(false);
  });

  it('refuses an overview whose remote binding points at another website or user', async () => {
    const inviter = await syncedInviter('overview-binding');
    summaryPatch = {
      user: { id: 'remote_other', external_user_id: 'somebody-else', website_id: siteId },
    };
    await expect(overview.getReferralOverview(inviter.userId, 0, 0, 0, centerSend))
      .rejects.toThrow('Referral website or user binding mismatch.');

    summaryPatch = {
      user: { id: `remote_${inviter.userId}`, external_user_id: inviter.userId,
        website_id: '00000000-0000-4000-8000-0000000000ff' },
    };
    await expect(overview.getReferralOverview(inviter.userId, 0, 0, 0, centerSend))
      .rejects.toThrow('Referral website or user binding mismatch.');
  });

  it('publishes only has-more flags, never a fabricated total', async () => {
    const inviter = await syncedInviter('overview-pages');
    const code = (await profileOf(inviter.userId)).invite_code;
    for (let index = 0; index < 21; index++) {
      const invitee = await seedUser(`overview-page-${index}`);
      await client`INSERT INTO referral_attributions (user_id, inviter_user_id, invite_code)
        VALUES (${invitee.userId}, ${inviter.userId}, ${code})`;
    }
    // The external total deliberately disagrees with the local mirror count.
    summaryInviteCount = 3;
    ledgerRows = Array.from({ length: 21 }, (_, index) => ledgerRow(index));
    withdrawalRows = Array.from({ length: 21 }, (_, index) =>
      withdrawalRow(index, `remote_${inviter.userId}`));

    const result = await overview.getReferralOverview(inviter.userId, 0, 0, 0, centerSend);
    if (result.state !== 'ready') throw new Error('overview did not become ready');

    expect(result.invitations).toHaveLength(20);
    expect(result.invitationsHaveMore).toBe(true);
    expect(result.ledger).toHaveLength(20);
    expect(result.ledgerHasMore).toBe(true);
    expect(result.withdrawals).toHaveLength(20);
    expect(result.withdrawalsHaveMore).toBe(true);
    expect(result.inviteCount).toBe(3);
    expect(result.inviteSyncPending).toBe(true);
    expect(Object.keys(result).filter((key) => /total|pages?$/i.test(key))).toEqual([]);

    // Payment Center owns the commission rules, ledger, balance and tiers: the
    // SaaS schema has no local authority table to disagree with it (AC22/AC31).
    const [tables] = await client<{ names: string[] }[]>`
      SELECT COALESCE(ARRAY_AGG(table_name ORDER BY table_name), ARRAY[]::text[]) AS names
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'commission_ledger', 'commission_ledgers', 'commission_balance', 'commission_balances',
        'referral_rules', 'referral_tier', 'referral_tiers', 'commission_rules',
        'commission_tiers')`;
    expect(tables!.names).toEqual([]);
  });
});
