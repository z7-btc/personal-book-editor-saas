import 'server-only';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { requireCapability } from '@/lib/config';
import { commissionGrantPreparations, paymentIntents } from '@/lib/db/integration-schema';
import {
  assertCurrencyPayable, getPaymentCatalog, methodCapability, settlementCurrencyFor,
} from '@/lib/payment-center/catalog';
import {
  assertOrderMatchesIntent, createCenterOrder, queryCenterOrder,
  queryCenterCommission, confirmCenterCommission, cancelCenterCommission,
  intentPaymentAction, type CenterCreateOrderRequest, type CenterOrder,
} from '@/lib/payment-center/orders';
import { BillingAccessError, ensureBillingAccount } from './account';
import { prepareCommissionGrant, markCommissionPreparation } from './commission-preparation';
import { PaymentIntentConflict } from './intents';

type Intent = typeof paymentIntents.$inferSelect;

/**
 * The asset (and, for chain channels, the network) a buyer picked inside the
 * embedded Payment Center widget. It is the capability card's resolved
 * settlement selection: every channel may settle in a different asset from the
 * catalogue quote, or in the same one.
 */
export type SettlementSelection = {
  currency: string;
  blockchain?: string;
  inputs?: Record<string, string>;
};

function amountUnits(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

function orderRequest(intent: Intent, settlement?: SettlementSelection): CenterCreateOrderRequest {
  const origin = process.env.APP_BASE_URL;
  if (!origin) throw new Error('APP_BASE_URL is missing');
  const base = new URL(origin);
  if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') {
    throw new Error('APP_BASE_URL must use HTTPS in production');
  }
  const action = intentPaymentAction(intent);
  const recurring = action === 'redirect' &&
    ['month', 'year'].includes(intent.priceInterval);
  const settlementCurrency = settlement?.currency ??
    intent.settlementCurrency ?? intent.currency;
  return {
    external_order_id: intent.externalOrderId,
    idempotency_key: intent.idempotencyKey,
    payer_external_user_id: intent.payerUserId,
    billing_account_id: intent.billingAccountId,
    payment_method: intent.method,
    ...(action === 'commission_reserved' ? { commission_flow: 'two_phase' as const } : {}),
    kind: recurring ? 'subscription' : 'one_time',
    product_code: intent.productCode,
    recurrence_interval: intent.priceInterval as 'one_time' | 'month' | 'year',
    amount: intent.amountDecimal,
    currency: settlementCurrency,
    catalog_currency: intent.currency,
    ...(settlement?.blockchain ? { blockchain: settlement.blockchain } : {}),
    ...(settlement?.inputs && Object.keys(settlement.inputs).length > 0
      ? { inputs: settlement.inputs } : {}),
    callback_url: new URL('/api/payment-center/webhook', base).href,
    ...(action === 'redirect' ? {
      success_url: new URL('/dashboard?checkout=returned', base).href,
      cancel_url: new URL('/pricing?checkout=cancelled', base).href,
    } : {}),
    metadata: {
      organizationId: intent.organizationId,
      billingAccountId: intent.billingAccountId,
      payerUserId: intent.payerUserId,
      intentId: intent.id,
    },
  };
}

async function recoverIncompleteCommissionOrder(intent: Intent, order: CenterOrder,
  send: typeof fetch) {
  if (intentPaymentAction(intent) !== 'commission_reserved' || order.status !== 'pending') {
    return order;
  }
  // The remote process may have committed the reservation but stopped before
  // marking its order ready. Replay the original create key to finish that step.
  const recovered = await createCenterOrder(orderRequest(intent), send);
  assertOrderMatchesIntent(intent, recovered.order);
  if (recovered.order.id !== order.id) {
    throw new PaymentIntentConflict('Commission recovery returned a different order');
  }
  return recovered.order;
}

function remoteStatus(order: CenterOrder): Intent['status'] {
  if (order.status === 'action_required') return 'action_required';
  if (order.status === 'failed' || order.status === 'expired') return 'failed';
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'refunded') return 'manual_review';
  // A remote `paid` order still needs a verified payment event and grant.
  return 'unknown';
}

async function settleReservedCommission(intent: Intent, order: CenterOrder,
  send: typeof fetch) {
  const state = await queryCenterCommission(intent.externalOrderId, send);
  assertOrderMatchesIntent(intent, state.order);
  // The reserve must be denominated in the order's settlement currency, which
  // may differ from the catalogue currency (e.g. a USD price settled in USDT).
  if (state.order.id !== order.id || !state.spend ||
      state.spend.external_spend_id !== `PC_${order.id}` ||
      state.spend.currency !== order.currency) {
    throw new PaymentIntentConflict('Commission reservation does not match the order');
  }
  if (state.order.status === 'refunded') {
    await db.update(paymentIntents).set({ status: 'manual_review',
      lastErrorCode: 'commission_refunded', updatedAt: new Date() })
      .where(eq(paymentIntents.id, intent.id));
    throw new PaymentIntentConflict('Commission payment was refunded');
  }
  if (state.spend_status === 'cancelled') {
    await markCommissionPreparation(intent.id, 'cancelled');
    await db.update(paymentIntents).set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(paymentIntents.id, intent.id));
    return { intentId: intent.id, status: 'cancelled' as const,
      order: state.order, action: state.order.payment_details || {} };
  }
  if (state.spend_status === 'reserved') {
    if (state.order.status !== 'action_required') {
      throw new PaymentIntentConflict('Reserved commission order is not payable');
    }
    try {
      await prepareCommissionGrant(intent.id, state.order);
    } catch (error) {
      // A local preparation failure must release the remote reservation.
      // If the cancel result is unknown, preserve this intent for reconciliation.
      const cancelled = await cancelCenterCommission(intent.externalOrderId, send);
      if (cancelled.spend_status !== 'cancelled') throw error;
      await markCommissionPreparation(intent.id, 'cancelled');
      await db.update(paymentIntents).set({ status: 'failed',
        lastErrorCode: 'grant_preparation_failed', updatedAt: new Date() })
        .where(eq(paymentIntents.id, intent.id));
      throw new PaymentIntentConflict('Commission grant could not be prepared');
    }
  } else if (state.spend_status !== 'completed') {
    throw new PaymentIntentConflict('Commission reservation is missing');
  }
  const [prepared] = await db.select().from(commissionGrantPreparations)
    .where(eq(commissionGrantPreparations.intentId, intent.id)).limit(1);
  if (!prepared || prepared.centerOrderId !== order.id ||
      prepared.spendId !== `PC_${order.id}` || prepared.status === 'cancelled') {
    throw new PaymentIntentConflict('Commission grant preparation is missing');
  }
  // A previous confirmation may have committed while its HTTP response was
  // lost. Calling again repairs the order and signed success event in PC.
  const confirmed = await confirmCenterCommission(intent.externalOrderId, send);
  assertOrderMatchesIntent(intent, confirmed.order);
  if (confirmed.order.id !== order.id || confirmed.spend_status !== 'completed' ||
      confirmed.order.status !== 'paid' || !confirmed.event_id) {
    throw new PaymentIntentConflict('Commission confirmation is incomplete');
  }
  await markCommissionPreparation(intent.id, 'confirmed');
  return { intentId: intent.id, status: 'action_required' as const,
    order: confirmed.order, action: confirmed.order.payment_details || {} };
}

async function finishClaim(intent: Intent, status: Intent['status'], orderId?: string,
  errorCode?: string) {
  const [saved] = await db.update(paymentIntents).set({
    status,
    paymentCenterOrderId: orderId || intent.paymentCenterOrderId,
    submissionLeaseExpiresAt: null,
    lastErrorCode: errorCode || null,
    updatedAt: new Date(),
  }).where(and(
    eq(paymentIntents.id, intent.id),
    eq(paymentIntents.status, 'submitting'),
    eq(paymentIntents.attemptCount, intent.attemptCount),
  )).returning({ id: paymentIntents.id });
  if (!saved) throw new PaymentIntentConflict('Payment intent claim changed during submission');
}

export async function submitPaymentIntent(intentId: string, actorUserId: string,
  send: typeof fetch = fetch, settlement?: SettlementSelection) {
  requireCapability('paymentCenter');
  const [intent] = await db.select().from(paymentIntents)
    .where(eq(paymentIntents.id, intentId)).limit(1);
  if (!intent) throw new PaymentIntentConflict('Payment intent does not exist');
  const account = await ensureBillingAccount(intent.organizationId, actorUserId);
  if (account.id !== intent.billingAccountId) {
    throw new BillingAccessError('Payment intent belongs to another billing account');
  }
  if (['failed', 'cancelled', 'settled', 'manual_review'].includes(intent.status)) {
    throw new PaymentIntentConflict('Payment intent is closed');
  }
  if (intent.status === 'action_required') {
    let order = await queryCenterOrder(intent.externalOrderId, send);
    if (!order) throw new PaymentIntentConflict('Payment Center order needs reconciliation');
    assertOrderMatchesIntent(intent, order);
    order = await recoverIncompleteCommissionOrder(intent, order, send);
    if (intentPaymentAction(intent) === 'commission_reserved') {
      return settleReservedCommission(intent, order, send);
    }
    const status = remoteStatus(order);
    if (status !== intent.status) {
      await db.update(paymentIntents).set({ status, updatedAt: new Date() })
        .where(and(eq(paymentIntents.id, intent.id),
          eq(paymentIntents.status, 'action_required')));
    }
    return { intentId: intent.id, status, order,
      action: order.payment_details || {} };
  }

  const [claimed] = await db.update(paymentIntents).set({
    status: 'submitting',
    submissionLeaseExpiresAt: new Date(Date.now() + 30_000),
    attemptCount: sql`${paymentIntents.attemptCount} + 1`,
    lastErrorCode: null,
    updatedAt: new Date(),
  }).where(and(
    eq(paymentIntents.id, intent.id),
    or(eq(paymentIntents.status, 'pending'), eq(paymentIntents.status, 'unknown'),
      and(eq(paymentIntents.status, 'submitting'),
        lt(paymentIntents.submissionLeaseExpiresAt, new Date()))),
  )).returning();
  if (!claimed) throw new PaymentIntentConflict('Payment intent is already being submitted');

  try {
    let order = await queryCenterOrder(claimed.externalOrderId, send);
    let action: Record<string, unknown> = order?.payment_details || {};
    if (!order) {
      const catalog = await getPaymentCatalog(send);
      const capability = methodCapability(catalog, claimed.method);
      const price = catalog.products.find((item) => item.code === claimed.productCode)
        ?.prices.find((item) => item.interval === claimed.priceInterval &&
          item.currency === claimed.currency);
      if (!price || amountUnits(price.amount_decimal) !== amountUnits(claimed.amountDecimal) ||
          !capability || !catalog.methods.includes(claimed.method) ||
          catalog.unavailable_methods[claimed.method]) {
        await finishClaim(claimed, 'failed', undefined, 'quote_changed');
        throw new PaymentIntentConflict('Stored quote is no longer available');
      }
      // A channel that settles in an asset the buyer chose (or asks for an input
      // at all) cannot be rebuilt from the stored quote alone: the selection
      // lives only in the widget request. Fail closed instead of silently using
      // somebody's default asset.
      const needsSelection = capability.settlement.currency.mode === 'input' ||
        capability.inputs.some((input) => input.required);
      if (needsSelection && !settlement) {
        await finishClaim(claimed, 'failed', undefined, 'payment_selection_missing');
        throw new PaymentIntentConflict(
          'Checkout must be restarted from the pricing page so the payment option is kept');
      }
      // Record the settlement asset before the order exists, so a crash between
      // the two cannot leave a paid order whose currency the site cannot verify.
      const settlementCurrency = settlement?.currency ??
        claimed.settlementCurrency ??
        settlementCurrencyFor(capability, {}, catalog, claimed.currency);
      assertCurrencyPayable(capability, settlementCurrency, claimed.currency);
      if (claimed.settlementCurrency !== settlementCurrency) {
        await db.update(paymentIntents).set({
          settlementCurrency, updatedAt: new Date(),
        }).where(eq(paymentIntents.id, claimed.id));
        claimed.settlementCurrency = settlementCurrency;
      }
      const created = await createCenterOrder(orderRequest(claimed, settlement), send);
      order = created.order;
      action = created.action;
    }
    order = await recoverIncompleteCommissionOrder(claimed, order, send);
    try {
      assertOrderMatchesIntent(claimed, order);
    } catch (error) {
      await finishClaim(claimed, 'manual_review', undefined, 'order_mismatch');
      throw error;
    }
    if (intentPaymentAction(claimed) === 'commission_reserved') {
      await prepareCommissionGrant(claimed.id, order);
      await finishClaim(claimed, 'action_required', order.id);
      return settleReservedCommission(claimed, order, send);
    }
    const status = remoteStatus(order);
    await finishClaim(claimed, status, order.id,
      status === 'manual_review' ? 'remote_refunded' : undefined);
    return { intentId: claimed.id, status, order, action };
  } catch (error) {
    if (!(error instanceof PaymentIntentConflict)) {
      const [current] = await db.select({ status: paymentIntents.status })
        .from(paymentIntents).where(eq(paymentIntents.id, claimed.id)).limit(1);
      if (current?.status === 'submitting') {
        await finishClaim(claimed, 'unknown', undefined, 'remote_result_unknown');
      }
    }
    throw error;
  }
}

export async function reconcileCommissionIntents(maxIntents = 25,
  send: typeof fetch = fetch) {
  requireCapability('paymentCenter');
  const now = new Date();
  const pending = await db.select().from(paymentIntents).where(and(
    eq(paymentIntents.paymentAction, 'commission_reserved'),
    or(eq(paymentIntents.status, 'action_required'),
      eq(paymentIntents.status, 'unknown'),
      and(eq(paymentIntents.status, 'submitting'),
        lt(paymentIntents.submissionLeaseExpiresAt, now))),
  )).limit(Math.min(Math.max(maxIntents, 1), 100));
  const report = { checked: 0, recovered: 0, failed: 0 };
  for (const intent of pending) {
    report.checked++;
    try {
      let order = await queryCenterOrder(intent.externalOrderId, send);
      if (!order) continue;
      assertOrderMatchesIntent(intent, order);
      order = await recoverIncompleteCommissionOrder(intent, order, send);
      const result = await settleReservedCommission(intent, order, send);
      if (result.status === 'action_required' && intent.status !== 'action_required') {
        await db.update(paymentIntents).set({ status: 'action_required',
          paymentCenterOrderId: order.id, submissionLeaseExpiresAt: null,
          updatedAt: new Date() }).where(eq(paymentIntents.id, intent.id));
      }
      report.recovered++;
    } catch {
      report.failed++;
    }
  }
  return report;
}
