import { hasLocale } from 'next-intl';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { publicPageMetadata } from '@/lib/seo';
import { LandingPage } from '@/components/landing/landing-page';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale, namespace: 'Seo' });
  return publicPageMetadata(locale, '', t('homeTitle'), t('homeDescription'));
}

/**
 * 首页：落地页。
 *
 * 页面本体在 components/landing/landing-page.tsx —— 它是服务端组件，
 * 文案全部来自 `Landing` 词条，样式在 landing.module.css 里。
 */
export default function HomePage() {
  return (
    <main>
      <LandingPage />
    </main>
  );
}
