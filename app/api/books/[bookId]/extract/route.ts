import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { extractChapter } from '@/lib/book-engine/pipeline/book-service.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { assertSameOrigin, readJsonBody, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

type ExtractBody = { chapters?: unknown; force?: unknown };

/**
 * POST /api/books/:bookId/extract —— 批量提取章节（不传 chapters 就是全部）。
 *
 * 单章失败不中断整批：结果里逐章标 ok/error，界面可以只重试失败的。
 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const metadata = (await ws.readBookMetadata(bookId)) as {
      chapters: Array<{ index: number }>;
    };
    const body = await readJsonBody<ExtractBody>(request);
    const only = Array.isArray(body.chapters) ? body.chapters.map(Number) : null;
    const results: Array<{ index: number; ok: boolean; chunks?: number; cached?: boolean; error?: string }> = [];
    for (const chapter of metadata.chapters) {
      if (only && !only.includes(chapter.index)) continue;
      try {
        const r = (await extractChapter(bookId, chapter.index, {
          force: Boolean(body.force),
        })) as { chunks?: unknown[]; cached?: boolean };
        results.push({ index: chapter.index, ok: true, chunks: r.chunks?.length ?? 0, cached: r.cached });
      } catch (err) {
        results.push({ index: chapter.index, ok: false, error: (err as Error).message });
      }
    }
    return { results };
  });
}
