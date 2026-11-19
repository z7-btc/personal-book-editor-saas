import 'server-only';

/**
 * 书籍任务的"调度台"：引擎的内存任务 + 数据库里的任务记录。
 *
 * 引擎的 JobManager 是单进程内存实现（暂停靠 AbortController、进度在内存里），
 * 带着一整套改写流水线。第一阶段不改它，而是在外面包一层：
 *
 *  - 启动任务：在用户上下文里调引擎，然后往 book_jobs 写一行；
 *  - 进度镜像：后台循环每几秒把内存里的进度写进数据库，
 *    用户刷新页面 / 换设备都能从数据库看到「跑到哪了」；
 *  - 重启收尾：进程重启后内存任务全没了，把遗留的 running 行改成 paused，
 *    并让引擎把磁盘上停在 processing 的章节收回 paused（可继续）。
 *
 * 多实例部署时：book_jobs 上"一本书只允许一个活跃任务"的部分唯一索引
 * 是最后一道闸；抢输的实例会立刻暂停自己刚启动的内存任务。
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { bookJobs } from '@/lib/db/book-schema';
import { JobManager } from '@/lib/book-engine/pipeline/jobs.js';
import { listBookIds } from '@/lib/book-engine/pipeline/workspace.js';
import { AppError } from '@/lib/book-engine/util/errors.js';
import { getRewriteContext } from './engine-context';
import { withBookUser } from './storage';
import { syncBookIndex } from './book-index';

/** 进程内唯一的引擎任务管理器。getContext 在用户上下文里完成挂载。 */
const manager = new JobManager({ getContext: getRewriteContext });

/** 已经写过最终状态的任务 id，防止后台镜像反复覆盖。 */
const finalized = new Set<string>();

export type StartBookJobArgs = {
  userId: string;
  bookId: string;
  kind: 'plan' | 'rewrite' | 'auto';
  chapters?: number[];
  resume?: boolean;
  /** 只影响任务标签（single / retry / all…），引擎行为由 chapters/resume 决定。 */
  mode?: string;
};

/** 引擎状态 → 数据库状态。 */
function toDbStatus(status: string): 'running' | 'paused' | 'done' | 'failed' {
  if (status === 'completed' || status === 'completed_with_errors') return 'done';
  if (status === 'paused') return 'paused';
  if (status === 'failed') return 'failed';
  return 'running';
}

/** 引擎 publicJob 里进度镜像用得到的字段。 */
type EngineJobLike = {
  message?: string;
  currentChapter?: number | null;
  completed?: number[];
  failed?: number[];
  skipped?: number[];
  usage?: unknown;
  log?: string[];
  elapsedMs?: number;
  result?: unknown;
};

function progressOf(job: EngineJobLike) {
  return {
    message: job.message || '',
    currentChapter: job.currentChapter ?? null,
    completed: job.completed || [],
    failed: job.failed || [],
    skipped: job.skipped || [],
    usage: job.usage || null,
    logTail: (job.log || []).slice(-20),
    elapsedMs: job.elapsedMs ?? null,
    result: job.result ?? null,
  };
}

/**
 * 启动一个任务。返回引擎的公共任务对象（含 id）。
 *
 * 校验顺序刻意如此：先查数据库有没有活跃任务（便宜、跨实例有效），
 * 再启动引擎，最后插入记录——插入撞唯一索引时把刚启动的引擎任务暂停掉。
 */
export async function startBookJob(args: StartBookJobArgs) {
  const { userId, bookId, kind, chapters = [], resume = false, mode } = args;

  const active = await db
    .select({ id: bookJobs.id })
    .from(bookJobs)
    .where(and(eq(bookJobs.bookId, bookId), inArray(bookJobs.status, ['queued', 'running'])));
  if (active.length) {
    throw new AppError('这本书已有任务在运行中', { code: 'JOB_ACTIVE', status: 409 });
  }

  const job = await withBookUser(userId, () => {
    // 引擎把 plan / auto 做成专用入口（顺手设定正确的 mode），
    // 通用 start 的 JSDoc 只声明了 rewrite/export 两种。
    if (kind === 'plan') return manager.startPlan({ bookId });
    if (kind === 'auto') return manager.startAuto({ bookId });
    return manager.start({ bookId, chapters, kind: 'rewrite', mode: mode || 'rewrite', resume });
  });

  try {
    await db.insert(bookJobs).values({
      id: job.id,
      userId,
      bookId,
      kind,
      status: 'running',
      payload: { chapters, resume },
      progress: progressOf(job),
    });
  } catch {
    // 唯一索引冲突：另一个实例抢先了。停掉自己这份内存任务。
    await withBookUser(userId, () => manager.pause(job.id)).catch(() => {});
    throw new AppError('这本书已有任务在运行中', { code: 'JOB_ACTIVE', status: 409 });
  }

  finalized.delete(job.id);
  return job;
}

/** 暂停任务。任务不在本进程内存里（例如重启前遗留）时直接把行标记为暂停。 */
export async function pauseBookJob(userId: string, jobId: string) {
  const row = await db.query.bookJobs.findFirst({
    where: and(eq(bookJobs.id, jobId), eq(bookJobs.userId, userId)),
  });
  if (!row) throw new AppError('任务不存在', { code: 'NOT_FOUND', status: 404 });

  const paused = manager.get(jobId);
  if (paused) {
    const result = await withBookUser(userId, () => manager.pause(jobId));
    await syncBookIndex(userId, row.bookId).catch(() => {});
    return result;
  }
  await db
    .update(bookJobs)
    .set({ status: 'paused', error: '任务不在本进程内（服务重启或由其他实例执行）', updatedAt: new Date() })
    .where(eq(bookJobs.id, jobId));
  await syncBookIndex(userId, row.bookId).catch(() => {});
  return null;
}

/** 查询单个任务：内存里活着就返回实时状态，否则回落到数据库行。 */
export async function getBookJob(userId: string, jobId: string) {
  const live = manager.get(jobId) as (EngineJobLike & { id: string; bookId: string; status: string }) | null;
  if (live) {
    // 任务表是全进程共享的，内存任务必须按「这本书在不在我的书柜里」判归属。
    // 别人的任务一律当作不存在：返回 403 等于告诉对方"有这么个任务"。
    const own = await withBookUser(userId, async () => (await listBookIds()).includes(live.bookId));
    if (!own) throw new AppError('任务不存在', { code: 'NOT_FOUND', status: 404 });
    return { source: 'memory' as const, job: live };
  }
  const row = await db.query.bookJobs.findFirst({
    where: and(eq(bookJobs.id, jobId), eq(bookJobs.userId, userId)),
  });
  if (!row) throw new AppError('任务不存在', { code: 'NOT_FOUND', status: 404 });
  return { source: 'db' as const, job: row };
}

/**
 * 任务清单：本进程里活着的（实时进度）+ 数据库里存过历史的。
 *
 * 内存任务按书柜归属过滤（同 getBookJob）；数据库行天然带 userId。
 * 两边按 id 去重：同一个任务以内存里的实时状态为准。
 */
export async function listBookJobs(userId: string) {
  const ownBookIds = new Set(await withBookUser(userId, () => listBookIds()));
  const live = (manager.list() as Array<EngineJobLike & { id: string; bookId: string }>).filter((job) =>
    ownBookIds.has(job.bookId),
  );
  const liveIds = new Set(live.map((j) => j.id));
  const rows = await db.query.bookJobs.findMany({
    where: eq(bookJobs.userId, userId),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit: 50,
  });
  return {
    jobs: live,
    history: rows.filter((row) => !liveIds.has(row.id)),
  };
}

/** 这本书有没有任务正在跑（「继续处理」按钮别再提示）。 */
export function activeJobForBook(bookId: string) {
  return manager.activeForBook(bookId);
}

/**
 * 后台镜像：把本进程里所有活跃任务的进度写进数据库，收尾时同步书库卡片。
 * 由 lib/jobs/background.ts 的循环定期调用。
 */
export async function mirrorBookJobs(): Promise<{ active: number; finalized: number }> {
  let active = 0;
  let done = 0;
  for (const job of manager.list()) {
    const dbStatus = toDbStatus(job.status);
    if (dbStatus === 'running') {
      active += 1;
      await db
        .update(bookJobs)
        .set({ status: 'running', progress: progressOf(job), updatedAt: new Date() })
        .where(eq(bookJobs.id, job.id))
        .catch(() => {});
      continue;
    }
    if (finalized.has(job.id)) continue;
    finalized.add(job.id);
    done += 1;
    const row = await db.query.bookJobs.findFirst({ where: eq(bookJobs.id, job.id) }).catch(() => null);
    await db
      .update(bookJobs)
      .set({
        status: dbStatus,
        progress: progressOf(job),
        error: job.error || (job.failed?.length ? `${job.failed.length} 章失败` : null),
        updatedAt: new Date(),
      })
      .where(eq(bookJobs.id, job.id))
      .catch(() => {});
    if (row) {
      await syncBookIndex(row.userId, job.bookId).catch(() => {});
    }
  }
  return { active, finalized: done };
}

/**
 * 启动时收尾：把上次进程留下的活跃任务行改成 paused，
 * 并在每个用户的磁盘上把"处理中"的章节收回"已暂停"。
 */
export async function reconcileBookJobsOnBoot(): Promise<void> {
  const rows = await db
    .select({ id: bookJobs.id })
    .from(bookJobs)
    .where(inArray(bookJobs.status, ['queued', 'running']));
  for (const row of rows) {
    if (manager.get(row.id)) continue;
    await db
      .update(bookJobs)
      .set({ status: 'paused', error: '服务重启，任务被中断', updatedAt: new Date() })
      .where(eq(bookJobs.id, row.id))
      .catch(() => {});
  }
}
