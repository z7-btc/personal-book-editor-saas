import { randomUUID } from 'node:crypto';
import { client } from '@/lib/db/drizzle';
import { requireCapability } from '@/lib/config';
import { contactFetchWithin, contactOperationKey, contactSnapshot, probeContact } from './contact';

type Job = {
  id: string;
  user_id: string;
  event_version: number;
  occurred_at: Date;
  attempt_count: number;
};

type Outcome = 'succeeded' | 'reconciled' | 'retried' | 'deadLetter' | 'superseded';

export type EmailSyncReport = {
  claimed: number;
  succeeded: number;
  reconciled: number;
  retried: number;
  deadLetter: number;
  superseded: number;
};

async function claimNext(owner: string): Promise<Job | null> {
  try {
    return await client.begin(async (tx) => {
      await tx`UPDATE email_contact_outbox SET reconcile_lease_owner = NULL,
        reconcile_lease_expires_at = NULL
        WHERE reconcile_lease_expires_at <= now()`;
      // Keep only the latest unsent snapshot for each user. This also clears
      // expired leases when a newer event was created during a failed send.
      await tx`
        UPDATE email_contact_outbox AS old
        SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = now()
        WHERE (old.status = 'pending' OR
               (old.status = 'processing' AND old.lease_expires_at <= now()))
          AND EXISTS (
            SELECT 1 FROM email_contact_outbox AS newer
            WHERE newer.user_id = old.user_id AND newer.event_version > old.event_version
          )
      `;

      const [row] = await tx<Job[]>`
        SELECT old.id, old.user_id, old.event_version,
               old.occurred_at, old.attempt_count
        FROM email_contact_outbox AS old
        WHERE ((old.status = 'pending' AND old.available_at <= now()) OR
               (old.status = 'processing' AND old.lease_expires_at <= now()))
          AND old.reconcile_lease_owner IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM email_contact_outbox AS newer
            WHERE newer.user_id = old.user_id AND newer.event_version > old.event_version
          )
          AND NOT EXISTS (
            SELECT 1 FROM email_contact_outbox AS active
            WHERE active.user_id = old.user_id AND active.id <> old.id
              AND active.status = 'processing' AND active.lease_expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM email_contact_outbox AS active
            WHERE active.user_id = old.user_id AND active.reconcile_lease_owner IS NOT NULL
          )
        ORDER BY old.id
        FOR UPDATE OF old SKIP LOCKED
        LIMIT 1
      `;
      if (!row) return null;

      await tx`
        UPDATE email_contact_outbox
        SET status = 'processing', lease_owner = ${owner},
            lease_expires_at = now() + interval '30 seconds',
            attempt_count = attempt_count + 1, updated_at = now()
        WHERE id = ${row.id}
      `;
      return row;
    });
  } catch (error) {
    // Another worker may claim a different version of the same user before
    // its update becomes visible. The partial unique index is the last guard.
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
}

export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    const requested = Number.isFinite(seconds)
      ? seconds * 1000
      : Number.isFinite(date) ? date - Date.now() : 0;
    if (requested > 0) return Math.min(requested, 3_600_000);
  }
  return Math.min(5_000 * 2 ** Math.min(attempt - 1, 8), 3_600_000)
    + Math.floor(Math.random() * 2_000);
}

async function settle(job: Job, owner: string, outcome: Exclude<Outcome, 'reconciled'>, code?: string,
  retryAfter?: string | null, reconcileCode?: string) {
  const status = outcome === 'deadLetter' ? 'dead_letter'
    : outcome === 'retried' ? 'pending'
      : outcome;
  const nextAt = new Date(Date.now() + retryDelayMs(job.attempt_count + 1, retryAfter || null));
  const stopReconcile = outcome === 'deadLetter' && Boolean(code && (
    /^(?:RECONCILE_)?HTTP_4(?!08|29)/.test(code) ||
    ['INSECURE_ENDPOINT', 'INVALID_RECONCILE_RESPONSE', 'IDEMPOTENCY_CONFLICT', 'REMOTE_BINDING_MISMATCH', 'REMOTE_FAILED'].includes(code)
  ));
  const reconcileAt = stopReconcile ? null : outcome === 'retried' ? nextAt.toISOString()
    : new Date(Date.now() + (outcome === 'deadLetter' ? 60_000 : 3_600_000)).toISOString();
  await client`
    UPDATE email_contact_outbox
    SET status = ${status}::email_outbox_status,
        available_at = ${outcome === 'retried' ? nextAt.toISOString() : new Date().toISOString()}::timestamptz,
        lease_owner = NULL, lease_expires_at = NULL,
        reconcile_after = ${reconcileAt}::timestamptz,
        last_reconciled_at = CASE WHEN ${reconcileCode ?? null}::text IS NULL
          THEN last_reconciled_at ELSE now() END,
        last_reconcile_code = COALESCE(${reconcileCode ?? null}, last_reconcile_code),
        last_error_code = ${code || null}, updated_at = now()
    WHERE id = ${job.id} AND status = 'processing' AND lease_owner = ${owner}
  `;
}

async function processJob(job: Job, owner: string, send: typeof fetch): Promise<Outcome> {
  const payload = await contactSnapshot(job);
  if (!payload) {
    await settle(job, owner, 'superseded');
    return 'superseded';
  }

  let reconcileCode: string | undefined;
  if (job.attempt_count > 0) {
    const probe = await probeContact(job, payload, send);
    reconcileCode = probe.code;
    if (probe.state === 'confirmed') {
      await settle(job, owner, 'succeeded', undefined, null, probe.code);
      return 'reconciled';
    }
    if (probe.state === 'conflict' || (probe.state === 'unavailable' && probe.permanent)) {
      await settle(job, owner, 'deadLetter', probe.code, null, probe.code);
      return 'deadLetter';
    }
    if (probe.state === 'unavailable') {
      const exhausted = job.attempt_count + 1 >= 8;
      await settle(job, owner, exhausted ? 'deadLetter' : 'retried', probe.code, probe.retryAfter, probe.code);
      return exhausted ? 'deadLetter' : 'retried';
    }
  }

  const endpoint = new URL('/api/v1/contacts/upsert', process.env.EMAIL_CENTER_URL);
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
    await settle(job, owner, 'deadLetter', 'INSECURE_ENDPOINT');
    return 'deadLetter';
  }

  try {
    const response = await send(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: `Bearer ${process.env.EMAIL_CENTER_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': contactOperationKey(job),
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 200 || response.status === 201) {
      const body = await response.json() as { data?: { contactApplicationId?: number } };
      if (!Number.isInteger(body.data?.contactApplicationId)) {
        throw new Error('INVALID_RESPONSE');
      }
      await settle(job, owner, 'succeeded', undefined, null, reconcileCode);
      return 'succeeded';
    }

    const permanent = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
    const code = `HTTP_${response.status}`;
    if (permanent || job.attempt_count + 1 >= 8) {
      await settle(job, owner, 'deadLetter', code, null, reconcileCode);
      return 'deadLetter';
    }
    await settle(job, owner, 'retried', code, response.headers.get('retry-after'), reconcileCode);
    return 'retried';
  } catch {
    if (job.attempt_count + 1 >= 8) {
      await settle(job, owner, 'deadLetter', 'NETWORK_OR_RESPONSE', null, reconcileCode);
      return 'deadLetter';
    }
    await settle(job, owner, 'retried', 'NETWORK_OR_RESPONSE', null, reconcileCode);
    return 'retried';
  }
}

export async function runEmailContactSync(options: {
  maxJobs?: number;
  maxMillis?: number;
  send?: typeof fetch;
} = {}): Promise<EmailSyncReport> {
  requireCapability('emailCenter');
  const report: EmailSyncReport = {
    claimed: 0, succeeded: 0, reconciled: 0, retried: 0, deadLetter: 0, superseded: 0,
  };
  const owner = randomUUID();
  const deadline = Date.now() + (options.maxMillis ?? 20_000);
  const send = contactFetchWithin(options.send ?? fetch, deadline);
  for (let i = 0; i < (options.maxJobs ?? 25) && Date.now() < deadline; i++) {
    const job = await claimNext(owner);
    if (!job) break;
    report.claimed++;
    const outcome = await processJob(job, owner, send);
    report[outcome]++;
  }
  return report;
}
