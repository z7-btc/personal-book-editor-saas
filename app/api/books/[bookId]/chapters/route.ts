import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { readUntouchedChapters } from '@/lib/book-engine/pipeline/plan-untouched.js';
import { noTextReason } from '@/lib/book-engine/epub/chapter-info.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { readMetadataUpgraded } from '@/lib/book-store/book-view';
import { withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

type ChapterStatusLike = {
  stage?: string;
  chunkTotal?: number;
  chunkDone?: number;
  quality?: unknown;
  usage?: unknown;
  error?: string | null;
  rewrittenChars?: number;
  note?: string | null;
  updatedAt?: string | null;
};

/**
 * GET /api/books/:bookId/chapters —— 逐章明细（工作台章节列表）。
 *
 * 整理方案要求原样保留/删除的章节也标 skipped：
 * 否则同一个页面上书库卡片说"进度 100%"，逐章明细却还挂着"待处理"。
 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const metadata = await readMetadataUpgraded(bookId);
    const untouched = (await readUntouchedChapters(bookId)) as Set<number>;
    const chapters = [];
    for (const chapter of metadata.chapters) {
      const status = (await ws.readChapterStatus(bookId, chapter.index)) as ChapterStatusLike | null;
      const keepByPlan = untouched.has(Number(chapter.index));
      chapters.push({
        ...chapter,
        stage:
          chapter.rewritable === false || keepByPlan
            ? 'skipped'
            : status?.stage || 'pending',
        note:
          chapter.rewritable === false
            ? status?.note ||
              `${noTextReason(chapter.kind) || '这一页没有正文内容'}（导出时会原样保留）`
            : keepByPlan
              ? '整理方案要求原样保留（导出时用原文）'
              : status?.note || null,
        chunkTotal: status?.chunkTotal ?? 0,
        chunkDone: status?.chunkDone ?? 0,
        quality: status?.quality || null,
        usage: status?.usage || null,
        error: chapter.rewritable === false || keepByPlan ? null : status?.error || null,
        rewrittenChars: status?.rewrittenChars || 0,
        updatedAt: status?.updatedAt || null,
      });
    }
    const rewritableCount = metadata.chapters.filter((c) => c.rewritable !== false).length;
    return {
      chapters,
      summary: {
        total: metadata.chapters.length,
        rewritable: rewritableCount,
        noText: metadata.chapters.length - rewritableCount,
      },
    };
  });
}
