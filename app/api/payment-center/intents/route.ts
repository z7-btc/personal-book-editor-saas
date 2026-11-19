import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getCapabilities } from '@/lib/config';
import { ensurePersonalWorkspace } from '@/lib/workspace/bootstrap';
import { BillingAccessError } from '@/lib/billing/account';
import { PaymentIntentConflict, PaymentOptionUnavailable, preparePaymentIntent } from '@/lib/billing/intents';
import { parsePlanKey } from '@/lib/billing/plan-key';

export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  planKey: z.string().max(160),
  // The catalogue decides which channels exist; this route only carries the
  // name through to `preparePaymentIntent`, which reads its capability card.
  method: z.string().trim().min(1).max(40),
  requestKey: z.uuid(),
}).strict();

export async function POST(request: Request) {
  const expectedOrigin = new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
  if (request.headers.get('origin') !== expectedOrigin) {
    return Response.json({ error: 'invalid_origin' }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!getCapabilities().paymentCenter.configured) {
    return Response.json({ error: 'payment_unavailable' }, { status: 503 });
  }
  let body: z.infer<typeof requestSchema>;
  let plan: ReturnType<typeof parsePlanKey>;
  try {
    const raw = await request.text();
    if (raw.length > 2_000) return Response.json({ error: 'invalid_request' }, { status: 413 });
    body = requestSchema.parse(JSON.parse(raw));
    plan = parsePlanKey(body.planKey);
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 422 });
  }

  try {
    const organizationId = (await ensurePersonalWorkspace(session.user.id, session.user.name)).id;
    const intent = await preparePaymentIntent(organizationId, session.user.id, {
      ...plan,
      method: body.method,
      requestKey: body.requestKey,
    });
    return Response.json({
      data: {
        intentId: intent.id,
        status: intent.status,
        planKey: body.planKey,
        method: intent.method,
        amountDecimal: intent.amountDecimal,
        currency: intent.currency,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof BillingAccessError) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    if (error instanceof PaymentIntentConflict) {
      return Response.json({ error: 'idempotency_conflict' }, { status: 409 });
    }
    if (error instanceof PaymentOptionUnavailable) {
      return Response.json({ error: 'payment_option_unavailable' }, { status: 422 });
    }
    return Response.json({ error: 'payment_unavailable' }, { status: 503 });
  }
}
