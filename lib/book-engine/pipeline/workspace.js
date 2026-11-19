/**
 * 工作区（持久化）层。
 *
 * 目录结构（对应需求第十三 / 十四节）：
 *
 *   workspace/
 *     books/
 *       BOOK_ID/
 *         original.epub                     原文，永不覆盖
 *         metadata.json                     书名 / 作者 / 章节表 / 源文件名…
 *         reader-profile-snapshot.json      处理时的画像快照
 *         book-memory.json                  跨章节一致性记忆
 *         book-feedback.json                读后反馈
 *         exports/<name>.epub               导出的成品
 *         chapters/001/
 *           original.xhtml                  （兼容说明里叫 original.html 的那份）
 *           chunks.json                     分块与原文
 *           rewritten.xhtml                 空 = 该章未改写
 *           status.json                     状态 / 质量报告 / 用量
 *
 * 每完成一个 chunk 立即落盘，所以刷新页面或程序崩溃都能继续。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  ensureDir,
  writeJson,
  readJson,
  readText,
  writeFileAtomic,
  exists,
  listDirs,
} from '../util/fsx.js';
import { chapterDirName, assertSafeBookId, sanitizeFileName } from '../util/ids.js';
import { NotFoundError } from '../util/errors.js';
import { currentUserContext } from '../auth/context.js';

/** @type {string|null} */
let workspaceRootCache = null;

export function defaultWorkspaceRoot() {
  return path.resolve(process.cwd(), 'workspace');
}

export function setWorkspaceRoot(root) {
  workspaceRootCache = root ? path.resolve(root) : null;
}

/**
 * 当前工作区根目录。
 *
 * 优先级：
 *  1. 请求上下文里的当前用户目录（Http 请求走这条，多账号互不可见）；
 *  2. setWorkspaceRoot() 设过的目录（命令行脚本 / 设置页的应用路径）；
 *  3. 默认 ./workspace。
 *
 * 没有用户上下文时必须和改动之前完全一致，否则现有脚本和测试会跑去
 * 别的地方读写数据。
 */
export function workspaceRoot() {
  const ctx = currentUserContext();
  if (ctx?.workspaceRoot) return ctx.workspaceRoot;
  return workspaceRootCache || defaultWorkspaceRoot();
}

export const WORKSPACE_DIRS = {
  books: 'books',
  exports: 'exports',
};

export function booksRoot() {
  return path.join(workspaceRoot(), WORKSPACE_DIRS.books);
}

export function exportsRoot() {
  return path.join(workspaceRoot(), WORKSPACE_DIRS.exports);
}

export function bookDir(bookId) {
  return path.join(booksRoot(), assertSafeBookId(bookId));
}

export function bookPaths(bookId) {
  const dir = bookDir(bookId);
  return {
    dir,
    original: path.join(dir, 'original.epub'),
    metadata: path.join(dir, 'metadata.json'),
    profileSnapshot: path.join(dir, 'reader-profile-snapshot.json'),
    memory: path.join(dir, 'book-memory.json'),
    feedback: path.join(dir, 'book-feedback.json'),
    chapters: path.join(dir, 'chapters'),
    exports: path.join(dir, 'exports'),
  };
}

export function chapterDir(bookId, index) {
  return path.join(bookPaths(bookId).chapters, chapterDirName(index));
}

export function chapterPaths(bookId, index) {
  const dir = chapterDir(bookId, index);
  return {
    dir,
    originalHtml: path.join(dir, 'original.xhtml'),
    originalHtmlCompat: path.join(dir, 'original.html'), // 见需求第十三节命名
    chunks: path.join(dir, 'chunks.json'),
    rewrittenHtml: path.join(dir, 'rewritten.xhtml'),
    status: path.join(dir, 'status.json'),
  };
}

export async function ensureWorkspace() {
  await ensureDir(booksRoot());
  await ensureDir(exportsRoot());
  return workspaceRoot();
}

/**
 * 应用配置的工作区目录。
 *
 * 关键防御：配置里可能残留一个**已经不存在的**路径
 * （典型场景：把 workspaceDir 指向临时目录，后来那个目录被删了；
 *  或者把项目目录整个拷到别的盘）。
 * 这时如果照用，程序每次启动都会把数据写进一个不存在的位置，
 * 而且不会有任何报错——「书怎么没了」却查不出原因。
 * 所以这里做一次可用性检查，不可用就回退到默认路径并给出告警。
 *
 * @param {string} configuredDir
 * @returns {Promise<{root: string|null, fallback: boolean, reason?: string}>}
 */
export async function applyWorkspaceDir(configuredDir) {
  const raw = String(configuredDir || '').trim();
  if (!raw) {
    setWorkspaceRoot(null);
    return { root: null, fallback: false };
  }
  const resolved = path.resolve(raw);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      setWorkspaceRoot(null);
      return { root: defaultWorkspaceRoot(), fallback: true, reason: `配置的工作区路径不是目录：${resolved}` };
    }
  } catch {
    // 不存在：创建它。创建失败才回退。
    try {
      await ensureDir(resolved);
    } catch (err) {
      setWorkspaceRoot(null);
      const reason = /ENOENT|EACCES|EPERM|EEXIST/.test(String(err.code || ''))
        ? `无法创建目录（${err.code}），路径可能位于不存在的盘符或没有写权限`
        : err.message;
      return {
        root: defaultWorkspaceRoot(),
        fallback: true,
        reason: `配置的工作区路径不可用：${resolved} —— ${reason}。已回退到 ${defaultWorkspaceRoot()}`,
      };
    }
  }
  setWorkspaceRoot(resolved);
  return { root: resolved, fallback: false };
}

export async function ensureBookDirs(bookId) {
  const paths = bookPaths(bookId);
  await ensureDir(paths.dir);
  await ensureDir(paths.chapters);
  await ensureDir(paths.exports);
  return paths;
}

/* -------------------------------------------------------------- 书籍 -- */

/**
 * @typedef {Object} BookMetadata
 * @property {string} bookId
 * @property {string} title
 * @property {string[]} authors
 * @property {string} language
 * @property {string} publisher
 * @property {string} date
 * @property {string} sourceFileName
 * @property {number} sourceSize
 * @property {string} epubVersion
 * @property {string} opfPath
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number} chapterCount
 * @property {number} totalChars
 * @property {number} totalWords
 * @property {Array<object>} chapters
 * @property {string[]} warnings
 * @property {object} [pipeline]  处理进度汇总
 */

export async function writeBookMetadata(bookId, metadata) {
  const paths = await ensureBookDirs(bookId);
  metadata.updatedAt = new Date().toISOString();
  await writeJson(paths.metadata, metadata);
  return metadata;
}

export async function readBookMetadata(bookId) {
  const paths = bookPaths(bookId);
  const data = await readJson(paths.metadata, null);
  if (!data) throw new NotFoundError(`找不到书籍: ${bookId}`);
  return data;
}

/**
 * 元数据版本。
 *
 * 每次给 metadata 增加「界面依赖」的字段就 +1，并在 upgradeBookMetadata 里补上。
 * 否则老书不会自动获得新字段，界面会退回默认行为 ——
 * 例如 v2 加的 kind/rewritable 缺失时，纯图片页会被当成正常章节送进 AI 队列。
 */
export const CURRENT_METADATA_VERSION = 2;

/**
 * 把老书的元数据补齐到当前版本。
 *
 * 需要重新解析原书才能算出的字段（正文性质、字数），
 * 由调用方通过 reanalyze 回调提供，避免这里依赖 epub 解析层。
 *
 * @param {object} metadata
 * @param {{reanalyze?: (chapter: object) => Promise<object|null>}} [opts]
 * @returns {Promise<{metadata: object, changed: boolean, from: number}>}
 */
export async function upgradeBookMetadata(metadata, opts = {}) {
  const from = Number(metadata.schemaVersion || 1);
  if (from >= CURRENT_METADATA_VERSION) return { metadata, changed: false, from };

  let changed = false;
  if (opts.reanalyze) {
    for (const chapter of metadata.chapters || []) {
      if (chapter.kind) continue;
      try {
        const info = await opts.reanalyze(chapter);
        if (info) {
          Object.assign(chapter, info);
          changed = true;
        }
      } catch {
        // 单章分析失败：跳过它，保持原样。
        // 调用方读到的是 undefined，界面会按「按正常章节处理」兜底。
        continue;
      }
    }
  }

  metadata.schemaVersion = CURRENT_METADATA_VERSION;
  return { metadata, changed: true, from };
}

export async function bookExists(bookId) {
  return exists(bookPaths(bookId).metadata);
}

/**
 * 当前工作区里有哪些书（只看目录名，不读 metadata）。
 *
 * 给「这个任务/这本书是不是当前用户的」这类归属判断用：
 * 判断一百个任务只需要一次 readdir，而不是每行读一遍 metadata.json。
 */
export async function listBookIds() {
  await ensureWorkspace();
  return listDirs(booksRoot());
}

/**
 * 列出所有书籍（按创建时间倒序）。
 * 单个书籍元数据损坏不会导致整个列表失败。
 */
export async function listBooks() {
  await ensureWorkspace();
  const ids = await listDirs(booksRoot());
  const books = [];
  for (const id of ids) {
    try {
      const meta = await readJson(path.join(booksRoot(), id, 'metadata.json'), null);
      if (!meta) continue;
      books.push(await decorateBookSummary(id, meta));
    } catch {
      // 跳过损坏的书籍目录
    }
  }
  books.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return books;
}

/**
 * 给列表补上进度汇总（便于主页展示）。
 *
 * 关键点：`skipped`（纯图片页 / 空白页，没有正文可改写）必须单独统计，
 * 不能混进 `pending`，也不能混进 `completed`。否则书籍页上会出现
 *   顶部统计「已完成 13 / 待处理 11」 vs 继续按钮「已完成 12，剩余 12 章」
 * 两个口径打架 —— 用户会以为程序算错了。
 * 与 server/routes.js 的 decorate() 保持同一口径。
 */
export async function decorateBookSummary(bookId, meta) {
  const statuses = await readAllChapterStatus(bookId, meta.chapterCount || 0);
  let completed = 0;
  let failed = 0;
  let processing = 0;
  let skipped = 0;
  let pending = 0;
  let rewrittenChars = 0;
  let totalTokens = 0;
  /**
   * 兼容没有 chapters 数组的老 metadata.json（升级前的书）：
   * 退回「按序号逐个读 status」的老算法，行为与之前一致。
   */
  const chapters = meta.chapters?.length
    ? meta.chapters
    : Array.from({ length: meta.chapterCount || 0 }, (_, i) => ({ index: i + 1 }));
  /**
   * 整理方案要求原样保留/删除的章节同样是「无需改写」。
   *
   * 不排除它们，书库卡片会永远写着「已处理 3/4 章 · 75%」，而书籍页
   * （server/routes.js 的 decorate）和「继续处理」按钮已经按同一口径
   * 把他们排掉了 —— 同一本书两个页面数字打架。
   *
   * 这里直接在文件内读方案，不 import plan-untouched.js：
   * 那个模块反过来 import 本文件，会形成循环依赖。
   */
  const plan = await readBookPlan(bookId).catch(() => null);
  const untouched = new Set(
    (plan?.entries || [])
      .filter((e) => e?.strategy === 'skip' || e?.strategy === 'drop')
      .map((e) => Number(e.index))
      .filter((i) => Number.isFinite(i)),
  );
  let rewritable = 0;
  for (const chapter of chapters) {
    const st = statuses[chapter.index];
    totalTokens += st?.usage?.totalTokens || 0;
    if (chapter.rewritable === false || untouched.has(chapter.index)) {
      skipped += 1;
      continue;
    }
    rewritable += 1;
    const stage = st?.stage || 'pending';
    if (stage === 'completed') {
      completed += 1;
      rewrittenChars += st?.rewrittenChars || 0;
    } else if (stage === 'failed') failed += 1;
    else if (stage === 'processing') processing += 1;
    else pending += 1;
  }
  const exports_ = await listExports(bookId);
  const total = meta.chapterCount || 0;
  // rewritable 取循环里实际计入的章节数：总数减去「没正文可改」和「方案要求保留」的页面
  return {
    ...meta,
    progress: {
      total,
      completed,
      failed,
      processing,
      skipped,
      pending,
      rewritable,
      rewrittenChars,
      totalTokens,
      percent: rewritable > 0 ? Math.round(((completed + failed) / rewritable) * 100) : 0,
    },
    exports: exports_,
  };
}

export async function readAllChapterStatus(bookId, chapterCount) {
  /** @type {Record<number, object|null>} */
  const out = {};
  for (let i = 1; i <= chapterCount; i += 1) {
    out[i] = await readChapterStatus(bookId, i);
  }
  return out;
}

/* -------------------------------------------------------------- 章节 -- */

/**
 * @typedef {Object} ChapterStatus
 * @property {number} index
 * @property {string} title
 * @property {string} href
 * @property {'pending'|'processing'|'paused'|'completed'|'failed'} stage
 * @property {number} chunkTotal
 * @property {number} chunkDone
 * @property {object|null} quality
 * @property {object|null} usage
 * @property {string|null} error
 * @property {number} originalChars
 * @property {number} rewrittenChars
 * @property {string|null} updatedAt
 */

export function blankChapterStatus({ index, title, href }) {
  return {
    index,
    title,
    href,
    stage: 'pending',
    chunkTotal: 0,
    chunkDone: 0,
    quality: null,
    usage: null,
    error: null,
    originalChars: 0,
    rewrittenChars: 0,
    attempts: 0,
    updatedAt: null,
  };
}

export async function readChapterStatus(bookId, index) {
  const paths = chapterPaths(bookId, index);
  return readJson(paths.status, null);
}

export async function writeChapterStatus(bookId, index, status) {
  const paths = chapterPaths(bookId, index);
  await ensureDir(paths.dir);
  status.updatedAt = new Date().toISOString();
  await writeJson(paths.status, status);
  return status;
}

/**
 * 保存一章的提取结果（original.xhtml + chunks.json）。
 * @param {string} bookId
 * @param {number} index
 * @param {{originalXhtml: string, chunks: object[], status: object}} payload
 */
export async function saveChapterExtraction(bookId, index, payload) {
  const paths = chapterPaths(bookId, index);
  await ensureDir(paths.dir);
  await writeFileAtomic(paths.originalHtml, payload.originalXhtml);
  // 同时写一份 .html，方便直接用浏览器打开检查（需求里的命名习惯）
  await writeFileAtomic(paths.originalHtmlCompat, payload.originalXhtml);
  await writeJson(paths.chunks, payload.chunks);
  await writeChapterStatus(bookId, index, payload.status);
  return paths;
}

export async function readChapterChunks(bookId, index) {
  const paths = chapterPaths(bookId, index);
  const chunks = await readJson(paths.chunks, null);
  if (!chunks) throw new NotFoundError(`章节 ${index} 尚未提取`);
  return chunks;
}

export async function readChapterOriginal(bookId, index) {
  const paths = chapterPaths(bookId, index);
  return readText(paths.originalHtml);
}

export async function readChapterRewritten(bookId, index) {
  const paths = chapterPaths(bookId, index);
  if (!(await exists(paths.rewrittenHtml))) return null;
  return readText(paths.rewrittenHtml);
}

export async function saveChapterRewritten(bookId, index, xhtml) {
  const paths = chapterPaths(bookId, index);
  await ensureDir(paths.dir);
  await writeFileAtomic(paths.rewrittenHtml, xhtml);
  return paths.rewrittenHtml;
}

export async function clearChapterRewritten(bookId, index) {
  const paths = chapterPaths(bookId, index);
  await fs.rm(paths.rewrittenHtml, { force: true });
}

/** 删除一章的所有中间产物（重新提取时用）。 */
export async function clearChapterArtifacts(bookId, index) {
  const paths = chapterPaths(bookId, index);
  await fs.rm(paths.dir, { recursive: true, force: true });
}

/* ------------------------------------------------------- 画像 / 记忆 -- */

export async function writeProfileSnapshot(bookId, profile) {
  const paths = await ensureBookDirs(bookId);
  await writeJson(paths.profileSnapshot, {
    capturedAt: new Date().toISOString(),
    profile,
  });
}

export async function readProfileSnapshot(bookId) {
  const paths = bookPaths(bookId);
  return readJson(paths.profileSnapshot, null);
}

export function blankBookMemory() {
  return {
    book_summary: '',
    important_concepts: [],
    people: [],
    terminology: [],
    author_positions: [],
    chapter_summaries: {},
    updatedAt: null,
  };
}

export async function readBookMemory(bookId) {
  const paths = bookPaths(bookId);
  const memory = await readJson(paths.memory, null);
  return memory || blankBookMemory();
}

export async function writeBookMemory(bookId, memory) {
  const paths = await ensureBookDirs(bookId);
  memory.updatedAt = new Date().toISOString();
  await writeJson(paths.memory, memory);
  return memory;
}

export function blankFeedback() {
  return { entries: [], updatedAt: null };
}

export async function readBookFeedback(bookId) {
  const paths = bookPaths(bookId);
  return (await readJson(paths.feedback, null)) || blankFeedback();
}

export async function writeBookFeedback(bookId, feedback) {
  const paths = await ensureBookDirs(bookId);
  feedback.updatedAt = new Date().toISOString();
  await writeJson(paths.feedback, feedback);
  return feedback;
}

/* ------------------------------------------------------- 未完任务 -- */

/**
 * 这本书「还有活没干完」的记录。
 *
 * 为什么要单独存一份：任务状态本来只活在内存里，
 * 用户点了暂停、刷新一下页面，左下角的任务坞就消失了，
 * 再也不知道该从哪里接着做。用户的原话是
 * 「刷新一下，左下角弹窗就不见了，也没办法点击继续生成了」。
 *
 * 这份记录与内存中的任务无关：只要还有未完成的章节就写下来，
 * 界面每次打开书籍页都会读到它，并显示一个显眼的「继续处理」入口。
 */
export function pendingWorkPath(bookId) {
  return path.join(bookDir(bookId), 'pending-work.json');
}

/* --------------------------------------------------- 阅读路径规划 -- */

/**
 * 这本书的「重新规划」结果。
 *
 * 它记录：每章是什么性质（核心/有用/背景/填充）、建议怎么处理
 * （精读改写 / 压缩成提要 / 原样保留）、以及理由。
 *
 * 为什么要落盘、而不是每次重新问模型：
 *  1. 「哪一章没价值」是**编辑判断**，用户要能审、能改判，
 *     改判结果必须留得住（`overrides` 字段）；
 *  2. 导出时要用它决定哪些章节放提要、要不要插阅读路径页；
 *  3. 重新规划一次要读一遍全书，不该重复花钱。
 */
export function bookPlanPath(bookId) {
  return path.join(bookDir(bookId), 'book-plan.json');
}

/**
 * 方案里的章号统一洗成数字。
 *
 * 为什么非得在**读入口**做：下游有十几处拿方案条目和章节目录比，
 * 写法都是 `e.index === chapter.index` 或 `skipSet.has(index)`。
 * 一旦方案文件里的章号是字符串（手改过、旧版本写出、或在编辑器里
 * `JSON.stringify` 时把键当成了字符串），这些比较永远为 false，而且
 * **不报任何错**：界面说这一章原样保留，导出时却把磁盘上更早的改写
 * 结果顶上去；报告的「原文字数」也会悄悄算错。
 *
 * 在唯一读入口洗一遍，比在每个调用点补 `Number()` 可靠 ——
 * 漏一处就是一处静默的错误账。而单看 `Number()` 本身也不够：
 * `Number(null)` 和 `Number('')` 都是 0、`Number(true)` 是 1，全都过得了
 * `Number.isFinite()`，一条手改坏的 `index: null` 会以「第 0 章」留下来，
 * 阅读路径页把全书 4 章写成 5 章。章节号从 1 开始（导入器按 i+1 编号），
 * 所以只收正整数与纯数字字符串，其余一律当坏条目丢掉。
 */
function planChapterIndex(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) {
    const n = Number(value);
    return n > 0 ? n : null;
  }
  return null;
}

function normalizePlanIndices(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const entries = Array.isArray(plan.entries)
    ? plan.entries
        .map((e) => {
          const index = planChapterIndex(e?.index);
          return index === null ? null : { ...e, index };
        })
        .filter(Boolean)
    : plan.entries;
  const order = Array.isArray(plan.order)
    ? plan.order.map(planChapterIndex).filter((n) => n !== null)
    : plan.order;
  return { ...plan, entries, order };
}

export async function readBookPlan(bookId) {
  return normalizePlanIndices(await readJson(bookPlanPath(bookId), null));
}

export async function writeBookPlan(bookId, plan) {
  await ensureBookDirs(bookId);
  const payload = { ...plan, updatedAt: new Date().toISOString() };
  await writeJson(bookPlanPath(bookId), payload);
  return payload;
}

export async function clearBookPlan(bookId) {
  await fs.rm(bookPlanPath(bookId), { force: true });
}

export async function writePendingWork(bookId, work) {
  const paths = await ensureBookDirs(bookId);
  await writeJson(pendingWorkPath(bookId), { ...work, updatedAt: new Date().toISOString() });
  return work;
}

export async function readPendingWork(bookId) {
  return readJson(pendingWorkPath(bookId), null);
}

/** 没有未完成的工作时清掉记录，避免界面一直提示「继续处理」。 */
export async function clearPendingWork(bookId) {
  await fs.rm(pendingWorkPath(bookId), { force: true });
}

/* -------------------------------------------------------------- 导出 -- */

export async function listExports(bookId) {
  const dir = bookPaths(bookId).exports;
  try {
    const files = await fs.readdir(dir);
    const out = [];
    for (const name of files) {
      if (!name.toLowerCase().endsWith('.epub')) continue;
      const stat = await fs.stat(path.join(dir, name));
      out.push({ name, size: stat.size, createdAt: stat.mtime.toISOString() });
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  } catch {
    return [];
  }
}

/**
 * 自动保留的导出份数上限。
 *
 * 每点一次「导出 EPUB」就会新增一份（带 ` (2)`、` (3)` 后缀，从不覆盖），
 * 而一本 93MB 的书占 93MB。用户查了一次就发现工作区里堆了 18 份、
 * 3.3 GB —— 他以为「下载完删掉浏览器的就行了」，不知道工作区还留着。
 * 所以导出后顺手把更早的清掉，只留最近几份。
 */
const MAX_EXPORTS = 3;

/** 导出成品。 */
export async function saveExport(bookId, fileName, buffer, meta = {}) {
  const paths = await ensureBookDirs(bookId);
  /**
   * 这里**只做安全清理，不做长度截断**（maxLength 放到 240）。
   *
   * 长度已经由 personalizedFileName() 统一控制在 110 以内，而且它是
   * 「先压缩标题、再拼 AI 标记」的。如果这里再用默认的 120 砍一刀，
   * 砍掉的正好是标记的尾巴 —— 用户的成品文件名就是这么变得
   * 和原文件一模一样的。这里的长度上限只用于兜住外部直接传进来的
   * 畸形文件名，不该参与正常的命名。
   */
  const safe = `${sanitizeFileName(fileName.replace(/\.epub$/i, ''), 'export', 240)}.epub`;
  const target = path.join(paths.exports, safe);
  await writeFileAtomic(target, buffer);
  /**
   * 不再往 workspace/exports 写第二份。
   *
   * 那一份是早先「所有导出汇总到一起方便找」的想法留下的，
   * 但**没有任何地方读它**（只写、只在删除时清理），
   * 等于每本书的磁盘占用直接翻倍：一份 93MB 的书变成 186MB。
   * 对本地单人使用来说纯属浪费，去掉。
   */
  await writeJson(
    path.join(paths.exports, `${safe}.json`),
    {
      fileName: safe,
      size: buffer.length,
      createdAt: new Date().toISOString(),
      ...meta,
    },
  );
  await pruneExports(bookId, MAX_EXPORTS);
  return { fileName: safe, size: buffer.length, path: target };
}

/**
 * 只保留最近 N 份导出，其余连 .json 记录一起删掉。
 * 清理失败不影响导出本身（最坏情况就是多占点磁盘）。
 */
async function pruneExports(bookId, keep) {
  try {
    const dir = bookPaths(bookId).exports;
    const entries = await fs.readdir(dir).catch(() => []);
    const exports_ = [];
    for (const name of entries) {
      if (!name.endsWith('.epub')) continue;
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (stat) exports_.push({ name, mtimeMs: stat.mtimeMs });
    }
    exports_.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of exports_.slice(keep)) {
      await fs.rm(path.join(dir, old.name), { force: true });
      await fs.rm(path.join(dir, `${old.name}.json`), { force: true });
      // 顺手清掉历史版本可能残留在顶层汇总目录的副本
      await fs.rm(path.join(exportsRoot(), `${bookId}__${old.name}`), { force: true });
    }
  } catch {
    /* 清理失败不影响导出 */
  }
}

export async function readExport(bookId, fileName) {
  // 上限必须和 saveExport 一致：这里若用更小的值，长文件名的查/删会找不到文件
  const safe = `${sanitizeFileName(fileName.replace(/\.epub$/i, ''), 'export', 240)}.epub`;
  const target = path.join(bookPaths(bookId).exports, safe);
  if (!(await exists(target))) throw new NotFoundError(`导出文件不存在: ${fileName}`);
  return { buffer: await fs.readFile(target), fileName: safe };
}

export async function deleteExport(bookId, fileName) {
  // 上限必须和 saveExport 一致：这里若用更小的值，长文件名的查/删会找不到文件
  const safe = `${sanitizeFileName(fileName.replace(/\.epub$/i, ''), 'export', 240)}.epub`;
  const target = path.join(bookPaths(bookId).exports, safe);
  await fs.rm(target, { force: true });
  await fs.rm(`${target}.json`, { force: true });
  await fs.rm(path.join(exportsRoot(), `${bookId}__${safe}`), { force: true });
  return { deleted: safe };
}

export async function deleteBook(bookId) {
  const paths = bookPaths(bookId);
  await fs.rm(paths.dir, { recursive: true, force: true });
  const exported = await fs.readdir(exportsRoot()).catch(() => []);
  for (const name of exported) {
    if (name.startsWith(`${bookId}__`)) {
      await fs.rm(path.join(exportsRoot(), name), { force: true });
    }
  }
  return { bookId };
}
