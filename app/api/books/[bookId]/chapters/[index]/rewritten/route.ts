import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { assertSameOrigin, parseChapterIndex, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string; index: string }> };

type ChapterStatusLike = {
  stage?: string;
  quality?: unknown;
  rewrittenChars?: number;
  error?: string | null;
  [key: string]: unknown;
};

/** DELETE /api/books/:bookId/chapters/:index/rewritten —— 清掉这章的改写稿，回到待处理。 */
export async function DELETE(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { bookId, index } = await params;
    assertSafeBookId(bookId);
    const chapterIndex = parseChapterIndex(index);
    await ws.clearChapterRewritten(bookId, chapterIndex);
    const status = (await ws.readChapterStatus(bookId, chapterIndex)) as ChapterStatusLike | null;
    if (status) {
      status.stage = 'pending';
      status.quality = null;
      status.rewrittenChars = 0;
      status.error = null;
      await ws.writeChapterStatus(bookId, chapterIndex, status);
    }
    return { ok: true };
  });
}
