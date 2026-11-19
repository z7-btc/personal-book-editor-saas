import 'server-only';
import { client } from '@/lib/db/drizzle';
import { logObservation, maskErrorCode } from '@/lib/observability/logger';
import { retentionDaysFor, retentionPolicy, type RetentionPolicy } from './retention';

/**
 * Retention scrub. The plan promises that once a task reaches a terminal state
 * its sensitive payload survives only for the configured window, and that after
 * the scrub the workers can no longer pick the row up by mistake.
 *
 * What is sensitive here, and what is deliberately kept:
 * - `referral_withdrawal_intents.account_ciphertext` is the AES-256-GCM blob of
 *   the payout account. Once the payout is submitted or rejected the plaintext
 *   is never needed again, so the blob is emptied. The fingerprint (keyed HMAC,
 *   for idempotency) and the mask (for display) stay, and so does every amount,
 *   status and provider id — a financial fact is not expiring data.
 * - Rows in `pending`, `sending` or `uncertain` are never touched: an attempt is
 *   still in flight. `manual_review` rows keep their payload for the failed
 *   window because a human still has to act on them.
 * - Expired one-use handshake challenges are removed, and processed payment
 *   inbox events are pruned. Both tables store routing identifiers and a body
 *   digest only; the prune limits how long that routing picture is kept.
 *
 * Every statement is written so a second run changes nothing, which is what the
 * maintenance smoke asserts.
 */
export type RetentionScrubReport = {
  policy: RetentionPolicy;
  withdrawalAccountsScrubbed: number;
  completedEventsPruned: number;
  failedEventsPruned: number;
  expiredChallengesPruned: number;
};

export type MaintenanceReport = RetentionScrubReport & { durationMs: number; dryRun: boolean };

/**
 * Counts what a scrub would remove without removing anything. Every predicate
 * below is the same expression `scrubRetention` uses, so a dry run is an
 * honest preview rather than an approximation.
 */
export async function countRetention(now = new Date()): Promise<RetentionScrubReport> {
  const policy = retentionPolicy();
  const completed = `${retentionDaysFor(policy, 'completed')} days`;
  const failed = `${retentionDaysFor(policy, 'failed')} days`;
  const audit = `${policy.auditDays} days`;
  const at = now.toISOString();

  return client.begin(async (tx) => {
    const [accounts] = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM referral_withdrawal_intents
      WHERE account_ciphertext IS NOT NULL
        AND ((status IN ('submitted', 'rejected')
              AND COALESCE(submitted_at, updated_at) <= ${at}::timestamptz - ${completed}::interval)
          OR (status = 'manual_review'
              AND updated_at <= ${at}::timestamptz - ${failed}::interval))
    `;
    const [completedEvents] = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM payment_inbox
      WHERE status = 'processed' AND received_at <= ${at}::timestamptz - ${completed}::interval
    `;
    const [failedEvents] = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM payment_inbox
      WHERE status IN ('quarantined', 'manual_review')
        AND received_at <= ${at}::timestamptz - ${failed}::interval
    `;
    const [challenges] = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM payment_handshake_challenges
      WHERE expires_at <= ${at}::timestamptz - ${audit}::interval
    `;

    return {
      policy,
      withdrawalAccountsScrubbed: Number(accounts?.count ?? 0),
      completedEventsPruned: Number(completedEvents?.count ?? 0),
      failedEventsPruned: Number(failedEvents?.count ?? 0),
      expiredChallengesPruned: Number(challenges?.count ?? 0),
    };
  });
}

export async function scrubRetention(now = new Date()): Promise<RetentionScrubReport> {
  const policy = retentionPolicy();
  const completed = `${retentionDaysFor(policy, 'completed')} days`;
  const failed = `${retentionDaysFor(policy, 'failed')} days`;
  const audit = `${policy.auditDays} days`;
  const at = now.toISOString();

  return client.begin(async (tx) => {
    const accounts = await tx<{ id: string }[]>`
      UPDATE referral_withdrawal_intents
      SET account_ciphertext = NULL, updated_at = now()
      WHERE account_ciphertext IS NOT NULL
        AND ((status IN ('submitted', 'rejected')
              AND COALESCE(submitted_at, updated_at) <= ${at}::timestamptz - ${completed}::interval)
          OR (status = 'manual_review'
              AND updated_at <= ${at}::timestamptz - ${failed}::interval))
      RETURNING id
    `;
    const completedEvents = await tx<{ event_id: string }[]>`
      DELETE FROM payment_inbox
      WHERE status = 'processed' AND received_at <= ${at}::timestamptz - ${completed}::interval
      RETURNING event_id
    `;
    const failedEvents = await tx<{ event_id: string }[]>`
      DELETE FROM payment_inbox
      WHERE status IN ('quarantined', 'manual_review')
        AND received_at <= ${at}::timestamptz - ${failed}::interval
      RETURNING event_id
    `;
    const challenges = await tx<{ check_id: string }[]>`
      DELETE FROM payment_handshake_challenges
      WHERE expires_at <= ${at}::timestamptz - ${audit}::interval
      RETURNING check_id
    `;

    return {
      policy,
      withdrawalAccountsScrubbed: accounts.length,
      completedEventsPruned: completedEvents.length,
      failedEventsPruned: failedEvents.length,
      expiredChallengesPruned: challenges.length,
    };
  });
}

/** One maintenance pass: report the policy in force, then scrub (or preview). */
export async function runMaintenance(
  now = new Date(),
  options: { dryRun?: boolean } = {},
): Promise<MaintenanceReport> {
  const startedAt = Date.now();
  const dryRun = options.dryRun === true;
  try {
    const report = dryRun ? await countRetention(now) : await scrubRetention(now);
    const removed = report.withdrawalAccountsScrubbed + report.completedEventsPruned
      + report.failedEventsPruned + report.expiredChallengesPruned;
    logObservation({
      event: 'maintenance.scrub',
      module: 'jobs',
      code: 'OK',
      status: dryRun ? 'skipped' : 'processed',
      count: removed,
      durationMs: Date.now() - startedAt,
    });
    return { ...report, dryRun, durationMs: Date.now() - startedAt };
  } catch (error) {
    logObservation({
      event: 'maintenance.scrub',
      module: 'jobs',
      level: 'error',
      status: 'failed',
      maskedErrorCode: maskErrorCode(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export { retentionPolicy, retentionDaysFor } from './retention';
export type { RetentionPolicy } from './retention';
