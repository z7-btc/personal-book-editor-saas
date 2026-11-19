import { eq } from 'drizzle-orm';
import { getCapabilities } from '@/lib/config';
import { db } from '@/lib/db/drizzle';
import { paymentInbox, paymentIntents } from '@/lib/db/integration-schema';
import { runPaymentInbox } from '@/lib/payment-center/inbox-worker';
import { InvalidPaymentWebhook, verifyPaymentWebhook } from '@/lib/payment-center/webhook';

export const dynamic = 'force-dynamic';

/** The centre waits up to 15 s for this callback, so the fast path stays inside it. */
const INLINE_DRAIN_MILLIS = 5_000;

/**
 * Fulfils the delivery that just arrived, so a verified payment never waits for
 * the scheduler, the worker or `npm run reconcile`. Never throws: whatever the
 * fast path cannot finish stays `pending` and the durable row is the backstop.
 */
async function processInline(eventId: string): Promise<'processed' | 'queued'> {
  try {
    const report = await runPaymentInbox({
      maxJobs: 1,
      maxMillis: INLINE_DRAIN_MILLIS,
      eventIds: [eventId],
    });
    if (report.processed === 1) return 'processed';
    const [row] = await db.select({ status: paymentInbox.status })
      .from(paymentInbox).where(eq(paymentInbox.eventId, eventId)).limit(1);
    return row?.status === 'processed' ? 'processed' : 'queued';
  } catch {
    return 'queued';
  }
}

async function readBoundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) {
      await reader.cancel();
      throw new InvalidPaymentWebhook('Invalid callback size');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: Request) {
  if (!getCapabilities().paymentCenter.configured) {
    return Response.json({ error: 'payment_unavailable' }, { status: 503 });
  }
  if (Number(request.headers.get('content-length') || 0) > 65_536) {
    return Response.json({ error: 'callback_too_large' }, { status: 413 });
  }

  let event: ReturnType<typeof verifyPaymentWebhook>;
  try {
    event = verifyPaymentWebhook(await readBoundedBody(request), request.headers);
  } catch (error) {
    return Response.json({ error: error instanceof InvalidPaymentWebhook
      ? 'invalid_callback' : 'callback_unavailable' }, { status: 400 });
  }
  if (event.websiteId !== process.env.PAYMENT_CENTER_WEBSITE_ID) {
    return Response.json({ error: 'wrong_website' }, { status: 403 });
  }

  try {
    const [intent] = await db.select({ centerOrderId: paymentIntents.paymentCenterOrderId })
      .from(paymentIntents)
      .where(eq(paymentIntents.externalOrderId, event.externalOrderId)).limit(1);
    const status = !intent ? 'quarantined' :
      intent.centerOrderId && intent.centerOrderId !== event.centerOrderId
        ? 'manual_review' : 'pending';
    const [inserted] = await db.insert(paymentInbox).values({
      ...event, status,
    }).onConflictDoNothing({ target: paymentInbox.eventId }).returning({
      eventId: paymentInbox.eventId,
    });
    if (!inserted) {
      const [prior] = await db.select({ bodySha256: paymentInbox.bodySha256 })
        .from(paymentInbox).where(eq(paymentInbox.eventId, event.eventId)).limit(1);
      if (!prior || prior.bodySha256 !== event.bodySha256) {
        return Response.json({ error: 'event_conflict' }, { status: 409 });
      }
    }
    return Response.json({ received: true, outcome: await processInline(event.eventId) }, {
      status: inserted ? 202 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'callback_unavailable' }, { status: 503 });
  }
}
