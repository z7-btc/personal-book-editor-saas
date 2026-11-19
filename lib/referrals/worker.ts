import { randomUUID } from 'node:crypto';
import { requireCapability } from '@/lib/config';
import { client } from '@/lib/db/drizzle';

type Job = { id: string; user_id: string; event_version: number; attempt_count: number };
type Outcome = 'succeeded' | 'retried' | 'deadLetter' | 'superseded';

export type ReferralSyncReport = {
  claimed: number;
  succeeded: number;
  retried: number;
  deadLetter: number;
  superseded: number;
};

async function claimNext(owner: string): Promise<Job | null> {
  try {
    return await client.begin(async (tx) => {
      await tx`
        UPDATE referral_user_outbox AS old
        SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = now()
        WHERE (old.status = 'pending' OR
               (old.status = 'processing' AND old.lease_expires_at <= now()))
          AND EXISTS (
            SELECT 1 FROM referral_user_outbox AS newer
            WHERE newer.user_id = old.user_id AND newer.event_version > old.event_version
          )
      `;
      const [row] = await tx<Job[]>`
        SELECT old.id, old.user_id, old.event_version, old.attempt_count
        FROM referral_user_outbox AS old
        WHERE ((old.status = 'pending' AND old.available_at <= now()) OR
               (old.status = 'processing' AND old.lease_expires_at <= now()))
          AND NOT EXISTS (
            SELECT 1 FROM referral_user_outbox AS newer
            WHERE newer.user_id = old.user_id AND newer.event_version > old.event_version
          )
          AND NOT EXISTS (
            SELECT 1 FROM referral_user_outbox AS active
            WHERE active.user_id = old.user_id AND active.id <> old.id
              AND active.status = 'processing' AND active.lease_expires_at > now()
          )
        ORDER BY old.id
        FOR UPDATE OF old SKIP LOCKED
        LIMIT 1
      `;
      if (!row) return null;
      await tx`
        UPDATE referral_user_outbox
        SET status = 'processing', lease_owner = ${owner},
            lease_expires_at = now() + interval '30 seconds',
            attempt_count = attempt_count + 1, updated_at = now()
        WHERE id = ${row.id}
      `;
      return row;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    const requested = Number.isFinite(seconds)
      ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 0;
    if (requested > 0) return Math.min(requested, 3_600_000);
  }
  return Math.min(5_000 * 2 ** Math.min(attempt - 1, 8), 3_600_000)
    + Math.floor(Math.random() * 2_000);
}

async function settle(job: Job, owner: string, outcome: Outcome, code?: string,
  retryAfter?: string | null) {
  const status = outcome === 'deadLetter' ? 'dead_letter'
    : outcome === 'retried' ? 'pending' : outcome;
  const nextAt = new Date(Date.now() + retryDelayMs(job.attempt_count + 1, retryAfter || null));
  await client`
    UPDATE referral_user_outbox
    SET status = ${status}::referral_sync_status,
        available_at = ${outcome === 'retried' ? nextAt.toISOString() : new Date().toISOString()}::timestamptz,
        lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = ${code || null}, updated_at = now()
    WHERE id = ${job.id} AND status = 'processing' AND lease_owner = ${owner}
  `;
}

type PushResult = {
  ok: boolean;
  /** A 4xx (other than 429): retrying the same request cannot help. */
  permanent: boolean;
  code: string;
  retryAfter?: string | null;
  /** The profile version this push carried, or null when the user is unknown. */
  syncVersion: number | null;
};

/**
 * Sends one user's current referral state to the Payment Center: display
 * fields, the invite code, and the inviter once an invitation has been bound.
 * Both the queue and the sign-up path push through here so the centre sees one
 * representation of a user, and a change to the payload has one place to land.
 *
 * The inviter travels as `referred_by_external_user_id`, never as their invite
 * code. A code is a display handle that can be reissued (migration 0027 did
 * exactly that for every existing account); the id never moves. Naming the
 * inviter by code also made the queue order load-bearing — an invitee pushed
 * before their inviter would carry a code the centre had not stored yet and be
 * rejected as `邀请码无效`, permanently.
 */
async function pushReferralUser(userId: string, send: typeof fetch): Promise<PushResult> {
  const [snapshot] = await client`
    SELECT u.id, u.name, u.email, p.invite_code, p.sync_version, a.inviter_user_id
    FROM "user" u JOIN referral_profiles p ON p.user_id = u.id
    LEFT JOIN referral_attributions a ON a.user_id = u.id
    WHERE u.id = ${userId}
  `;
  if (!snapshot) {
    return { ok: false, permanent: true, code: 'USER_MISSING', syncVersion: null };
  }
  const failure = (permanent: boolean, code: string, retryAfter?: string | null): PushResult => ({
    ok: false, permanent, code, retryAfter, syncVersion: snapshot.sync_version,
  });
  const endpoint = new URL('/api/referral-center/users/upsert', process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
    return failure(true, 'INSECURE_ENDPOINT');
  }

  try {
    const response = await send(endpoint, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
      headers: {
        'X-API-Key': process.env.PAYMENT_CENTER_REFERRAL_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        external_user_id: snapshot.id,
        username: snapshot.name,
        email: snapshot.email,
        invite_code: snapshot.invite_code,
        ...(snapshot.inviter_user_id
          ? { referred_by_external_user_id: snapshot.inviter_user_id }
          : {}),
      }),
    });
    if (response.ok) {
      const body = await response.json() as { data?: { user?: Record<string, unknown> } };
      const remote = body.data?.user;
      if (String(remote?.website_id || '') !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
          String(remote?.external_user_id || '') !== snapshot.id ||
          String(remote?.invite_code || '') !== snapshot.invite_code ||
          (snapshot.inviter_user_id && !remote?.referred_by_id)) {
        return failure(true, 'BINDING_MISMATCH');
      }
      return { ok: true, permanent: false, code: 'OK', syncVersion: snapshot.sync_version };
    }
    return failure(
      response.status >= 400 && response.status < 500 && response.status !== 429,
      `HTTP_${response.status}`,
      response.headers.get('retry-after'),
    );
  } catch {
    return failure(false, 'NETWORK_OR_RESPONSE');
  }
}

async function processJob(job: Job, owner: string, send: typeof fetch): Promise<Outcome> {
  const pushed = await pushReferralUser(job.user_id, send);
  if (pushed.syncVersion === null) {
    await settle(job, owner, 'deadLetter', 'USER_MISSING');
    return 'deadLetter';
  }
  // A newer profile edit already queued its own job; this one has nothing to add.
  if (pushed.syncVersion > job.event_version) {
    await settle(job, owner, 'superseded');
    return 'superseded';
  }
  if (pushed.ok) {
    await settle(job, owner, 'succeeded');
    return 'succeeded';
  }
  if (pushed.permanent || job.attempt_count + 1 >= 8) {
    await settle(job, owner, 'deadLetter', pushed.code);
    return 'deadLetter';
  }
  await settle(job, owner, 'retried', pushed.code, pushed.retryAfter);
  return 'retried';
}

/**
 * Pushes a user's referral state immediately instead of waiting for the queue,
 * so a fresh sign-up — or a freshly bound invitation — is already current when
 * the dashboard loads. When the push lands, the pending queue entry is settled
 * so it will not repeat the same call; when it does not, the entry is left
 * exactly as it was, and that is the retry path. This is why a hiccup here
 * never costs the user their commission.
 */
export async function syncReferralUserNow(userId: string, send: typeof fetch = fetch) {
  const pushed = await pushReferralUser(userId, send);
  if (!pushed.ok) return 'deferred' as const;
  await client`
    UPDATE referral_user_outbox
    SET status = 'succeeded'::referral_sync_status,
        lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = NULL, updated_at = now()
    WHERE user_id = ${userId} AND status = 'pending'
  `;
  return 'synced' as const;
}

export async function runReferralUserSync(options: {
  maxJobs?: number;
  maxMillis?: number;
  send?: typeof fetch;
} = {}): Promise<ReferralSyncReport> {
  requireCapability('referrals');
  const report: ReferralSyncReport = {
    claimed: 0, succeeded: 0, retried: 0, deadLetter: 0, superseded: 0,
  };
  const owner = randomUUID();
  const deadline = Date.now() + (options.maxMillis ?? 20_000);
  for (let index = 0; index < (options.maxJobs ?? 25) && Date.now() < deadline; index++) {
    const job = await claimNext(owner);
    if (!job) break;
    report.claimed++;
    const outcome = await processJob(job, owner, options.send ?? fetch);
    report[outcome]++;
  }
  return report;
}
