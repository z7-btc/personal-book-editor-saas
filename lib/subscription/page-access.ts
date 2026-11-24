import 'server-only';
import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { resolveToolAccess, subscriptionRequiredRedirect } from './access';

/**
 * 工具页面（书库、书籍详情、阅读画像、提示词、模型设置）的入口闸门。
 *
 * 没登录 → 登录页；登录了但订阅无效 → 定价页并写明原因。账户类的页面
 * （账单、账户、安全、活动、邀请）不走这里：不付钱也得能买、能看账单。
 */
export async function guardToolPage(): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  const locale = await getLocale();
  if (!session) redirect(`/${locale}/sign-in`);
  const access = await resolveToolAccess(session.user);
  if (!access.allowed) redirect(subscriptionRequiredRedirect(locale));
}
