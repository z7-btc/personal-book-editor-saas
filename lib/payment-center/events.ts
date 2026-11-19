import 'server-only';
import { z } from 'zod';
import { requireCapability } from '@/lib/config';
import { orderSchema } from './orders';

const responseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    event: z.object({
      id: z.uuid(),
      type: z.string().min(1),
      data: z.object({ order: orderSchema }).passthrough(),
    }),
    delivery_status: z.string(),
  }),
});

export type CenterEvent = z.infer<typeof responseSchema>['data']['event'];

export async function queryCenterEvent(eventId: string, send: typeof fetch = fetch) {
  requireCapability('paymentCenter');
  if (!z.uuid().safeParse(eventId).success) throw new Error('Invalid Payment Center event ID');
  const url = new URL(`/api/payment-center/events/${eventId}`,
    process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Payment Center URL must use HTTPS in production');
  }
  const response = await send(url, {
    headers: { 'X-API-Key': process.env.PAYMENT_CENTER_API_KEY! },
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Payment Center event query returned HTTP ${response.status}`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Payment Center event query response is invalid');
  const event = parsed.data.data.event;
  if (event.id !== eventId ||
      event.data.order.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID) {
    throw new Error('Payment Center event belongs to another website or ID');
  }
  return event;
}
