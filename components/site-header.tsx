'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  CreditCard,
  Gift,
  Languages,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { authClient } from '@/lib/auth-client';
import { GithubMark } from '@/components/icons/github-mark';
import { LOCALES } from '@/components/language-switcher';
import { applyThemeChoice, useThemeChoice } from '@/components/theme-switcher';
import { THEME_CHOICES, type ThemeChoice } from '@/lib/theme';
import { useHoverMenu } from '@/components/nav-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const THEME_ICONS: Record<ThemeChoice, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

/**
 * 站点的顶栏。
 *
 * 以前这里把 定价 / 常见问题 / 关注 X / 控制台 / 邀请返佣 / 退出登录 平铺成
 * 一排，九个同权重的文字链接，找东西全靠扫。现在按用途收成四块：
 *
 *  - 主链接：书库（登录后）、定价；
 *  - 「帮助」：常见问题、关注 X —— 低频入口收进悬停菜单；
 *  - 头像菜单：控制台、邀请返佣、退出登录；
 *  - 「偏好」：语言和主题并成同一个菜单，少两个控件。
 *
 * 窄屏没有悬停，整排收进汉堡菜单，不挤成两行。
 */
export default function SiteHeader() {
  const router = useRouter();
  const t = useTranslations('Nav');
  const { data: session, isPending } = authClient.useSession();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function signOut() {
    await authClient.signOut();
    router.push('/');
    router.refresh();
  }

  const linkClass = (href: string) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return [
      'rounded-md px-3 py-2 text-sm transition-colors',
      active
        ? 'font-medium text-gray-950 dark:text-white'
        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white',
    ].join(' ');
  };

  return <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
    <nav className="mx-auto flex max-w-7xl items-center gap-2 px-5 py-3">
      {/* 窄屏下品牌名让位给右侧按钮：`min-w-0 truncate` 兜底，长语言（德语、
          法语）也不会把登录按钮和汉堡挤出屏幕。 */}
      <Link href="/" className="mr-2 min-w-0 truncate text-base font-semibold tracking-tight transition-opacity duration-200 hover:opacity-70 sm:text-lg motion-reduce:transition-none">
        {t('brand')}
      </Link>

      <div className="hidden items-center gap-0.5 md:flex">
        {session?.user && (
          <Link href="/dashboard/library" className={linkClass('/dashboard/library')} aria-current={pathname.startsWith('/dashboard/library') ? 'page' : undefined}>
            <BookOpen aria-hidden="true" className="mr-1.5 inline h-4 w-4" />
            {t('library')}
          </Link>
        )}
        <Link href="/pricing" className={linkClass('/pricing')} aria-current={pathname === '/pricing' ? 'page' : undefined}>
          {t('pricing')}
        </Link>
        <HelpMenu label={t('help')} faqLabel={t('faq')} followLabel={t('followX')} />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {isPending ? null : session?.user ? (
          <AccountMenu
            name={session.user.name || session.user.email || ''}
            labels={{ account: t('account'), workspace: t('workspace'), referrals: t('referrals'), signOut: t('signOut') }}
            onSignOut={() => void signOut()}
          />
        ) : (
          <Link
            href="/sign-in"
            aria-label={t('signIn')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-sm whitespace-nowrap text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-gray-800 hover:shadow-lg hover:shadow-gray-900/20 active:translate-y-0 active:shadow-sm sm:px-4 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200 dark:hover:shadow-black/30"
          >
            <LogIn aria-hidden="true" className="h-4 w-4" />
            {/* 手机上只留图标：德语「Anmelden」、法语「Se connecter」放不下，
                会换行或把整条顶栏撑出屏幕；完整文字在汉堡菜单的账户区里。 */}
            <span className="hidden sm:inline">{t('signIn')}</span>
          </Link>
        )}
        {/* 开源仓库：品牌图标本身就是标签，不再加文字，窄屏收进汉堡菜单。 */}
        <a
          href="https://github.com/z7-btc/personal-book-editor-saas"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
          title="GitHub"
          className="hidden h-10 w-10 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 sm:inline-flex dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <GithubMark />
        </a>
        <div className="hidden md:block">
          <PreferencesMenu labels={{ preferences: t('preferences'), language: t('language'), theme: t('theme'), light: t('light'), dark: t('dark'), system: t('system') }} />
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          aria-label={mobileOpen ? t('closeMenu') : t('openMenu')}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-gray-300 text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 md:hidden dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          {mobileOpen ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
        </button>
      </div>
    </nav>

    {mobileOpen && (
      <MobileMenu
        signedIn={Boolean(session?.user)}
        pathname={pathname}
        labels={{
          nav: t('navSection'),
          account: t('accountSection'),
          preferences: t('preferenceSection'),
          library: t('library'),
          pricing: t('pricing'),
          faq: t('faq'),
          followX: t('followX'),
          workspace: t('workspace'),
          referrals: t('referrals'),
          signIn: t('signIn'),
          signOut: t('signOut'),
          language: t('language'),
          theme: t('theme'),
          light: t('light'),
          dark: t('dark'),
          system: t('system'),
        }}
        onSignOut={() => void signOut()}
        onClose={() => setMobileOpen(false)}
      />
    )}
  </header>;
}

function HelpMenu({ label, faqLabel, followLabel }: { label: string; faqLabel: string; followLabel: string }) {
  const { open, onOpenChange, hoverHandlers } = useHoverMenu();
  return <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
    <DropdownMenuTrigger
      {...hoverHandlers}
      className="group inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 data-[state=open]:bg-gray-100 data-[state=open]:text-gray-950 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white dark:data-[state=open]:bg-gray-800 dark:data-[state=open]:text-white"
    >
      {label}
      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 opacity-60 transition-transform group-data-[state=open]:rotate-180" />
    </DropdownMenuTrigger>
    <DropdownMenuContent {...hoverHandlers} align="start" className="min-w-[10rem] rounded-lg border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
      <DropdownMenuItem asChild className="cursor-pointer rounded-md px-2.5 py-2 text-sm focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800">
        <Link href="/faq"><CircleHelp aria-hidden="true" className="h-4 w-4" />{faqLabel}</Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild className="cursor-pointer rounded-md px-2.5 py-2 text-sm focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800">
        <a href="https://x.com/traderdonmark" target="_blank" rel="noopener noreferrer"><XMarkIcon />{followLabel}</a>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function AccountMenu({ name, labels, onSignOut }: {
  name: string;
  labels: { account: string; workspace: string; referrals: string; signOut: string };
  onSignOut: () => void;
}) {
  const { open, onOpenChange, hoverHandlers } = useHoverMenu();
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
    <DropdownMenuTrigger
      {...hoverHandlers}
      aria-label={labels.account}
      className="group inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white py-1 pr-2 pl-1 text-sm transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 data-[state=open]:border-gray-300 data-[state=open]:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600 dark:hover:bg-gray-800 dark:data-[state=open]:bg-gray-800"
    >
      <span aria-hidden="true" className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 text-xs font-semibold text-white dark:bg-gray-100 dark:text-gray-900">{initial}</span>
      <span className="hidden max-w-32 truncate lg:inline">{name}</span>
      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 opacity-60 transition-transform group-data-[state=open]:rotate-180" />
    </DropdownMenuTrigger>
    <DropdownMenuContent {...hoverHandlers} align="end" className="min-w-[11rem] rounded-lg border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
      <DropdownMenuItem asChild className="cursor-pointer rounded-md px-2.5 py-2 text-sm focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800">
        <Link href="/dashboard"><LayoutDashboard aria-hidden="true" className="h-4 w-4" />{labels.workspace}</Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild className="cursor-pointer rounded-md px-2.5 py-2 text-sm focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800">
        <Link href="/dashboard/referrals"><Gift aria-hidden="true" className="h-4 w-4" />{labels.referrals}</Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator className="bg-gray-100 dark:bg-gray-800" />
      <DropdownMenuItem onSelect={onSignOut} className="cursor-pointer rounded-md px-2.5 py-2 text-sm focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800">
        <LogOut aria-hidden="true" className="h-4 w-4" />{labels.signOut}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function PreferencesMenu({ labels }: {
  labels: { preferences: string; language: string; theme: string; light: string; dark: string; system: string };
}) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { open, onOpenChange, close, hoverHandlers } = useHoverMenu();
  const theme = useThemeChoice();

  function chooseTheme(choice: ThemeChoice) {
    applyThemeChoice(choice);
  }

  return <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
    <DropdownMenuTrigger
      {...hoverHandlers}
      aria-label={labels.preferences}
      className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 data-[state=open]:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800 dark:data-[state=open]:bg-gray-800"
    >
      <Settings2 aria-hidden="true" className="h-4 w-4" />
    </DropdownMenuTrigger>
    <DropdownMenuContent {...hoverHandlers} align="end" className="min-w-[12rem] rounded-lg border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
      <DropdownMenuLabel className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Languages aria-hidden="true" className="h-3.5 w-3.5" />{labels.language}
      </DropdownMenuLabel>
      {LOCALES.map((option) => (
        <DropdownMenuItem
          key={option.value}
          onSelect={() => {
            router.replace(`${pathname}${window.location.search}${window.location.hash}`, { locale: option.value });
            close();
          }}
          className="cursor-pointer rounded-md px-2.5 py-2 text-sm focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800"
        >
          {option.label}
          {option.value === locale && <Check aria-hidden="true" className="ml-auto h-4 w-4" />}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator className="bg-gray-100 dark:bg-gray-800" />
      <DropdownMenuLabel className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Sun aria-hidden="true" className="h-3.5 w-3.5" />{labels.theme}
      </DropdownMenuLabel>
      {THEME_CHOICES.map((option) => {
        const Icon = THEME_ICONS[option];
        return <DropdownMenuItem
          key={option}
          onSelect={() => chooseTheme(option)}
          className="cursor-pointer rounded-md px-2.5 py-2 text-sm focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800"
        >
          <Icon aria-hidden="true" className="h-4 w-4" />
          {option === 'light' ? labels.light : option === 'dark' ? labels.dark : labels.system}
          {theme === option && <Check aria-hidden="true" className="ml-auto h-4 w-4" />}
        </DropdownMenuItem>;
      })}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function MobileMenu({ signedIn, pathname, labels, onSignOut, onClose }: {
  signedIn: boolean;
  pathname: string;
  labels: {
    nav: string; account: string; preferences: string; library: string; pricing: string; faq: string; followX: string;
    workspace: string; referrals: string; signIn: string; signOut: string; language: string; theme: string;
    light: string; dark: string; system: string;
  };
  onSignOut: () => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const router = useRouter();
  const theme = useThemeChoice();

  const itemClass = (href: string) => [
    'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
    pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`))
      ? 'bg-gray-100 font-medium text-gray-950 dark:bg-gray-800 dark:text-white'
      : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800',
  ].join(' ');

  return <div id="mobile-nav" className="border-t border-gray-200 px-5 py-4 md:hidden dark:border-gray-800">
    <p className="text-xs font-medium text-gray-500 uppercase dark:text-gray-400">{labels.nav}</p>
    <div className="mt-1 grid">
      {signedIn && <Link href="/dashboard/library" onClick={onClose} className={itemClass('/dashboard/library')}><BookOpen aria-hidden="true" className="h-4 w-4" />{labels.library}</Link>}
      <Link href="/pricing" onClick={onClose} className={itemClass('/pricing')}><CreditCard aria-hidden="true" className="h-4 w-4" />{labels.pricing}</Link>
      <Link href="/faq" onClick={onClose} className={itemClass('/faq')}><CircleHelp aria-hidden="true" className="h-4 w-4" />{labels.faq}</Link>
      <a href="https://x.com/traderdonmark" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"><XMarkIcon />{labels.followX}</a>
      <a href="https://github.com/z7-btc/personal-book-editor-saas" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"><GithubMark />GitHub</a>
    </div>

    <p className="mt-4 text-xs font-medium text-gray-500 uppercase dark:text-gray-400">{labels.account}</p>
    <div className="mt-1 grid">
      {signedIn ? <>
        <Link href="/dashboard" onClick={onClose} className={itemClass('/dashboard')}><LayoutDashboard aria-hidden="true" className="h-4 w-4" />{labels.workspace}</Link>
        <Link href="/dashboard/referrals" onClick={onClose} className={itemClass('/dashboard/referrals')}><Gift aria-hidden="true" className="h-4 w-4" />{labels.referrals}</Link>
        <button type="button" onClick={() => { onClose(); onSignOut(); }} className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"><LogOut aria-hidden="true" className="h-4 w-4" />{labels.signOut}</button>
      </> : (
        <Link href="/sign-in" onClick={onClose} className={itemClass('/sign-in')}><LogIn aria-hidden="true" className="h-4 w-4" />{labels.signIn}</Link>
      )}
    </div>

    <p className="mt-4 text-xs font-medium text-gray-500 uppercase dark:text-gray-400">{labels.language}</p>
    <div className="mt-1 grid grid-cols-2 gap-1">
      {LOCALES.map((option) => <button
        key={option.value}
        type="button"
        onClick={() => { router.replace(`${pathname}${window.location.search}${window.location.hash}`, { locale: option.value }); onClose(); }}
        className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-left text-sm ${option.value === locale ? 'bg-gray-100 font-medium text-gray-950 dark:bg-gray-800 dark:text-white' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800'}`}
      >
        {option.label}
        {option.value === locale && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
      </button>)}
    </div>

    <p className="mt-4 text-xs font-medium text-gray-500 uppercase dark:text-gray-400">{labels.theme}</p>
    <div className="mt-1 grid grid-cols-3 gap-1">
      {THEME_CHOICES.map((option) => {
        const Icon = THEME_ICONS[option];
        return <button
          key={option}
          type="button"
          onClick={() => applyThemeChoice(option)}
          className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm ${theme === option ? 'bg-gray-100 font-medium text-gray-950 dark:bg-gray-800 dark:text-white' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800'}`}
        >
          <Icon aria-hidden="true" className="h-4 w-4" />
          {option === 'light' ? labels.light : option === 'dark' ? labels.dark : labels.system}
        </button>;
      })}
    </div>
  </div>;
}

function XMarkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
}
