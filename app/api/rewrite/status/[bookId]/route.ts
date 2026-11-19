import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { countRemaining, readMetadataUpgraded } from '@/lib/book-store/book-view';
import { activeJobForBook } from '@/lib/book-store/job-runner';
import { withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

type PendingWorkLike = {
  reason?: string;
  updatedAt?: string;
  remaining?: number;
  partialChapters?: number[];
  failedChapters?: number[];
};

/**
 * GET /api/rewrite/status/:bookId —— 「还有多少没做」，给「继续处理」按钮用。
 *
 * 连同「上次是怎么停下来的」一起返回，界面能说明原因而不是干巴巴一个按钮。
 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const metadata = await readMetadataUpgraded(bookId);
    const detail = await countRemaining(bookId, metadata);
    const pending = (await ws.readPendingWork(bookId)) as PendingWorkLike | null;
    return {
      ...detail,
      pending: pending
        ? {
            reason: pending.reason,
            updatedAt: pending.updatedAt,
            remaining: pending.remaining,
            partialChapters: pending.partialChapters || [],
            failedChapters: pending.failedChapters || [],
          }
        : null,
      // 有任务正在跑时不该再提示「继续处理」
      running: activeJobForBook(bookId),
    };
  });
}
