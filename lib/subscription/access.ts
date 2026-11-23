import 'server-only';
import { getCapabilities } from '@/lib/config';
import { ensurePersonalWorkspace } from '@/lib/workspace/bootstrap';
import { hasUnexpiredPaidPeriod } from './service';

/**
 * 工具使用权的唯一判定口。
 *
 * 定价页写的是「每月 1 美元使用这个工具：书库、整理方案、逐章改写、导出都在内」，
 * 那么没有有效订阅的账号就一个都不该能用——API 层（`withBookApi`）和页面层
 * （`guardToolPage`）都从这里取答案，两边规则不会走偏。
 *
 * 两个运维开关：
 * - `SUBSCRIPTION_ENFORCEMENT=off`：紧急放行全部账号（支付中心故障、回调积压时
 *   先别把所有人挡在门外），改完不用发版。
 * - `SUBSCRIPTION_EXEMPT_EMAILS`：逗号分隔的邮箱白名单，给开发者自己或客服账号
 *   留口子。只读环境变量，不接受请求里传来的值。
 *
 * 支付中心没配置齐全时一律不拦：开源自建的用户不该被一个他们没接的收费系统锁死。
 */

export type ToolAccess = {
  /** 这次判定是否真的执行了订阅检查。 */
  enforced: boolean;
  allowed: boolean;
  reason: 'active' | 'exempt' | 'inactive' | 'not_enforced';
};

export function subscriptionGateEnabled(): boolean {
  if ((process.env.SUBSCRIPTION_ENFORCEMENT || '').trim().toLowerCase() === 'off') return false;
  return getCapabilities().paymentCenter.configured;
}

function exemptEmails(): Set<string> {
  return new Set(
    (process.env.SUBSCRIPTION_EXEMPT_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function resolveToolAccess(
  user: { id: string; email?: string | null; name?: string | null },
): Promise<ToolAccess> {
  if (!subscriptionGateEnabled()) {
    return { enforced: false, allowed: true, reason: 'not_enforced' };
  }
  const email = (user.email || '').trim().toLowerCase();
  if (email && exemptEmails().has(email)) {
    return { enforced: true, allowed: true, reason: 'exempt' };
  }
  const workspace = await ensurePersonalWorkspace(user.id, user.name || '');
  const active = await hasUnexpiredPaidPeriod(workspace.id);
  return { enforced: true, allowed: active, reason: active ? 'active' : 'inactive' };
}

/** 给页面用的版本：没订阅就跳定价页，带上原因让定价页说明。 */
export function subscriptionRequiredRedirect(locale: string): string {
  return `/${locale}/pricing?need=subscription`;
}
