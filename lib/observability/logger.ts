// Structured output is deliberately a whitelist. Never accept a request,
// Error, free-form message, Cookie, UID, email, URL, or arbitrary metadata.
//
// Every operational log line must carry enough to follow one background fact —
// the owning module, the original business id, the event or task id, the state,
// the retry count and a masked error code — and nothing else. Values that are
// not part of that shape are dropped instead of serialised, so a new caller can
// never widen the log surface by passing an extra field.
const events = [
  'activity.read', 'activity.write', 'activity.failure', 'auth.session',
  'email.sync', 'email.reconcile', 'email.verify', 'payment.inbox', 'payment.reconcile',
  'referral.sync', 'withdrawal.dispatch', 'subscription.change', 'maintenance.scrub',
  'capability.report',
] as const;
const codes = ['OK', 'UNAUTHORIZED', 'INVALID_CURSOR', 'DATABASE_ERROR', 'ACTIVITY_UNAVAILABLE', 'WRITE_REJECTED'] as const;
const modules = [
  'activity', 'auth', 'billing', 'email-center', 'jobs',
  'payment-center', 'referrals', 'subscription',
] as const;
// `submitted` is the only status here that is a fact rather than a verdict: a
// payout the Payment Center accepted has left this system, so the dispatch
// record has to be able to say so. `uncertain` and `rejected` are the two other
// outcomes the payout dispatcher can settle a job with (see `Result` in
// lib/referrals/withdrawal-worker.ts): `uncertain` means the request may or may
// not have arrived and must be retried under the same external id, `rejected`
// means the Payment Center refused it outright. Dropping either from the log
// would make an operator unable to tell those two apart from a plain failure.
const statuses = [
  'ok', 'processed', 'submitted', 'uncertain', 'rejected', 'retried',
  'manual_review', 'dead_letter', 'quarantined', 'skipped', 'failed', 'denied',
  'unavailable',
] as const;

// A masked error code names a failure class, never a provider message: at most
// three uppercase words or snake_case words, at most 40 characters, no digits
// carrying a value, and no punctuation that could smuggle a raw payload.
const codePattern = /^(?=.{1,40}$)[A-Za-z][A-Za-z_]*(?:[._:-][A-Za-z][A-Za-z_]*)*$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

export type Observation = {
  event: typeof events[number]; code?: typeof codes[number]; level?: 'info' | 'warn' | 'error';
  module?: typeof modules[number]; status?: typeof statuses[number];
  businessId?: string; taskId?: string; maskedErrorCode?: string;
  retryCount?: number; count?: number; durationMs?: number;
  activityId?: string; correlation?: string;
};

export function sanitizeObservation(value: unknown): Observation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const input = value as Record<string, unknown>;
    if (!events.includes(input.event as typeof events[number])) return null;
    const clean: Observation = { event: input.event as Observation['event'] };
    if (codes.includes(input.code as typeof codes[number])) clean.code = input.code as Observation['code'];
    if (modules.includes(input.module as typeof modules[number])) clean.module = input.module as Observation['module'];
    if (statuses.includes(input.status as typeof statuses[number])) clean.status = input.status as Observation['status'];
    if (['info', 'warn', 'error'].includes(String(input.level))) clean.level = input.level as Observation['level'];
    if (typeof input.businessId === 'string' && idPattern.test(input.businessId)) clean.businessId = input.businessId;
    if (typeof input.taskId === 'string' && idPattern.test(input.taskId)) clean.taskId = input.taskId;
    if (typeof input.maskedErrorCode === 'string' && codePattern.test(input.maskedErrorCode)) {
      clean.maskedErrorCode = input.maskedErrorCode;
    }
    if (typeof input.retryCount === 'number' && Number.isSafeInteger(input.retryCount) && input.retryCount >= 0 && input.retryCount <= 1_000) clean.retryCount = input.retryCount;
    if (typeof input.count === 'number' && Number.isSafeInteger(input.count) && input.count >= 0 && input.count <= 1_000_000) clean.count = input.count;
    if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0 && input.durationMs <= 86_400_000) clean.durationMs = Math.round(input.durationMs);
    if (typeof input.activityId === 'string' && /^[1-9][0-9]{0,18}$/.test(input.activityId)) clean.activityId = input.activityId;
    if (typeof input.correlation === 'string' && /^[0-9a-f]{64}$/.test(input.correlation)) clean.correlation = input.correlation;
    return clean;
  } catch { return null; }
}

export function logObservation(value: Observation): void {
  const clean = sanitizeObservation(value);
  if (!clean) return;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...clean });
  if (clean.level === 'error') console.error('[observability]', line);
  else if (clean.level === 'warn') console.warn('[observability]', line);
  else console.info('[observability]', line);
}

/**
 * The failure vocabulary of the background workers, published so a status page,
 * a reconciliation script and a test all name the same codes.
 */
export const observableCodes = codes;

/**
 * Reduces a provider or database failure to a class name. The raw message may
 * embed an email, a UID, a URL or a secret, so it is never logged or returned;
 * callers that need to distinguish cases pass their own short snake_case code.
 */
export function maskErrorCode(error: unknown, fallback = 'UNEXPECTED_FAILURE'): string {
  if (error && typeof error === 'object') {
    const candidate = (error as { code?: unknown }).code;
    if (typeof candidate === 'string' && codePattern.test(candidate)) return candidate;
  }
  return codePattern.test(fallback) ? fallback : 'UNEXPECTED_FAILURE';
}
