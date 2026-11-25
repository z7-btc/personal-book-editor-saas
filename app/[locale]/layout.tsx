import '../globals.css';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { GoogleAnalytics } from '@/components/analytics/google-analytics';
import { routing } from '@/i18n/routing';
import { resolveGoogleAnalyticsId } from '@/lib/analytics';
import { defaultShareImage, siteOrigin } from '@/lib/seo';
import { THEME_COOKIE, readThemeChoice, themeClassFor } from '@/lib/theme';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // The title and description live in the message bundle so every locale is
  // covered by the same key-symmetry test as the rest of the interface; a
  // per-locale ternary here would silently fall back to English.
  const t = await getTranslations({ locale, namespace: 'Seo' });
  return {
    title: t('siteTitle'),
    description: t('siteDescription'),
    metadataBase: new URL(siteOrigin()),
    // Fallback for any route that does not go through publicPageMetadata;
    // pages that define their own openGraph must repeat the image because
    // Next.js merges the nested object as a whole.
    openGraph: { images: [defaultShareImage()] },
    twitter: { card: 'summary_large_image', images: [defaultShareImage()] },
  };
}

/**
 * Zooming stays available. `maximumScale: 1` used to sit here, which axe-core
 * reports as `meta-viewport` (WCAG 1.4.4) because it forbids a reader from
 * enlarging the text; the two values kept below are what Next.js already emits
 * by default, so the page now states the contract instead of narrowing it.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  return (
    <LocaleDocument params={params}>
      {children}
    </LocaleDocument>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

async function LocaleDocument({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // The theme is the one piece of interface state that has to be known before
  // the first paint, so it is read from the cookie here and rendered onto
  // `<html>` instead of being applied by an inline script. React 19 never
  // executes a script it renders — it replaces the node with an inert one and
  // warns — and the `[locale]` layout is re-rendered on every language switch,
  // so a script here could not work. `system` adds no class at all and lets the
  // `prefers-color-scheme` rules in globals.css decide.
  const themeClass = themeClassFor(readThemeChoice((await cookies()).get(THEME_COOKIE)?.value));
  // Analytics stays fully off when the deployment does not configure it; the
  // validator also refuses anything that is not a plain G- measurement id, so
  // this flag cannot be flipped on by a malformed environment value.
  const gaId = resolveGoogleAnalyticsId(process.env.NEXT_PUBLIC_GA_ID);
  return (
    <html
      lang={locale}
      // `suppressHydrationWarning` stays because the client-side switcher and
      // browser extensions both mutate this class list; the value rendered here
      // is the source of truth, and it is the same on both sides of hydration.
      className={`bg-white text-black dark:bg-gray-950 dark:text-white${themeClass ? ` ${themeClass}` : ''}`}
      suppressHydrationWarning
    >
      <body className="min-h-[100dvh] bg-gray-50 dark:bg-gray-950">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
        {gaId ? <GoogleAnalytics measurementId={gaId} /> : null}
      </body>
    </html>
  );
}
