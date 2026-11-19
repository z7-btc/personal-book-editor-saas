import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { startBookJob } from '@/lib/book-store/job-runner';
import {
  assertSameOrigin,
  privateHeaders,
  withBookApi,
} from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

type PlanLike = { entries?: unknown[]; [key: string]: unknown };

/**
 * GET /api/books/:bookId/plan —— 读整理方案。
 *
 * 顺手按当前 entries 重算 counts/values/warnings：
 * 存下来的那份是规划那一刻的快照，事后动过 entries 就会和事实对不上。
 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const plan = (await ws.readBookPlan(bookId).catch(() => null)) as PlanLike | null;
    const { summarizePlan } = (await import('@/lib/book-engine/pipeline/book-plan.js')) as {
      summarizePlan(plan: PlanLike): unknown;
    };
    return { plan: plan ? summarizePlan(plan) : null };
  });
}

/**
 * POST /api/books/:bookId/plan —— 让模型读完整本书，生成整理方案。
 * 几十次调用的长任务，走任务队列。
 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const { bookId } = await params;
    assertSafeBookId(bookId);
    await ws.readBookMetadata(bookId); // 书不存在时给出 404
    const job = await startBookJob({ userId, bookId, kind: 'plan' });
    return Response.json({ job }, { status: 202, headers: privateHeaders });
  });
}
