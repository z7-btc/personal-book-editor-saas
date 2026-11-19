import { hasLocale, useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { publicPageMetadata, siteOrigin } from '@/lib/seo';
import { EmailCenterWidget } from '@/components/email-center/widget-loader';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale, namespace: 'Seo' });
  return publicPageMetadata(locale, '', t('homeTitle'), t('homeDescription'));
}

export default function HomePage() {
  const t = useTranslations('Home');
  const seo = useTranslations('Seo');
  const requestedLocale = useLocale();
  // The `[locale]` layout has already 404'd anything outside the routing table,
  // so this only spells out to the type system what the URL already guarantees.
  const locale = hasLocale(routing.locales, requestedLocale) ? requestedLocale : routing.defaultLocale;
  const foundations = [
    { title: t('accountTitle'), detail: t('accountDetail') },
    { title: t('paymentsTitle'), detail: t('paymentsDetail') },
    { title: t('emailTitle'), detail: t('emailDetail') },
  ];
  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'SaaS Framework',
            url: `${siteOrigin()}/${locale}`,
            description: seo('homeDescription'),
            inLanguage: locale,
          }).replace(/</g, '\\u003c'),
        }}
      />
      <section className="mx-auto max-w-7xl px-5 py-24">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">{t('eyebrow')}</p>
        <h1 className="mt-5 max-w-3xl text-5xl font-semibold leading-tight tracking-tight text-gray-900 dark:text-white">
          {t('title')}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-gray-600 dark:text-gray-300">
          {t('description')}
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/sign-up" className="rounded-lg bg-gray-900 px-6 py-3 font-medium text-white dark:bg-white dark:text-gray-950">
            {t('createAccount')}
          </Link>
          <Link href="/pricing" className="rounded-lg border border-gray-300 px-6 py-3 font-medium dark:border-gray-600">
            {t('pricingStatus')}
          </Link>
        </div>
      </section>
      <section className="border-t bg-white py-16 dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto grid max-w-7xl gap-6 px-5 md:grid-cols-3">
          {foundations.map((item) => (
            <article key={item.title} className="rounded-xl border p-6 dark:border-gray-700">
              <h2 className="text-xl font-semibold">{item.title}</h2>
              <p className="mt-3 leading-7 text-gray-600 dark:text-gray-300">{item.detail}</p>
            </article>
          ))}
        </div>
      </section>
      <EmailCenterWidget locale={locale} />
    </main>
  );
}
