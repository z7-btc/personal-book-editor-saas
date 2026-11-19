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
export default async function PricingPage() {
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
      <p className="mt-4 text-lg text-gray-600 dark:text-gray-300">
        {catalog ? t('catalog', { name: catalog.site_name })
          : failed ? t('failed') : t('notConnected')}
      </p>
      {catalog && (
        catalog.products.length > 0
          ? <PricingPlans products={catalog.products} />
          : <p className="mt-8 text-sm text-gray-500 dark:text-gray-400">{t('noPlans')}</p>
      )}
      {!catalog && <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">{t('checkoutDisabled')}</p>}
    </main>
  );
}
