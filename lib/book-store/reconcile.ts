import 'server-only';

/**
 * 启动时收拾残局（原项目 src/server/index.js 里 reconcileWorkspace 的移植）。
 *
 * 任务状态只活在内存里，进程一重启就没了，但磁盘上的章节状态还停在
 * `processing`。用户打开书籍页会看到"处理中"，而其实什么都没在跑。
 * 所以：启动时凡是 `processing` 的一律降级成 `paused`（可继续、
 * 可复用已完成的 chunk），并补写 pending-work.json，
 * 保证「继续处理」的入口从第一秒就存在。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  listBooks,
  readBookMetadata,
  readChapterStatus,
  writeChapterStatus,
  writePendingWork,
} from '@/lib/book-engine/pipeline/workspace.js';
import { readUntouchedChapters } from '@/lib/book-engine/pipeline/plan-untouched.js';
import { storageRoot, withBookUser } from './storage';

/** 引擎 metadata.json / listBooks 摘要里这里用到的字段。 */
type MetadataLike = {
  bookId?: string;
  chapters?: Array<{ index: number; rewritable?: boolean }>;
};

export type ReconcileResult = {
  userId: string;
  books: number;
  pendingBooks: number;
  pausedChapters: number;
  touchedBookIds: string[];
  error?: string;
};

export async function reconcileUserWorkspace(userId: string): Promise<ReconcileResult> {
  return withBookUser(userId, async (): Promise<ReconcileResult> => {
    const result: ReconcileResult = {
      userId,
      books: 0,
      pendingBooks: 0,
      pausedChapters: 0,
      touchedBookIds: [],
    };
    const books = await listBooks();
    result.books = books.length;
    for (const book of books as Array<{ bookId?: string }>) {
      const bookId = book.bookId;
      if (!bookId) continue;
      let metadata: MetadataLike;
      try {
        metadata = (await readBookMetadata(bookId)) as MetadataLike;
      } catch {
        continue;
      }
      const untouched = await readUntouchedChapters(bookId);
      const remaining: number[] = [];
      const partial: number[] = [];
      let touched = 0;
      for (const chapter of metadata.chapters || []) {
        if (chapter.rewritable === false) continue;
        if (untouched.has(chapter.index)) continue;
        const status = await readChapterStatus(bookId, chapter.index);
        const stage = status?.stage || 'pending';
        if (stage === 'completed') continue;
        remaining.push(chapter.index);
        if (status?.chunkDone > 0 && status?.chunkResults) partial.push(chapter.index);
        if (stage === 'processing') {
          await writeChapterStatus(bookId, chapter.index, {
            ...status,
            stage: 'paused',
            note: '上次运行被中断（程序重启）',
          });
          touched += 1;
        }
      }
      if (!remaining.length) continue;
      result.pendingBooks += 1;
      result.pausedChapters += touched;
      if (touched) result.touchedBookIds.push(bookId);
      await writePendingWork(bookId, {
        reason: '程序重启，任务被中断',
        remainingChapters: remaining,
        remaining: remaining.length,
        partialChapters: partial,
      });
    }
    return result;
  });
}

/** 有哪些用户在自己的书柜里存过东西。 */
export async function listUserIdsWithData(): Promise<string[]> {
  const usersDir = path.join(storageRoot(), 'users');
  try {
    const entries = await fs.readdir(usersDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** 启动时对所有用户跑一遍。任何单个用户失败都不影响其他用户。 */
export async function reconcileAllUsers(): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const userId of await listUserIdsWithData()) {
    try {
      results.push(await reconcileUserWorkspace(userId));
    } catch (err) {
      results.push({
        userId,
        books: 0,
        pendingBooks: 0,
        pausedChapters: 0,
        touchedBookIds: [],
        error: (err as Error).message,
      });
    }
  }
  return results;
}
