import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, freshSessionMiddleware, sensitiveSessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import { getCapabilities } from '@/lib/config';
import { client } from '@/lib/db/drizzle';

type NativeAccountOperations = {
  verifyPassword: (password: string, headers: Headers) => Promise<unknown>;
  changeEmail: (newEmail: string, headers: Headers) => Promise<unknown>;
};

// Extend the existing identity system with policy checks. Better Auth still
// owns password verification, email tokens and the actual address change.
export function accountSettings(operations: NativeAccountOperations) {
  return {
    id: 'account-settings',
    endpoints: {
      requestEmailChange: createAuthEndpoint('/account/request-email-change', {
        method: 'POST',
        body: z.object({
          newEmail: z.email().max(254),
          password: z.string().min(1).max(128),
        }),
        use: [sensitiveSessionMiddleware, freshSessionMiddleware],
      }, async (ctx) => {
        if (!getCapabilities().transactionalEmail.configured) {
          throw new APIError('SERVICE_UNAVAILABLE', { code: 'EMAIL_CHANGE_UNAVAILABLE', message: 'Email confirmation is unavailable.' });
        }
        if (!ctx.context.session.user.emailVerified) {
          throw new APIError('FORBIDDEN', { code: 'EMAIL_OWNERSHIP_REQUIRED', message: 'Confirm the current email first.' });
        }
        // Require a same-origin browser request even when there is no Origin
        // header for Better Auth's default CSRF middleware to compare.
        const origin = new URL(process.env.APP_BASE_URL!).origin;
        if (ctx.headers?.get('origin') !== origin) {
          throw new APIError('FORBIDDEN', { code: 'INVALID_ORIGIN', message: 'Invalid origin.' });
        }
        const now = Date.now();
        const cutoff = now - 15 * 60_000;
        const key = `account-email-change:${ctx.context.session.user.id}`;
        // The built-in limiter handles IPs. This atomic use of the same table
        // also bounds password attempts for one account across different IPs.
        const consumed = await client`
          INSERT INTO "rateLimit" (id, key, count, last_request)
          VALUES (${randomUUID()}, ${key}, 1, ${now})
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN "rateLimit".last_request <= ${cutoff}
              THEN 1 ELSE "rateLimit".count + 1 END,
            last_request = CASE WHEN "rateLimit".last_request <= ${cutoff}
              THEN ${now} ELSE "rateLimit".last_request END
          WHERE "rateLimit".last_request <= ${cutoff} OR "rateLimit".count < 5
          RETURNING id
        `;
        if (!consumed.length) {
          throw new APIError('TOO_MANY_REQUESTS', {
            code: 'EMAIL_CHANGE_RATE_LIMITED', message: 'Too many email change attempts.' },
          { 'Retry-After': '900' });
        }
        await operations.verifyPassword(ctx.body.password, ctx.headers!);
        await operations.changeEmail(ctx.body.newEmail, ctx.headers!);
        return ctx.json({ status: true });
      }),
    },
  } satisfies BetterAuthPlugin;
}
