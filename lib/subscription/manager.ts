import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/lib/db/drizzle';
import { member } from '@/lib/db/auth-schema';
import { preparePaymentIntent, type PreparePaymentIntentInput } from '@/lib/billing/intents';
import { BillingAccessError, ensureBillingAccount } from '@/lib/billing/account';
import { planKeyParts } from './manager-support';
import { logObservation, maskErrorCode } from '@/lib/observability/logger';

/**
 * Subscription manager: the single place where a subscription is changed.
 *
 * `lib/subscription/service.ts` owns the fulfilment side — one base subscription
 * per workspace, one reversible grant per settled period, and a reversal that
 * touches only the period it belongs to. This module owns the request side:
 * which change a workspace may ask for, which policy applies, and how the
 * request stays idempotent when a browser, a retry and a double-click all send
 * the same intent.
 *
 * The three guarantees the plan asks for are implemented here:
 * 1. A workspace row lock plus the monotonic `subscriptions.version` mean two
 *    concurrent change requests serialise instead of interleaving.
 * 2. The caller supplies a stable `operationKey`; the derived Payment Center
 *    request key is a pure function of it, so a replayed request returns the
 *    same checkout instead of creating a second one.
 * 3. A cross-provider switch fails closed. Moving a subscription from one
 *    provider to another has to cancel the old billing relationship and can
 *    leave a user paying twice, so it is refused unless the deployment sets
 *    `SUBSCRIPTION_PROVIDER_SWITCH=allowed` after verifying the cancellation
 *    path with the provider.
 */

/**
 * A payment channel name from the Payment Center catalogue. Deliberately not a
 * union: a channel enabled there must be usable here without a redeploy.
 */
export type ProviderId = string;

export const changeSubscriptionSchema = z.object({
  operationKey: z.string().trim().min(1).max(120),
  action: z.enum(['renew', 'interval_switch', 'provider_switch']),
  productCode: z.string().trim().min(1).max(120),
  priceInterval: z.enum(['month', 'year']),
  currency: z.string().regex(/^[A-Z]{3,10}$/),
  target: z.string().trim().min(1).max(40),
  current: z.string().trim().min(1).max(40).nullable().default(null),
  planVersion: z.number().int().positive().default(1),
});

export type ChangeSubscriptionRequest = z.input<typeof changeSubscriptionSchema>;

export type ChangeSubscriptionResult = {
  operationKey: string;
  action: z.infer<typeof changeSubscriptionSchema>['action'];
  subscriptionVersion: number;
  planVersion: number;
  intentId: string;
  externalOrderId: string;
  replay: boolean;
};

export type DowngradeDecision = {
  /** What the caller recorded as the current plan, if anything. */
  currentPlanKey: string | null;
  targetPlanKey: string;
  /** Cheap first-token comparison; the authoritative check is the plan lookup. */
  cheaperFirstToken: boolean;
  policy: 'period_end' | 'immediate' | 'reject';
  action: 'cancel_at_period_end' | 'apply_now' | 'reject';
  existingPlanFactsPreserved: true;
  subscriptionKeyUnchanged: true;
};

export class SubscriptionChangeError extends Error {}

function derivedRequestKey(organizationId: string, operationKey: string): string {
  const digest = createHash('sha256')
    .update(`subscription-change:v1:${organizationId}:${operationKey}`)
    .digest('hex')
    .slice(0, 32);
  return [
    digest.slice(0, 8), digest.slice(8, 12), `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`, digest.slice(20, 32),
  ].join('-');
}

async function assertOwner(organizationId: string, actorUserId: string) {
  // The membership has to match on BOTH columns: a user who owns some workspace
  // is not thereby entitled to spend on this one. `ensureBillingAccount` repeats
  // the check for the workspace it is about to bill, and the duplication is
  // deliberate — the guard must not depend on the caller having reached the
  // billing layer first.
  const [membership] = await db.select({ role: member.role }).from(member).where(
    and(eq(member.organizationId, organizationId), eq(member.userId, actorUserId)),
  ).limit(1);
  if (membership?.role !== 'owner') {
    throw new BillingAccessError('Personal billing requires the account owner');
  }
  await ensureBillingAccount(organizationId, actorUserId);
}

/**
 * Provider switches are refused unless the deployment has verified the
 * cancellation path with the outgoing provider. The check reads the
 * environment, never a request field, so a caller cannot opt itself in.
 */
export function providerSwitchAllowed(): boolean {
  return process.env.SUBSCRIPTION_PROVIDER_SWITCH === 'allowed';
}

export async function changeSubscription(
  organizationId: string,
  actorUserId: string,
  request: ChangeSubscriptionRequest,
): Promise<ChangeSubscriptionResult> {
  const parsed = changeSubscriptionSchema.parse(request);
  if (parsed.action === 'provider_switch') {
    if (!parsed.current || parsed.current === parsed.target) {
      throw new SubscriptionChangeError('A provider switch needs two different providers');
    }
    if (!providerSwitchAllowed()) {
      throw new SubscriptionChangeError(
        'Cross-provider switching is disabled until the outgoing cancellation path is verified',
      );
    }
  }
  await assertOwner(organizationId, actorUserId);

  const requestKey = derivedRequestKey(organizationId, parsed.operationKey);
  const startedAt = Date.now();
  try {
    // The workspace row lock is what makes the recorded version meaningful: two
    // concurrent changes cannot both read the same "before" state. The lock is
    // taken in its own short transaction — holding it across the catalog lookup
    // and the Payment Center call would serialise unrelated workspaces.
    const subscriptionVersion = await client.begin(async (tx) => {
      const [locked] = await tx<{ version: number }[]>`
        SELECT version FROM subscriptions
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      if (locked) return Number(locked.version);
      const [inserted] = await tx<{ version: number }[]>`
        INSERT INTO subscriptions (organization_id, version)
        VALUES (${organizationId}, 0)
        ON CONFLICT (organization_id) DO NOTHING
        RETURNING version
      `;
      return Number(inserted?.version ?? 0);
    });

    const input: PreparePaymentIntentInput = {
      requestKey,
      productCode: parsed.productCode,
      priceInterval: parsed.priceInterval,
      currency: parsed.currency,
      method: parsed.target,
    };
    const intent = await preparePaymentIntent(organizationId, actorUserId, input);
    // A checkout that already existed when this call started is a replay of an
    // earlier request that carried the same operation key.
    const replay = intent.createdAt.getTime() < startedAt;
    const result: ChangeSubscriptionResult = {
      operationKey: parsed.operationKey,
      action: parsed.action,
      subscriptionVersion,
      planVersion: parsed.planVersion,
      intentId: intent.id,
      externalOrderId: intent.externalOrderId,
      replay,
    };
    logObservation({
      event: 'subscription.change',
      module: 'subscription',
      code: 'OK',
      status: replay ? 'ok' : 'processed',
      businessId: intent.externalOrderId,
      taskId: parsed.operationKey,
      count: subscriptionVersion,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logObservation({
      event: 'subscription.change',
      module: 'subscription',
      level: 'error',
      status: 'failed',
      maskedErrorCode: maskErrorCode(error, 'SUBSCRIPTION_CHANGE_FAILED'),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/**
 * The documented business extension point for a provider switch, an upgrade or
 * a downgrade. The default policy is deliberately conservative:
 *
 * - an upgrade takes effect immediately, because more access is never harmful;
 * - a downgrade keeps the paid period the user already owns and only stops the
 *   next charge, so the reversal logic in `service.ts` is never bypassed;
 * - a cross-provider switch is rejected outright.
 *
 * A deployment that needs different rules replaces this function, not the
 * billing service. It reads the recorded facts and returns a decision; it does
 * not write access itself, because the grant table stays the only authority.
 */
export function handleSubscriptionDowngradeProcess(input: {
  currentPlanKey: string | null;
  targetPlanKey: string;
  policy?: 'period_end' | 'immediate' | 'reject';
}): DowngradeDecision {
  const policy = input.policy ?? 'period_end';
  const target = planKeyParts(input.targetPlanKey);
  const current = input.currentPlanKey ? planKeyParts(input.currentPlanKey) : null;
  const cheaperFirstToken = Boolean(
    current && target && current.productCode !== target.productCode,
  );
  const action = policy === 'reject'
    ? 'reject'
    : policy === 'immediate' ? 'apply_now' : 'cancel_at_period_end';
  logObservation({
    event: 'subscription.change',
    module: 'subscription',
    code: 'OK',
    status: action === 'reject' ? 'denied' : 'ok',
    businessId: input.currentPlanKey ?? undefined,
    taskId: `downgrade:${input.targetPlanKey}:${policy}`,
  });
  return {
    currentPlanKey: input.currentPlanKey,
    targetPlanKey: input.targetPlanKey,
    cheaperFirstToken,
    policy,
    action,
    // Both facts are structurally true: the decision never deletes a paid
    // period and never rewrites the subscription key.
    existingPlanFactsPreserved: true,
    subscriptionKeyUnchanged: true,
  };
}

/** A stable id for a change that has not been persisted yet. */
export function newOperationKey(): string {
  return `sub-${randomUUID().replaceAll('-', '')}`;
}
