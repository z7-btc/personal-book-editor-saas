import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import { paymentIntents, subscriptionGrants } from '@/lib/db/integration-schema';
import { getPaymentCatalog, methodCapability } from '@/lib/payment-center/catalog';
import { features } from '@/lib/config';
import { ensureBillingAccount } from './account';

const requestSchema = z.object({
  requestKey: z.uuid(),
  productCode: z.string().trim().min(1).max(120),
  priceInterval: z.enum(['one_time', 'month', 'year']),
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  // Deliberately a string, not an enum: the Payment Center catalogue is the
  // only list of channels, and a new one must not require a redeploy here.
  method: z.string().trim().min(1).max(40),
});

export type PreparePaymentIntentInput = z.infer<typeof requestSchema>;

/**
 * The refusal a buyer can actually act on. It used to share one sentence with
 * "you already have a paid period", which sent people hunting for an unpaid
 * order that did not exist, so the route needs to name it to say anything
 * useful. (Buying on top of a running period is no longer a refusal at all —
 * whichever channel pays for it.)
 */
export type PaymentIntentConflictCode = 'pending_checkout';

export class PaymentIntentConflict extends Error {
  readonly code: PaymentIntentConflictCode | null;

  constructor(message: string, code: PaymentIntentConflictCode | null = null) {
    super(message);
    this.code = code;
  }
}

export class PaymentOptionUnavailable extends Error {}

const DAY_MS = 86_400_000;

/**
 * When a buyer switches plans mid-subscription, the time they already paid for
 * is exchanged for its equivalent in the new plan. The remaining days — across
 * every unexpired grant, including a prior renewal — are scaled by the ratio of
 * the two monthly prices.
 *
 * The result is the end of the **converted slice alone**, not the end of the new
 * access: the buyer is also owed the full period they are paying for right now,
 * which only the centre can size (a month is not always 30 days). Fulfilment
 * therefore adds this slice onto the centre's period — see `fulfillSubscription`.
 * Reading this value as the final period end would silently drop the purchased
 * period.
 *
 * Returns `undefined` for a fresh purchase (no unexpired grant) or a same-plan
 * renewal (nothing to exchange), both of which keep the centre's own period.
 */
async function proratePlanSwitch(organizationId: string, toProductCode: string,
  toPriceInterval: string, toCurrency: string, now: Date) {
  const [latest] = await db.select({
    productCode: subscriptionGrants.productCode,
    periodEnd: subscriptionGrants.periodEnd,
  }).from(subscriptionGrants).where(and(
    eq(subscriptionGrants.organizationId, organizationId),
    eq(subscriptionGrants.status, 'active'),
    gt(subscriptionGrants.periodEnd, now),
  )).orderBy(desc(subscriptionGrants.periodEnd)).limit(1);
  // No unexpired access, or the same plan: nothing to exchange.
  if (!latest || latest.productCode === toProductCode) return undefined;
  if (!['month', 'year'].includes(toPriceInterval)) return undefined;

  const remainingDays = Math.ceil((latest.periodEnd.getTime() - now.getTime()) / DAY_MS);
  if (remainingDays <= 0) return undefined;

  const catalog = await getPaymentCatalog();
  const monthly = (code: string) => {
    const product = catalog.products.find((item) => item.code === code);
    return product?.prices.find((item) => item.interval === 'month' &&
      item.currency === toCurrency)?.amount ?? null;
  };
  const fromPrice = monthly(latest.productCode);
  const toPrice = monthly(toProductCode);
  if (!fromPrice || !toPrice || fromPrice <= 0 || toPrice <= 0) return undefined;

  const convertedDays = Math.floor(remainingDays * fromPrice / toPrice);
  if (convertedDays <= 0) return undefined;
  return new Date(now.getTime() + convertedDays * DAY_MS);
}

export async function preparePaymentIntent(
  organizationId: string,
  actorUserId: string,
  input: PreparePaymentIntentInput,
) {
  const request = requestSchema.parse(input);
  const billingAccount = await ensureBillingAccount(organizationId, actorUserId);
  const keyFilter = and(
    eq(paymentIntents.organizationId, organizationId),
    eq(paymentIntents.payerUserId, actorUserId),
    eq(paymentIntents.requestKey, request.requestKey),
  );
  const [existing] = await db.select().from(paymentIntents).where(keyFilter).limit(1);
  if (existing) {
    if (existing.productCode !== request.productCode ||
        existing.priceInterval !== request.priceInterval ||
        existing.currency !== request.currency ||
        existing.method !== request.method) {
      throw new PaymentIntentConflict('Request key was already used for a different quote');
    }
    return existing;
  }

  // A repeat purchase is welcome in either shape, whichever channel pays for
  // it: the same plan stacks onto the running period, and a different plan is
  // exchanged for it. `proratePlanSwitch` below prices that exchange, and
  // fulfilment either stitches the new span onto the old one or converts it —
  // see `fulfillSubscription`.
  //
  // The unpaid-order lock is per channel, never per workspace. A buyer who opens
  // a card checkout and changes their mind must still be able to pay by crypto
  // or commission balance — and a channel that has already retired its order
  // (an expired checkout, a lapsed amount lock) leaves nothing to lock at all,
  // because the centre closes it and the inbox worker closes the intent here.
  const [open] = await db.select().from(paymentIntents).where(and(
    eq(paymentIntents.organizationId, organizationId),
    eq(paymentIntents.method, request.method),
    inArray(paymentIntents.status, ['submitting', 'action_required', 'unknown']),
  )).limit(1);
  if (open) {
    if (open.payerUserId === actorUserId &&
        open.productCode === request.productCode &&
        open.priceInterval === request.priceInterval &&
        open.currency === request.currency) {
      return open;
    }
    throw new PaymentIntentConflict('Workspace already has a pending checkout', 'pending_checkout');
  }

  const catalog = await getPaymentCatalog();
  // The catalogue's capability card is the only statement of what this channel
  // can do. No card means the centre does not know the channel (a typo or an
  // older centre) — display nothing and accept nothing.
  const capability = methodCapability(catalog, request.method);
  if (!capability || !catalog.methods.includes(request.method) ||
      catalog.unavailable_methods[request.method]) {
    throw new PaymentOptionUnavailable('Payment method is unavailable');
  }
  // A redirect checkout is fulfilled by the centre's invoice event, which only
  // exists for a month/year subscription. A one-time redirect order would take
  // the money and leave the workspace unfulfilled, so fail closed before any
  // order reaches the centre.
  if (request.priceInterval === 'one_time' && capability.action === 'redirect') {
    throw new PaymentOptionUnavailable('One-time checkout is not available for redirect payment');
  }
  // Commission-funded channels stay behind the deployment's own flag.
  if (capability.action === 'commission_reserved' && !features.commissionBalance) {
    throw new PaymentOptionUnavailable('Payment method is unavailable');
  }
  const product = catalog.products.find((item) => item.code === request.productCode);
  const price = product?.prices.find((item) =>
    item.interval === request.priceInterval && item.currency === request.currency);
  if (!price) throw new PaymentOptionUnavailable('Selected catalog price is unavailable');

  // A plan switch is priced here so the webhook can grant the prorated span
  // without re-reading the catalogue. Fresh purchases and renewals leave it null.
  const proratedPeriodEnd = await proratePlanSwitch(
    organizationId, request.productCode, request.priceInterval, request.currency, new Date());

  const id = `pi_${randomUUID().replaceAll('-', '')}`;
  const [created] = await db.insert(paymentIntents).values({
    id,
    organizationId,
    billingAccountId: billingAccount.id,
    payerUserId: actorUserId,
    requestKey: request.requestKey,
    productCode: request.productCode,
    priceInterval: request.priceInterval,
    amountDecimal: price.amount_decimal,
    currency: price.currency,
    method: request.method,
    paymentAction: capability.action,
    proratedPeriodEnd,
    externalOrderId: id,
    idempotencyKey: id,
  }).onConflictDoNothing().returning();
  if (created) return created;

  const [concurrent] = await db.select().from(paymentIntents).where(keyFilter).limit(1);
  if (!concurrent) {
    const [otherOpen] = await db.select().from(paymentIntents).where(and(
      eq(paymentIntents.organizationId, organizationId),
      eq(paymentIntents.method, request.method),
      inArray(paymentIntents.status, ['submitting', 'action_required', 'unknown']),
    )).limit(1);
    if (otherOpen?.payerUserId === actorUserId &&
        otherOpen.productCode === request.productCode &&
        otherOpen.priceInterval === request.priceInterval &&
        otherOpen.currency === request.currency) {
      return otherOpen;
    }
    throw new PaymentIntentConflict('Workspace already has a pending checkout', 'pending_checkout');
  }
  if (concurrent.productCode !== request.productCode ||
      concurrent.priceInterval !== request.priceInterval ||
      concurrent.currency !== request.currency ||
      concurrent.method !== request.method) {
    throw new PaymentIntentConflict('Request key was already used for a different quote');
  }
  return concurrent;
}
