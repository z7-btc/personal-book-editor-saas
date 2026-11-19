import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';
import { features, getCapabilities } from '@/lib/config';

const handler = toNextJsHandler(auth);
const turnstileEndpoints = new Set([
  '/api/auth/sign-up/email',
  '/api/auth/sign-in/email',
  '/api/auth/request-password-reset',
]);
// Both endpoints exist only to deliver a link. With the transactional-email
// adapter unconfigured Better Auth answers them "successfully" while sending
// nothing (the reset endpoint is silent on purpose, to avoid revealing which
// addresses exist), so the honest answer has to come from here: AC 29 requires
// the action to be explicitly unavailable rather than quietly a no-op. The
// protected email change already answers 503 EMAIL_CHANGE_UNAVAILABLE for the
// same reason, and this is the same answer for the two public entry points.
const mailEndpoints = new Set([
  '/api/auth/request-password-reset',
  '/api/auth/send-verification-email',
]);

// Personal billing storage has no public organization-management surface.
// Admin operations are outside product scope; direct email changes must use
// the protected account endpoint instead.
function isUnavailableRoute(request: Request) {
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(request.url).pathname).replace(/\/+$/, ''); }
  catch { return true; }
  return ['/api/auth/organization', '/api/auth/admin'].some((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ) || pathname === '/api/auth/change-email';
}

function unavailable() {
  return Response.json({ error: 'not_found' }, {
    status: 404, headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  if (isUnavailableRoute(request)) return unavailable();
  return handler.GET(request);
}

export async function POST(request: Request) {
  const pathname = new URL(request.url).pathname.replace(/\/$/, '');
  if (isUnavailableRoute(request)) return unavailable();
  if (pathname === '/api/auth/account/request-email-change') {
    const length = request.headers.get('content-length');
    if (length && Number(length) > 2048) {
      return Response.json({ error: 'body_too_large' }, { status: 413 });
    }
    // Bound the raw body before Better Auth parses the custom endpoint.
    const reader = request.clone().body?.getReader();
    if (reader) {
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2048) {
            void reader.cancel();
            return Response.json({ error: 'body_too_large' }, { status: 413 });
          }
        }
      } finally { reader.releaseLock(); }
    }
  }
  if (
    (process.env.NODE_ENV === 'production' || features.turnstile) &&
    turnstileEndpoints.has(pathname) &&
    !getCapabilities().turnstile.configured
  ) {
    return Response.json(
      { error: 'Human verification is unavailable. Please try again later.' },
      { status: 503 }
    );
  }
  if (mailEndpoints.has(pathname) && !getCapabilities().transactionalEmail.configured) {
    return Response.json({
      code: 'TRANSACTIONAL_EMAIL_UNAVAILABLE',
      message: 'Password reset and email confirmation are unavailable.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const response = await handler.POST(request);
  if (pathname === '/api/auth/account/request-email-change') {
    response.headers.set('Cache-Control', 'no-store');
  }
  return response;
}
