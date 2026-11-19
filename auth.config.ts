import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';

// This database-free instance is used only by the Better Auth schema generator.
// The server runtime adds the Drizzle adapter in lib/auth.ts.
export const authOptions = {
  baseURL: process.env.APP_BASE_URL || 'http://localhost:3000',
  user: {
    additionalFields: {
      // Must mirror the `locales` list in i18n/routing.ts; the array is spelled
      // out rather than imported because the Better Auth CLI loads this file
      // without the app's path aliases and Next runtime. tests/i18n.test.ts
      // asserts the two lists stay identical.
      preferredLocale: {
        type: ['en', 'zh-CN', 'ja', 'de', 'es', 'fr'] as ['en', 'zh-CN', 'ja', 'de', 'es', 'fr'],
        required: false,
        defaultValue: 'en',
        fieldName: 'preferred_locale',
      },
      localeSource: {
        type: ['browser_detected', 'user_selected', 'site_locale', 'fallback'] as ['browser_detected', 'user_selected', 'site_locale', 'fallback'],
        required: false,
        defaultValue: 'fallback',
        fieldName: 'locale_source',
      },
      marketingOptInRequested: {
        type: 'boolean' as const,
        required: false,
        defaultValue: false,
        fieldName: 'marketing_opt_in_requested',
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    autoSignIn: true,
  },
  emailVerification: {
    sendOnSignUp: false,
    sendOnSignIn: false,
  },
  session: { freshAge: 15 * 60 },
  // The public email-change entry point adds password and account policies.
  // Native auth.api.changeEmail remains available internally.
  disabledPaths: ['/change-email'],
  rateLimit: {
    enabled: true,
    storage: 'database' as const,
    customRules: {
      '/account/request-email-change': { window: 15 * 60, max: 5 },
    },
  },
  plugins: [organization()],
};

export const auth = betterAuth(authOptions);
