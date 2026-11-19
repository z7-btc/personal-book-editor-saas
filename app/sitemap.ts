import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/seo';
import { routing } from '@/i18n/routing';

/**
 * Public pages only. A path belongs here when the page renders for anonymous
 * visitors in every locale and `publicPageMetadata` accepts it, so the crawl
 * surface cannot drift away from the pages the app actually serves.
 */
const publicPaths = ['', '/pricing', '/faq', '/privacy', '/terms'] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const languages = (path: string) => Object.fromEntries(
    routing.locales.map((locale) => [locale, `${origin}/${locale}${path}`])
  );
  return publicPaths.flatMap((path) =>
    routing.locales.map((locale) => ({
      url: `${origin}/${locale}${path}`,
      alternates: { languages: languages(path) },
    }))
  );
}
