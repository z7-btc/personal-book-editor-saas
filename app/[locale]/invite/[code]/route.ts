import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { routing, type Locale } from '@/i18n/routing';
import { INVITE_COOKIE_NAME, resolveInviteCode } from '@/lib/referrals/invite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: {
  params: Promise<{ locale: string; code: string }>;
}) {
  const { locale, code } = await context.params;
  if (!routing.locales.includes(locale as Locale)) {
    return new Response('Not found', { status: 404 });
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    return NextResponse.redirect(new URL(`/${locale}/dashboard`, request.url));
  }
  try {
    const invite = await resolveInviteCode(code);
    if (!invite) return new Response('Invitation unavailable', { status: 404 });
    const response = NextResponse.redirect(new URL(`/${locale}/sign-up`, request.url));
    response.headers.set('Cache-Control', 'no-store');
    response.cookies.set(INVITE_COOKIE_NAME, invite.ticket, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: invite.maxAge,
    });
    return response;
  } catch {
    return new Response('Invitation service unavailable', {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
