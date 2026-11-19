import { listProviderBackups } from '@/lib/book-engine/config/providers.js';
import { withBookApi } from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

/** GET /api/providers/backups —— 列出 Provider 配置的备份（方便手动找回 Key）。 */
export async function GET(request: Request) {
  return withBookApi(request, async () => {
    return { backups: await listProviderBackups(projectRoot()) };
  });
}
