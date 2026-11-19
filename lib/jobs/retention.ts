import 'server-only';

/**
 * Data retention policy. The three windows mirror the environment contract in
 * `.env.example`: a successful task keeps its sensitive payload for the
 * completed window, a failed or manually reviewed one keeps it long enough for
 * a human to finish the work, and the audit and payment facts are kept for the
 * audit window.
 *
 * The numbers alone are harmless; what matters is that the code reads them and
 * that the scrub is provably idempotent. An unreadable or non-positive value
 * falls back to the documented default rather than disabling the cleanup —
 * silently retaining sensitive payloads forever is the failure mode this module
 * exists to prevent.
 */
export type RetentionPolicy = {
  completedPayloadDays: number;
  failedPayloadDays: number;
  auditDays: number;
};

const DEFAULTS = {
  completedPayloadDays: 30,
  failedPayloadDays: 90,
  auditDays: 365,
} as const;

const MAX_DAYS = 36_500;

function readDays(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_DAYS) return fallback;
  return parsed;
}

export function retentionPolicy(): RetentionPolicy {
  return {
    completedPayloadDays: readDays('COMPLETED_PAYLOAD_RETENTION_DAYS', DEFAULTS.completedPayloadDays),
    failedPayloadDays: readDays('FAILED_PAYLOAD_RETENTION_DAYS', DEFAULTS.failedPayloadDays),
    auditDays: readDays('AUDIT_RETENTION_DAYS', DEFAULTS.auditDays),
  };
}

/** The window that applies to one terminal queue state. */
export function retentionDaysFor(
  policy: RetentionPolicy,
  outcome: 'completed' | 'failed' | 'manual_review',
): number {
  if (outcome === 'completed') return policy.completedPayloadDays;
  if (outcome === 'failed') return policy.failedPayloadDays;
  return policy.failedPayloadDays;
}
