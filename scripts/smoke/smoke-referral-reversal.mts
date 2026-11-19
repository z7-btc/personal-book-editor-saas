import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

/**
 * Validates the referral reversal contract. The Payment Center books the
 * earning itself when it settles its own order; only the refund reversal comes
 * back to us, so that is the call this covers.
 *
 * Part one mocks the centre and checks the bytes we sign: the HMAC, the
 * literal backslash-n separator, the encoded event id and the payload.
 * Part two, when a local centre is reachable, proves the centre accepts that
 * signature — a probe that must fail on business grounds, never on the
 * signature, which is how the 401 separator bug surfaced.
 */
process.env.REFERRAL_PAYMENT_INGEST_SECRET =
  'smoke-ingest-secret-0123456789abcdef0123456789abcdef';
process.env.PAYMENT_CENTER_PAYMENT_INGEST_API_KEY = 'mock-ingest-key';
process.env.PAYMENT_CENTER_BASE_URL ||= 'https://payments.example.test';
process.env.FEATURE_REFERRALS = 'true';

const SECRET = process.env.REFERRAL_PAYMENT_INGEST_SECRET!;

// The centre separates signed parts with a LITERAL backslash-n pair (its Python
// source writes `\\n`, an escaped backslash — not a newline). A real newline
// yields a different HMAC and a 401 in production.
const SEPARATOR = '\\n';

type Captured = { url: URL; headers: Headers; body: unknown };

function verifySignature(headers: Headers, path: string, rawBody: string) {
  const parts = ['POST', path, rawBody,
    headers.get('x-payment-timestamp')!, headers.get('x-payment-nonce')!];
  const expected = createHmac('sha256', SECRET).update(parts.join(SEPARATOR)).digest('hex');
  assert.equal(headers.get('x-payment-signature'), expected,
    'HMAC signature must match the signed payload');
  assert.equal(headers.get('x-api-key'), 'mock-ingest-key');
  // Guard the quirk: an edit that "simplifies" the separator to a real newline
  // must fail loudly here instead of only against the live centre.
  assert.notEqual(expected,
    createHmac('sha256', SECRET).update(parts.join('\n')).digest('hex'),
    'the separator must be a literal backslash-n, never a newline');
}

// --- Part one: the bytes we sign -------------------------------------------
const { reverseReferralPurchase } = await import('../../lib/referrals/reversal');

const captured: Captured[] = [];
const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  captured.push({
    url: new URL(String(input)),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)),
  });
  return Response.json({ status: 'success', data: {
    processed: true, idempotent: false, commission_amount: '14.85000000', currency: 'USD',
  } });
}) as typeof fetch;

const eventId = 'pi_abc123def456';
const result = await reverseReferralPurchase({
  externalEventId: eventId,
  providerPaymentId: 'pi_123',
  reason: 'stripe_refund',
}, mockFetch);
assert.deepEqual(result, { submitted: true, commissionAmount: 14.85, currency: 'USD' });

const reversal = captured[0];
assert.equal(reversal.url.pathname,
  `/api/referral-center/purchases/${eventId}/refund`,
  'the reversal must key on the order id the centre booked under');
const body = reversal.body as Record<string, unknown>;
assert.equal(body.provider_payment_id, 'pi_123');
assert.equal(body.reason, 'stripe_refund');
verifySignature(reversal.headers,
  `/api/referral-center/purchases/${eventId}/refund`, JSON.stringify(body));
console.log('Offline: reversal HMAC signing, separator and payload verified.');

// --- Part two: a live centre must accept the signature ----------------------
const live = process.env.SMOKE_REFERRAL_CENTER_URL;
if (live) {
  process.env.PAYMENT_CENTER_BASE_URL = live;
  process.env.REFERRAL_PAYMENT_INGEST_SECRET =
    process.env.SMOKE_REFERRAL_CENTER_SECRET || SECRET;
  process.env.PAYMENT_CENTER_PAYMENT_INGEST_API_KEY =
    process.env.SMOKE_REFERRAL_CENTER_KEY || '';
  const probe = `pi_probe_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const { reverseReferralPurchase: liveReverse } = await import('../../lib/referrals/reversal');
  const outcome = await liveReverse({
    externalEventId: probe, providerPaymentId: probe, reason: 'stripe_refund',
  });
  // The only answer a bad signature can produce is 401. Everything else —
  // including the idempotent success an unknown id gets — means the centre
  // accepted the signature, which is what this probe is here to prove.
  if (!outcome.submitted) {
    assert.ok(!outcome.reason.includes('401'),
      `the centre rejected the signature: ${outcome.reason}`);
  }
  console.log(`Live: centre accepted the signature (${outcome.submitted
    ? 'idempotent success for the unknown id' : `business reply ${outcome.reason}`}).`);
}
