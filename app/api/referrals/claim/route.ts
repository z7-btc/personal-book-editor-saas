import { cookies, headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { features } from '@/lib/config';
import { claimInvite, INVITE_COOKIE_NAME } from '@/lib/referrals/invite';
import { syncReferralUserNow } from '@/lib/referrals/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: 'invalid_origin' }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const cookieStore = await cookies();
  const signed = cookieStore.get(INVITE_COOKIE_NAME)?.value;
  if (!signed) return new Response(null, { status: 204 });
  if (!features.referrals) {
    return Response.json({ error: 'referrals_unavailable' }, { status: 503 });
  }
  try {
    const outcome = await claimInvite(session.user.id, signed);
    if (outcome === 'claimed' || outcome === 'already_claimed') {
      cookieStore.delete(INVITE_COOKIE_NAME);
      // Push the new relationship right away so the inviter is bound before
      // any payment can be attributed. If this does not land, the queue row
      // `claimInvite` re-armed carries it on the next pass.
      try {
        await syncReferralUserNow(session.user.id);
      } catch {
        // Deferred to the background runner.
      }
      return Response.json({ status: outcome }, { headers: { 'Cache-Control': 'no-store' } });
    }
    cookieStore.delete(INVITE_COOKIE_NAME);
    return Response.json({ error: outcome },
      { status: outcome === 'conflict' ? 409 : 400, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Keep the signed cookie so a later dashboard visit can retry the same claim.
    return Response.json({ error: 'claim_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
