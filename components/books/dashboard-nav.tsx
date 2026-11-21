'use client';

import { useTranslations } from 'next-intl';
import { BookOpen, CreditCard, FileText, KeyRound, SlidersHorizontal, UserCog, UserRound, Activity } from 'lucide-react';
import { Link, usePathname } from '@/i18n/navigation';

/**
 * 控制台侧栏。
 *
 * 八个入口以前是一根竖着的平铺列表，看不出哪些是「读书用的」、哪些是
 * 「管账号的」。现在分成两组：阅读（书库、阅读画像、提示词模板、AI 模型设置）
 * 和账户（账单、账户、安全、活动），并且高亮当前页——以前点进哪一页，
 * 侧栏都长得一样。
 *
 * 窄屏下变成一条可横向滑动的胶囊条，分组之间用细线隔开，不再把八项挤进
 * 一行小字里。
 */
export default function DashboardNav() {
  const t = useTranslations('Books');
  const tNav = useTranslations('DashboardNav');
  const pathname = usePathname();

  const groups = [
    {
      title: tNav('group.reading'),
      items: [
        { href: '/dashboard/library', label: t('nav.library'), icon: BookOpen },
        { href: '/dashboard/profile', label: t('nav.profile'), icon: UserRound },
        { href: '/dashboard/prompts', label: t('nav.prompts'), icon: FileText },
        { href: '/dashboard/settings', label: t('nav.settings'), icon: SlidersHorizontal },
      ],
    },
    {
      title: tNav('group.account'),
      items: [
        { href: '/dashboard/billing', label: tNav('billing'), icon: CreditCard },
        { href: '/dashboard/general', label: tNav('account'), icon: UserCog },
        { href: '/dashboard/security', label: tNav('security'), icon: KeyRound },
        { href: '/dashboard/activity', label: tNav('activity'), icon: Activity },
      ],
    },
  ];

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return <aside aria-label={tNav('aria')}>
    {/* 桌面：分组竖排 */}
    <nav className="hidden md:block">
      {groups.map((group, index) => <div key={group.title} className={index ? 'mt-6' : ''}>
        <p className="px-3 text-xs font-medium text-gray-500 dark:text-gray-400">{group.title}</p>
        <div className="mt-1.5 space-y-0.5">
          {group.items.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${active
                ? 'bg-gray-900 font-medium text-white dark:bg-gray-100 dark:text-gray-900'
                : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white'}`}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>;
          })}
        </div>
      </div>)}
    </nav>

    {/* 窄屏：横向胶囊条，分组之间用细线隔开 */}
    <nav aria-label={tNav('aria')} className="flex w-full max-w-full items-center gap-1.5 overflow-x-auto pb-1 md:hidden">
      {groups.map((group, index) => <div key={group.title} className={`flex shrink-0 items-center gap-1.5 ${index ? 'border-l border-gray-200 pl-2 dark:border-gray-700' : ''}`}>
        {group.items.map((item) => {
          const active = isActive(item.href);
          return <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors ${active
              ? 'bg-gray-900 font-medium text-white dark:bg-gray-100 dark:text-gray-900'
              : 'bg-white text-gray-700 hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'}`}
          >
            {item.label}
          </Link>;
        })}
      </div>)}
    </nav>
  </aside>;
}
