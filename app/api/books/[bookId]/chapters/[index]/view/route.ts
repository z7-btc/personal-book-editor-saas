import {
  readChapterPreview,
  readChapterTexts,
} from '@/lib/book-engine/pipeline/book-service.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { parseChapterIndex, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string; index: string }> };

/**
 * GET /api/books/:bookId/chapters/:index/view?mode=original|rewritten
 *
 * 拿不到要求的版本时退回原书预览（与原项目一致）。
 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId, index } = await params;
    assertSafeBookId(bookId);
    const chapterIndex = parseChapterIndex(index);
    const mode = new URL(request.url).searchParams.get('mode') || 'original';
    const texts = (await readChapterTexts(bookId, chapterIndex)) as {
      original?: string | null;
      rewritten?: string | null;
    };
    const source = mode === 'rewritten' ? texts.rewritten : texts.original;
    if (!source) {
      // 尚未提取 / 尚未改写 => 直接从原书读
      const preview = (await readChapterPreview(bookId, chapterIndex)) as {
        xhtml: string;
        chapter: unknown;
      };
      return { mode: 'original', xhtml: preview.xhtml, chapter: preview.chapter };
    }
    return { mode, xhtml: source };
  });
}
