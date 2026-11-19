import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { publicPageMetadata, siteOrigin } from '@/lib/seo';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale, namespace: 'Seo' });
  return publicPageMetadata(locale, '/faq', t('faqTitle'), t('faqDescription'));
}

export default async function FaqPage() {
  const t = await getTranslations('Faq');
  const seo = await getTranslations('Seo');
  const locale = await getLocale();
  const questions = ['signup', 'billing', 'email'] as const;
  return (
    <main className="mx-auto max-w-3xl px-5 py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: seo('faqTitle'),
            description: seo('faqDescription'),
            url: `${siteOrigin()}/${locale}/faq`,
            inLanguage: locale,
          }).replace(/</g, '\\u003c'),
        }}
      />
      <h1 className="text-4xl font-semibold">{t('title')}</h1>
      <p className="mt-4 text-lg text-gray-600 dark:text-gray-300">{t('intro')}</p>
      <div className="mt-12 space-y-10">
        {questions.map((key) => (
          <section key={key}>
            <h2 className="text-xl font-semibold">{t(`${key}Question`)}</h2>
            <p className="mt-3 leading-7 text-gray-600 dark:text-gray-300">{t(`${key}Answer`)}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
