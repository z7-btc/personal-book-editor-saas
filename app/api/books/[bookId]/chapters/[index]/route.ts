import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { parseChapterIndex, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string; index: string }> };

/** GET /api/books/:bookId/chapters/:index —— 章节状态 + 分块结果。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId, index } = await params;
    assertSafeBookId(bookId);
    const chapterIndex = parseChapterIndex(index);
    const status = await ws.readChapterStatus(bookId, chapterIndex);
    const chunks = await ws.readChapterChunks(bookId, chapterIndex).catch(() => null);
    return { status, chunks };
  });
}
