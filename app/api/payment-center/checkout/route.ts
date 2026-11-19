import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getCapabilities } from '@/lib/config';
import { ensurePersonalWorkspace } from '@/lib/workspace/bootstrap';
import { BillingAccessError } from '@/lib/billing/account';
import {
  PaymentIntentConflict, PaymentOptionUnavailable, preparePaymentIntent,
} from '@/lib/billing/intents';
import { submitPaymentIntent } from '@/lib/billing/submit';
import {
  getPaymentCatalog, MethodSelectionError, resolveMethodSelection,
} from '@/lib/payment-center/catalog';
import { isCryptoAsset } from '@/lib/payment-center/methods';

export const dynamic = 'force-dynamic';

/**
 * The `createOrder` callback of the embedded Payment Center widget.
 *
 * The widget owns the buyer interface and sends its selection here; this route
 * keeps the application's own bookkeeping intact — one stored intent per quote,
 * the centre order created with our idempotency key, and the payment method,
 * plan and amount checked against the catalogue before any money can move. The
 * answer is the flat `{ order, action }` shape the widget renders: an
 * `action.checkout_url` for card payments, the address dialog for blockchain and
 * manual payments.
 */
const requestSchema = z.object({
  product_code: z.string().trim().min(1).max(120),
  billing_interval: z.enum(['one_time', 'month', 'year']),
  catalog_currency: z.string().trim().regex(/^[A-Z]{3,10}$/),
  // The Payment Center catalogue is the only channel list. A method that
  // arrived after this build must still be accepted if its capability card
  // says how to collect it.
  payment_method: z.string().trim().min(1).max(40),
  blockchain: z.string().trim().regex(/^[A-Z0-9_-]{2,20}$/).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3,10}$/).optional(),
  // Everything the capability card declared as an input. The shape is checked
  // against the card below, never against a list written here.
  inputs: z.record(z.string().trim().min(1).max(60),
    z.string().max(200)).optional(),
});

function fail(status: number, error: string, message: string) {
  return Response.json({ error, message },
    { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const expectedOrigin = new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
  if (request.headers.get('origin') !== expectedOrigin) {
    return fail(403, 'invalid_origin', '付款请求来源不正确，请刷新页面后重试。');
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return fail(401, 'unauthorized', '请先登录，再购买此套餐。');
  if (!getCapabilities().paymentCenter.configured) {
    return fail(503, 'payment_unavailable', '收款服务暂时无法连接，请稍后重试。');
  }
  let body: z.infer<typeof requestSchema>;
  try {
    const raw = await request.text();
    if (raw.length > 2_000) return fail(413, 'invalid_request', '付款请求过长。');
    body = requestSchema.parse(JSON.parse(raw));
  } catch {
    return fail(422, 'invalid_request', '付款请求格式不正确，请刷新页面后重试。');
  }
  // The card channel has no crypto assets: a crypto-priced plan can never be
  // paid by card, and asking the centre would only surface a provider error.
  // This is a Stripe-specific business rule, not a list of enabled channels.
  if (body.payment_method === 'stripe' && isCryptoAsset(body.catalog_currency)) {
    return fail(422, 'payment_option_unavailable', '这个套餐以加密货币定价，银行卡付款不可用。');
  }

  let selection: ReturnType<typeof resolveMethodSelection>;
  try {
    const catalog = await getPaymentCatalog();
    selection = resolveMethodSelection(catalog, body.payment_method, body,
      body.catalog_currency);
  } catch (error) {
    if (error instanceof MethodSelectionError) {
      return fail(422, 'invalid_request', error.message);
    }
    return fail(503, 'payment_unavailable', '收款服务暂时无法连接，请稍后重试。');
  }
  if (!selection) {
    return fail(422, 'payment_option_unavailable', '这种付款方式暂时不能用于此套餐。');
  }

  try {
    const organizationId = (await ensurePersonalWorkspace(session.user.id, session.user.name)).id;
    const intent = await preparePaymentIntent(organizationId, session.user.id, {
      requestKey: randomUUID(),
      productCode: body.product_code,
      priceInterval: body.billing_interval,
      currency: body.catalog_currency,
      method: body.payment_method,
    });
    // The capability card resolved the settlement asset and flattened the
    // chain field; forward that unchanged so this route never re-interprets
    // which channel needs which input.
    const submitted = await submitPaymentIntent(intent.id, session.user.id, fetch, {
      currency: selection.currency,
      blockchain: selection.blockchain,
      inputs: selection.inputs,
    });
    return Response.json({
      order: submitted.order,
      action: submitted.action,
      intentId: submitted.intentId,
      status: submitted.status,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof BillingAccessError) {
      return fail(403, 'forbidden', '当前账户暂时无法购买，请联系支持。');
    }
    if (error instanceof PaymentOptionUnavailable) {
      return fail(422, 'payment_option_unavailable', '这种付款方式暂时不能用于此套餐。');
    }
    if (error instanceof PaymentIntentConflict) {
      // The one dead end a buyer can act on: an unpaid order already holding this
      // channel. It says exactly what to do about it, which is why the code has
      // to travel this far.
      if (error.code === 'pending_checkout') {
        return fail(409, 'pending_checkout',
          '这种付款方式下你还有一笔未完成的订单，请先完成它，或者换一种付款方式。');
      }
      return fail(409, 'existing_checkout', '当前无法创建这笔付款，请稍后重试。');
    }
    return fail(503, 'payment_unavailable', '收款服务暂时无法连接，请稍后重试。');
  }
}
