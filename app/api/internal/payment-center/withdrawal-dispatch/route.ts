import { cronFailure, cronHeaders } from '@/lib/jobs/cron-auth';
import { runWithdrawalDispatch } from '@/lib/referrals/withdrawal-worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const rejected = cronFailure(request);
  if (rejected) return rejected;
  try {
    return Response.json(await runWithdrawalDispatch({ maxJobs: 20, maxMillis: 20_000 }), {
      headers: cronHeaders,
    });
  } catch {
    return Response.json({ error: 'withdrawal_dispatch_unavailable' }, {
      status: 503, headers: cronHeaders,
    });
  }
}
