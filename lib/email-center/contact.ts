import { z } from 'zod';
import { client } from '@/lib/db/drizzle';
import { routing, type Locale } from '@/i18n/routing';

export type ContactEvent = { id: string; user_id: string; event_version: number; occurred_at: Date };

/** Keep both receipt queries and sends inside the runner's remaining budget. */
export function contactFetchWithin(send: typeof fetch, deadline: number): typeof fetch {
  return async (url, init) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('EMAIL_BATCH_BUDGET_EXPIRED');
    const signal = AbortSignal.timeout(remaining);
    return send(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
  };
}

export async function contactSnapshot(job: ContactEvent) {
  // One statement observes the user and its trigger-created event version
  // together, preventing a retry from using a newer profile with an old key.
  const [user] = await client`
    SELECT u.id, u.email, u.name, u.email_verified, u.preferred_locale,
      u.locale_source, u.marketing_opt_in_requested,
      (SELECT MAX(event_version) FROM email_contact_outbox WHERE user_id = u.id) AS latest_version
    FROM "user" u WHERE u.id = ${job.user_id}
  `;
  if (!user || Number(user.latest_version) !== job.event_version) return null;
  return {
    externalUserId: job.user_id,
    email: String(user.email), name: String(user.name),
    source: job.event_version === 1 ? 'registration' : 'api',
    occurredAt: new Date(job.occurred_at).toISOString(),
    // Forward the locale the account actually holds; unknown stored values
    // (older rows, hand edits) fall back to English rather than escaping into
    // the outbound contract.
    preferredLocale: routing.locales.includes(user.preferred_locale as Locale)
      ? user.preferred_locale
      : 'en',
    localeSource: user.locale_source || 'fallback',
    marketingConsent: Boolean(user.email_verified && user.marketing_opt_in_requested),
    metadata: {},
  };
}
export type ContactPayload = NonNullable<Awaited<ReturnType<typeof contactSnapshot>>>;
export function contactOperationKey(job: ContactEvent) {
  return `saas:contact:${job.user_id}:v${job.event_version}`;
}

const responseSchema = z.object({ data: z.object({
  applicationId: z.number().int().positive(), idempotencyKey: z.string(),
  operation: z.object({
    status: z.enum(['not_received', 'processing', 'succeeded', 'failed']),
    requestMatches: z.boolean(), contactApplicationId: z.number().int().positive().nullable(),
  }),
  contact: z.object({
    bindingMatches: z.boolean(), profileMatches: z.boolean(),
    marketingConsent: z.boolean(), marketingSuppressed: z.boolean(),
    globalStatus: z.enum(['active', 'bounced', 'complained', 'suppressed']),
  }).nullable(),
}) });

export type Probe =
  | { state: 'confirmed'; code: 'MATCHED' | 'AUTHORITY_SUPPRESSED' | 'REMOTE_PREFERENCE_CHANGED' }
  | { state: 'notReceived'; code: 'NOT_RECEIVED' }
  | { state: 'conflict'; code: 'IDEMPOTENCY_CONFLICT' | 'REMOTE_BINDING_MISMATCH' | 'REMOTE_FAILED' }
  | { state: 'unavailable'; code: string; permanent: boolean; retryAfter?: string | null };

export async function probeContact(job: ContactEvent, payload: ContactPayload, send: typeof fetch): Promise<Probe> {
  const endpoint = new URL('/api/v1/contacts/reconcile', process.env.EMAIL_CENTER_URL);
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
    return { state: 'unavailable', code: 'INSECURE_ENDPOINT', permanent: true };
  }
  try {
    const response = await send(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4_000),
      headers: { Authorization: `Bearer ${process.env.EMAIL_CENTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: contactOperationKey(job), contact: payload }),
    });
    if (!response.ok) return {
      state: 'unavailable', code: `RECONCILE_HTTP_${response.status}`,
      permanent: response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status),
      retryAfter: response.headers.get('retry-after'),
    };
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.data.idempotencyKey !== contactOperationKey(job)) {
      return { state: 'unavailable', code: 'INVALID_RECONCILE_RESPONSE', permanent: true };
    }
    const { operation, contact } = parsed.data.data;
    if (operation.status === 'not_received') return { state: 'notReceived', code: 'NOT_RECEIVED' };
    if (!operation.requestMatches) return { state: 'conflict', code: 'IDEMPOTENCY_CONFLICT' };
    if (operation.status === 'failed') return { state: 'conflict', code: 'REMOTE_FAILED' };
    if (operation.status !== 'succeeded') return { state: 'unavailable', code: 'REMOTE_PROCESSING', permanent: false };
    if (!contact?.bindingMatches || operation.contactApplicationId === null) {
      return { state: 'conflict', code: 'REMOTE_BINDING_MISMATCH' };
    }
    // A newer unsubscribe or provider suppression is authoritative. Receipt
    // confirmation never writes consent or tries to restore the saved intent.
    const code = contact.marketingSuppressed ? 'AUTHORITY_SUPPRESSED'
      : !contact.profileMatches || contact.marketingConsent !== payload.marketingConsent
        ? 'REMOTE_PREFERENCE_CHANGED' : 'MATCHED';
    return { state: 'confirmed', code };
  } catch {
    return { state: 'unavailable', code: 'RECONCILE_NETWORK_OR_RESPONSE', permanent: false };
  }
}
