import { relations, sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

/**
 * 书籍引擎的业务表。
 *
 * 设计取舍（第一阶段）：引擎（lib/book-engine）仍然按"每本书一个目录"的
 * 文件方式工作——它带着 374 个测试，改文件语义风险高。数据库这边先接管
 * 三件事：
 *   1. 书库索引（列表页直接查库，不用扫目录）
 *   2. 任务表（跨进程/重启可恢复，替代进程内内存队列）
 *   3. 导出记录
 *
 * 文件本身按用户分目录存在本地磁盘（BOOK_STORAGE_ROOT），上线前换对象存储
 * 只需替换 lib/book-store/storage.ts 一个适配层。
 */

export const bookStatus = pgEnum('book_status', [
  'ready', // 刚导入，未做任何处理
  'extracting', // 正在切章并抽取正文
  'planning', // 正在生成整理方案
  'rewriting', // 正在逐章改写
  'paused', // 用户暂停或服务重启中断
  'done', // 全部处理完并有导出
  'failed', // 不可恢复的失败，需要人看一眼
]);

// 章节级状态由引擎的章节目录（status.json）承载，这里只在 metadata 里冗余
// 一份轻量摘要给列表页；不单独建表，避免与引擎文件状态出现双写冲突。

export const books = pgTable('books', {
  // 引擎生成的 bookId（16 进制短哈希），目录名与它一一对应。
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  author: text('author'),
  fileName: text('file_name').notNull(),
  status: bookStatus('status').notNull().default('ready'),
  totalChapters: integer('total_chapters').notNull().default(0),
  processedChapters: integer('processed_chapters').notNull().default(0),
  /**
   * 引擎 metadata.json 的镜像摘要：章节表（序号/标题/href/kind）、
   * 整理方案摘要（counts）、最新导出名。列表页只读这里，不碰磁盘。
   */
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('books_user_created_idx').on(table.userId, table.createdAt),
  index('books_user_status_idx').on(table.userId, table.status),
]);

export const bookJobKind = pgEnum('book_job_kind', [
  'plan', // 生成整理方案
  'rewrite', // 改写（含压缩/补讲）
  'export', // 导出 EPUB
  'auto', // 一键整理：plan → rewrite → export
]);

export const bookJobStatus = pgEnum('book_job_status', [
  'queued',
  'running',
  'paused',
  'done',
  'failed',
]);

export const bookJobs = pgTable('book_jobs', {
  // 引擎 JobManager 的任务 id 沿用（内存表时代的 id），落库后用于去重。
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull(),
  kind: bookJobKind('kind').notNull(),
  status: bookJobStatus('status').notNull().default('queued'),
  /** 任务参数：章节选择、失败重试范围等（引擎 start() 的 scope） */
  payload: jsonb('payload').notNull().default({}),
  /** 进度快照：阶段、当前章节、完成数、最近错误等，便于日志与前端轮询 */
  progress: jsonb('progress').notNull().default({}),
  error: text('error'),
  // 租约模式与底座其他 worker 保持一致：多个实例同时跑时只有一个能领任务。
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('book_jobs_user_created_idx').on(table.userId, table.createdAt),
  index('book_jobs_status_idx').on(table.status, table.createdAt),
  index('book_jobs_book_idx').on(table.bookId),
  // 一本书同时只允许一个未完成任务（引擎语义：start 时若已有任务则复用）。
  uniqueIndex('book_jobs_one_active_per_book')
    .on(table.bookId)
    .where(sql`status IN ('queued', 'running')`),
]);

export const bookExports = pgTable('book_exports', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('book_exports_book_idx').on(table.bookId, table.createdAt),
  index('book_exports_user_idx').on(table.userId, table.createdAt),
]);

export const booksRelations = relations(books, ({ one, many }) => ({
  user: one(user, { fields: [books.userId], references: [user.id] }),
  exports: many(bookExports),
}));

export const bookExportsRelations = relations(bookExports, ({ one }) => ({
  book: one(books, { fields: [bookExports.bookId], references: [books.id] }),
}));
