import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Idempotent personal-workspace bootstrap plus the referral-profile side of the
 * registration flow. Both depend on database triggers installed by the
 * migrations, so the assertions read the real rows back instead of trusting the
 * application's return value.
 */
process.env.FEATURE_REFERRALS = 'true';

const suffix = randomUUID();
const scope: { userIds: string[]; organizationIds: string[] } = {
  userIds: [],
  organizationIds: [],
};

type Bootstrap = typeof import('@/lib/workspace/bootstrap');
type Invite = typeof import('@/lib/referrals/invite');

let bootstrap: Bootstrap;
let invite: Invite;
let userId = '';
let fixtures: typeof import('./support/fixtures');

beforeAll(async () => {
  fixtures = await import('./support/fixtures');
  const user = await fixtures.createUserFixture({ suffix });
  userId = user.userId;
  scope.userIds.push(userId);
  bootstrap = await import('@/lib/workspace/bootstrap');
  invite = await import('@/lib/referrals/invite');
});

afterAll(async () => {
  await fixtures.cleanupFixtures(scope);
  await fixtures.closeClient();
});

describe('personal workspace bootstrap', () => {
  it('derives a stable slug from the user id', () => {
    expect(bootstrap.personalSlug('AbC-123_x')).toBe('personal-abc123x');
    expect(bootstrap.personalSlug(userId)).toBe(
      `personal-${userId.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    );
    expect(bootstrap.personalSlug('user with spaces')).toBe('personal-userwithspaces');
  });

  it('creates exactly one workspace for repeated calls', async () => {
    const first = await bootstrap.ensurePersonalWorkspace(userId, 'Vitest');
    const second = await bootstrap.ensurePersonalWorkspace(userId, 'Renamed');
    expect(second.id).toBe(first.id);
    scope.organizationIds.push(first.id);

    const client = await fixtures.getClient();
    const rows = await client<{ count: number }[]>`
      SELECT COUNT(*)::integer AS count FROM organization WHERE slug = ${bootstrap.personalSlug(userId)}
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it('makes the caller the owner and nothing else', async () => {
    const workspace = await bootstrap.ensurePersonalWorkspace(userId, 'Vitest');
    const client = await fixtures.getClient();
    const members = await client<{ user_id: string; role: string; count: number }[]>`
      SELECT user_id, role, COUNT(*) OVER ()::integer AS count
      FROM member WHERE organization_id = ${workspace.id}
    `;
    expect(members).toHaveLength(1);
    expect(members[0]?.user_id).toBe(userId);
    expect(members[0]?.role).toBe('owner');
  });

  it('never reuses another user workspace', async () => {
    const other = await fixtures.createUserFixture();
    scope.userIds.push(other.userId);
    const mine = await bootstrap.ensurePersonalWorkspace(userId, 'Vitest');
    const theirs = await bootstrap.ensurePersonalWorkspace(other.userId, 'Other');
    scope.organizationIds.push(theirs.id);
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.slug).toBe(bootstrap.personalSlug(other.userId));
  });
});

describe('referral profile bootstrap', () => {
  it('creates the profile and invite code in the database, not the caller', async () => {
    const client = await fixtures.getClient();
    const rows = await client<{ invite_code: string; sync_version: number }[]>`
      SELECT invite_code, sync_version FROM referral_profiles WHERE user_id = ${userId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invite_code).toMatch(/^[0-9A-Z]{8}$/);
    // The signing layer must accept exactly what the database issued.
    expect(
      invite.verifyInviteTicket(
        invite.signInviteTicket({
          code: rows[0]!.invite_code,
          inviterUserId: userId,
          issuedAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 86_400,
        }),
      ),
    ).not.toBeNull();
  });

  it('refuses to change an invite code once issued', async () => {
    const client = await fixtures.getClient();
    await expect(
      client`UPDATE referral_profiles SET invite_code = ${'SF' + 'A'.repeat(32)} WHERE user_id = ${userId}`,
    ).rejects.toThrow(/invite|code|不允许|禁止|immutable/i);
  });

  it('queues a durable sync job for the new profile', async () => {
    const client = await fixtures.getClient();
    const rows = await client<{ status: string; event_version: number }[]>`
      SELECT status::text, event_version FROM referral_user_outbox
      WHERE user_id = ${userId} ORDER BY event_version ASC
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.event_version).toBeGreaterThanOrEqual(1);
  });

  it('coalesces a second profile change into a newer event version', async () => {
    const client = await fixtures.getClient();
    const before = await client<{ event_version: number }[]>`
      SELECT MAX(event_version)::integer AS event_version FROM referral_user_outbox WHERE user_id = ${userId}
    `;
    // The coalescing hook hangs off the profile-bearing columns of "user", not
    // off a direct bump of sync_version: only a real profile change may queue a
    // newer event.
    await client`UPDATE "user" SET name = ${'Renamed ' + suffix} WHERE id = ${userId}`;
    const after = await client<{ event_version: number }[]>`
      SELECT MAX(event_version)::integer AS event_version FROM referral_user_outbox WHERE user_id = ${userId}
    `;
    expect(after[0]!.event_version).toBeGreaterThan(before[0]!.event_version);
  });
});
