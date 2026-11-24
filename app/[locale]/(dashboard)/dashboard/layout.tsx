import { getLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { resolveToolAccess } from '@/lib/subscription/access';
import { JobDock, JobsProvider } from '@/components/books/jobs-provider';
import { CheckoutReturnNotice } from '@/components/billing/checkout-return-notice';
import DashboardNav from '@/components/books/dashboard-nav';
import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  const locale = await getLocale();
  if (!session) redirect(`/${locale}/sign-in`);

  // 没订阅的账号不进书库，任务轮询也没必要开：接口本来就会回 402。
  const access = await resolveToolAccess(session.user);

  return (
    <JobsProvider enabled={access.allowed}>
      <div className="mx-auto grid min-h-[calc(100vh-72px)] max-w-7xl gap-8 px-5 py-8 md:grid-cols-[210px_1fr]">
        {/* `min-w-0` keeps the mobile pill row from widening the grid column:
            a grid item defaults to `min-width: auto`, which would let the
            scroll container grow to its content and push the whole page
            sideways instead of scrolling inside itself. */}
        <div className="min-w-0 max-w-full md:sticky md:top-6 md:self-start">
          <DashboardNav />
        </div>
        <main className="min-w-0">{children}</main>
      </div>
      <JobDock />
      {/* 付款回跳的成功提示：只在 `?checkout=returned` 时出现，其他页面不渲染。 */}
      <CheckoutReturnNotice initialAccess={access} />
    </JobsProvider>
  );
}
