import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { BillingAccessError } from '@/lib/billing/account';
import { getAuthorizedStripeSubscription } from '@/lib/billing/subscription-controls';
import { getCapabilities } from '@/lib/config';
import { queryCenterSubscription, setCenterAutoRenew } from '@/lib/payment-center/subscriptions';
import { ensurePersonalWorkspace } from '@/lib/workspace/bootstrap';

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };
const changeSchema = z.object({ enabled: z.boolean() }).strict();

async function bindingForSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: 'unauthorized' as const };
  const organizationId = (await ensurePersonalWorkspace(session.user.id, session.user.name)).id;
  const binding = await getAuthorizedStripeSubscription(organizationId, session.user.id);
  if (!binding) return { error: 'subscription_unavailable' as const };
  return { binding };
}

function verifiedResult(
  binding: NonNullable<Awaited<ReturnType<typeof getAuthorizedStripeSubscription>>>,
  result: Awaited<ReturnType<typeof queryCenterSubscription>>,
) {
  if (result.order_id !== binding.centerOrderId) {
    throw new Error('Payment Center subscription order does not match the paid grant');
  }
  return {
    productCode: binding.productCode,
    periodEnd: binding.periodEnd.toISOString(),
    status: result.status,
    autoRenewEnabled: !result.cancel_at_period_end,
    providerPeriodEnd: result.current_period_end,
  };
}

function unavailable(error: unknown) {
  if (error instanceof BillingAccessError) {
    return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
  }
  return Response.json({ error: 'subscription_unavailable' }, { status: 503, headers: noStore });
}

export async function GET() {
  if (!getCapabilities().paymentCenter.configured) {
    return Response.json({ error: 'payment_unavailable' }, { status: 503, headers: noStore });
  }
  try {
    const context = await bindingForSession();
    if ('error' in context) {
      return Response.json({ error: context.error }, {
        status: context.error === 'unauthorized' ? 401 : 404, headers: noStore,
      });
    }
    const result = await queryCenterSubscription(
      context.binding.accountId, context.binding.providerSubscriptionId,
    );
    return Response.json({ data: verifiedResult(context.binding, result) }, { headers: noStore });
  } catch (error) {
    return unavailable(error);
  }
}

export async function POST(request: Request) {
  if (!getCapabilities().paymentCenter.configured) {
    return Response.json({ error: 'payment_unavailable' }, { status: 503, headers: noStore });
  }
  const expectedOrigin = new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
  if (request.headers.get('origin') !== expectedOrigin) {
    return Response.json({ error: 'invalid_origin' }, { status: 403, headers: noStore });
  }
  let enabled: boolean;
  try {
    const raw = await request.text();
    if (raw.length > 256) throw new Error('Oversized body');
    enabled = changeSchema.parse(JSON.parse(raw)).enabled;
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 422, headers: noStore });
  }

  try {
    const context = await bindingForSession();
    if ('error' in context) {
      return Response.json({ error: context.error }, {
        status: context.error === 'unauthorized' ? 401 : 404, headers: noStore,
      });
    }
    const binding = context.binding;
    const current = await queryCenterSubscription(binding.accountId, binding.providerSubscriptionId);
    verifiedResult(binding, current);
    if (current.cancel_at_period_end === !enabled) {
      return Response.json({ data: verifiedResult(binding, current), unchanged: true }, { headers: noStore });
    }
    let result;
    try {
      result = await setCenterAutoRenew(binding.accountId, binding.providerSubscriptionId, enabled);
    } catch {
      // An uncertain write is resolved by querying the same bound subscription.
      result = await queryCenterSubscription(binding.accountId, binding.providerSubscriptionId);
    }
    verifiedResult(binding, result);
    if (result.cancel_at_period_end !== !enabled) throw new Error('Automatic renewal was not updated');
    return Response.json({ data: verifiedResult(binding, result) }, { headers: noStore });
  } catch (error) {
    return unavailable(error);
  }
}
