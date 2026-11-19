import { exportBook } from '@/lib/book-engine/pipeline/book-service.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { collectCompletedChapters, decorate } from '@/lib/book-store/book-view';
import { syncBookIndex } from '@/lib/book-store/book-index';
import { assertSameOrigin, readJsonBody, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

type ExportBody = { chapters?: unknown; fileName?: unknown };

/**
 * POST /api/books/:bookId/export —— 生成成品 EPUB。
 *
 * 不传 chapters 时默认只导出已完成的章节（原项目行为）。
 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const body = await readJsonBody<ExportBody>(request);
    const chapters =
      Array.isArray(body.chapters) && body.chapters.length
        ? body.chapters.map(Number)
        : await collectCompletedChapters(bookId);
    const result = await exportBook({
      bookId,
      chapters,
      fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
    });
    await syncBookIndex(userId, bookId);
    return { export: result, book: await decorate(bookId) };
  });
}
