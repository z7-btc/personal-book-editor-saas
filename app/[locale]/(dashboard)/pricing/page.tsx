import { getCapabilities } from '@/lib/config';
import { getPaymentCatalog } from '@/lib/payment-center/catalog';
import { getLocale, getTranslations } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { publicPageMetadata, siteOrigin } from '@/lib/seo';
import { PricingPlans } from './pricing-plans';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale, namespace: 'Seo' });
  return publicPageMetadata(locale, '/pricing', t('pricingTitle'), t('pricingDescription'));
}

export const dynamic = 'force-dynamic';

/**
 * The pricing surface renders the plans itself and opens the Payment Center
 * widget only after the buyer picks a plan and a billing interval — the widget
 * then shows one locked price and the payment methods, not a plan browser.
 * This page only checks the binding is configured and that the centre answers.
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ need?: string }>;
}) {
  const params = await searchParams;
  // 被工具页挡回来的访客：先说清楚为什么到了定价页。
  const needsSubscription = params.need === 'subscription';
  const t = await getTranslations('Pricing');
  const seo = await getTranslations('Seo');
  const locale = await getLocale();
  const payment = getCapabilities().paymentCenter;
  let catalog: Awaited<ReturnType<typeof getPaymentCatalog>> | null = null;
  let failed = false;
  if (payment.configured) {
    try {
      catalog = await getPaymentCatalog();
    } catch {
      failed = true;
    }
  }
  return (
    <main className="mx-auto max-w-4xl px-5 py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: seo('pricingTitle'),
            description: seo('pricingDescription'),
            url: `${siteOrigin()}/${locale}/pricing`,
            inLanguage: locale,
          }).replace(/</g, '\\u003c'),
        }}
      />
      <h1 className="text-4xl font-semibold tracking-tight">{t('title')}</h1>
      {needsSubscription && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {t('subscriptionRequired')}
        </p>
      )}
      <p className="mt-4 text-lg text-gray-600 dark:text-gray-300">
        {catalog ? t('catalog', { name: catalog.site_name })
          : failed ? t('failed') : t('notConnected')}
      </p>
      <section className="mt-8 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="text-base font-semibold">{t('scopeTitle')}</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{t('scopeBody')}</p>
      </section>
      {catalog && (
        catalog.products.length > 0
          ? <PricingPlans products={catalog.products} />
          : <p className="mt-8 text-sm text-gray-500 dark:text-gray-400">{t('noPlans')}</p>
      )}
      {!catalog && <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">{t('checkoutDisabled')}</p>}
    </main>
  );
}
