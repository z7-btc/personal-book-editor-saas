import { loadProfile, saveProfile } from '@/lib/book-engine/config/profile.js';
import { assertSameOrigin, readJsonBody, withBookApi } from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

/** GET /api/profile —— 当前用户的读者画像。 */
export async function GET(request: Request) {
  return withBookApi(request, async () => {
    return { profile: await loadProfile(projectRoot()) };
  });
}

/** PUT / POST /api/profile —— 保存画像（引擎会做归一化与校验）。 */
export async function PUT(request: Request) {
  return writeProfile(request);
}

export async function POST(request: Request) {
  return writeProfile(request);
}

async function writeProfile(request: Request) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const body = await readJsonBody<{ profile?: unknown }>(request);
    // 配置类函数内部按用户上下文落盘（见 book-engine/config/settings.js 的 configDir）
    const profile = await saveProfile(projectRoot(), body.profile || body);
    return { profile };
  });
}
