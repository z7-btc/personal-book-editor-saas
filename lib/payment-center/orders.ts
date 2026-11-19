import 'server-only';
import { z } from 'zod';
import { requireCapability } from '@/lib/config';
import { CRYPTO_ASSETS } from '@/lib/payment-center/methods';

// The centre owns the channel names. Unknown ones must pass through: an older
// site build has to be able to read an order for a channel it has never heard
// of, because the capability card — not this schema — decides how it settles.
const methodSchema = z.string().trim().min(1).max(40);

export const orderSchema = z.object({
  id: z.string().min(1),
  website_id: z.uuid(),
  external_order_id: z.string(),
  idempotency_key: z.string(),
  payer_external_user_id: z.string().nullable(),
  billing_account_id: z.string().nullable(),
  payment_method: methodSchema,
  commission_flow: z.literal('two_phase').optional(),
  kind: z.enum(['one_time', 'subscription']),
  status: z.string().min(1),
  amount_decimal: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  currency: z.string(),
  product_code: z.string().nullable(),
  recurrence_interval: z.string().nullable(),
  provider_subscription_id: z.string().nullable().optional(),
  provider_payment_id: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()),
  payment_details: z.record(z.string(), z.unknown()).optional(),
});

const createResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    order: orderSchema,
    action: z.record(z.string(), z.unknown()),
    idempotent: z.boolean(),
    reused: z.boolean().optional(),
  }),
});

const queryResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({ order: orderSchema }),
});

const commissionResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    order: orderSchema,
    spend: z.object({
      external_spend_id: z.string().min(1),
      status: z.enum(['reserved', 'completed', 'cancelled']),
      currency: z.string(),
    }).passthrough().nullable(),
    spend_status: z.enum(['missing', 'reserved', 'completed', 'cancelled']),
    event_id: z.string().optional(),
  }),
});

export type CenterOrder = z.infer<typeof orderSchema>;
export type CenterCreateOrder = z.infer<typeof createResponseSchema>['data'];

const createRequestSchema = z.object({
  external_order_id: z.string().min(1).max(180),
  idempotency_key: z.string().min(1).max(180),
  payer_external_user_id: z.string().min(1),
  billing_account_id: z.string().min(1).max(128),
  payment_method: methodSchema,
  commission_flow: z.literal('two_phase').optional(),
  kind: z.enum(['one_time', 'subscription']),
  product_code: z.string().min(1).max(120),
  recurrence_interval: z.enum(['one_time', 'month', 'year']),
  amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  catalog_currency: z.string().regex(/^[A-Z]{3,10}$/),
  // The chain a blockchain order settles on. Omitted for every other method.
  blockchain: z.string().regex(/^[A-Z0-9_-]{2,20}$/).optional(),
  // Everything the capability card declared as an input, unchanged. The centre
  // validates it; this site must not invent its own field list.
  inputs: z.record(z.string().min(1).max(60), z.string().max(200)).optional(),
  callback_url: z.url(),
  success_url: z.url().optional(),
  cancel_url: z.url().optional(),
  metadata: z.object({
    organizationId: z.string().min(1),
    billingAccountId: z.string().min(1),
    payerUserId: z.string().min(1),
    intentId: z.string().min(1),
  }).strict(),
}).strict();

export type CenterCreateOrderRequest = z.infer<typeof createRequestSchema>;
export type CenterCommissionState = z.infer<typeof commissionResponseSchema>['data'];

function endpoint(path: string) {
  requireCapability('paymentCenter');
  const url = new URL(path, process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Payment Center URL must use HTTPS in production');
  }
  return url;
}

export async function queryCenterOrder(externalOrderId: string, send: typeof fetch = fetch) {
  const response = await send(endpoint(
    `/api/payment-center/orders/${encodeURIComponent(externalOrderId)}`,
  ), {
    headers: { 'X-API-Key': process.env.PAYMENT_CENTER_API_KEY! },
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Payment Center order query returned HTTP ${response.status}`);
  const parsed = queryResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Payment Center order query response is invalid');
  return parsed.data.data.order;
}

export async function createCenterOrder(payload: CenterCreateOrderRequest,
  send: typeof fetch = fetch): Promise<CenterCreateOrder> {
  const request = createRequestSchema.parse(payload);
  const response = await send(endpoint('/api/payment-center/orders'), {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.PAYMENT_CENTER_API_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Payment Center order creation returned HTTP ${response.status}`);
  const parsed = createResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Payment Center order creation response is invalid');
  return parsed.data.data;
}

async function commissionRequest(externalOrderId: string, action: 'state' | 'confirm' | 'cancel' | 'refund',
  reason: string | undefined, send: typeof fetch): Promise<CenterCommissionState> {
  const suffix = action === 'state' ? 'commission-state' : `commission-${action}`;
  const response = await send(endpoint(
    `/api/payment-center/orders/${encodeURIComponent(externalOrderId)}/${suffix}`,
  ), {
    method: action === 'state' ? 'GET' : 'POST',
    headers: {
      'X-API-Key': process.env.PAYMENT_CENTER_API_KEY!,
      ...(action === 'refund' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(action === 'refund' ? { body: JSON.stringify({ reason }) } : {}),
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Payment Center commission ${action} returned HTTP ${response.status}`);
  const parsed = commissionResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Payment Center commission response is invalid');
  return parsed.data.data;
}

export const queryCenterCommission = (id: string, send: typeof fetch = fetch) =>
  commissionRequest(id, 'state', undefined, send);
export const confirmCenterCommission = (id: string, send: typeof fetch = fetch) =>
  commissionRequest(id, 'confirm', undefined, send);
export const cancelCenterCommission = (id: string, send: typeof fetch = fetch) =>
  commissionRequest(id, 'cancel', undefined, send);
export const refundCenterCommission = (id: string, reason: string, send: typeof fetch = fetch) =>
  commissionRequest(id, 'refund', reason, send);

function scaledAmount(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

/**
 * The capability action an intent was created under. New rows store it; rows
 * written before capability cards existed fall back to the five actions they
 * were hard-coded to.
 */
const LEGACY_ACTION_BY_METHOD: Record<string, string> = {
  stripe: 'redirect',
  manual: 'manual',
  commission_balance: 'commission_reserved',
  blockchain: 'blockchain',
  binance_pay: 'binance_pay',
};

export function intentPaymentAction(intent: {
  method: string; paymentAction?: string | null;
}): string | null {
  return intent.paymentAction || LEGACY_ACTION_BY_METHOD[intent.method] || null;
}

export function assertOrderMatchesIntent(
  intent: {
    id: string; externalOrderId: string; idempotencyKey: string;
    organizationId: string; billingAccountId: string; payerUserId: string;
    productCode: string; priceInterval: string; amountDecimal: string;
    currency: string; method: string;
    paymentAction?: string | null; settlementCurrency?: string | null;
  },
  order: CenterOrder,
) {
  const metadata = order.metadata;
  const action = intentPaymentAction(intent);
  const kind = action === 'redirect' &&
    ['month', 'year'].includes(intent.priceInterval) ? 'subscription' : 'one_time';
  // The order settles in the currency the capability card derived at checkout,
  // which may differ from the catalogue currency (a USD price is payable in a
  // parity stablecoin one to one). The catalogue price itself is still pinned
  // by `amount_decimal`. Old rows without a recorded settlement currency keep
  // their historical crypto allowances so settled history still verifies.
  const payableCurrencies = intent.settlementCurrency
    ? [intent.settlementCurrency]
    : intent.method === 'blockchain'
      ? [intent.currency, ...CRYPTO_ASSETS]
      : intent.method === 'binance_pay'
        ? [intent.currency, 'USDT', 'USDC']
        : [intent.currency];
  if (order.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
      order.external_order_id !== intent.externalOrderId ||
      order.idempotency_key !== intent.idempotencyKey ||
      order.payer_external_user_id !== intent.payerUserId ||
      order.billing_account_id !== intent.billingAccountId ||
      order.payment_method !== intent.method || order.kind !== kind ||
      (action === 'commission_reserved' &&
       order.payment_details?.commission_flow !== 'two_phase') ||
      order.product_code !== intent.productCode ||
      order.recurrence_interval !== intent.priceInterval ||
      !payableCurrencies.includes(order.currency) ||
      scaledAmount(order.amount_decimal) !== scaledAmount(intent.amountDecimal) ||
      metadata.organizationId !== intent.organizationId ||
      metadata.billingAccountId !== intent.billingAccountId ||
      metadata.payerUserId !== intent.payerUserId ||
      metadata.intentId !== intent.id) {
    throw new Error('Payment Center order does not match the stored intent');
  }
}
