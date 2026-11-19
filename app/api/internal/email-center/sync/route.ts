import { runEmailContactSync } from '@/lib/email-center/worker';
import { cronFailure, cronHeaders } from '@/lib/jobs/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function handle(request: Request) {
  const failure = cronFailure(request);
  if (failure) return failure;
  try {
    const report = await runEmailContactSync({ maxJobs: 25, maxMillis: 20_000 });
    return Response.json({ status: 'ok', report }, { headers: cronHeaders });
  } catch {
    return Response.json({ error: 'sync_unavailable' }, { status: 503, headers: cronHeaders });
  }
}

export const GET = handle;
export const POST = handle;
