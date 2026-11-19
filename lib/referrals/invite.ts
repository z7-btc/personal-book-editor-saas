import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireCapability } from '@/lib/config';
import { client } from '@/lib/db/drizzle';

export const INVITE_COOKIE_NAME = 'saas_referral_invite';
// 新码是 8 位大写字母数字（见 0026 迁移）；老用户的 SF + 32 位十六进制码还要能认，
// 已经发出去的邀请链接不能因为换了生成规则就打不开。
const CODE_PATTERN = /^(?:[0-9A-Z]{8}|SF[0-9A-Z]{8,32})$/;
const MAX_COOKIE_SECONDS = 90 * 24 * 60 * 60;

type InviteTicket = {
  code: string;
  inviterUserId: string;
  issuedAt: number;
  expiresAt: number;
};

function signingKey(): string {
  const secret = process.env.BETTER_AUTH_SECRET || '';
  if (secret.length < 32) throw new Error('Invitation signing secret is unavailable.');
  return secret;
}

export function signInviteTicket(ticket: InviteTicket): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
  const signature = createHmac('sha256', signingKey())
    .update(`referral-invite-v1.${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyInviteTicket(value: string | undefined): InviteTicket | null {
  if (!value || value.length > 1_000) return null;
  const [payload, supplied, extra] = value.split('.');
  if (!payload || !supplied || extra) return null;
  const expected = createHmac('sha256', signingKey())
    .update(`referral-invite-v1.${payload}`).digest();
  let signature: Buffer;
  try { signature = Buffer.from(supplied, 'base64url'); } catch { return null; }
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  try {
    const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as InviteTicket;
    const now = Math.floor(Date.now() / 1_000);
    if (!CODE_PATTERN.test(ticket.code) || !ticket.inviterUserId ||
        !Number.isInteger(ticket.issuedAt) || !Number.isInteger(ticket.expiresAt) ||
        ticket.issuedAt > now + 60 || ticket.expiresAt <= now ||
        ticket.expiresAt - ticket.issuedAt > MAX_COOKIE_SECONDS) return null;
    return ticket;
  } catch {
    return null;
  }
}

export async function resolveInviteCode(code: string, send: typeof fetch = fetch) {
  requireCapability('referrals');
  if (!CODE_PATTERN.test(code)) return null;
  const endpoint = new URL('/api/referral-center/attribution', process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
    throw new Error('Insecure referral endpoint.');
  }
  endpoint.searchParams.set('invite_code', code);
  const response = await send(endpoint, {
    headers: { 'X-API-Key': process.env.PAYMENT_CENTER_REFERRAL_API_KEY! },
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('Referral lookup failed.');
  const body = await response.json() as { data?: {
    valid?: boolean; invite_code?: string; external_user_id?: string;
    cookie_days?: number;
  } };
  const remote = body.data;
  if (!remote?.valid || remote.invite_code !== code || !remote.external_user_id) return null;
  const [local] = await client`
    SELECT user_id FROM referral_profiles
    WHERE invite_code = ${code} AND user_id = ${remote.external_user_id}
  `;
  if (!local) return null;
  const days = Number(remote.cookie_days);
  const lifetime = Number.isFinite(days) && days > 0
    ? Math.min(Math.floor(days * 86_400), MAX_COOKIE_SECONDS) : 30 * 86_400;
  const issuedAt = Math.floor(Date.now() / 1_000);
  const ticket = {
    code,
    inviterUserId: remote.external_user_id,
    issuedAt,
    expiresAt: issuedAt + lifetime,
  };
  return { ticket: signInviteTicket(ticket), maxAge: lifetime };
}

export async function claimInvite(userId: string, signedTicket: string | undefined) {
  requireCapability('referrals');
  const ticket = verifyInviteTicket(signedTicket);
  if (!ticket) return 'invalid' as const;
  if (ticket.inviterUserId === userId) return 'self' as const;
  return client.begin(async (tx) => {
    // `user.created_at` follows this schema's naive-UTC convention: the app
    // writes it from a JS `Date`, which Drizzle maps to a UTC wall clock. The
    // column must therefore be read back as UTC — anchoring it to the session
    // zone (Asia/Shanghai here) shifts it by the whole UTC offset, which made
    // every fresh claim look eight hours old and fail with `existing_account`.
    // The freshness bound is read from the database clock so both sides of the
    // comparison come from one source.
    const [user] = await tx`
      SELECT id,
        EXTRACT(EPOCH FROM created_at AT TIME ZONE 'UTC')::bigint
          AS created_at_epoch,
        EXTRACT(EPOCH FROM now())::bigint AS now_epoch
      FROM "user" WHERE id = ${userId} FOR UPDATE
    `;
    if (!user) return 'invalid' as const;
    const [existing] = await tx`
      SELECT inviter_user_id, invite_code FROM referral_attributions
      WHERE user_id = ${userId}
    `;
    if (existing) {
      // Compare inviters, not codes. 0027 reissued codes for existing accounts,
      // so an attribution recorded earlier legitimately holds the inviter's old
      // code; the same inviter arriving with their new code is still the same
      // binding, not a competing one.
      return existing.inviter_user_id === ticket.inviterUserId
        ? 'already_claimed' as const : 'conflict' as const;
    }
    // A visitor cannot attach a fresh invite link to an old account.
    const createdAt = Number(user.created_at_epoch);
    const now = Number(user.now_epoch);
    if (!Number.isFinite(createdAt) || createdAt < ticket.issuedAt - 60 ||
        createdAt > now + 60) {
      return 'existing_account' as const;
    }
    // The ticket is HMAC-signed by us, so the inviter id is the trusted part;
    // the code inside it is only there for display and logging. Checking it
    // against the profile would strand anyone whose invite cookie was issued
    // before 0027 reissued that inviter's code.
    const [inviter] = await tx`
      SELECT user_id FROM referral_profiles WHERE user_id = ${ticket.inviterUserId}
    `;
    if (!inviter) return 'invalid' as const;
    await tx`
      INSERT INTO referral_attributions (user_id, inviter_user_id, invite_code)
      VALUES (${userId}, ${ticket.inviterUserId}, ${ticket.code})
    `;
    // The invitation changes what the centre must know about this user, but the
    // queue row the signup trigger wrote may already have been consumed by the
    // time this lands — without re-arming it the inviter would never be
    // credited, because nothing else would ever push the new relationship.
    // Reusing the current version's row keeps one row per profile version.
    await tx`
      INSERT INTO referral_user_outbox (user_id, event_version, status, available_at)
      SELECT user_id, sync_version, 'pending', now()
      FROM referral_profiles WHERE user_id = ${userId}
      ON CONFLICT (user_id, event_version) DO UPDATE
        SET status = 'pending', available_at = now(),
            lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = NULL, updated_at = now()
    `;
    return 'claimed' as const;
  });
}
