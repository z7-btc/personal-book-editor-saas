import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { resolveToolAccess } from '@/lib/subscription/access';

/**
 * 当前登录账号的工具使用权，只回答「这次请求的人自己」。
 *
 * 给付款回跳后的成功提示轮询用：支付中心的 webhook 往往比浏览器晚几秒，
 * 页面不能凭 `checkout=returned` 就宣布开通，只能问这个接口。判定规则沿用
 * `lib/subscription/access.ts`，与页面和书籍接口是同一把尺子。
 */
export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: privateHeaders });
  }
  try {
    const access = await resolveToolAccess(session.user);
    return Response.json({ data: access }, { headers: privateHeaders });
  } catch {
    return Response.json({ error: 'access_unavailable' }, { status: 503, headers: privateHeaders });
  }
}
