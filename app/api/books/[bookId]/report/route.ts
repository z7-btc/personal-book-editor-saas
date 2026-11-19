import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { getReport } from '@/lib/book-store/book-view';
import { withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

/**
 * GET /api/books/:bookId/report?deep=1 —— 「整理结果」报告。
 *
 * 计算一次约 1.6 秒，book-view 里做了 10 秒短缓存（按成品修改时间失效）。
 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    await ws.readBookMetadata(bookId); // 书不存在时给出 404
    const deep = new URL(request.url).searchParams.get('deep') === '1';
    return { report: await getReport(bookId, deep) };
  });
}
