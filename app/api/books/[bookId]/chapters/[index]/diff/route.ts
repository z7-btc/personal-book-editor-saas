import { readChapterTexts } from '@/lib/book-engine/pipeline/book-service.js';
import { extractBodyText } from '@/lib/book-engine/pipeline/rewrite.js';
import { diffParagraphs } from '@/lib/book-engine/pipeline/quality.js';
import { NotFoundError } from '@/lib/book-engine/util/errors.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { parseChapterIndex, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string; index: string }> };

/** GET /api/books/:bookId/chapters/:index/diff —— 原文与改写稿逐段比对。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId, index } = await params;
    assertSafeBookId(bookId);
    const chapterIndex = parseChapterIndex(index);
    const texts = (await readChapterTexts(bookId, chapterIndex)) as {
      original?: string | null;
      rewritten?: string | null;
    };
    if (!texts.original || !texts.rewritten) {
      throw new NotFoundError('该章尚未完成改写，无法比较');
    }
    const original = extractBodyText(texts.original) as string;
    const rewritten = extractBodyText(texts.rewritten) as string;
    return {
      diff: diffParagraphs(original, rewritten),
      originalChars: original.replace(/\s+/g, '').length,
      rewrittenChars: rewritten.replace(/\s+/g, '').length,
    };
  });
}
