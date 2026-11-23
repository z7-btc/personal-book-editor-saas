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

/**
 * 进程内唯一的引擎任务管理器。getContext 在用户上下文里完成挂载。
 *
 * 必须挂在 globalThis 上，不能用模块级常量：Next.js 会把
 * instrumentation 和路由处理编成两套 bundle，同一个模块各打一份。
 * 生产镜像里可以同时找到两份 `job-runner`（instrumentation 的 chunk
 * 和路由的 chunk），两边的 `manager` 是两个互不相识的对象 ——
 * 后台镜像循环跑在 instrumentation 那份里，永远看不到路由启动的任务，
 * 于是 book_jobs 的行一直停在 running，用户点「重试」只会收到 409，
 * 界面上看起来就是按钮没反应。
 *
 * globalThis 在同一个 Node 进程里是共享的，两套 bundle 就能拿到同一个
 * 实例；dev 模式热重载重新求值模块时也会复用，不会丢正在跑的任务。
 */
const MANAGER_KEY = Symbol.for('saas.book-job-manager');
const managerStore = globalThis as unknown as Record<symbol, JobManager | undefined>;
const manager = managerStore[MANAGER_KEY] ?? new JobManager({ getContext: getRewriteContext });
managerStore[MANAGER_KEY] = manager;

/** 已经写过最终状态的任务 id，防止后台镜像反复覆盖。 */
const finalized = new Set<string>();

/**
 * 活跃任务行多久没更新就算「失联」。
 *
 * 镜像循环每 5 秒写一次进度；多实例部署时，真正在跑的那台会持续刷新。
 * 超过这个时间还是 running，说明那台进程已经没了（重启 / 崩溃），
 * 把行收尾掉，否则用户永远卡在「已有任务在运行」。
 */
const BOOK_JOB_STALE_MS = 3 * 60_000;

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
    .select({ id: bookJobs.id, status: bookJobs.status, updatedAt: bookJobs.updatedAt })
    .from(bookJobs)
    .where(and(eq(bookJobs.bookId, bookId), inArray(bookJobs.status, ['queued', 'running'])));
  if (active.length) {
    /**
     * 活跃行不一定真的还在跑：进程重启、崩溃、或者镜像循环没跟上，
     * 都会留下一条永远 running 的行。不收拾它，用户点多少次重试
     * 都只会收到 409。
     *
     * 判定分三种：
     *  - 本进程内存里还在跑 → 真的在跑，拒绝；
     *  - 内存里已经结束（镜像还没来得及落库）→ 按内存的最终状态收尾；
     *  - 内存里没有、且超过 BOOK_JOB_STALE_MS 没更新 → 失联，收尾。
     */
    const now = Date.now();
    const blockers: string[] = [];
    const settle: Array<{ id: string; status: 'paused' | 'done' | 'failed'; error: string | null }> = [];
    for (const row of active) {
      const live = manager.get(row.id) as { status?: string; error?: string | null } | null;
      if (live && (live.status === 'running' || live.status === 'pausing')) {
        blockers.push(row.id);
        continue;
      }
      if (live) {
        const dbStatus = toDbStatus(live.status || '');
        settle.push({
          id: row.id,
          status: dbStatus === 'running' ? 'paused' : dbStatus,
          error: live.error || null,
        });
        continue;
      }
      if (now - new Date(row.updatedAt).getTime() < BOOK_JOB_STALE_MS) {
        blockers.push(row.id);
        continue;
      }
      settle.push({
        id: row.id,
        status: 'paused',
        error: '上一次任务没有正常收尾（长时间没有进度更新），已自动结束，可以重新开始',
      });
    }
    if (blockers.length) {
      throw new AppError('这本书已有任务在运行中', { code: 'JOB_ACTIVE', status: 409 });
    }
    for (const row of settle) {
      await db
        .update(bookJobs)
        .set({ status: row.status, error: row.error, updatedAt: new Date() })
        .where(eq(bookJobs.id, row.id));
    }
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
    const row = await db.query.bookJobs.findFirst({ where: eq(bookJobs.id, job.id) }).catch(() => null);
    try {
      await db
        .update(bookJobs)
        .set({
          status: dbStatus,
          progress: progressOf(job),
          error: job.error || (job.failed?.length ? `${job.failed.length} 章失败` : null),
          updatedAt: new Date(),
        })
        .where(eq(bookJobs.id, job.id));
    } catch {
      // 写库暂时失败（连接抖动等）：这一轮先不标记 finalized，
      // 下一轮还会再写，否则这条任务行会永远停在 running。
      continue;
    }
    finalized.add(job.id);
    done += 1;
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
