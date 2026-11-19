import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getCapabilities } from '@/lib/config';
import { createEmbedToken } from '@/lib/payment-center/embed';

export const dynamic = 'force-dynamic';

/**
 * The widget calls this itself (same-origin, with the session cookie) before it
 * reads the public catalogue or polls an order. The website API key stays on
 * this server: only the short-lived embed token reaches the browser.
 */
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
  try {
    const token = await createEmbedToken(session.user.id);
    return Response.json(token, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'payment_unavailable' }, { status: 503 });
  }
}
