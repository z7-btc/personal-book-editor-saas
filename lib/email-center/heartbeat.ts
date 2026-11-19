import 'server-only';
import { z } from 'zod';
import { requireCapability } from '@/lib/config';

/**
 * 「我们跟邮件中心还通得上吗」——**只有这一份判据**。
 *
 * 两个地方要用它，而且必须给同一个答案：
 * - `/api/ready` 的健康报告（够不着就把 emailApplication 报成 unreachable）
 * - 常驻 runner 的保活心跳（见下）
 *
 * 为什么要有心跳这回事：邮件中心仪表盘上那个「已接通 / 接入失败」看的是
 * `applications.lastApiUsedAt`——**15 分钟内有没有被服务端 Bearer 调过**。
 * 而写这个字段的只有 `authenticateIntegration` 一处，也就是**只有"同步联系人"
 * 这条路会写它**；widget 走公开 key，永远不刷新。
 *
 * 于是同步队列一空（低流量站：没人注册），牌子就在 15 分钟后自动变红，看上去像
 * "对接失败"，其实什么都没坏。见 memory「邮件中心徽章是 15 分钟心跳」。
 *
 * 心跳补上缺的那一半：**没数据要送的时候，也定期报到一次。**
 * 它认的是服务端 Bearer key，所以这一趟顺带验证了"钥匙还对、两台服务器之间通"——
 * 这正是「已接通」该有的意思：**能通就是好，而不是"最近有人来过才算好"**。
 *
 * ⚠️ 这是"真信号"不是"假绿"：心跳由本站服务端**常驻**发出，本站一停或钥匙一失效，
 * 15 分钟后牌子照样会红。区别在于——**过去只有"有用户注册"才算活着，
 * 现在"服务还在、还连得上"就算活着**。
 *
 * 失败一律抛错，由调用方决定怎么记：runner 记一条 warn（探活失败本身就是想被看见的
 * 信号，不该悄悄咽掉），`/api/ready` 把它收成一个 `false`。
 */
export type EmailHeartbeat = { applicationId: number };

// 认回执的形状，不只是看状态码：2xx 也可能是别的东西（代理的欢迎页、被换掉的实现）。
// 这里要求的正是我们真正依赖的三样——连上了、有应用 id、对端支持联系人对账 v1。
// `/api/ready` 早先手写的检查就是这三条，抽出来时一条没少。
const responseSchema = z.object({
  data: z.object({
    connected: z.literal(true),
    applicationId: z.number().int().positive(),
    capabilities: z.object({ contactReconciliation: z.literal('v1') }),
  }),
});

export async function verifyEmailCenterConnection(
  options: { send?: typeof fetch } = {},
): Promise<EmailHeartbeat> {
  requireCapability('emailCenter');
  const endpoint = new URL('/api/v1/integrations/verify', process.env.EMAIL_CENTER_URL);
  // 钥匙在 Authorization 头里，生产环境绝不允许走明文。
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
    throw new Error('EMAIL_CENTER_INSECURE_ENDPOINT');
  }

  const send = options.send ?? fetch;
  const response = await send(endpoint, {
    method: 'POST',
    redirect: 'error',
    cache: 'no-store',
    // 5 秒：这一趟只是让对方查一次库再写一个时间戳。健康检查也会走它，
    // 给太长会把 `/api/ready` 一起拖住。
    signal: AbortSignal.timeout(5_000),
    headers: { Authorization: `Bearer ${process.env.EMAIL_CENTER_API_KEY}` },
  });
  if (!response.ok) throw new Error(`EMAIL_CENTER_VERIFY_HTTP_${response.status}`);

  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('EMAIL_CENTER_INVALID_VERIFY_RESPONSE');

  return { applicationId: parsed.data.data.applicationId };
}
