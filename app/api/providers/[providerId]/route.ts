import {
  backupProviders,
  loadProviders,
  maskProvider,
  normalizeProvider,
  saveProviders,
} from '@/lib/book-engine/config/providers.js';
import { NotFoundError } from '@/lib/book-engine/util/errors.js';
import { assertSameOrigin, readJsonBody, withBookApi } from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

type Params = { params: Promise<{ providerId: string }> };
type ProviderLike = { id: string; apiKey?: string; [key: string]: unknown };
type ProvidersFile = { activeId: string | null; providers: ProviderLike[] };

/** PUT / PATCH /api/providers/:providerId —— 改配置（覆盖 Key 前先备份）。 */
export async function PUT(request: Request, { params }: Params) {
  return updateProvider(request, params);
}

export async function PATCH(request: Request, { params }: Params) {
  return updateProvider(request, params);
}

async function updateProvider(request: Request, params: Params['params']) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { providerId } = await params;
    const body = await readJsonBody<{ provider?: Record<string, unknown> }>(request);
    const data = (await loadProviders(projectRoot())) as ProvidersFile;
    const idx = data.providers.findIndex((p) => p.id === providerId);
    if (idx < 0) throw new NotFoundError('Provider 不存在');
    // 引擎是纯 JS：第二个参数的 JSDoc 推断不出对象类型，这里补个签名
    const normalize = normalizeProvider as unknown as (
      input: Record<string, unknown>,
      existing?: ProviderLike | null,
    ) => ProviderLike;
    const next = normalize(
      { ...(body.provider || (body as Record<string, unknown>)), id: providerId },
      data.providers[idx],
    );
    // 改配置可能覆盖 API Key，先备份
    if (next.apiKey !== data.providers[idx].apiKey) {
      await backupProviders(projectRoot(), 'edit-provider-key');
    }
    data.providers[idx] = next;
    await saveProviders(projectRoot(), data);
    return { provider: maskProvider(data.providers[idx]) };
  });
}

/** DELETE /api/providers/:providerId —— 删 Provider（删前备份，避免手误弄丢唯一一份 Key）。 */
export async function DELETE(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { providerId } = await params;
    const data = (await loadProviders(projectRoot())) as ProvidersFile;
    await backupProviders(projectRoot(), 'delete-provider');
    data.providers = data.providers.filter((p) => p.id !== providerId);
    if (data.activeId === providerId) data.activeId = data.providers[0]?.id || null;
    await saveProviders(projectRoot(), data);
    return { ok: true, activeId: data.activeId };
  });
}
