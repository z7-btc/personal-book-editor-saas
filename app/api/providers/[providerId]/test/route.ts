import {
  getProvider,
  loadProviders,
  saveProviders,
  validateProvider,
} from '@/lib/book-engine/config/providers.js';
import { testProvider } from '@/lib/book-engine/llm/client.js';
import { NotFoundError, ValidationError } from '@/lib/book-engine/util/errors.js';
import { assertSameOrigin, withBookApi } from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

type Params = { params: Promise<{ providerId: string }> };
type ProviderLike = { id: string; lastTest?: unknown; [key: string]: unknown };
type ProvidersFile = { activeId: string | null; providers: ProviderLike[] };

/**
 * POST /api/providers/:providerId/test —— 连通性测试。
 *
 * 真发一次最小请求；结果（含耗时/模型回复）写回该 Provider 的 lastTest。
 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { providerId } = await params;
    const provider = (await getProvider(projectRoot(), providerId)) as ProviderLike | null;
    if (!provider) throw new NotFoundError('Provider 不存在');
    const errors = validateProvider(provider) as string[];
    if (errors.length) throw new ValidationError(errors.join('；'));
    const result = await testProvider(provider);
    const data = (await loadProviders(projectRoot())) as ProvidersFile;
    const target = data.providers.find((p) => p.id === provider.id);
    if (target) {
      target.lastTest = { ...(result as Record<string, unknown>), at: new Date().toISOString() };
      await saveProviders(projectRoot(), data);
    }
    return { result };
  });
}
