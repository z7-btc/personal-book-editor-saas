import type { Metadata } from 'next';
import { routing, type Locale } from '@/i18n/routing';

export function siteOrigin(): string {
  return new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
}

/**
 * Open Graph locales are not the same identifiers as the URL segments: they
 * follow the `language_TERRITORY` form. Every locale in `routing` needs a row
 * here or its pages would advertise the wrong language to social crawlers.
 */
const OG_LOCALES: Record<Locale, string> = {
  en: 'en_US',
  'zh-CN': 'zh_CN',
  ja: 'ja_JP',
  de: 'de_DE',
  es: 'es_ES',
  fr: 'fr_FR',
};

export function publicPageMetadata(
  locale: Locale,
  path: '' | '/pricing' | '/faq' | '/privacy' | '/terms',
  title: string,
  description: string
): Metadata {
  const origin = siteOrigin();
  const localizedPath = (language: Locale) => `${origin}/${language}${path}`;
  const languages = Object.fromEntries(
    routing.locales.map((language) => [language, localizedPath(language)])
  );
  return {
    title,
    description,
    alternates: {
      canonical: localizedPath(locale),
      languages: {
        ...languages,
        // Derived rather than hard-coded so the search-engine fallback cannot
        // drift away from the locale the middleware actually falls back to.
        'x-default': localizedPath(routing.defaultLocale),
      },
    },
    openGraph: {
      type: 'website',
      locale: OG_LOCALES[locale],
      url: localizedPath(locale),
      siteName: 'SaaS Framework',
      title,
      description,
    },
  };
}
