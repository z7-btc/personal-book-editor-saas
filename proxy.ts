import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  const response = intlMiddleware(request);
  const vary = response.headers.get('Vary');
  if (vary !== '*') {
    const fields = new Set((vary || '').split(',').map((field) => field.trim()).filter(Boolean));
    fields.add('Cookie');
    fields.add('Accept-Language');
    response.headers.set('Vary', [...fields].join(', '));
  }
  return response;
}

export const config = {
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};
