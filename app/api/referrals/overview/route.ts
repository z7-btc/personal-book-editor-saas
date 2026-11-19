import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getCapabilities } from '@/lib/config';
import { getReferralOverview, referralOffset } from '@/lib/referrals/overview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!getCapabilities().referrals.configured) {
    return Response.json({ error: 'referrals_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = new URL(request.url);
  try {
    // 返佣只结算 USDT，币种不由调用方决定；调用方若仍带 ?currency=，
    // 这里不读它——宁可静默忽略，也不给一个能查出别的币种视图的口子。
    const result = await getReferralOverview(
      session.user.id,
      referralOffset(url.searchParams.get('ledgerOffset') || undefined),
      referralOffset(url.searchParams.get('inviteOffset') || undefined),
      referralOffset(url.searchParams.get('withdrawalOffset') || undefined),
    );
    return Response.json({ data: result }, {
      status: result.state === 'syncing' ? 202 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch {
    return Response.json({ error: 'referrals_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
