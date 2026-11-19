import { loadProfile } from '@/lib/book-engine/config/profile.js';
import { readProfileSnapshot } from '@/lib/book-engine/pipeline/book-service.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { withBookApi } from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

type Params = { params: Promise<{ bookId: string }> };

/**
 * GET /api/books/:bookId/profile-snapshot —— 导入时冻结的读者画像快照。
 *
 * 界面要能证明「你的画像确实被用了」，否则用户会以为自己填的没生效。
 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const live = await loadProfile(projectRoot());
    return { snapshot: await readProfileSnapshot(bookId, live) };
  });
}
