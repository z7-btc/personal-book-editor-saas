import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { startBookJob } from '@/lib/book-store/job-runner';
import {
  assertSameOrigin,
  parseChapterIndex,
  privateHeaders,
  withBookApi,
} from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string; index: string }> };

/** POST /api/books/:bookId/chapters/:index/retry —— 重试失败的单章。 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const { bookId, index } = await params;
    assertSafeBookId(bookId);
    const chapterIndex = parseChapterIndex(index);
    const job = await startBookJob({
      userId,
      bookId,
      kind: 'rewrite',
      chapters: [chapterIndex],
      mode: 'retry',
    });
    return Response.json({ job }, { status: 202, headers: privateHeaders });
  });
}
