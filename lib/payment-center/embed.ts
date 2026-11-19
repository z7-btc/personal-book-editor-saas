import 'server-only';
import { z } from 'zod';
import { requireCapability } from '@/lib/config';

/**
 * The Payment Center widget contract, host side.
 *
 * The remote script (`<baseUrl>/static/js/payment-center.js`) owns the buyer
 * interface: it renders the plan, interval and payment-method choices, creates
 * the order through this application's `createOrder` callback, then shows the
 * Stripe redirect, the blockchain address or the manual instructions itself.
 * This module only hands the browser the public identifiers it needs and mints
 * the short-lived embed session token that authorises the widget's public
 * catalogue and order polling calls. The website API key never leaves the
 * server.
 */

export type PaymentCenterPublicConfig = { baseUrl: string; siteCode: string };

const tokenSchema = z.object({
  token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

export type PaymentCenterEmbedToken = z.infer<typeof tokenSchema>;

/** Public identifiers only — safe to send to the browser. */
export function paymentCenterPublicConfig(): PaymentCenterPublicConfig {
  const baseUrl = (process.env.PAYMENT_CENTER_BASE_URL || '').trim();
  const siteCode = (process.env.PAYMENT_CENTER_SITE_CODE || '').trim();
  if (!baseUrl || !siteCode) {
    throw new Error('Payment Center public configuration is incomplete');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), siteCode };
}

function tokenEndpoint() {
  const url = new URL('/api/payment-center/embed-token',
    process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Payment Center URL must use HTTPS in production');
  }
  return url;
}

/**
 * Mints the embed session token for one signed-in user. The token is what the
 * widget presents as `Authorization: Bearer …` when it reads the public
 * catalogue and polls its own order, so it must be issued server-side.
 */
export async function createEmbedToken(externalUserId: string,
  send: typeof fetch = fetch): Promise<PaymentCenterEmbedToken> {
  requireCapability('paymentCenter');
  const response = await send(tokenEndpoint(), {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.PAYMENT_CENTER_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ external_user_id: externalUserId }),
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Payment Center embed token returned HTTP ${response.status}`);
  }
  // The centre answers `{ status, data: { token, expires_in } }`, the same
  // envelope the widget's own client unwraps.
  const payload = (await response.json()) as { data?: unknown };
  const parsed = tokenSchema.safeParse(payload?.data ?? payload);
  if (!parsed.success) throw new Error('Payment Center embed token response is invalid');
  return parsed.data;
}
