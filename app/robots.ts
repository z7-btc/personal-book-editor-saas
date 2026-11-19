import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/*/dashboard/', '/*/sign-in', '/*/sign-up'],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
