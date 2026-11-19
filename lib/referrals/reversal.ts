import 'server-only';
import { createHmac, randomUUID } from 'node:crypto';
import { logObservation, maskErrorCode } from '@/lib/observability/logger';

/**
 * Reverses a referral commission the Payment Center already booked.
 *
 * The centre books the earning itself when it settles one of its own gateway
 * orders — its own notes say a site whose orders settle inside it "must not
 * need an external payment_ingest key merely to use the referral APIs". This
 * module therefore never *submits* a purchase: there is exactly one writer per
 * earning, and it is not us. (Submitting here as well double-books the
 * commission under a second idempotency key, which is not deduplicated.)
 *
 * A refund is the exception. The centre's Stripe reversal handling refunds the
 * order but does not unwind the commission it paid on it, so that call stays
 * with the integration. It is keyed on the id the centre booked under — the
 * order's external id, which is our payment intent id — so the reversal lands
 * on the right ledger entry instead of creating a second one.
 *
 * A failed reversal must never block or roll back the grant reversal the
 * refund already earned, so callers get a result, not an exception.
 */

export type ReferralReversalResult =
  | { submitted: true; commissionAmount: number; currency: string }
  | { submitted: false; reason: string };

/**
 * Payment Center signs and verifies with a LITERAL backslash-n pair between
 * parts — its Python source writes `f'...\\n...'`, where `\\` is an escaped
 * backslash, not a newline. A real newline produces a different HMAC and the
 * centre answers `401 invalid_payment_signature`. The separator is spelled out
 * here so the quirk stays visible rather than hiding inside a template literal
 * that reads like an ordinary newline.
 */
const INGEST_SEPARATOR = '\\n';

function ingestSecret(): string {
  const secret = process.env.REFERRAL_PAYMENT_INGEST_SECRET || '';
  if (secret.length < 32) throw new Error('REFERRAL_PAYMENT_INGEST_SECRET is unavailable.');
  return secret;
}

function ingestApiKey(): string {
  const key = process.env.PAYMENT_CENTER_PAYMENT_INGEST_API_KEY
    || process.env.PAYMENT_CENTER_API_KEY || '';
  if (!key) throw new Error('Payment ingest API key is unavailable.');
  return key;
}

function endpoint(path: string): URL {
  const url = new URL(path, process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Insecure Payment Center referral endpoint.');
  }
  return url;
}

/**
 * Signs `METHOD\\nPATH\\nRAW_BODY\\nTIMESTAMP\\nNONCE` with the ingest secret
 * and attaches the `X-Payment-*` headers the centre's
 * `require_payment_ingest_signature` checks. The body string must be
 * byte-for-byte what is sent, after this returns.
 */
function signPaymentIngest(headers: Record<string, string>,
  method: 'POST', path: string, rawBody: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replaceAll('-', '');
  const signature = createHmac('sha256', ingestSecret())
    .update([method, path, rawBody, timestamp, nonce].join(INGEST_SEPARATOR))
    .digest('hex');
  headers['X-Payment-Timestamp'] = timestamp;
  headers['X-Payment-Nonce'] = nonce;
  headers['X-Payment-Signature'] = signature;
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function postSigned(path: string, body: unknown, send: typeof fetch) {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = {
    'X-API-Key': ingestApiKey(),
    'Content-Type': 'application/json',
  };
  signPaymentIngest(headers, 'POST', path, rawBody);
  return send(endpoint(path), {
    method: 'POST', headers, body: rawBody,
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
}

/**
 * Reverses a previously booked payment's commission on refund or a lost
 * dispute, keyed by the id the centre booked it under.
 */
export async function reverseReferralPurchase(input: {
  externalEventId: string;
  providerPaymentId: string;
  reason: 'stripe_refund' | 'dispute_lost';
}, send: typeof fetch = fetch): Promise<ReferralReversalResult> {
  const path = `/api/referral-center/purchases/${encodeURIComponent(input.externalEventId)}/refund`;
  const response = await postSigned(path, {
    provider_payment_id: input.providerPaymentId,
    reason: input.reason,
  }, send);
  const payload = await response.json().catch(() => ({})) as {
    status?: string; data?: {
      processed?: boolean; commission_amount?: number | string;
      currency?: string; reason?: string; message?: string;
    };
  };
  const data = payload.data ?? {};
  if (!response.ok || payload.status === 'error') {
    // Never echo a provider message — it may embed a UID, URL or account.
    return { submitted: false, reason: data.reason || `refused_http_${response.status}` };
  }
  return {
    submitted: true,
    commissionAmount: numberOr(data.commission_amount, 0),
    currency: data.currency || 'USD',
  };
}

/**
 * Fire-and-forget reversal hook. A refund or lost dispute unwinds the
 * commission the centre booked, keyed on the same order id the centre used.
 * Never throws: any failure is reduced to an operational observation so the
 * grant reversal the refund already earned is untouched.
 */
export async function settleReferralReversal(input: {
  payerUserId: string;
  method: string;
  externalEventId: string;
  sourceEventId: string;
  providerPaymentId: string;
  reason: 'stripe_refund' | 'dispute_lost';
}, send: typeof fetch = fetch) {
  // No channel list here: a channel the Payment Center enables later must be
  // able to unwind its commission too. The centre refuses a reversal it does
  // not recognise, and that refusal is logged rather than thrown.
  try {
    const result = await reverseReferralPurchase({
      externalEventId: input.externalEventId,
      providerPaymentId: input.providerPaymentId,
      reason: input.reason,
    }, send);
    logObservation({
      event: 'subscription.change',
      module: 'referrals',
      level: result.submitted ? 'info' : 'warn',
      status: result.submitted ? 'submitted' : 'skipped',
      businessId: input.payerUserId,
      taskId: input.sourceEventId,
      maskedErrorCode: result.submitted ? undefined : safeCode(result.reason),
    });
  } catch (error) {
    logObservation({
      event: 'subscription.change',
      module: 'referrals',
      level: 'error',
      status: 'failed',
      businessId: input.payerUserId,
      taskId: input.sourceEventId,
      maskedErrorCode: maskErrorCode(error, 'REVERSAL_FAILED'),
    });
  }
}

// A reason already reduced to a safe class by this module; the logger's
// `codePattern` requires a leading letter and at most 40 chars, so a provider
// reason that slips through is never passed verbatim.
function safeCode(reason: string): string {
  const clean = reason.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
  if (/^[A-Za-z]/.test(clean)) return clean;
  return `CODE_${clean}`;
}
