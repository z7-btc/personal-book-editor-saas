import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { features, getCapabilities } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Step two of sign-up: check the code the user typed and, on success, confirm
 * the mailbox and hand over a session.
 *
 * `verifyEmailOTP` does all three — it is the plugin's own endpoint, so the
 * attempt counter and expiry are the same ones that guarded the code when it
 * was issued. `autoSignInAfterVerification` is on, so a correct code also
 * returns the session cookie; the account it belongs to was created in step
 * one and could not be signed into until this moment.
 */
export async function POST(request: Request) {
  // Same-origin check against the public site address; `request.url` is the
  // internal listen address behind the production proxy.
  const origin = request.headers.get('origin');
  const expectedOrigin = new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
  if (origin && origin !== expectedOrigin) {
    return Response.json({ error: 'invalid_origin' }, { status: 403 });
  }
  if (!features.referrals && !getCapabilities().transactionalEmail.configured) {
    return Response.json({ error: 'email_unavailable' }, { status: 503 });
  }

  const body = await request.json().catch(() => null) as
    { email?: unknown; code?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!email || !code) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  try {
    await auth.api.verifyEmailOTP({
      body: { email, otp: code },
      headers: await headers(),
      // The session this sets must travel back with our own response.
      returnHeaders: false,
    });
  } catch (error) {
    // Wrong code, expired code, or too many tries all land here. The plugin
    // keeps them apart internally; the caller only needs "that did not work".
    const message = error instanceof Error ? error.message : '';
    if (/not found/i.test(message)) {
      return Response.json({ error: 'not_registered' }, { status: 404 });
    }
    return Response.json({ error: 'invalid_code' }, { status: 400 });
  }
  return Response.json({ status: 'verified' }, { headers: { 'Cache-Control': 'no-store' } });
}
