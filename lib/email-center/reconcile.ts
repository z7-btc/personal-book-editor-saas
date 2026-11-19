import { randomUUID } from 'node:crypto';
import { client } from '@/lib/db/drizzle';
import { requireCapability } from '@/lib/config';
import { contactFetchWithin, contactSnapshot, probeContact, type ContactEvent, type Probe } from './contact';
import { retryDelayMs } from './worker';

export type EmailReconcileReport = {
  checked: number; confirmed: number; notReceived: number; conflicts: number;
  unreachable: number; superseded: number;
};
type Candidate = ContactEvent & { status: string; attempt_count: number };

async function claim(owner: string, options: { userId?: string; eventVersion?: number; force?: boolean }): Promise<Candidate | null> {
  try {
    return await client.begin(async (tx) => {
      await tx`UPDATE email_contact_outbox SET reconcile_lease_owner = NULL,
        reconcile_lease_expires_at = NULL WHERE reconcile_lease_expires_at <= now()`;
      const [row] = await tx<Candidate[]>`
        SELECT e.id, e.user_id, e.event_version, e.occurred_at, e.status, e.attempt_count
        FROM email_contact_outbox e
        WHERE e.status IN ('pending', 'succeeded', 'dead_letter') AND e.attempt_count > 0
          AND e.reconcile_lease_owner IS NULL
          AND (${options.force === true} OR e.reconcile_after <= now())
          AND (${options.userId ?? null}::text IS NULL OR e.user_id = ${options.userId ?? null})
          AND (${options.eventVersion ?? null}::integer IS NULL OR e.event_version = ${options.eventVersion ?? null})
          AND NOT EXISTS (SELECT 1 FROM email_contact_outbox newer
            WHERE newer.user_id = e.user_id AND newer.event_version > e.event_version)
          AND NOT EXISTS (SELECT 1 FROM email_contact_outbox active
            WHERE active.user_id = e.user_id AND (active.status = 'processing' OR active.reconcile_lease_owner IS NOT NULL))
        ORDER BY e.reconcile_after NULLS LAST, e.id
        FOR UPDATE OF e SKIP LOCKED LIMIT 1
      `;
      if (!row) return null;
      await tx`UPDATE email_contact_outbox SET reconcile_lease_owner = ${owner},
        reconcile_lease_expires_at = now() + interval '30 seconds' WHERE id = ${row.id}`;
      return row;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
}

async function finish(job: Candidate, owner: string, probe: Probe | null) {
  const code = probe?.code || 'NEWER_LOCAL_VERSION';
  const status = probe?.state === 'confirmed' ? 'succeeded'
    : probe?.state === 'conflict' && job.status !== 'succeeded' ? 'dead_letter'
      : !probe && job.status === 'pending' ? 'superseded' : job.status;
  const permanent = probe?.state === 'unavailable' && probe.permanent;
  const next = permanent ? null : new Date(Date.now() + (
    probe?.state === 'unavailable' ? retryDelayMs(4, probe.retryAfter || null) : 3_600_000
  )).toISOString();
  await client`
    UPDATE email_contact_outbox SET status = ${status}::email_outbox_status,
      last_reconciled_at = now(), last_reconcile_code = ${code}, reconcile_after = ${next}::timestamptz,
      reconcile_lease_owner = NULL, reconcile_lease_expires_at = NULL,
      last_error_code = CASE WHEN ${status} = 'succeeded' THEN NULL
        WHEN ${probe?.state === 'conflict'} THEN ${code} ELSE last_error_code END,
      updated_at = now()
    WHERE id = ${job.id} AND reconcile_lease_owner = ${owner}
  `;
}

export async function runEmailContactReconcile(options: {
  maxJobs?: number; maxMillis?: number; send?: typeof fetch;
  userId?: string; eventVersion?: number; force?: boolean;
} = {}): Promise<EmailReconcileReport> {
  requireCapability('emailCenter');
  if (options.force && (!options.userId || !Number.isSafeInteger(options.eventVersion) || Number(options.eventVersion) <= 0)) {
    throw new Error('A forced query requires the original user ID and event version.');
  }
  const report: EmailReconcileReport = { checked: 0, confirmed: 0, notReceived: 0, conflicts: 0, unreachable: 0, superseded: 0 };
  const owner = randomUUID();
  const deadline = Date.now() + (options.maxMillis ?? 20_000);
  const send = contactFetchWithin(options.send ?? fetch, deadline);
  for (let i = 0; i < (options.maxJobs ?? 25) && Date.now() < deadline; i++) {
    const job = await claim(owner, options);
    if (!job) break;
    report.checked++;
    const snapshot = await contactSnapshot(job);
    const probe = snapshot ? await probeContact(job, snapshot, send) : null;
    if (!probe) report.superseded++;
    else if (probe.state === 'confirmed') report.confirmed++;
    else if (probe.state === 'notReceived') report.notReceived++;
    else if (probe.state === 'conflict') report.conflicts++;
    else report.unreachable++;
    await finish(job, owner, probe);
    if (options.force) break;
  }
  return report;
}

/** Explicit local recovery grants one additional send without resetting history. */
export async function requeueEmailContact(userId: string, eventVersion: number,
  options: { send?: typeof fetch } = {}) {
  requireCapability('emailCenter');
  // The row's verdict is read BEFORE the probe: `runEmailContactReconcile`
  // overwrites `last_reconcile_code` with whatever the centre answers, so a
  // guard applied afterwards would compare the answer against itself and grant
  // a manual resend to any row the centre happens not to remember — including a
  // payload it permanently rejected on the previous attempt.
  const [before] = await client<{ status: string; last_reconcile_code: string | null }[]>`
    SELECT status::text AS status, last_reconcile_code FROM email_contact_outbox
    WHERE user_id = ${userId} AND event_version = ${eventVersion}
  `;
  const report = await runEmailContactReconcile({ userId, eventVersion, force: true, ...options });
  if (report.confirmed === 1) return { action: 'already_confirmed', report } as const;
  if (report.notReceived !== 1) return { action: 'not_requeued', report } as const;
  if (before?.status !== 'dead_letter' || before.last_reconcile_code !== 'NOT_RECEIVED') {
    return { action: 'not_requeued', report } as const;
  }
  const changed = await client`
    UPDATE email_contact_outbox e SET status = 'pending', available_at = now(),
      last_reconcile_code = 'MANUAL_RETRY_REQUESTED', updated_at = now()
    WHERE e.user_id = ${userId} AND e.event_version = ${eventVersion}
      AND e.status = 'dead_letter' AND e.last_reconcile_code = 'NOT_RECEIVED'
      AND NOT EXISTS (SELECT 1 FROM email_contact_outbox newer
        WHERE newer.user_id = e.user_id AND newer.event_version > e.event_version)
      AND NOT EXISTS (SELECT 1 FROM email_contact_outbox active
        WHERE active.user_id = e.user_id AND (active.status = 'processing' OR active.reconcile_lease_owner IS NOT NULL))
    RETURNING e.id
  `;
  return { action: changed.length ? 'requeued' : 'not_requeued', report } as const;
}
