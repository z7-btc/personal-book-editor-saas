import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/lib/db/drizzle';
import {
  commissionGrantPreparations, paymentEvidence, paymentInbox, paymentIntents,
  subscriptionGrants, subscriptions,
} from '@/lib/db/integration-schema';
import {
  assertOrderMatchesIntent, intentPaymentAction, type CenterOrder,
} from '@/lib/payment-center/orders';

const positiveAmount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/)
  .refine((value) => /[1-9]/.test(value));

const settledPeriodSchema = z.object({
  sourceEventId: z.uuid(),
  intentId: z.string().min(1),
  providerInvoiceId: z.string().min(1).max(255),
  providerSubscriptionId: z.string().min(1).max(255),
  providerPaymentId: z.string().nullable(),
  amountDecimal: positiveAmount,
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  settledAt: z.number().int().positive(),
  servicePeriodStart: z.number().int().positive(),
  servicePeriodEnd: z.number().int().positive(),
});

const prepaidPeriodSchema = z.object({
  sourceEventId: z.uuid(),
  intentId: z.string().min(1),
  providerPaymentId: z.string().min(1).max(255),
  amountDecimal: positiveAmount,
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  settledAt: z.number().int().positive(),
  servicePeriodStart: z.number().int().positive(),
  servicePeriodEnd: z.number().int().positive(),
  // Any channel whose capability card says it fulfils a paid period. The name
  // is not a local enum: a new channel must not need a code change here.
  method: z.string().trim().min(1).max(40),
  // `one_time` is the buyout: the centre stamps a far-future period end and the
  // grant never lapses, so every period comparison below keeps working.
  interval: z.enum(['one_time', 'month', 'year']),
});

/**
 * How long a buyout period must run before it counts as permanent. The centre
 * sends year 9999; a short span labelled `one_time` is a centre bug, and
 * refusing it here keeps a month sold as "forever" from becoming a grant.
 */
const PERMANENT_MIN_SECONDS = 100 * 365 * 86_400;

export type SettledPeriod = z.infer<typeof settledPeriodSchema>;
export type PrepaidPeriod = z.infer<typeof prepaidPeriodSchema>;
export class SubscriptionConflict extends Error {}

export async function hasUnexpiredPaidPeriod(organizationId: string, now = new Date()) {
  const [grant] = await db.select({ id: subscriptionGrants.id })
    .from(subscriptionGrants).where(and(
      eq(subscriptionGrants.organizationId, organizationId),
      eq(subscriptionGrants.status, 'active'),
      gt(subscriptionGrants.periodEnd, now),
    )).limit(1);
  return Boolean(grant);
}

function sameMoment(a: Date | null, b: Date | null) {
  return a?.getTime() === b?.getTime();
}

/**
 * The Payment Center derives a prepaid period from the moment of payment, so a
 * buyer who pays again while a period is still running would get a span that
 * overlaps the one already granted (both start "now"). The centre has no way to
 * stitch the two together — it does not own our grant history — so a continuing
 * purchase is stitched here instead: the new period keeps its full length but
 * starts where the workspace's paid access currently ends.
 *
 * This only fires for a genuine overlap. A period that already starts at or
 * after the current end (a Stripe renewal invoice, or a purchase after expiry)
 * is left exactly as the centre issued it. The effective span is written to both
 * the evidence and the grant, so the two rows stay in step for the billing
 * history join.
 */
function continuationPeriod(period: { servicePeriodStart: number; servicePeriodEnd: number },
  lastPeriodEnd: Date | null) {
  const start = period.servicePeriodStart;
  const end = period.servicePeriodEnd;
  if (!lastPeriodEnd) return { start, end };
  const currentEnd = Math.floor(lastPeriodEnd.getTime() / 1000);
  // No overlap: the centre already placed this period in the future.
  if (start >= currentEnd) return { start, end };
  const length = end - start;
  return { start: currentEnd, end: currentEnd + length };
}

async function recomputeSubscription(tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string, now: Date) {
  // The workspace's paid access runs to the end of its latest unexpired grant.
  // A continuation stitches a second grant onto the first (see
  // `continuationPeriod`), so the aggregate must report the *latest* period end,
  // not the one currently in force — a buyer who paid twice sees one month
  // added, not a "current period" that looks unchanged.
  const [current] = await tx.select().from(subscriptionGrants).where(and(
    eq(subscriptionGrants.organizationId, organizationId),
    eq(subscriptionGrants.status, 'active'),
    gt(subscriptionGrants.periodEnd, now),
  )).orderBy(desc(subscriptionGrants.periodEnd)).limit(1);
  const [before] = await tx.select().from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId)).limit(1);
  const next = {
    productCode: current?.productCode || null,
    paymentMethod: current?.paymentMethod || null,
    providerSubscriptionId: current?.providerSubscriptionId || null,
    status: current ? 'active' : 'inactive',
    activeUntil: current?.periodEnd || null,
  };
  if (before && before.productCode === next.productCode &&
      before.paymentMethod === next.paymentMethod &&
      before.providerSubscriptionId === next.providerSubscriptionId &&
      before.status === next.status && sameMoment(before.activeUntil, next.activeUntil)) {
    return before;
  }
  const [updated] = await tx.update(subscriptions).set({
    ...next,
    version: sql`${subscriptions.version} + 1`,
    updatedAt: now,
  }).where(eq(subscriptions.organizationId, organizationId)).returning();
  return updated;
}

function amountUnits(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) {
    throw new SubscriptionConflict('Payment amount is invalid');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

export async function fulfillSubscription(periodInput: SettledPeriod | PrepaidPeriod,
  order: CenterOrder, now = new Date()) {
  const prepaid = 'method' in periodInput;
  const period = prepaid ? prepaidPeriodSchema.parse(periodInput)
    : settledPeriodSchema.parse(periodInput);
  const providerInvoiceId = prepaid ? null : (period as SettledPeriod).providerInvoiceId;
  const providerSubscriptionId = prepaid ? null : (period as SettledPeriod).providerSubscriptionId;
  const providerPaymentId = period.providerPaymentId;
  const prepaidInterval = prepaid ? (period as PrepaidPeriod).interval : null;
  const duration = period.servicePeriodEnd - period.servicePeriodStart;
  if (period.servicePeriodEnd <= period.servicePeriodStart ||
      (prepaidInterval === 'one_time'
        ? duration < PERMANENT_MIN_SECONDS
        : duration > 370 * 24 * 3600)) {
    throw new SubscriptionConflict('Service period is invalid');
  }
  if (period.settledAt > Math.floor(now.getTime() / 1000) + 300) {
    throw new SubscriptionConflict('Settlement time is in the future');
  }
  if (order.status !== 'paid') {
    throw new SubscriptionConflict('Payment Center order is not paid');
  }
  if (prepaid) {
    const proof = period as PrepaidPeriod;
    if (order.kind !== 'one_time' || order.payment_method !== proof.method ||
        order.recurrence_interval !== proof.interval ||
        order.provider_payment_id !== proof.providerPaymentId ||
        proof.servicePeriodStart !== proof.settledAt) {
      throw new SubscriptionConflict('Prepaid payment evidence does not match the paid order');
    }
    // The capability card's `fulfillment` shape is what decides how the centre
    // proves the amount. Derive it from the evidence it published rather than
    // from the channel name, so a new channel reusing a shape works unchanged:
    //   chain_confirmed -> the centre confirmed an on-chain amount
    //   paid_fields     -> the provider reported the asset it actually received
    //   exact           -> the paid amount must equal the quoted amount
    const details = order.payment_details ?? {};
    let proofMatches: boolean;
    if (details.confirmed_amount_decimal !== undefined) {
      proofMatches = details.confirmed_amount_decimal === proof.amountDecimal &&
        amountUnits(proof.amountDecimal) >= amountUnits(order.amount_decimal);
    } else if (details.paid_amount_decimal !== undefined) {
      proofMatches = details.paid_amount_decimal === proof.amountDecimal &&
        details.paid_currency === proof.currency &&
        proof.currency === order.currency &&
        amountUnits(proof.amountDecimal) >= amountUnits(order.amount_decimal);
    } else {
      proofMatches = amountUnits(proof.amountDecimal) === amountUnits(order.amount_decimal);
    }
    if (!proofMatches) {
      throw new SubscriptionConflict('Prepaid payment evidence does not match the paid order');
    }
    const proofDuration = proof.servicePeriodEnd - proof.servicePeriodStart;
    if (proof.interval === 'month' &&
          (proofDuration < 28 * 86_400 || proofDuration > 31 * 86_400) ||
        proof.interval === 'year' &&
          (proofDuration < 365 * 86_400 || proofDuration > 366 * 86_400)) {
      throw new SubscriptionConflict('Prepaid service period has an invalid duration');
    }
  } else if (order.kind !== 'subscription' ||
      order.provider_subscription_id !== providerSubscriptionId) {
    throw new SubscriptionConflict('Subscription evidence does not match the paid order');
  }

  return db.transaction(async (tx) => {
    const [intent] = await tx.select().from(paymentIntents)
      .where(eq(paymentIntents.id, period.intentId)).limit(1);
    // A settlement may be deliberately in a different asset from the catalogue
    // quote (USD priced, a parity stablecoin paid one to one). The order itself
    // is what fixes the accepted asset — `assertOrderMatchesIntent` below checks
    // it against the intent's recorded settlement currency — so accepting both
    // the quote's currency and the order's own is enough and stays generic for
    // any future channel.
    const methodMatches = prepaid
      ? intent?.method === (period as PrepaidPeriod).method
      : intentPaymentAction(intent ?? { method: '' }) === 'redirect';
    if (!intent || !methodMatches ||
        !['one_time', 'month', 'year'].includes(intent.priceInterval) ||
        ![intent.currency, order.currency].includes(period.currency) ||
        (prepaid && intent.priceInterval !== (period as PrepaidPeriod).interval) ||
        (intent.paymentCenterOrderId && intent.paymentCenterOrderId !== order.id)) {
      throw new SubscriptionConflict('Payment intent does not match settled subscription');
    }
    assertOrderMatchesIntent(intent, order);

    if (prepaid && intentPaymentAction(intent) === 'commission_reserved') {
      const [prepared] = await tx.select().from(commissionGrantPreparations)
        .where(eq(commissionGrantPreparations.intentId, intent.id)).limit(1);
      if (!prepared || prepared.centerOrderId !== order.id ||
          prepared.spendId !== providerPaymentId || prepared.status === 'cancelled') {
        throw new SubscriptionConflict('Commission grant was not prepared before payment');
      }
    }

    // All grants for a workspace serialize behind its existing organization row.
    const locked = await tx.execute(sql`SELECT id FROM organization
      WHERE id = ${intent.organizationId} FOR UPDATE`);
    if (!locked.length) throw new SubscriptionConflict('Workspace no longer exists');
    await tx.insert(subscriptions).values({ organizationId: intent.organizationId })
      .onConflictDoNothing({ target: subscriptions.organizationId });

    const evidenceKey = prepaid ? `order:${order.id}` : `invoice:${providerInvoiceId}`;
    const [prior] = await tx.select().from(paymentEvidence).where(and(
      eq(paymentEvidence.websiteId, order.website_id),
      eq(paymentEvidence.evidenceKey, evidenceKey),
    )).limit(1);
    if (prior) {
      if (prior.intentId !== intent.id || prior.centerOrderId !== order.id ||
          prior.amountDecimal !== period.amountDecimal ||
          prior.currency !== period.currency ||
          prior.providerSubscriptionId !== providerSubscriptionId ||
          prior.providerPaymentId !== providerPaymentId ||
          prior.servicePeriodStart.getTime() !== period.servicePeriodStart * 1000 ||
          prior.servicePeriodEnd.getTime() !== period.servicePeriodEnd * 1000) {
        throw new SubscriptionConflict('Invoice evidence was already used differently');
      }
      await tx.update(paymentInbox).set({
        status: 'processed', leaseOwner: null, leaseExpiresAt: null,
        lastErrorCode: null, updatedAt: now,
      }).where(eq(paymentInbox.eventId, period.sourceEventId));
      // A replay grants nothing new, so it supersedes nothing either: whatever
      // subscription this purchase replaced was turned off when the event was
      // first processed.
      return { evidenceId: prior.id, duplicate: true, status: prior.status,
        planSwitched: false };
    }

    // Any purchase made while access is still running continues it, whichever
    // channel pays for it: the centre's period begins at the payment moment, so
    // it would otherwise overlap the period already granted. Only the new span is
    // moved, to start where the workspace's access currently ends.
    //
    // A plan switch is the exception: it was priced at checkout, the remaining
    // paid time exchanged for its new-plan equivalent, so it replaces the running
    // access outright rather than stacking onto it (see `proratedPeriodEnd`).
    const [running] = await tx.select({
      periodEnd: subscriptionGrants.periodEnd,
      productCode: subscriptionGrants.productCode,
    }).from(subscriptionGrants).where(and(
      eq(subscriptionGrants.organizationId, intent.organizationId),
      eq(subscriptionGrants.status, 'active'),
      gt(subscriptionGrants.periodEnd, now),
    )).orderBy(desc(subscriptionGrants.periodEnd)).limit(1);
    // Whether this purchase takes the workspace off the plan it was on. That is
    // what makes an auto-renewing subscription wrong — it pays for a plan nobody
    // is using any more — while stacking more time onto the *same* plan must
    // leave the renewal alone. A priced switch says so through
    // `proratedPeriodEnd`; an unpriced one (see `proratePlanSwitch`) arrives as
    // a plain continuation, so the running plan is compared directly. The caller
    // uses this to decide whether to cancel the superseded subscription.
    //
    // A buyout supersedes every renewal outright: permanent access cannot be
    // topped up by a monthly charge, and leaving the mandate running would bill
    // the buyer for something they already own forever.
    const planSwitched = Boolean(intent.proratedPeriodEnd) ||
      Boolean(running && running.productCode !== intent.productCode) ||
      (prepaid && (period as PrepaidPeriod).interval === 'one_time' && Boolean(running));
    // A plan switch owes the buyer two things at once, and the conversion used to
    // swallow the first: the full period the centre just sold them (the new plan's
    // own month or year) *plus* whatever their old plan's unused time converts
    // into. `proratedPeriodEnd` describes only the converted slice — checkout
    // prices it as `settledAt + convertedDays` (see `proratePlanSwitch`) — so it
    // is added to the centre's period, never substituted for it. Reading it as the
    // final end date is what made a 60-day Starter buyer pay for Pro and receive
    // 17 days.
    const convertedSeconds = intent.proratedPeriodEnd
      ? Math.floor(intent.proratedPeriodEnd.getTime() / 1000) - Math.floor(period.settledAt)
      : 0;
    const span = intent.proratedPeriodEnd
      ? { start: period.servicePeriodStart, end: period.servicePeriodEnd + convertedSeconds }
      : continuationPeriod(period, running?.periodEnd ?? null);
    const periodStart = new Date(span.start * 1000);
    const periodEnd = new Date(span.end * 1000);
    // A prepaid purchase may not overlap access that is already granted — that
    // would be paying twice for the same time. A plan switch is the exception:
    // the running grants it would collide with are the very ones it is about to
    // reverse (below), their unused time having been converted into this span.
    if (prepaid && !intent.proratedPeriodEnd) {
      const [overlap] = await tx.select({ id: subscriptionGrants.id })
        .from(subscriptionGrants).where(and(
          eq(subscriptionGrants.organizationId, intent.organizationId),
          eq(subscriptionGrants.status, 'active'),
          lt(subscriptionGrants.periodStart, periodEnd),
          gt(subscriptionGrants.periodEnd, periodStart),
        )).limit(1);
      if (overlap) throw new SubscriptionConflict('Workspace already has a paid period');
    }
    // The exact same span must never be granted twice, whichever subscription
    // it arrives under. A continuation is moved off the running period first, so
    // it only collides here when the centre really did send a duplicate period.
    const [samePeriod] = await tx.select({ id: subscriptionGrants.id })
      .from(subscriptionGrants).where(and(
        eq(subscriptionGrants.organizationId, intent.organizationId),
        eq(subscriptionGrants.status, 'active'),
        eq(subscriptionGrants.periodStart, periodStart),
        eq(subscriptionGrants.periodEnd, periodEnd),
      )).limit(1);
    if (samePeriod) throw new SubscriptionConflict('Another invoice already granted this period');

    // A plan switch consumes the running access: the old plan's remaining time is
    // exchanged for the new plan's equivalent, so the superseded grants close now
    // instead of stacking with the new one. Only the new grant stays active.
    if (intent.proratedPeriodEnd) {
      await tx.update(subscriptionGrants).set({ status: 'reversed', reversedAt: now })
        .where(and(
          eq(subscriptionGrants.organizationId, intent.organizationId),
          eq(subscriptionGrants.status, 'active'),
          gt(subscriptionGrants.periodEnd, now),
        ));
    }

    const evidenceId = `pe_${randomUUID().replaceAll('-', '')}`;
    await tx.insert(paymentEvidence).values({
      id: evidenceId,
      websiteId: order.website_id,
      organizationId: intent.organizationId,
      intentId: intent.id,
      evidenceKey,
      sourceEventId: period.sourceEventId,
      centerOrderId: order.id,
      providerSubscriptionId,
      providerInvoiceId,
      providerPaymentId,
      amountDecimal: period.amountDecimal,
      currency: period.currency,
      settledAt: new Date(period.settledAt * 1000),
      servicePeriodStart: periodStart,
      servicePeriodEnd: periodEnd,
    });
    await tx.insert(subscriptionGrants).values({
      id: `sg_${randomUUID().replaceAll('-', '')}`,
      organizationId: intent.organizationId,
      evidenceId,
      productCode: intent.productCode,
      paymentMethod: intent.method,
      providerSubscriptionId,
      periodStart,
      periodEnd,
    });
    await tx.update(paymentIntents).set({
      status: 'settled', paymentCenterOrderId: order.id, updatedAt: now,
    }).where(eq(paymentIntents.id, intent.id));
    await tx.update(paymentInbox).set({
      status: 'processed', leaseOwner: null, leaseExpiresAt: null,
      lastErrorCode: null, updatedAt: now,
    }).where(eq(paymentInbox.eventId, period.sourceEventId));
    const aggregate = await recomputeSubscription(tx, intent.organizationId, now);
    return { evidenceId, duplicate: false, status: 'settled' as const,
      subscription: aggregate, planSwitched };
  });
}

export async function reverseSubscriptionGrant(websiteId: string, evidenceKey: string,
  reversalEventId: string, now = new Date(), expected?: {
    intentId: string; centerOrderId: string; providerPaymentId: string;
    amountDecimal: string; currency: string;
  }) {
  if (!z.uuid().safeParse(reversalEventId).success) {
    throw new SubscriptionConflict('Reversal event ID is invalid');
  }
  return db.transaction(async (tx) => {
    const [found] = await tx.select().from(paymentEvidence).where(and(
      eq(paymentEvidence.websiteId, websiteId),
      eq(paymentEvidence.evidenceKey, evidenceKey),
    )).limit(1);
    if (!found) throw new SubscriptionConflict('Original payment evidence is missing');
    await tx.execute(sql`SELECT id FROM organization
      WHERE id = ${found.organizationId} FOR UPDATE`);
    const [evidence] = await tx.select().from(paymentEvidence)
      .where(eq(paymentEvidence.id, found.id)).limit(1);
    if (!evidence) throw new SubscriptionConflict('Original payment evidence is missing');
    if (expected && (evidence.intentId !== expected.intentId ||
        evidence.centerOrderId !== expected.centerOrderId ||
        evidence.providerPaymentId !== expected.providerPaymentId ||
        evidence.amountDecimal !== expected.amountDecimal ||
        evidence.currency !== expected.currency)) {
      throw new SubscriptionConflict('Refund does not match the original invoice payment');
    }
    if (evidence.status === 'reversed') {
      if (evidence.reversedByEventId !== reversalEventId) {
        throw new SubscriptionConflict('Payment was reversed by a different event');
      }
      await tx.update(paymentInbox).set({
        status: 'processed', leaseOwner: null, leaseExpiresAt: null,
        lastErrorCode: null, updatedAt: now,
      }).where(eq(paymentInbox.eventId, reversalEventId));
      return { evidenceId: evidence.id, duplicate: true };
    }
    await tx.update(paymentEvidence).set({
      status: 'reversed', reversedByEventId: reversalEventId, updatedAt: now,
    }).where(eq(paymentEvidence.id, evidence.id));
    await tx.update(subscriptionGrants).set({ status: 'reversed', reversedAt: now })
      .where(eq(subscriptionGrants.evidenceId, evidence.id));
    await tx.update(paymentInbox).set({
      status: 'processed', leaseOwner: null, leaseExpiresAt: null,
      lastErrorCode: null, updatedAt: now,
    }).where(eq(paymentInbox.eventId, reversalEventId));
    const aggregate = await recomputeSubscription(tx, evidence.organizationId, now);
    return { evidenceId: evidence.id, duplicate: false, subscription: aggregate };
  });
}

export async function refreshWorkspaceSubscription(organizationId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`SELECT id FROM organization
      WHERE id = ${organizationId} FOR UPDATE`);
    if (!locked.length) throw new SubscriptionConflict('Workspace no longer exists');
    await tx.insert(subscriptions).values({ organizationId })
      .onConflictDoNothing({ target: subscriptions.organizationId });
    return recomputeSubscription(tx, organizationId, now);
  });
}

export async function refreshDueSubscriptions(limit = 100, now = new Date()) {
  const due = await client<{ organization_id: string }[]>`
    SELECT organization_id FROM (
      SELECT grants.organization_id
      FROM subscription_grants AS grants
      LEFT JOIN subscriptions AS current
        ON current.organization_id = grants.organization_id
      WHERE grants.status = 'active'
        AND grants.period_start <= ${now.toISOString()}::timestamptz
        AND grants.period_end > ${now.toISOString()}::timestamptz
        AND (current.status IS NULL OR current.status <> 'active'
          OR current.active_until IS NULL
          OR current.active_until < grants.period_end)
      UNION
      SELECT organization_id FROM subscriptions
      WHERE status = 'active'
        AND active_until <= ${now.toISOString()}::timestamptz
    ) AS due
    ORDER BY organization_id
    LIMIT ${Math.max(1, Math.min(limit, 1_000))}
  `;
  for (const row of due) {
    await refreshWorkspaceSubscription(row.organization_id, now);
  }
  return due.length;
}
