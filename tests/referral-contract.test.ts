import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupFixtures,
  closeClient,
  createUserFixture,
  getClient,
  uniqueSuffix,
} from './support/fixtures';

/**
 * Plan acceptance criteria 12 and 13: an invitation claim is signed, expires,
 * rejects self-referral and tampering, and can never overwrite an existing
 * first-touch attribution.
 *
 * `lib/config.ts` snapshots the feature flags into a top-level `features`
 * object the first time it is evaluated, and ES module imports are hoisted
 * above every statement in this file. The flag is therefore set at module
 * scope and `@/lib/referrals/invite` is imported dynamically inside
 * `beforeAll`, mirroring how the smoke scripts order env mutation before the
 * dynamic import of any module that reads capabilities.
 */
process.env.FEATURE_REFERRALS = 'true';
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'http://127.0.0.1:3000';
process.env.PAYMENT_CENTER_BASE_URL = process.env.PAYMENT_CENTER_BASE_URL || 'http://127.0.0.1:5000';
process.env.PAYMENT_CENTER_SITE_CODE = process.env.PAYMENT_CENTER_SITE_CODE || 'saas-framework';
process.env.PAYMENT_CENTER_WEBSITE_ID =
  process.env.PAYMENT_CENTER_WEBSITE_ID || '00000000-0000-4000-8000-000000000001';
process.env.PAYMENT_CENTER_REFERRAL_API_KEY =
  process.env.PAYMENT_CENTER_REFERRAL_API_KEY || 'referral-read-key';

const userIds: string[] = [];
const organizationIds: string[] = [];

type InviteModule = typeof import('@/lib/referrals/invite');
let invite: InviteModule;

beforeAll(async () => {
  invite = await import('@/lib/referrals/invite');
});

afterAll(async () => {
  await cleanupFixtures({ userIds, organizationIds });
  await closeClient();
});

function ticketFor(inviterUserId: string, overrides: Record<string, unknown> = {}) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return {
    code: `SF${'A'.repeat(32)}`,
    inviterUserId,
    issuedAt,
    expiresAt: issuedAt + 86_400,
    ...overrides,
  };
}

async function createInviter() {
  const inviter = await createUserFixture({ suffix: uniqueSuffix() });
  userIds.push(inviter.userId);
  // The `user_referral_profile_insert` database trigger already creates the
  // stable invite code in the same transaction as the account.
  const client = await getClient();
  const [profile] = await client`
    SELECT invite_code FROM referral_profiles WHERE user_id = ${inviter.userId}`;
  expect(profile?.invite_code).toMatch(/^[0-9A-Z]{8}$/);
  return { ...inviter, code: profile.invite_code as string };
}

describe('invite ticket signing', () => {
  it('round-trips a signed ticket without exposing the payload as plain text', () => {
    const inviter = 'user-1';
    const signed = invite.signInviteTicket(ticketFor(inviter));
    expect(signed.split('.')).toHaveLength(2);
    expect(signed).not.toContain(inviter);
    expect(invite.verifyInviteTicket(signed)).toMatchObject({ inviterUserId: inviter });
  });

  it('rejects a tampered payload, a tampered signature and a truncated value', () => {
    const signed = invite.signInviteTicket(ticketFor('user-1'));
    const [payload, signature] = signed.split('.');
    const forged = Buffer.from(JSON.stringify(ticketFor('user-2'))).toString('base64url');
    expect(invite.verifyInviteTicket(`${forged}.${signature}`)).toBeNull();
    expect(invite.verifyInviteTicket(`${payload}.${signature.slice(0, -2)}AA`)).toBeNull();
    expect(invite.verifyInviteTicket(payload)).toBeNull();
    expect(invite.verifyInviteTicket(`${payload}.${signature}.extra`)).toBeNull();
    expect(invite.verifyInviteTicket(undefined)).toBeNull();
    expect(invite.verifyInviteTicket('')).toBeNull();
  });

  it('rejects an oversized cookie value before parsing it', () => {
    expect(invite.verifyInviteTicket('a'.repeat(1_001))).toBeNull();
  });

  it('rejects an expired, not-yet-issued or over-long ticket', () => {
    const now = Math.floor(Date.now() / 1_000);
    expect(invite.verifyInviteTicket(invite.signInviteTicket(ticketFor('u', {
      issuedAt: now - 120, expiresAt: now - 60,
    })))).toBeNull();
    expect(invite.verifyInviteTicket(invite.signInviteTicket(ticketFor('u', {
      issuedAt: now + 3_600, expiresAt: now + 7_200,
    })))).toBeNull();
    expect(invite.verifyInviteTicket(invite.signInviteTicket(ticketFor('u', {
      issuedAt: now, expiresAt: now + 91 * 24 * 60 * 60,
    })))).toBeNull();
  });

  it('rejects a ticket whose code is not a well-formed invite code', () => {
    expect(invite.verifyInviteTicket(invite.signInviteTicket(ticketFor('u', { code: 'nope' })))).toBeNull();
    expect(invite.verifyInviteTicket(invite.signInviteTicket(ticketFor('u', { code: 'SF123' })))).toBeNull();
  });

  it('uses the documented cookie name', () => {
    expect(invite.INVITE_COOKIE_NAME).toBe('saas_referral_invite');
  });
});

describe('invite claim', () => {
  it('records the first verified inviter and is idempotent for the same ticket', async () => {
    const inviter = await createInviter();
    const invitee = await createUserFixture();
    userIds.push(invitee.userId);
    const signed = invite.signInviteTicket(ticketFor(inviter.userId, { code: inviter.code }));

    expect(await invite.claimInvite(invitee.userId, signed)).toBe('claimed');
    expect(await invite.claimInvite(invitee.userId, signed)).toBe('already_claimed');

    const client = await getClient();
    const [attribution] = await client`
      SELECT inviter_user_id, invite_code FROM referral_attributions
      WHERE user_id = ${invitee.userId}`;
    expect(attribution.inviter_user_id).toBe(inviter.userId);
    expect(attribution.invite_code).toBe(inviter.code);
  });

  it('refuses to overwrite an existing attribution with a different inviter', async () => {
    const first = await createInviter();
    const second = await createInviter();
    const invitee = await createUserFixture();
    userIds.push(invitee.userId);

    expect(await invite.claimInvite(invitee.userId,
      invite.signInviteTicket(ticketFor(first.userId, { code: first.code })))).toBe('claimed');
    expect(await invite.claimInvite(invitee.userId,
      invite.signInviteTicket(ticketFor(second.userId, { code: second.code })))).toBe('conflict');

    const client = await getClient();
    const rows = await client`
      SELECT inviter_user_id FROM referral_attributions WHERE user_id = ${invitee.userId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].inviter_user_id).toBe(first.userId);
  });

  it('rejects self-referral', async () => {
    const inviter = await createInviter();
    const signed = invite.signInviteTicket(ticketFor(inviter.userId, { code: inviter.code }));
    expect(await invite.claimInvite(inviter.userId, signed)).toBe('self');
    const client = await getClient();
    const rows = await client`
      SELECT 1 FROM referral_attributions WHERE user_id = ${inviter.userId}`;
    expect(rows).toHaveLength(0);
  });

  it('rejects an unsigned or forged ticket without touching the database', async () => {
    const inviter = await createInviter();
    const invitee = await createUserFixture();
    userIds.push(invitee.userId);
    const forged = Buffer.from(JSON.stringify(
      ticketFor(inviter.userId, { code: inviter.code })
    )).toString('base64url');
    expect(await invite.claimInvite(invitee.userId, `${forged}.deadbeef`)).toBe('invalid');
    expect(await invite.claimInvite(invitee.userId, undefined)).toBe('invalid');
  });

  it('honours a ticket carrying an invite code the inviter no longer owns', async () => {
    const inviter = await createInviter();
    const invitee = await createUserFixture();
    userIds.push(invitee.userId);
    // 0027 reissued every code, so a cookie minted before that carries a code
    // the inviter no longer has. The signature vouches for the inviter id; the
    // code is decoration and must not strand someone mid-funnel.
    const staleCode = `SF${'B'.repeat(32)}`;
    const signed = invite.signInviteTicket(ticketFor(inviter.userId, { code: staleCode }));
    expect(await invite.claimInvite(invitee.userId, signed)).toBe('claimed');
    const db = await getClient();
    const rows = await db`
      SELECT inviter_user_id FROM referral_attributions WHERE user_id = ${invitee.userId}`;
    expect(rows[0]?.inviter_user_id).toBe(inviter.userId);
  });

  it('refuses to attach a fresh invite link to a pre-existing account', async () => {
    const inviter = await createInviter();
    const invitee = await createUserFixture();
    userIds.push(invitee.userId);
    const client = await getClient();
    // Backdate the account beyond the ticket issue time (naive UTC, matching
    // how `claimInvite` compares the column).
    await client`UPDATE "user" SET created_at = timezone('UTC', now()) - interval '2 days'
      WHERE id = ${invitee.userId}`;
    const signed = invite.signInviteTicket(ticketFor(inviter.userId, { code: inviter.code }));
    expect(await invite.claimInvite(invitee.userId, signed)).toBe('existing_account');
    const rows = await client`
      SELECT 1 FROM referral_attributions WHERE user_id = ${invitee.userId}`;
    expect(rows).toHaveLength(0);
  });
});

