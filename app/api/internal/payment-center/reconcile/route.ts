import { reconcileCommissionIntents } from '@/lib/billing/submit';
import { getCapabilities } from '@/lib/config';
import { cronFailure, cronHeaders } from '@/lib/jobs/cron-auth';
import { runPaymentInbox } from '@/lib/payment-center/inbox-worker';
import { refreshDueSubscriptions } from '@/lib/subscription/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(request: Request) {
  const failure = cronFailure(request);
  if (failure) return failure;
  if (!getCapabilities().paymentCenter.configured) {
    return Response.json({ error: 'payment_center_unavailable' },
      { status: 503, headers: cronHeaders });
  }
  try {
    const commission = await reconcileCommissionIntents(2);
    const inbox = await runPaymentInbox({ maxJobs: 10, maxMillis: 15_000 });
    const refreshedSubscriptions = await refreshDueSubscriptions(50);
    return Response.json({ status: 'ok', commission, inbox, refreshedSubscriptions },
      { headers: cronHeaders });
  } catch {
    return Response.json({ error: 'reconcile_unavailable' },
      { status: 503, headers: cronHeaders });
  }
}

export const GET = handle;
export const POST = handle;
