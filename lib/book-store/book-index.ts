/**
 * 书库索引：把磁盘上的书稿状态镜像到数据库，列表页只查库。
 *
 * 权威数据仍在磁盘（引擎的 workspace），这里是"目录卡"：
 *  - 列表页不用扫目录、读上千个 status.json；
 *  - 排序、筛选、分页都走 SQL；
 *  - 书被删掉时同步删卡片。
 *
 * 每次导入 / 删除 / 任务结束都调一次 syncBookIndex；如果卡片和磁盘
 * 万一漂移（比如任务中途进程被杀），syncAllBooksFromDisk 能整体重建。
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { books, bookJobs } from '../db/book-schema';
import {
  bookExists,
  decorateBookSummary,
  listBookIds,
  readBookMetadata,
  readBookPlan,
  readPendingWork,
} from '../book-engine/pipeline/workspace.js';
import { withBookUser } from './storage';

type BookStatus = 'ready' | 'extracting' | 'planning' | 'rewriting' | 'paused' | 'done' | 'failed';

/** 引擎 decorateBookSummary 的返回形状（只取这里用到的字段）。 */
type BookSummaryLike = {
  progress?: {
    rewritable?: number;
    completed?: number;
    failed?: number;
    processing?: number;
  };
  exports?: Array<{ name: string; size: number; createdAt: string }>;
};

/**
 * 从磁盘状态推导书的状态。
 *
 * 口径与引擎书库卡片一致（decorateBookSummary.progress），不另算一套：
 *  - 所有可改写章节都完成、且有导出 → done
 *  - 有"继续处理"记录 → paused
 *  - 有完成的/失败的/进行中的章节 → rewriting
 *  - 否则 ready
 * 全部章节都不可改写（纯图片书）时按导出情况判 done。
 */
function deriveStatus(summary: BookSummaryLike, pendingWork: unknown): BookStatus {
  const progress = summary.progress || {};
  const rewritable = Number(progress.rewritable || 0);
  const completed = Number(progress.completed || 0);
  const hasExport = (summary.exports || []).length > 0;

  if (rewritable > 0 && completed >= rewritable) {
    return hasExport ? 'done' : 'rewriting';
  }
  if (rewritable === 0 && hasExport) return 'done';
  if (pendingWork) return 'paused';
  if (completed > 0 || Number(progress.failed || 0) > 0 || Number(progress.processing || 0) > 0) {
    return 'rewriting';
  }
  return 'ready';
}

/**
 * 同步一本书的目录卡（不存在则插入，存在则更新）。
 * 传进来的 userId 必须是会话里拿到的那个；函数自己切用户上下文。
 */
export async function syncBookIndex(userId: string, bookId: string): Promise<{ synced: boolean; status?: BookStatus }> {
  return withBookUser(userId, async () => {
    if (!(await bookExists(bookId))) {
      await removeBookIndex(userId, bookId);
      return { synced: false };
    }
    const meta = await readBookMetadata(bookId);
    const summary = await decorateBookSummary(bookId, meta);
    const pendingWork = await readPendingWork(bookId).catch(() => null);
    const plan = await readBookPlan(bookId).catch(() => null);

    const status = deriveStatus(summary, pendingWork);
    const exportsList = summary.exports || [];
    const latest = exportsList[0] || null;

    const values = {
      id: bookId,
      userId,
      title: String(meta.title || '未命名书籍'),
      author: Array.isArray(meta.authors) && meta.authors.length ? meta.authors.join('、') : null,
      fileName: String(meta.sourceFileName || ''),
      status,
      totalChapters: Number(meta.chapterCount || 0),
      processedChapters: Number(summary.progress?.completed || 0),
      metadata: {
        authors: meta.authors || [],
        language: meta.language || '',
        chapterCount: meta.chapterCount || 0,
        progress: summary.progress,
        exportCount: exportsList.length,
        latestExport: latest ? { name: latest.name, size: latest.size, createdAt: latest.createdAt } : null,
        planCounts: plan?.counts || null,
        pendingWork: pendingWork
          ? { remaining: pendingWork.remaining ?? 0, mode: pendingWork.mode || null, reason: pendingWork.reason || null }
          : null,
      },
      updatedAt: new Date(),
    };

    await db
      .insert(books)
      .values(values)
      .onConflictDoUpdate({
        target: books.id,
        set: {
          title: values.title,
          author: values.author,
          fileName: values.fileName,
          status: values.status,
          totalChapters: values.totalChapters,
          processedChapters: values.processedChapters,
          metadata: values.metadata,
          updatedAt: values.updatedAt,
        },
      });

    return { synced: true, status };
  });
}

/**
 * 删掉一本书的目录卡与导出记录。
 *
 * books 表上导出记录有外键级联，删 books 行会带走 book_exports；
 * book_jobs 没有外键（book_id 只是文本），需要显式清。
 */
export async function removeBookIndex(userId: string, bookId: string): Promise<void> {
  await db.delete(bookJobs).where(and(eq(bookJobs.bookId, bookId), eq(bookJobs.userId, userId)));
  await db.delete(books).where(and(eq(books.id, bookId), eq(books.userId, userId)));
}

/**
 * 整库重建：磁盘上有几本书就同步几张卡。
 * 返回同步结果，便于排查异常书（比如 metadata.json 损坏）。
 */
export async function syncAllBooksFromDisk(userId: string): Promise<{ total: number; failed: string[] }> {
  const ids = await withBookUser(userId, () => listBookIds());
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await syncBookIndex(userId, id);
    } catch (err) {
      failed.push(id);
      console.warn(`[book-index] 同步失败 ${id}:`, (err as Error).message);
    }
  }
  return { total: ids.length, failed };
}

/** 列表页查询：只返回卡片字段，可选按状态过滤。 */
export async function listUserBooks(userId: string, opts: { status?: BookStatus; limit?: number } = {}) {
  const where = opts.status
    ? and(eq(books.userId, userId), eq(books.status, opts.status))
    : eq(books.userId, userId);
  return db.query.books.findMany({
    where,
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit: Math.min(Math.max(opts.limit || 100, 1), 500),
  });
}
