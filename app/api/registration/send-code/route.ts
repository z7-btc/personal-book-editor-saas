import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { features, getCapabilities } from '@/lib/config';
import { db } from '@/lib/db/drizzle';
import { session, user } from '@/lib/db/auth-schema';
import { routing, type Locale } from '@/i18n/routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Step one of sign-up: create the (still unverified) account and mail a code
 * to the address.
 *
 * The account is created here rather than after the code is checked because
 * the OTP plugin only mails a code for an address it can already find; the
 * second step is what marks the mailbox confirmed. The account is therefore
 * unusable until then — signing in is refused while `emailVerified` is false —
 * so an abandoned sign-up occupies an address but grants nothing.
 *
 * An address with a *verified* account is refused: that is a returning user,
 * and letting it through would let anyone reset a stranger's password by
 * "registering" their address. An address with an *unverified* account is
 * re-registered instead — the earlier attempt never proved the mailbox, so it
 * must not be allowed to block this one.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: 'invalid_origin' }, { status: 403 });
  }
  if (!features.referrals && !getCapabilities().transactionalEmail.configured) {
    return Response.json({ error: 'email_unavailable' }, { status: 503 });
  }

  const body = await request.json().catch(() => null) as
    {
      email?: unknown; password?: unknown; name?: unknown;
      marketingOptInRequested?: unknown; preferredLocale?: unknown;
    } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  // The profile the account is created with. The old one-shot sign-up carried
  // these on the same request that created the row; here that request only
  // sends a code, so they have to be forwarded to the step that creates it.
  const marketingOptInRequested = body?.marketingOptInRequested === true;
  const requestedLocale = typeof body?.preferredLocale === 'string' ? body.preferredLocale : '';
  const preferredLocale = routing.locales.includes(requestedLocale as Locale)
    ? (requestedLocale as Locale)
    : 'en';
  if (!EMAIL.test(email) || email.length > 254) {
    return Response.json({ error: 'invalid_email' }, { status: 400 });
  }
  if (password.length < 8 || password.length > 128) {
    return Response.json({ error: 'invalid_password' }, { status: 400 });
  }

  const [existing] = await db.select({ id: user.id, verified: user.emailVerified })
    .from(user).where(eq(user.email, email)).limit(1);
  if (existing?.verified) {
    return Response.json({ error: 'email_taken' }, { status: 409 });
  }
  if (existing) {
    // An earlier sign-up that never confirmed the mailbox: clear it so this
    // attempt starts clean. Cascades take its sessions and profile with it.
    await db.delete(user).where(eq(user.id, existing.id));
  }

  try {
    // The captcha token the browser solved is forwarded so the sign-up
    // endpoint's own human check runs on it — the token is single-use, so this
    // is the one and only time it is spent.
    const created = await auth.api.signUpEmail({
      body: {
        email, password,
        name: name || email.split('@')[0]!,
        marketingOptInRequested,
        preferredLocale,
        localeSource: 'site_locale',
      },
      headers: await headers(),
    });
    // Sign-up hands back a live session, which would let an unconfirmed
    // mailbox straight into the dashboard. The account exists now but is not
    // yet usable, so that session is withdrawn; step two mints a new one the
    // moment the code proves the address.
    await db.delete(session).where(eq(session.userId, created.user.id));
    await auth.api.sendVerificationOTP({
      body: { email, type: 'email-verification' },
    });
  } catch (error) {
    // Do not leak which half failed, and never echo the provider message.
    const message = error instanceof Error ? error.message : '';
    if (/exist|taken/i.test(message)) {
      return Response.json({ error: 'email_taken' }, { status: 409 });
    }
    return Response.json({ error: 'send_failed' }, { status: 502 });
  }
  return Response.json({ status: 'sent' }, { headers: { 'Cache-Control': 'no-store' } });
}
