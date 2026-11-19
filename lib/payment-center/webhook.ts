import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const eventSchema = z.object({
  id: z.uuid(),
  type: z.string().min(1).max(120),
  data: z.object({
    order: z.object({
      id: z.uuid(),
      external_order_id: z.string().min(1).max(180),
      website_id: z.uuid(),
    }),
  }),
});

export class InvalidPaymentWebhook extends Error {}

export function verifyPaymentWebhook(raw: Uint8Array, headers: Headers,
  nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET || '';
  if (secret.length < 32) throw new InvalidPaymentWebhook('Signing secret is unavailable');
  if (raw.byteLength === 0 || raw.byteLength > 65_536) {
    throw new InvalidPaymentWebhook('Invalid callback size');
  }
  const timestamp = headers.get('x-payment-center-timestamp') || '';
  if (!/^[1-9]\d{9,12}$/.test(timestamp) ||
      Math.abs(nowSeconds - Number(timestamp)) > 300) {
    throw new InvalidPaymentWebhook('Callback timestamp is outside the allowed window');
  }
  const signature = headers.get('x-payment-center-signature') || '';
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) {
    throw new InvalidPaymentWebhook('Invalid callback signature format');
  }
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'ascii'), Buffer.from(raw)]);
  const expected = createHmac('sha256', secret).update(signed).digest();
  const provided = Buffer.from(signature.slice(7), 'hex');
  if (!timingSafeEqual(expected, provided)) {
    throw new InvalidPaymentWebhook('Callback signature does not match');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new InvalidPaymentWebhook('Invalid callback JSON');
  }
  const event = eventSchema.safeParse(parsed);
  if (!event.success || headers.get('x-payment-center-event') !== event.data.id) {
    throw new InvalidPaymentWebhook('Callback event ID or order is invalid');
  }
  return {
    eventId: event.data.id,
    eventType: event.data.type,
    centerOrderId: event.data.data.order.id,
    externalOrderId: event.data.data.order.external_order_id,
    websiteId: event.data.data.order.website_id,
    bodySha256: createHash('sha256').update(raw).digest('hex'),
  };
}
