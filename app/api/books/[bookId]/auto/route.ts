import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { startBookJob } from '@/lib/book-store/job-runner';
import {
  assertSameOrigin,
  privateHeaders,
  withBookApi,
} from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

/**
 * POST /api/books/:bookId/auto —— 一键整理：方案 → 逐章改写 → 导出。
 *
 * 合成一个任务而不是前端串三次：关掉页面链路就断了，
 * 而且中间任何一步失败都没人接着做。
 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const { bookId } = await params;
    assertSafeBookId(bookId);
    await ws.readBookMetadata(bookId); // 书不存在时给出 404
    const job = await startBookJob({ userId, bookId, kind: 'auto' });
    return Response.json({ job }, { status: 202, headers: privateHeaders });
  });
}
