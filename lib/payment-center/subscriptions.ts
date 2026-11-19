import 'server-only';
import { z } from 'zod';
import { requireCapability } from '@/lib/config';

const subscriptionSchema = z.object({
  order_id: z.uuid(),
  website_id: z.uuid(),
  billing_account_id: z.string().min(1),
  provider_subscription_id: z.string().min(1),
  status: z.string().min(1),
  cancel_at_period_end: z.boolean(),
  current_period_end: z.number().int().positive().nullable(),
});

const responseSchema = z.object({
  status: z.literal('success'),
  data: subscriptionSchema,
});

function endpoint(accountId: string, subscriptionId: string, action?: string) {
  requireCapability('paymentCenter');
  if (!accountId || !subscriptionId) throw new Error('Subscription binding is missing');
  const path = `/api/payment-center/subscriptions/by-account/${
    encodeURIComponent(accountId)}/${encodeURIComponent(subscriptionId)}${action || ''}`;
  const url = new URL(path, process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Payment Center URL must use HTTPS in production');
  }
  return url;
}

async function parseResponse(response: Response, accountId: string, subscriptionId: string) {
  if (!response.ok) throw new Error(`Payment Center subscription returned HTTP ${response.status}`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Payment Center subscription response is invalid');
  const data = parsed.data.data;
  if (data.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
      data.billing_account_id !== accountId ||
      data.provider_subscription_id !== subscriptionId) {
    throw new Error('Payment Center subscription belongs to another account');
  }
  return data;
}

export async function queryCenterSubscription(accountId: string, subscriptionId: string,
  send: typeof fetch = fetch) {
  const response = await send(endpoint(accountId, subscriptionId), {
    headers: { 'X-API-Key': process.env.PAYMENT_CENTER_API_KEY! },
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  return parseResponse(response, accountId, subscriptionId);
}

export async function setCenterAutoRenew(accountId: string, subscriptionId: string,
  enabled: boolean, send: typeof fetch = fetch) {
  const response = await send(endpoint(accountId, subscriptionId, '/auto-renew'), {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.PAYMENT_CENTER_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enabled }),
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  return parseResponse(response, accountId, subscriptionId);
}
