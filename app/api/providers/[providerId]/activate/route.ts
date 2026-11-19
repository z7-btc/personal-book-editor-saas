import { loadProviders, saveProviders } from '@/lib/book-engine/config/providers.js';
import { NotFoundError } from '@/lib/book-engine/util/errors.js';
import { assertSameOrigin, withBookApi } from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

type Params = { params: Promise<{ providerId: string }> };
type ProviderLike = { id: string };
type ProvidersFile = { activeId: string | null; providers: ProviderLike[] };

/** POST /api/providers/:providerId/activate —— 切换当前使用的 Provider。 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { providerId } = await params;
    const data = (await loadProviders(projectRoot())) as ProvidersFile;
    if (!data.providers.some((p) => p.id === providerId)) {
      throw new NotFoundError('Provider 不存在');
    }
    data.activeId = providerId;
    await saveProviders(projectRoot(), data);
    return { activeId: data.activeId };
  });
}
