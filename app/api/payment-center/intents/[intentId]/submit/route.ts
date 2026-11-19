import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getCapabilities } from '@/lib/config';
import { BillingAccessError } from '@/lib/billing/account';
import { PaymentIntentConflict } from '@/lib/billing/intents';
import { submitPaymentIntent } from '@/lib/billing/submit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request,
  { params }: { params: Promise<{ intentId: string }> }) {
  const expectedOrigin = new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
  if (request.headers.get('origin') !== expectedOrigin) {
    return Response.json({ error: 'invalid_origin' }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!getCapabilities().paymentCenter.configured) {
    return Response.json({ error: 'payment_unavailable' }, { status: 503 });
  }
  const { intentId } = await params;
  if (!z.string().regex(/^pi_[0-9a-f]{32}$/).safeParse(intentId).success) {
    return Response.json({ error: 'invalid_intent' }, { status: 422 });
  }
  try {
    const result = await submitPaymentIntent(intentId, session.user.id);
    return Response.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof BillingAccessError) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    if (error instanceof PaymentIntentConflict) {
      return Response.json({ error: 'intent_conflict' }, { status: 409 });
    }
    return Response.json({ error: 'payment_unavailable' }, { status: 503 });
  }
}
