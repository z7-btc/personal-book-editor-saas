import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const handshakeSchema = z.object({
  event: z.literal('handshake.check'),
  check_id: z.string().regex(/^[0-9a-f]{32}$/),
  site_code: z.string().min(1).max(64),
  modules: z.array(z.string()).min(1),
});

export class InvalidPaymentHandshake extends Error {}

export async function readHandshakeBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidPaymentHandshake('Missing handshake body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 8_192) {
      await reader.cancel();
      throw new InvalidPaymentHandshake('Handshake body is too large');
    }
    chunks.push(value);
  }
  if (!length) throw new InvalidPaymentHandshake('Missing handshake body');
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

export function verifyPaymentHandshake(raw: Uint8Array, headers: Headers,
  nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET || '';
  const expectedSite = process.env.PAYMENT_CENTER_SITE_CODE || '';
  if (secret.length < 32 || !expectedSite) {
    throw new InvalidPaymentHandshake('Handshake is not configured');
  }
  if (!raw.byteLength || raw.byteLength > 8_192) {
    throw new InvalidPaymentHandshake('Invalid handshake body size');
  }
  const timestamp = headers.get('x-payment-center-timestamp') || '';
  if (!/^[1-9]\d{9,12}$/.test(timestamp) ||
      Math.abs(nowSeconds - Number(timestamp)) > 300) {
    throw new InvalidPaymentHandshake('Handshake timestamp is outside the allowed window');
  }
  const signature = headers.get('x-payment-center-signature') || '';
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) {
    throw new InvalidPaymentHandshake('Invalid handshake signature');
  }
  const expected = createHmac('sha256', secret)
    .update(Buffer.from(`${timestamp}.`, 'ascii')).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) {
    throw new InvalidPaymentHandshake('Handshake signature does not match');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new InvalidPaymentHandshake('Invalid handshake JSON');
  }
  const parsed = handshakeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.site_code !== expectedSite ||
      headers.get('x-payment-center-site') !== expectedSite ||
      headers.get('x-payment-center-event') !== parsed.data.check_id ||
      !['payment_pricing', 'referral', 'payment_callback']
        .every((module) => parsed.data.modules.includes(module))) {
    throw new InvalidPaymentHandshake('Handshake site or challenge is invalid');
  }
  return parsed.data.check_id;
}
