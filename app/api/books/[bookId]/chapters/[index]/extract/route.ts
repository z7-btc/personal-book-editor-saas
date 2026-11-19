import { extractChapter } from '@/lib/book-engine/pipeline/book-service.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import {
  assertSameOrigin,
  parseChapterIndex,
  readJsonBody,
  withBookApi,
} from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string; index: string }> };

/** 落盘/回传给前端的 chunk 摘要（DOM 引用不能进响应体）。 */
type ChunkSummary = {
  index: number;
  id: string;
  headingPath: string;
  nextHeading: string | null;
  charCount: number;
  blockIndexes: number[];
};

type ExtractResult = {
  cached: boolean;
  chunks: Array<Partial<ChunkSummary> & { entries?: unknown; blockIndexes?: number[] }>;
  status: unknown;
  skipped?: Array<{ tag: string; reason: string; path?: string; textLength?: number }>;
};

/** 新提取的 chunk 带 DOM 引用，缓存命中的是磁盘上的摘要——统一成摘要形状。 */
function toSummary(c: ExtractResult['chunks'][number]): ChunkSummary {
  return {
    index: Number(c.index || 0),
    id: String(c.id || ''),
    headingPath: String(c.headingPath || ''),
    nextHeading: (c.nextHeading as string | null) ?? null,
    charCount: Number(c.charCount || 0),
    blockIndexes: Array.isArray(c.blockIndexes) ? c.blockIndexes : [],
  };
}

/** POST /api/books/:bookId/chapters/:index/extract —— 提取单章的分块。 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { bookId, index } = await params;
    assertSafeBookId(bookId);
    const chapterIndex = parseChapterIndex(index);
    const body = await readJsonBody<{ force?: unknown }>(request);
    const result = (await extractChapter(bookId, chapterIndex, {
      force: Boolean(body.force),
    })) as ExtractResult;
    return {
      cached: result.cached,
      chunks: result.chunks.map(toSummary),
      status: result.status,
      // skipped 里是 DOM 节点引用（带循环的 parentNode），不能直接塞进响应体
      skipped: (result.skipped || []).map((s) => ({
        tag: s.tag,
        reason: s.reason,
        path: s.path,
        textLength: s.textLength,
      })),
    };
  });
}
