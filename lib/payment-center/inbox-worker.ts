import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireCapability } from '@/lib/config';
import { client, db } from '@/lib/db/drizzle';
import { paymentIntents } from '@/lib/db/integration-schema';
import { and, eq, inArray } from 'drizzle-orm';
import { fulfillSubscription, reverseSubscriptionGrant, SubscriptionConflict } from '@/lib/subscription/service';
import { settleReferralReversal } from '@/lib/referrals/reversal';
import { cancelSupersededAutoRenew } from '@/lib/billing/subscription-controls';
import { logObservation } from '@/lib/observability/logger';
import { queryCenterEvent } from './events';
import {
  assertOrderMatchesIntent, intentPaymentAction, queryCenterCommission, queryCenterOrder,
} from './orders';

type Job = {
  event_id: string;
  event_type: string;
  center_order_id: string;
  external_order_id: string;
  website_id: string;
  attempt_count: number;
};

type Outcome = 'processed' | 'retried' | 'manualReview';

const periodSchema = z.object({
  contract_version: z.literal(1),
  evidence_complete: z.literal(true),
  provider_invoice_id: z.string().min(1),
  provider_subscription_id: z.string().min(1),
  provider_payment_id: z.string().nullable(),
  amount_paid_decimal: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  settled_at: z.number().int().positive(),
  service_period_start: z.number().int().positive(),
  service_period_end: z.number().int().positive(),
});

const prepaidSchema = z.object({
  contract_version: z.literal(1),
  evidence_complete: z.literal(true),
  // Any non-subscription channel the catalogue enabled. Not an enum: a new
  // channel reusing the prepaid evidence shape must not need a code change.
  payment_method: z.string().trim().min(1).max(40),
  // `one_time` is the buyout: the centre stamps a permanent period end for it.
  recurrence_interval: z.enum(['one_time', 'month', 'year']),
  provider_payment_id: z.string().min(1),
  amount_paid_decimal: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  settled_at: z.number().int().positive(),
  service_period_start: z.number().int().positive(),
  service_period_end: z.number().int().positive(),
});

const fullRefundSchema = z.object({
  contract_version: z.literal(1),
  evidence_complete: z.literal(true),
  provider_invoice_id: z.string().min(1),
  provider_payment_id: z.string().min(1),
  amount_refunded_decimal: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  currency: z.string().regex(/^[A-Z]{3,10}$/),
});

const lostDisputeSchema = z.object({
  contract_version: z.literal(1),
  evidence_complete: z.literal(true),
  provider_invoice_id: z.string().min(1),
  provider_payment_id: z.string().min(1),
  amount_disputed_decimal: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  dispute_status: z.literal('lost'),
});

const commissionRefundSchema = z.object({
  provider_payment_id: z.string().min(1),
  amount_refunded_decimal: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  original_event_id: z.string().min(1),
});

export type PaymentInboxReport = {
  claimed: number;
  processed: number;
  retried: number;
  manualReview: number;
};

/**
 * Claims one due row. `eventIds` scopes the claim to specific deliveries: the
 * callback fast path processes exactly what it just received, and never touches
 * a row the queue parked as quarantined or awaiting human review.
 */
async function claimNext(owner: string, eventIds?: string[]): Promise<Job | null> {
  const scoped = eventIds !== undefined && eventIds.length > 0;
  return client.begin(async (tx) => {
    const [job] = scoped
      ? await tx<Job[]>`
          SELECT event_id, event_type, center_order_id, external_order_id,
                 website_id, attempt_count
          FROM payment_inbox
          WHERE event_id = ANY(${eventIds}::text[])
            AND status = 'pending' AND available_at <= now()
          ORDER BY received_at, event_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `
      : await tx<Job[]>`
          SELECT event_id, event_type, center_order_id, external_order_id,
                 website_id, attempt_count
          FROM payment_inbox
          WHERE ((status IN ('pending', 'quarantined') AND available_at <= now()) OR
                 (status = 'processing' AND lease_expires_at <= now()))
          ORDER BY received_at, event_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
    if (!job) return null;
    await tx`
      UPDATE payment_inbox
      SET status = 'processing', lease_owner = ${owner},
          lease_expires_at = now() + interval '30 seconds',
          attempt_count = attempt_count + 1, updated_at = now()
      WHERE event_id = ${job.event_id}
    `;
    return job;
  });
}

function retryDelayMs(attempt: number) {
  return Math.min(5_000 * 2 ** Math.min(attempt - 1, 8), 3_600_000)
    + Math.floor(Math.random() * 2_000);
}

async function settle(job: Job, owner: string, outcome: Exclude<Outcome, 'processed'>,
  code: string) {
  const status = outcome === 'retried' ? 'pending' : 'manual_review';
  const next = new Date(Date.now() + retryDelayMs(job.attempt_count + 1));
  await client`
    UPDATE payment_inbox
    SET status = ${status}::payment_inbox_status,
        available_at = ${next.toISOString()}::timestamptz,
        lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = ${code}, updated_at = now()
    WHERE event_id = ${job.event_id}
      AND status = 'processing' AND lease_owner = ${owner}
  `;
  // Every deferred or abandoned event is reported with its business identity,
  // its task identity, the attempt count and the sanitized code, so an operator
  // can follow one order through the retry history.
  logObservation({
    event: 'payment.inbox',
    module: 'payment-center',
    level: 'warn',
    status: outcome === 'retried' ? 'retried' : 'manual_review',
    businessId: job.external_order_id,
    taskId: job.event_id,
    retryCount: job.attempt_count + 1,
    maskedErrorCode: code,
  });
}

async function manualReview(job: Job, owner: string, code: string): Promise<Outcome> {
  await settle(job, owner, 'manualReview', code);
  return 'manualReview';
}

async function retry(job: Job, owner: string, code: string): Promise<Outcome> {
  if (job.attempt_count + 1 >= 8) return manualReview(job, owner, code);
  await settle(job, owner, 'retried', code);
  return 'retried';
}

/** True when this order's fulfilment event has already been committed. */
async function periodAlreadyGranted(job: Job) {
  const [row] = await client<{ event_id: string }[]>`
    SELECT event_id FROM payment_inbox
    WHERE center_order_id = ${job.center_order_id}
      AND event_type = 'subscription.period_paid' AND status = 'processed'
    LIMIT 1
  `;
  return Boolean(row);
}

/**
 * Closes a recognised notification without touching any grant. Only the event
 * that carries the evidence writes business state; a notification that repeats
 * it must not leave a manual-review row behind.
 */
async function markProcessed(job: Job, owner: string): Promise<Outcome> {
  await client`
    UPDATE payment_inbox
    SET status = 'processed'::payment_inbox_status,
        lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = NULL, updated_at = now()
    WHERE event_id = ${job.event_id}
      AND status = 'processing' AND lease_owner = ${owner}
  `;
  return 'processed';
}

async function processJob(job: Job, owner: string, send: typeof fetch): Promise<Outcome> {
  try {
    const event = await queryCenterEvent(job.event_id, send);
    if (!event) return retry(job, owner, 'event_not_found');
    if (event.type !== job.event_type ||
        event.data.order.id !== job.center_order_id ||
        event.data.order.external_order_id !== job.external_order_id ||
        event.data.order.website_id !== job.website_id) {
      return manualReview(job, owner, 'event_identity_mismatch');
    }
    const [intent] = await db.select().from(paymentIntents)
      .where(eq(paymentIntents.externalOrderId, job.external_order_id)).limit(1);
    if (!intent) return retry(job, owner, 'intent_not_found');
    try {
      assertOrderMatchesIntent(intent, event.data.order);
    } catch {
      return manualReview(job, owner, 'event_order_intent_mismatch');
    }
    const order = await queryCenterOrder(job.external_order_id, send);
    if (!order) return retry(job, owner, 'order_not_found');
    if (order.id !== job.center_order_id) {
      return manualReview(job, owner, 'order_identity_mismatch');
    }
    try {
      assertOrderMatchesIntent(intent, order);
    } catch {
      return manualReview(job, owner, 'order_intent_mismatch');
    }
    if (event.type === 'payment.refunded' &&
        intentPaymentAction(intent) === 'commission_reserved') {
      const refund = commissionRefundSchema.safeParse(event.data);
      if (!refund.success || order.status !== 'refunded' ||
          refund.data.provider_payment_id !== `PC_${order.id}` ||
          refund.data.amount_refunded_decimal !== order.amount_decimal ||
          refund.data.currency !== order.currency) {
        return manualReview(job, owner, 'commission_refund_mismatch');
      }
      const spend = await queryCenterCommission(intent.externalOrderId, send);
      if (spend.spend_status !== 'cancelled' || spend.order.id !== order.id) {
        return manualReview(job, owner, 'commission_refund_unverified');
      }
      try {
        await reverseSubscriptionGrant(job.website_id, `order:${order.id}`,
          job.event_id, new Date(), {
            intentId: intent.id, centerOrderId: order.id,
            providerPaymentId: refund.data.provider_payment_id,
            amountDecimal: refund.data.amount_refunded_decimal,
            currency: refund.data.currency,
          });
        return 'processed';
      } catch (error) {
        if (error instanceof SubscriptionConflict) {
          return manualReview(job, owner, 'commission_refund_grant_conflict');
        }
        throw error;
      }
    }
    // A one-time order carries its own paid-period evidence, whatever channel
    // funded it. Deriving this from the order kind keeps a new channel on the
    // same path without listing its name here.
    if (event.type === 'payment.succeeded' && order.kind === 'one_time') {
      const prepaid = prepaidSchema.safeParse(event.data);
      if (!prepaid.success || prepaid.data.payment_method !== intent.method) {
        return manualReview(job, owner, 'prepaid_evidence_incomplete');
      }
      if (order.status !== 'paid') {
        return order.status === 'pending' || order.status === 'action_required'
          ? retry(job, owner, 'order_not_settled')
          : manualReview(job, owner, 'order_not_payable');
      }
      try {
        const granted = await fulfillSubscription({
          sourceEventId: job.event_id,
          intentId: intent.id,
          providerPaymentId: prepaid.data.provider_payment_id,
          amountDecimal: prepaid.data.amount_paid_decimal,
          currency: prepaid.data.currency,
          settledAt: prepaid.data.settled_at,
          servicePeriodStart: prepaid.data.service_period_start,
          servicePeriodEnd: prepaid.data.service_period_end,
          method: prepaid.data.payment_method,
          interval: prepaid.data.recurrence_interval,
        }, order);
        // Paying for a different plan by crypto, manual transfer or commission
        // balance leaves the buyer without the subscription they were on — a
        // Stripe mandate paying for a plan nobody uses any more, with no way to
        // turn it off from the new one. A prepaid order has no subscription of
        // its own, so there is nothing to keep and every live one is superseded.
        // A same-plan top-up is the opposite case and is deliberately not
        // cancelled: the buyer was told at checkout that Stripe keeps renewing
        // and their access grows. `planSwitched` tells the two apart.
        if (granted.planSwitched) {
          await cancelSupersededAutoRenew(intent.organizationId, null, send).catch(() => []);
        }
        return 'processed';
      } catch (error) {
        if (error instanceof SubscriptionConflict || error instanceof z.ZodError) {
          return manualReview(job, owner, 'prepaid_grant_conflict');
        }
        throw error;
      }
    }
    if (event.type === 'subscription.period_refunded' ||
        event.type === 'subscription.period_disputed') {
      const reversal = event.type === 'subscription.period_refunded'
        ? fullRefundSchema.safeParse(event.data)
        : lostDisputeSchema.safeParse(event.data);
      if (!reversal.success) return manualReview(job, owner, 'reversal_evidence_incomplete');
      const evidence = reversal.data;
      const amount = 'amount_refunded_decimal' in evidence
        ? evidence.amount_refunded_decimal : evidence.amount_disputed_decimal;
      try {
        await reverseSubscriptionGrant(job.website_id,
          `invoice:${evidence.provider_invoice_id}`, job.event_id, new Date(), {
            intentId: intent.id,
            centerOrderId: job.center_order_id,
            providerPaymentId: evidence.provider_payment_id,
            amountDecimal: amount,
            currency: evidence.currency,
          });
        // The centre books the earning against our order id when it settles
        // the payment itself, so the reversal has to name the same id — its
        // own `external_order_id` is this intent's.
        await settleReferralReversal({
          payerUserId: intent.payerUserId,
          method: intent.method,
          externalEventId: intent.externalOrderId,
          sourceEventId: job.event_id,
          providerPaymentId: evidence.provider_payment_id,
          reason: event.type === 'subscription.period_disputed' ? 'dispute_lost' : 'stripe_refund',
        }, send);
        return 'processed';
      } catch (error) {
        if (error instanceof SubscriptionConflict || error instanceof z.ZodError) {
          return manualReview(job, owner, 'reversal_grant_conflict');
        }
        throw error;
      }
    }
    if (event.type === 'payment.succeeded' && order.kind === 'subscription') {
      // A subscription payment notification carries no fulfilment payload: the
      // centre issues prepaid evidence only for one-time orders, and a
      // subscription is granted by `subscription.period_paid` (it carries the
      // invoice and subscription ids). Recognise the notification
      // instead of raising a manual review, and keep waiting while the period
      // event is still in flight so a genuinely missing fulfilment still surfaces.
      if (!await periodAlreadyGranted(job)) return retry(job, owner, 'awaiting_period_event');
      return markProcessed(job, owner);
    }
    if (event.type === 'payment.expired') {
      // The centre has retired this order: a card checkout page timed out, a
      // blockchain amount lock lapsed, or a manual or commission reservation was
      // released. Nobody can pay it any more, so an intent left open here would
      // keep showing a purchase that can never complete — and, now that the
      // open-order lock is per channel, it would hold that channel's slot
      // against the customer's very next attempt.
      if (order.status !== 'expired') {
        // The centre emits this only once an order is genuinely unpayable, so a
        // live order means the two sides disagree. Never act on a contradiction.
        return manualReview(job, owner, 'order_expired_unverified');
      }
      // Only the open statuses are closed. A settled intent keeps its grant: an
      // expiry notice must never take away access that was already paid for.
      await db.update(paymentIntents).set({
        status: 'failed',
        lastErrorCode: 'order_expired',
        submissionLeaseExpiresAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(paymentIntents.id, intent.id),
        inArray(paymentIntents.status, ['submitting', 'action_required', 'unknown']),
      ));
      return markProcessed(job, owner);
    }
    if (event.type !== 'subscription.period_paid') {
      return manualReview(job, owner, 'event_contract_not_ready');
    }
    const period = periodSchema.safeParse(event.data);
    if (!period.success) return manualReview(job, owner, 'period_evidence_incomplete');
    if (order.status !== 'paid') {
      return order.status === 'pending' || order.status === 'action_required'
        ? retry(job, owner, 'order_not_settled')
        : manualReview(job, owner, 'order_not_payable');
    }
    try {
      await fulfillSubscription({
        sourceEventId: job.event_id,
        intentId: intent.id,
        providerInvoiceId: period.data.provider_invoice_id,
        providerSubscriptionId: period.data.provider_subscription_id,
        providerPaymentId: period.data.provider_payment_id,
        amountDecimal: period.data.amount_paid_decimal,
        currency: period.data.currency,
        settledAt: period.data.settled_at,
        servicePeriodStart: period.data.service_period_start,
        servicePeriodEnd: period.data.service_period_end,
      }, order);
      // A fresh Stripe purchase supersedes any earlier subscription's renewal:
      // the old period is honoured but must stop billing in parallel. This never
      // fails the grant — the money is taken and access is already granted.
      await cancelSupersededAutoRenew(intent.organizationId,
        period.data.provider_subscription_id, send).catch(() => []);
      return 'processed';
    } catch (error) {
      if (error instanceof SubscriptionConflict || error instanceof z.ZodError) {
        return manualReview(job, owner, 'grant_conflict');
      }
      throw error;
    }
  } catch {
    return retry(job, owner, 'center_or_database_unavailable');
  }
}

export async function runPaymentInbox(options: {
  maxJobs?: number;
  maxMillis?: number;
  send?: typeof fetch;
  /** Restricts the drain to specific deliveries (the callback fast path). */
  eventIds?: string[];
} = {}): Promise<PaymentInboxReport> {
  requireCapability('paymentCenter');
  const report: PaymentInboxReport = {
    claimed: 0, processed: 0, retried: 0, manualReview: 0,
  };
  const owner = randomUUID();
  const startedAt = Date.now();
  const deadline = startedAt + (options.maxMillis ?? 20_000);
  for (let i = 0; i < (options.maxJobs ?? 25) && Date.now() < deadline; i++) {
    const job = await claimNext(owner, options.eventIds);
    if (!job) break;
    report.claimed++;
    const outcome = await processJob(job, owner, options.send ?? fetch);
    report[outcome]++;
    if (outcome === 'processed') {
      logObservation({
        event: 'payment.inbox',
        module: 'payment-center',
        code: 'OK',
        status: 'processed',
        businessId: job.external_order_id,
        taskId: job.event_id,
        retryCount: job.attempt_count,
      });
    }
  }
  logObservation({
    event: 'payment.inbox',
    module: 'payment-center',
    code: 'OK',
    count: report.processed,
    retryCount: report.retried,
    durationMs: Date.now() - startedAt,
  });
  return report;
}
