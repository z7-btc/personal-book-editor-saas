import type { Metadata } from 'next';
import { routing, type Locale } from '@/i18n/routing';
import { BRAND_NAME } from '@/lib/brand';

export function siteOrigin(): string {
  return new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
}

/**
 * The one share card the whole site points at. `public/og-image.png` is a
 * rendered 1200x630 card — the size Slack, X, Facebook and WeChat crop to;
 * anything smaller gets letterboxed or rejected by some of them. The URL is
 * absolute so the tag stays valid wherever `metadataBase` has not been set,
 * and every page must carry it itself: Next.js merges metadata shallowly, so
 * a page that defines `openGraph` without `images` drops the layout fallback.
 */
export function defaultShareImage() {
  return {
    url: `${siteOrigin()}/og-image.png`,
    width: 1200,
    height: 630,
    alt: 'AI Personal Book Editor — one book in, a new book out',
  };
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
      siteName: BRAND_NAME,
      title,
      description,
      images: [defaultShareImage()],
    },
    // Without `summary_large_image` X renders a thumbnail next to the text
    // instead of the card below it — the size difference is the whole point
    // of shipping an image at all.
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [defaultShareImage()],
    },
  };
}
