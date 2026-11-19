import 'server-only';

/**
 * 书籍页面需要的派生视图（原项目 src/server/routes.js 的移植）：
 * 元数据升级、书籍详情、进度口径、章节选择、整理结果报告。
 *
 * 这些都依赖"当前用户的书柜上下文"，只能在 withBookUser 里调用。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { readUntouchedChapters, readUntouchedStrategies } from '@/lib/book-engine/pipeline/plan-untouched.js';
import { analyzeChapterDocument, inferChapterTitle, isRewritable } from '@/lib/book-engine/epub/chapter-info.js';
import { readEpub } from '@/lib/book-engine/epub/epub-reader.js';

export type ChapterMeta = {
  index: number;
  title: string;
  href: string;
  kind?: string;
  rewritable?: boolean;
  textLength?: number;
  blockCount?: number;
  imageCount?: number;
  tocTitle?: string;
  navTitle?: string;
};

export type BookMetadata = {
  bookId: string;
  title: string;
  authors?: string[];
  language?: string;
  chapterCount: number;
  chapters: ChapterMeta[];
  schemaVersion?: number;
  sourceFileName?: string;
  sourceSize?: number;
  createdAt?: string;
  updatedAt?: string;
  warnings?: string[];
};

export type PlanFile = {
  entries?: Array<{ index: number; strategy: 'keep' | 'digest' | 'skip' | 'drop'; [key: string]: unknown }>;
  names?: Record<string, string>;
  order?: number[];
  counts?: Record<string, number>;
  updatedAt?: string;
  createdAt?: string;
};

/**
 * 读取书籍元数据，需要时把老书升级到当前版本。
 *
 * 老书（schemaVersion < 2）没有 kind / rewritable 字段，界面会把纯图片页
 * 当成正常章节。这里就地补一次分析并写回，用户不需要重新导入。
 */
export async function readMetadataUpgraded(bookId: string): Promise<BookMetadata> {
  const metadata = (await ws.readBookMetadata(bookId)) as BookMetadata;
  if (Number(metadata.schemaVersion || 1) >= (ws.CURRENT_METADATA_VERSION as number)) return metadata;
  try {
    const buffer = await fsp.readFile(ws.bookPaths(bookId).original);
    const epub = readEpub(buffer);
    const { metadata: upgraded, changed } = (await ws.upgradeBookMetadata(metadata, {
      reanalyze: async (chapterRaw: object) => {
        const chapter = chapterRaw as ChapterMeta;
        // 条目缺失时 getDocument 抛错，upgradeBookMetadata 会跳过该章。
        const doc = epub.getDocument(chapter.href);
        const info = analyzeChapterDocument(doc);
        const title = inferChapterTitle({
          title: chapter.title,
          navTitle: chapter.tocTitle || chapter.navTitle,
          kind: info.kind,
          heading: info.heading,
          firstText: info.firstText,
          index: chapter.index,
          href: chapter.href,
        });
        return {
          title,
          kind: info.kind,
          rewritable: isRewritable(info.kind),
          textLength: info.textLength,
          blockCount: info.blockCount,
          imageCount: info.imageCount,
        };
      },
    })) as { metadata: BookMetadata; changed: boolean };
    if (changed) await ws.writeBookMetadata(bookId, upgraded);
    return upgraded;
  } catch {
    // 升级失败就用原元数据，不影响正常使用
    return metadata;
  }
}

export type ChapterStatusLike = {
  stage?: string;
  chunkTotal?: number;
  chunkDone?: number;
  quality?: unknown;
  usage?: { totalTokens?: number };
  error?: string | null;
  rewrittenChars?: number;
  digest?: boolean;
  note?: string | null;
  updatedAt?: string | null;
  noteRefsBefore?: number;
  noteRefsAfter?: number;
};

/**
 * 书籍详情（书籍工作台首屏）。
 *
 * 统计口径与「继续处理」按钮（countRemaining）完全一致：
 * 方案要求原样保留/删除的章节、没有正文的页面都不算"需改写"。
 */
export async function decorate(bookId: string) {
  const metadata = await readMetadataUpgraded(bookId);
  const statuses = (await ws.readAllChapterStatus(bookId, metadata.chapterCount)) as Record<number, ChapterStatusLike | null>;
  let completed = 0;
  let failed = 0;
  let processing = 0;
  let pending = 0;
  let totalTokens = 0;
  for (const st of Object.values(statuses)) {
    totalTokens += st?.usage?.totalTokens || 0;
  }
  const untouched = (await readUntouchedStrategies(bookId)) as Map<number, string>;
  let rewritable = 0;
  for (const chapter of metadata.chapters) {
    if (chapter.rewritable === false) continue;
    if (untouched.has(chapter.index)) continue;
    rewritable += 1;
    const stage = statuses[chapter.index]?.stage || 'pending';
    if (stage === 'completed') completed += 1;
    else if (stage === 'failed') failed += 1;
    else if (stage === 'processing') processing += 1;
    else pending += 1;
  }
  const skipped = metadata.chapterCount - rewritable;
  return {
    ...metadata,
    chapters: metadata.chapters.map((c) => {
      const stage = c.rewritable === false || untouched.has(c.index)
        ? 'skipped'
        : statuses[c.index]?.stage || 'pending';
      return {
        ...c,
        stage,
        skippedReason: c.rewritable === false ? 'no-body' : untouched.get(c.index) || null,
        chunkTotal: statuses[c.index]?.chunkTotal ?? 0,
        chunkDone: statuses[c.index]?.chunkDone ?? 0,
        quality: statuses[c.index]?.quality || null,
        usage: statuses[c.index]?.usage || null,
        error: statuses[c.index]?.error || null,
        rewrittenChars: statuses[c.index]?.rewrittenChars || 0,
        digest: Boolean(statuses[c.index]?.digest) && stage === 'completed',
        note: statuses[c.index]?.note || null,
        updatedAt: statuses[c.index]?.updatedAt || null,
      };
    }),
    progress: {
      total: metadata.chapterCount,
      completed,
      failed,
      processing,
      pending,
      skipped,
      rewritable,
      totalTokens,
      percent: rewritable ? Math.round(((completed + failed) / rewritable) * 100) : 0,
    },
    exports: await ws.listExports(bookId),
    processed: await summarizeProcessed(bookId, metadata, statuses),
    pendingWork: await ws.readPendingWork(bookId),
  };
}

/** 这本书「整理过没有」的轻量摘要（只读 book-plan.json，书库卡片用）。 */
export async function summarizeProcessed(
  bookId: string,
  metadata: BookMetadata,
  statuses: Record<number, ChapterStatusLike | null>,
) {
  const plan = (await ws.readBookPlan(bookId).catch(() => null)) as PlanFile | null;
  const base = summarizePlanCounts(plan);
  if (!base) return null;
  let notesBefore = 0;
  let notesAfter = 0;
  for (const c of metadata.chapters || []) {
    notesBefore += statuses[c.index]?.noteRefsBefore || 0;
    notesAfter += statuses[c.index]?.noteRefsAfter || 0;
  }
  return { ...base, notes: notesBefore ? { before: notesBefore, after: notesAfter } : null };
}

/** 只从方案本身算摘要，不碰章节状态。 */
export function summarizePlanCounts(plan: PlanFile | null | undefined) {
  if (!plan?.entries?.length) return null;
  const counts: Record<string, number> = { keep: 0, digest: 0, skip: 0, drop: 0 };
  for (const e of plan.entries) counts[e.strategy] = (counts[e.strategy] || 0) + 1;
  return {
    at: plan.updatedAt || plan.createdAt || null,
    counts,
    renamed: Object.keys(plan.names || {}).length,
    reordered: Boolean(plan.order?.length),
    notes: null,
  };
}

/** 已完成的章节（导出默认范围）。 */
export async function collectCompletedChapters(bookId: string): Promise<number[]> {
  const metadata = (await ws.readBookMetadata(bookId)) as BookMetadata;
  const out: number[] = [];
  for (const chapter of metadata.chapters) {
    const status = (await ws.readChapterStatus(bookId, chapter.index)) as ChapterStatusLike | null;
    if (status?.stage === 'completed') out.push(chapter.index);
  }
  return out;
}

/**
 * 按模式挑选要改写的章节（口径与 countRemaining 一致）。
 *
 * 所有模式都尊重整理方案：标了 skip/drop 的章节不进 AI 队列，
 * 纯图片页/空白页也不进。
 */
export async function selectChapters(bookId: string, metadata: BookMetadata, mode: string): Promise<number[]> {
  const rewritable = new Set(
    metadata.chapters.filter((c) => c.rewritable !== false).map((c) => c.index),
  );
  const untouched = (await readUntouchedChapters(bookId)) as Set<number>;
  const all = metadata.chapters
    .map((c) => c.index)
    .filter((i) => rewritable.has(i) && !untouched.has(i));

  if (mode === 'all') return all;
  if (mode === 'failed') {
    const out: number[] = [];
    for (const index of all) {
      const status = (await ws.readChapterStatus(bookId, index)) as ChapterStatusLike | null;
      if (status?.stage === 'failed') out.push(index);
    }
    return out;
  }
  // pending：只补没做完的；resume：连失败的也重试
  if (mode === 'pending' || mode === 'resume') {
    const retryFailed = mode === 'resume';
    const out: number[] = [];
    for (const index of all) {
      const status = (await ws.readChapterStatus(bookId, index)) as ChapterStatusLike | null;
      const stage = status?.stage || 'pending';
      if (stage === 'completed') continue;
      if (stage === 'failed' && !retryFailed) continue;
      out.push(index);
    }
    return out;
  }
  return all;
}

/** 「还剩多少要做」——界面「继续处理」按钮上的数字。 */
export async function countRemaining(bookId: string, metadata: BookMetadata) {
  const remaining: number[] = [];
  const incomplete: number[] = [];
  const done: number[] = [];
  const untouched = (await readUntouchedChapters(bookId)) as Set<number>;
  let total = 0;
  for (const chapter of metadata.chapters || []) {
    if (chapter.rewritable === false) continue;
    if (untouched.has(chapter.index)) continue;
    total += 1;
    const status = (await ws.readChapterStatus(bookId, chapter.index)) as ChapterStatusLike | null;
    const stage = status?.stage || 'pending';
    if (stage === 'completed') {
      done.push(chapter.index);
      continue;
    }
    remaining.push(chapter.index);
    if ((status?.chunkDone || 0) > 0) incomplete.push(chapter.index);
  }
  return {
    total,
    done: done.length,
    remaining: remaining.length,
    remainingChapters: remaining,
    resumableChapters: incomplete,
  };
}

/* ---------------------------------------------------- 整理结果报告缓存 -- */

/**
 * 「整理结果」报告的短缓存：算一次要 1.6 秒（读原书认脚注、逐章比对），
 * 工作台轮询期间不做缓存会把 CPU 打满。10 秒 + 按成品文件修改时间失效。
 */
const reportCache = new Map<string, { stamp: string; at: number; report: unknown }>();

export async function getReport(bookId: string, deep: boolean) {
  const dir = ws.bookPaths(bookId).exports as string;
  let stamp = 'none';
  try {
    const files = (await fsp.readdir(dir)).filter((n) => n.endsWith('.epub'));
    const stamped: string[] = [];
    for (const f of files) {
      const stat = await fsp.stat(path.join(dir, f)).catch(() => null);
      if (stat) stamped.push(`${f}:${stat.mtimeMs}`);
    }
    stamp = stamped.sort().join('|');
  } catch {
    /* 还没有成品 */
  }
  const key = `${bookId}::${deep ? 'deep' : 'lite'}`;
  const hit = reportCache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < 10000) return hit.report;

  const { buildBookReport } = (await import('@/lib/book-engine/pipeline/report-service.js')) as {
    buildBookReport(bookId: string, opts?: { deep?: boolean }): Promise<unknown>;
  };
  const report = await buildBookReport(bookId, { deep });
  reportCache.set(key, { stamp, at: Date.now(), report });
  return report;
}
