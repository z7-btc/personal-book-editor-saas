import {
  PROVIDER_PRESETS,
  backupProviders,
  loadProviders,
  maskProvider,
  normalizeProvider,
  providersPath,
  saveProviders,
} from '@/lib/book-engine/config/providers.js';
import {
  assertSameOrigin,
  privateHeaders,
  readJsonBody,
  withBookApi,
} from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

type ProviderLike = {
  id: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  [key: string]: unknown;
};
type ProvidersFile = { activeId: string | null; providers: ProviderLike[] };

/** GET /api/providers —— Provider 列表（Key 一律打码）+ 预设 + 存档路径。 */
export async function GET(request: Request) {
  return withBookApi(request, async () => {
    const data = (await loadProviders(projectRoot())) as ProvidersFile;
    return {
      activeId: data.activeId,
      providers: data.providers.map(maskProvider),
      presets: PROVIDER_PRESETS,
      // 把 Key 存在哪告诉前端，用户才能自己确认「不是临时的」
      configPath: providersPath(projectRoot()),
    };
  });
}

/** POST /api/providers —— 新增一个 Provider（先备份再写）。 */
export async function POST(request: Request) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const body = await readJsonBody<{ provider?: Record<string, unknown> }>(request);
    const data = (await loadProviders(projectRoot())) as ProvidersFile;
    const provider = normalizeProvider(body.provider || body) as ProviderLike;
    // 这份文件里有 API Key、不在版本控制里，覆盖了就找不回来
    await backupProviders(projectRoot(), 'add-provider');
    data.providers.push(provider);
    data.activeId = data.activeId || provider.id;
    const saved = (await saveProviders(projectRoot(), data)) as ProvidersFile;
    return Response.json(
      { provider: maskProvider(provider), activeId: saved.activeId },
      { status: 201, headers: privateHeaders },
    );
  });
}
