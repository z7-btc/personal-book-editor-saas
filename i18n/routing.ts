import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  // English first, so `locales[0]` and `defaultLocale` cannot disagree.
  // The list grows by measured demand, not by ambition: every extra locale is
  // another full message bundle to keep in step with English (see
  // tests/i18n.test.ts, which requires identical key sets).
  locales: ['en', 'zh-CN', 'ja', 'de', 'es', 'fr'],
  // English is the fallback: a visitor whose browser asks for a language this
  // template does not serve lands on English rather than Chinese. Browsers that
  // do announce a served language still get it, because `localeDetection` is
  // left on.
  defaultLocale: 'en',
  localePrefix: 'always',
});

export type Locale = (typeof routing.locales)[number];
