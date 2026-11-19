import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { ValidationError } from '@/lib/book-engine/util/errors.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { selectChapters } from '@/lib/book-store/book-view';
import { startBookJob } from '@/lib/book-store/job-runner';
import {
  assertSameOrigin,
  privateHeaders,
  readJsonBody,
  withBookApi,
} from '@/lib/book-store/api-helpers';

type RewriteBody = {
  bookId?: string;
  chapters?: unknown;
  mode?: string;
  resume?: unknown;
};

/**
 * POST /api/rewrite —— 批量改写。
 *
 * body: { bookId, chapters?, mode?, resume? }
 * 不传 chapters 时按 mode 自动挑章节（all / pending / failed / resume）。
 * resume 语义：接着上次跑，复用已保存的 chunk 结果；mode=all 是全部重做，不复用。
 */
export async function POST(request: Request) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const body = await readJsonBody<RewriteBody>(request);
    const bookId = assertSafeBookId(String(body.bookId || ''));
    const metadata = await ws.readBookMetadata(bookId);
    const mode = body.mode || 'all';

    let chapters: number[];
    if (Array.isArray(body.chapters) && body.chapters.length) {
      chapters = body.chapters
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
    } else {
      chapters = await selectChapters(bookId, metadata, mode);
    }
    if (!chapters.length) throw new ValidationError('没有需要处理的章节');

    const resume = body.resume !== undefined ? Boolean(body.resume) : mode !== 'all';
    const job = await startBookJob({
      userId,
      bookId,
      kind: 'rewrite',
      chapters,
      resume,
      mode,
    });
    return Response.json({ job }, { status: 202, headers: privateHeaders });
  });
}
