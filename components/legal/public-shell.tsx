import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { CircleHelp, CreditCard, House } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { XMark } from '@/components/icons/x-mark';

export async function LegalPublicShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  const [nav, t] = await Promise.all([
    getTranslations({ locale, namespace: 'Nav' }),
    getTranslations({ locale, namespace: 'Legal' }),
  ]);
  // The underline grows from the centre and the icon lifts a hair: enough to
  // answer the pointer without shifting any layout.
  const linkClass = 'group relative inline-flex items-center gap-1.5 rounded-sm transition-colors duration-200 after:absolute after:-bottom-1 after:left-0 after:h-0.5 after:w-full after:origin-center after:scale-x-0 after:rounded-full after:bg-current after:transition-transform after:duration-200 after:ease-out hover:after:scale-x-100 focus-visible:outline-2 focus-visible:outline-offset-4 motion-reduce:transition-none motion-reduce:after:transition-none';
  const iconClass = 'h-4 w-4 transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none';
  return (
    <div className="min-h-screen">
      <a href="#legal-content" className="sr-only focus:not-sr-only focus:fixed focus:left-5 focus:top-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-3 focus:text-gray-950 focus:shadow-lg">
        {t('navigation.skip')}
      </a>
      <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <nav aria-label={t('navigation.primary')} className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight transition-opacity duration-200 hover:opacity-70 motion-reduce:transition-none">{nav('brand')}</Link>
          <div className="flex flex-wrap items-center justify-end gap-3 text-sm md:gap-5">
            <Link href="/" className={linkClass}>
              <House className={iconClass} aria-hidden="true" />
              {t('navigation.home')}
            </Link>
            <Link href="/pricing" className={linkClass}>
              <CreditCard className={iconClass} aria-hidden="true" />
              {nav('pricing')}
            </Link>
            <Link href="/faq" className={linkClass}>
              <CircleHelp className={iconClass} aria-hidden="true" />
              {nav('faq')}
            </Link>
            <a href="https://x.com/traderdonmark" target="_blank" rel="noopener noreferrer" className={linkClass}>
              <XMark className={iconClass} />
              {nav('followX')}
            </a>
            <LanguageSwitcher />
            <ThemeSwitcher />
          </div>
        </nav>
      </header>
      {children}
      <footer className="border-t border-gray-200 dark:border-gray-800">
        <nav aria-label={t('navigation.documents')} className="mx-auto flex max-w-3xl flex-wrap gap-x-6 gap-y-3 px-5 py-6 text-sm text-gray-600 dark:text-gray-300">
          <Link href="/privacy" className={linkClass}>{t('privacy.title')}</Link>
          <Link href="/terms" className={linkClass}>{t('terms.title')}</Link>
        </nav>
      </footer>
    </div>
  );
}
