import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  const locale = await getLocale();
  if (!session) redirect(`/${locale}/sign-in`);
  const t = await getTranslations('DashboardNav');

  // 侧栏只放"控制台内部"的账户页。控制台首页和邀请返佣都挪到页头了，
  // 同一个入口不在两处各摆一份，用户不用猜该点哪个。
  const navigation = [
    ['/dashboard/billing', t('billing')],
    ['/dashboard/general', t('account')],
    ['/dashboard/security', t('security')],
    ['/dashboard/activity', t('activity')],
  ];

  return (
    <div className="mx-auto grid min-h-[calc(100vh-72px)] max-w-7xl gap-8 px-5 py-8 md:grid-cols-[200px_1fr]">
      <aside aria-label={t('aria')} className="flex gap-4 overflow-x-auto md:flex-col">
        {navigation.map(([href, label]) => (
          <Link key={href} href={href} className="rounded-lg px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800">
            {label}
          </Link>
        ))}
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
