'use client';

import { useTranslations } from 'next-intl';
import { CircleHelp, CreditCard, Gift, LayoutDashboard, LogIn, LogOut } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { authClient } from '@/lib/auth-client';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { XMark } from '@/components/icons/x-mark';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const t = useTranslations('Nav');
  const { data: session, isPending } = authClient.useSession();
  // The underline grows from the centre and the icon lifts a hair: enough to
  // answer the pointer without shifting any layout.
  const navLinkClass = 'group relative inline-flex items-center gap-1.5 transition-colors duration-200 hover:text-gray-950 after:absolute after:-bottom-1 after:left-0 after:h-0.5 after:w-full after:origin-center after:scale-x-0 after:rounded-full after:bg-current after:transition-transform after:duration-200 after:ease-out hover:after:scale-x-100 motion-reduce:transition-none motion-reduce:after:transition-none dark:hover:text-white';
  const navIconClass = 'h-4 w-4 transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none';

  async function signOut() {
    await authClient.signOut();
    router.push('/');
    router.refresh();
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <nav className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight transition-opacity duration-200 hover:opacity-70 motion-reduce:transition-none">{t('brand')}</Link>
          <div className="flex flex-wrap items-center justify-end gap-3 text-sm md:gap-5">
            <Link href="/pricing" className={navLinkClass}>
              <CreditCard className={navIconClass} aria-hidden="true" />
              {t('pricing')}
            </Link>
            <Link href="/faq" className={navLinkClass}>
              <CircleHelp className={navIconClass} aria-hidden="true" />
              {t('faq')}
            </Link>
            <a href="https://x.com/traderdonmark" target="_blank" rel="noopener noreferrer" className={navLinkClass}>
              <XMark className={navIconClass} />
              {t('followX')}
            </a>
            {session?.user ? (
              <>
                <Link href="/dashboard" className={navLinkClass}>
                  <LayoutDashboard className={navIconClass} aria-hidden="true" />
                  {t('workspace')}
                </Link>
                {/* 邀请返佣是一条独立的增长路径，和「控制台」并列摆到页头；
                    侧栏不再重复一遍，免得同一个入口在两处出现。 */}
                <Link href="/dashboard/referrals" className={navLinkClass}>
                  <Gift className={navIconClass} aria-hidden="true" />
                  {t('referrals')}
                </Link>
                <button type="button" onClick={signOut} className={navLinkClass}>
                  <LogOut className={navIconClass} aria-hidden="true" />
                  {t('signOut')}
                </button>
              </>
            ) : !isPending ? (
              <Link href="/sign-in" className="group inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-gray-800 hover:shadow-lg hover:shadow-gray-900/20 active:translate-y-0 active:shadow-sm motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200 dark:hover:shadow-black/30">
                <LogIn className="h-4 w-4 transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none" aria-hidden="true" />
                {t('signIn')}
              </Link>
            ) : null}
            <LanguageSwitcher />
            <ThemeSwitcher />
          </div>
        </nav>
      </header>
      {children}
    </div>
  );
}
