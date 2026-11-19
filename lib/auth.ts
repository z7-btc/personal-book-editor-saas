import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { captcha, emailOTP } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { authOptions } from '@/auth.config';
import { db } from '@/lib/db/drizzle';
import * as authSchema from '@/lib/db/auth-schema';
import { features } from '@/lib/config';
import { getCapabilities } from '@/lib/config';
import {
  sendEmailOwnershipLink, sendPasswordResetLink, sendEmailChangeConfirmation,
  sendVerificationCode,
} from '@/lib/transactional-email/resend';
import { accountSettings } from '@/lib/auth/account-settings';
import { syncReferralUserNow } from '@/lib/referrals/worker';

const hostnameList = process.env.TURNSTILE_ALLOWED_HOSTNAMES
  ?.split(',')
  .map((hostname) => hostname.trim())
  .filter(Boolean);
// Cloudflare's dummy Siteverify response has no action and reports example.com;
// only production widgets can exercise the metadata checks end to end.
const dummyTurnstile =
  process.env.NODE_ENV !== 'production' &&
  /^[123]x0000000000000000000000000000000/.test(process.env.TURNSTILE_SECRET_KEY || '');

export const auth = betterAuth({
  ...authOptions,
  baseURL: process.env.APP_BASE_URL || 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET,
  // Better Auth turns origin and callback validation off whenever NODE_ENV is
  // "test" (its context builder defaults `skipOriginCheck` to `isTest()`), which
  // would let this repository's suite accept an off-site `callbackURL` or
  // `redirectTo` that production answers 403 to. Pinning it to false keeps the
  // guard live in every environment, so a test can prove it rather than assume it.
  advanced: { disableOriginCheck: false },
  // A provider callback normally carries the state that names where a failure
  // should land (`errorCallbackURL`). This is the fallback for when the state
  // itself is gone — an expired cookie, or a flow finished in a browser on
  // another device — where Better Auth would otherwise serve its own English
  // error page inside a Chinese product. Deliberately locale-neutral: the
  // middleware picks the language from the cookie on the way in.
  onAPIError: { errorURL: '/sign-in' },
  database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
  databaseHooks: {
    user: {
      create: {
        // Push the new profile to the Referral Center as the account is
        // created, the way AutoTrading does, so the referral dashboard is
        // current on the user's first visit instead of waiting for the queue.
        // The trigger that writes the profile and its queue row has already
        // committed by the time this runs (the hook is deferred to after the
        // transaction), so the push carries the invite code.
        //
        // A failure here must never fail sign-up. `syncReferralUserNow`
        // reports rather than throws, and it leaves the queue row untouched
        // when the centre is unreachable — that row is the retry.
        after: async (user) => {
          if (!features.referrals) return;
          try {
            await syncReferralUserNow(user.id);
          } catch {
            // Deferred to the background runner.
          }
        },
      },
    },
    session: {
      create: {
        // Sign-up deliberately leaves the account unusable until a mailed code
        // proves the address, and this is what makes that hold for the
        // credential path too: without it, step one's email and password would
        // sign straight in and the mailbox check would only ever be optional.
        // The code-verification flow clears `emailVerified` first, so the
        // session it mints passes.
        //
        // Sign-up itself is exempt: `signUpEmail` mints a session as part of
        // creating the account, and refusing that one would fail the very
        // request that is doing the verifying. The route withdraws it right
        // after, so the account still cannot be used until the code lands.
        before: async (newSession, ctx) => {
          const path = (ctx as { path?: string } | null)?.path ?? '';
          if (path.includes('/sign-up')) return;
          const [owner] = await db.select({ verified: authSchema.user.emailVerified })
            .from(authSchema.user)
            .where(eq(authSchema.user.id, newSession.userId))
            .limit(1);
          if (owner && !owner.verified) {
            throw new APIError('FORBIDDEN', {
              message: 'Confirm your email address before signing in. / 请先完成邮箱验证再登录。',
            });
          }
        },
      },
    },
  },
  user: {
    ...authOptions.user,
    changeEmail: {
      enabled: getCapabilities().transactionalEmail.configured,
      updateEmailWithoutVerification: false,
      sendChangeEmailConfirmation: async ({ user, newEmail, url, token }) => {
        await sendEmailChangeConfirmation(user.email, newEmail, url, token);
      },
    },
  },
  emailAndPassword: {
    ...authOptions.emailAndPassword,
    resetPasswordTokenExpiresIn: 3600,
    revokeSessionsOnPasswordReset: true,
    ...(getCapabilities().transactionalEmail.configured ? {
      sendResetPassword: async ({ user, url, token }: {
        user: { email: string }; url: string; token: string;
      }) => {
        await sendPasswordResetLink(user.email, url, token);
      },
    } : {}),
  },
  emailVerification: {
    ...authOptions.emailVerification,
    expiresIn: 3600,
    // A confirmed mailbox is the last step of sign-up, so the session it
    // earns is handed over immediately instead of asking for the credentials
    // again on the next screen.
    autoSignInAfterVerification: true,
    ...(getCapabilities().transactionalEmail.configured ? {
      sendVerificationEmail: async ({ user, url, token }: {
        user: { email: string }; url: string; token: string;
      }) => {
        await sendEmailOwnershipLink(user.email, url, token);
      },
    } : {}),
  },
  // One-click sign-in. Each provider is loaded only when its capability reports
  // `configured`, so a deployment that enables the flag without the keys keeps
  // the password-only page instead of exposing a button that cannot work.
  //
  // `requireEmailVerification` is the one non-default setting, and it exists to
  // keep a dead end shut: without it a provider address nobody proved
  // (emailVerified: false) gets a user row created, then the session gate below
  // refuses the session and the browser stops on a raw error at
  // /api/auth/callback/<provider> with no password to fall back on. With it,
  // Better Auth refuses before the session and redirects to our own error page.
  //
  // Better Auth also reads GitHub's private addresses itself: the provider asks
  // for `user:email` and falls back to GET /user/emails, preferring the primary
  // one and carrying its `verified` flag.
  socialProviders: {
    ...(getCapabilities().googleOAuth.configured ? {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID as string,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
        requireEmailVerification: true,
      },
    } : {}),
    ...(getCapabilities().githubOAuth.configured ? {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID as string,
        clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
        requireEmailVerification: true,
      },
    } : {}),
  },
  plugins: [
    ...authOptions.plugins,
    accountSettings({
      verifyPassword: (password, headers): Promise<unknown> => auth.api.verifyPassword({ body: { password }, headers }),
      changeEmail: (newEmail, headers): Promise<unknown> => auth.api.changeEmail({
        body: { newEmail, callbackURL: '/dashboard/general' }, headers,
      }),
    }),
    ...(features.turnstile && process.env.TURNSTILE_SECRET_KEY
      ? [
          captcha({
            provider: 'cloudflare-turnstile',
            secretKey: process.env.TURNSTILE_SECRET_KEY,
            endpoints: ['/sign-up/email', '/sign-in/email', '/request-password-reset'],
            expectedAction: dummyTurnstile ? undefined : 'saas_auth',
            allowedHostnames: dummyTurnstile ? undefined : hostnameList,
          }),
        ]
      : []),
    // Sign-up is gated on a code mailed to the address, so the account only
    // exists once someone has proved they can read that mailbox. Loaded only
    // when mail is actually wired up: without a sender the plugin would mint
    // codes nobody can receive and every registration would stall.
    ...(getCapabilities().transactionalEmail.configured
      ? [emailOTP({
          otpLength: 6,
          expiresIn: 600,
          allowedAttempts: 5,
          async sendVerificationOTP({ email, otp }) {
            await sendVerificationCode(email, otp);
          },
        })]
      : []),
    nextCookies(),
  ],
});
