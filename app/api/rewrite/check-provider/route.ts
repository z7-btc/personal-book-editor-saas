import {
  getProvider,
  maskProvider,
  validateProvider,
} from '@/lib/book-engine/config/providers.js';
import { assertSameOrigin, readJsonBody, withBookApi } from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

type ProviderLike = { id: string; [key: string]: unknown };

/**
 * POST /api/rewrite/check-provider —— 发起任务前先验证 Provider 可用。
 *
 * 只做本地校验（不发请求，不花钱）；真正的连通性测试在 /api/providers/:id/test。
 */
export async function POST(request: Request) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const body = await readJsonBody<{ providerId?: string | null }>(request);
    const provider = (await getProvider(projectRoot(), body.providerId || null)) as ProviderLike | null;
    const errors = validateProvider(provider) as string[];
    return { ok: errors.length === 0, errors, provider: maskProvider(provider) };
  });
}
