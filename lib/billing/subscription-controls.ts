import 'server-only';
import { and, desc, eq, gt, isNotNull, ne, or } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { member } from '@/lib/db/auth-schema';
import {
  billingAccounts, paymentEvidence, paymentIntents, subscriptionGrants,
} from '@/lib/db/integration-schema';
import { setCenterAutoRenew } from '@/lib/payment-center/subscriptions';
import { BillingAccessError } from './account';

export async function getAuthorizedStripeSubscription(organizationId: string, actorUserId: string) {
  const [membership] = await db.select({ role: member.role }).from(member).where(and(
    eq(member.organizationId, organizationId), eq(member.userId, actorUserId),
  )).limit(1);
  if (membership?.role !== 'owner') {
    throw new BillingAccessError('Personal billing requires the account owner');
  }

  const now = new Date();
  // Read the grant directly instead of going through the `subscriptions`
  // aggregate. That row mirrors only the *latest* unexpired grant, so a workspace
  // whose newest purchase came from a prepaid channel reports
  // `paymentMethod: 'blockchain'` and a null `providerSubscriptionId` — and a join
  // on those two columns silently stops finding a Stripe subscription that is
  // still very much charging every month.
  const [binding] = await db.select({
    accountId: billingAccounts.externalBillingId,
    providerSubscriptionId: subscriptionGrants.providerSubscriptionId,
    centerOrderId: paymentIntents.paymentCenterOrderId,
    periodEnd: subscriptionGrants.periodEnd,
    productCode: subscriptionGrants.productCode,
  }).from(subscriptionGrants)
    .innerJoin(paymentEvidence, eq(paymentEvidence.id, subscriptionGrants.evidenceId))
    .innerJoin(paymentIntents, eq(paymentIntents.id, paymentEvidence.intentId))
    .innerJoin(billingAccounts, eq(billingAccounts.id, paymentIntents.billingAccountId))
    .where(and(
      eq(subscriptionGrants.organizationId, organizationId),
      eq(billingAccounts.organizationId, organizationId),
      eq(billingAccounts.originalPayerUserId, actorUserId),
      eq(paymentIntents.payerUserId, actorUserId),
      eq(paymentIntents.organizationId, organizationId),
      eq(paymentEvidence.status, 'settled'),
      eq(paymentEvidence.centerOrderId, paymentIntents.paymentCenterOrderId),
      eq(subscriptionGrants.status, 'active'),
      eq(subscriptionGrants.paymentMethod, 'stripe'),
      isNotNull(subscriptionGrants.providerSubscriptionId),
      // "Still charging" is *unexpired*, not "running right now": once a prepaid
      // top-up has pushed the newest Stripe grant into the future, its
      // `periodStart` is ahead of `now` and a liveness filter would hide it.
      gt(subscriptionGrants.periodEnd, now),
    )).orderBy(desc(subscriptionGrants.periodEnd)).limit(1);
  if (!binding?.providerSubscriptionId || !binding.centerOrderId) return null;
  return {
    accountId: binding.accountId,
    providerSubscriptionId: binding.providerSubscriptionId,
    centerOrderId: binding.centerOrderId,
    periodEnd: binding.periodEnd,
    productCode: binding.productCode,
  };
}

/**
 * Turns off auto-renewal on the workspace's *other* live Stripe subscriptions.
 *
 * A buyer who pays again from the pricing page makes Payment Center open a new
 * Stripe subscription, and the new grant is stitched onto the running period.
 * The old subscription's already-paid period is honoured, but it must not keep
 * charging every month in parallel — that is the double-billing this closes.
 *
 * The superseded subscription comes in two shapes, and both must be found:
 * a same-plan repurchase leaves the old grant `active` (its time is continued,
 * see `continuationPeriod`), while a plan switch reverses the old grant at
 * fulfilment — *before* this runs — so its status no longer says "active". A
 * reversed grant whose period has not yet run out is exactly an old
 * subscription that was superseded mid-period and must still be turned off;
 * matching on status alone would silently skip every plan switch. A reversed
 * grant whose period has already elapsed is left alone, so history never
 * accumulates into repeated no-op calls.
 *
 * `keepProviderSubscriptionId` is null when the superseding purchase has no
 * subscription of its own — a plan switch paid for by a prepaid channel. Nothing
 * is kept in that case: every live Stripe subscription belongs to the plan the
 * buyer just left behind. (It is *not* null for a same-plan prepaid top-up,
 * which deliberately leaves Stripe renewing; the caller decides whether to call
 * this at all.)
 *
 * Best effort by design: the new subscription is already paid and granted, so a
 * failure to reach the centre must not undo any of that. It is retried on the
 * next period event instead.
 */
export async function cancelSupersededAutoRenew(organizationId: string,
  keepProviderSubscriptionId: string | null, send: typeof fetch = fetch,
  now = new Date()) {
  const rows = await db.selectDistinct({
    accountId: billingAccounts.externalBillingId,
    providerSubscriptionId: subscriptionGrants.providerSubscriptionId,
  }).from(subscriptionGrants)
    .innerJoin(billingAccounts, eq(billingAccounts.organizationId, subscriptionGrants.organizationId))
    .where(and(
      eq(subscriptionGrants.organizationId, organizationId),
      // Any channel that produced a provider subscription can keep billing in
      // parallel. Naming Stripe here would leave a channel enabled later
      // renewing silently after the buyer moved on.
      or(
        eq(subscriptionGrants.status, 'active'),
        and(eq(subscriptionGrants.status, 'reversed'),
          gt(subscriptionGrants.periodEnd, now)),
      ),
      isNotNull(subscriptionGrants.providerSubscriptionId),
      // Spelled out as a conditional rather than `ne(...)` over a nullable value:
      // `x <> NULL` is NULL in SQL, which would filter out every row — the exact
      // opposite of "keep none".
      ...(keepProviderSubscriptionId
        ? [ne(subscriptionGrants.providerSubscriptionId, keepProviderSubscriptionId)]
        : []),
    ));
  const cancelled: string[] = [];
  for (const row of rows) {
    if (!row.providerSubscriptionId) continue;
    try {
      const result = await setCenterAutoRenew(row.accountId, row.providerSubscriptionId, false, send);
      if (result.cancel_at_period_end) cancelled.push(row.providerSubscriptionId);
    } catch {
      // Best effort: the grant stands, the old subscription is retried later.
    }
  }
  return cancelled;
}
