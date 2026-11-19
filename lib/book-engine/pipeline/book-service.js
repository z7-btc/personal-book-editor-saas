/**
 * 书籍级编排：导入 / 提取 / 导出。
 *
 * Phase 1 的核心就是这里：input.epub -> 不经过 AI -> output.epub 必须能正常打开。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { readEpub } from '../epub/epub-reader.js';
import { repackEpub, personalizedFileName, insertFrontPage, insertTocEntry, reorderSpine, reorderToc, dropChapters, AI_MARKER, PLAIN_MARKER } from '../epub/epub-writer.js';
import { renderReadingPathPage, READING_PATH_HREF, READING_PATH_ID, READING_PATH_TOC_TITLE } from './reading-path.js';
import { buildSpineOrder, attachRestToChapters } from './book-plan.js';
import { alignTitleToBody, hanScriptOf, toSimplified } from './han-variants.js';
import { extractBlocks } from '../epub/sanitize.js';
import { cleanChapterXhtml } from '../epub/mediawiki.js';
import { injectPbeStyle } from '../epub/pbe-style.js';
import { parseXml } from '../epub/xml-dom.js';
import { newBookId } from '../util/ids.js';
import { normalizeProfile } from '../config/profile.js';
import { analyzeChapterDocument, inferChapterTitle, isRewritable, noTextReason } from '../epub/chapter-info.js';
import { analyzeInboundLinks } from '../epub/inbound-links.js';
import { buildNoteIndex } from '../epub/footnotes.js';
import { writeFileAtomic, readJson, writeJson, exists } from '../util/fsx.js';
import { ValidationError, NotFoundError, EpubError } from '../util/errors.js';
import * as ws from './workspace.js';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB，足够任何正常电子书

/**
 * 导入一本 EPUB：解析 -> 落盘原文 -> 写 metadata -> 为每章建立目录。
 *
 * 这一步**不做 AI**，也**不改内容**，只是把书「拆开摆好」，
 * 这样刷新页面 / 重启程序都能继续。
 *
 * @param {Object} args
 * @param {Buffer} args.buffer
 * @param {string} args.fileName
 * @param {object} args.profile
 * @returns {Promise<object>} metadata
 */
export async function importBook({ buffer, fileName, profile }) {
  if (!buffer || buffer.length === 0) throw new ValidationError('上传的文件为空');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ValidationError(`文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 200MB`);
  }
  assertLooksLikeZip(buffer);
  const safeName = String(fileName || 'book.epub').replace(/[\\/]/g, '_').slice(0, 200);
  if (!/\.epub$/i.test(safeName)) {
    throw new ValidationError('只支持 .epub 文件');
  }

  // 解析（这一步就会因为结构不合法而抛出可读错误）
  const book = readEpub(buffer);

  const bookId = newBookId();
  const paths = await ws.ensureBookDirs(bookId);

  // 1) 原文落盘（永不覆盖）
  await writeFileAtomic(paths.original, buffer);

  // 2) 画像快照（冻结处理时使用的画像）
  await ws.writeProfileSnapshot(bookId, profile);

  // 3) 建立章节目录并统计
  let totalChars = 0;
  let totalWords = 0;
  const chapterSummaries = [];
  for (const chapter of book.chapters) {
    const chapterPaths = ws.chapterPaths(bookId, chapter.index);
    await fsp.mkdir(chapterPaths.dir, { recursive: true });

    let info = { kind: 'content', textLength: 0, blockCount: 0, imageCount: 0, heading: '', firstText: '' };
    let skippedBlocks = 0;
    let fullText = '';
    try {
      const doc = book.getDocument(chapter.href);
      info = analyzeChapterDocument(doc);
      const { skipped } = extractBlocks(doc);
      skippedBlocks = skipped.length;
      fullText = doc.documentElement.textContent;
    } catch {
      // 单章解析失败不阻断导入，导出时会原样搬运
    }

    chapter.textLength = info.textLength;
    chapter.wordCount = countWordsSafe(fullText);
    chapter.isCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(fullText.slice(0, 3000));
    chapter.blockCount = info.blockCount;
    chapter.skippedBlocks = skippedBlocks;
    totalChars += chapter.textLength || 0;
    totalWords += chapter.wordCount || 0;

    // 没有 TOC 标题的章节，用正文推断一个能看懂的标题。
    // 否则界面上会出现 text00027 这种对用户毫无意义的文件名。
    const title = inferChapterTitle({
      title: chapter.title,
      navTitle: chapter.navTitle,
      kind: info.kind,
      heading: info.heading,
      firstText: info.firstText,
      index: chapter.index,
      href: chapter.href,
    });

    chapterSummaries.push({
      index: chapter.index,
      id: chapter.id,
      href: chapter.href,
      title,
      tocTitle: chapter.navTitle || null,
      // content / tiny / image-only / empty：界面据此说明"这页没有可改写的正文"
      kind: info.kind,
      rewritable: isRewritable(info.kind),
      linear: chapter.linear,
      mediaType: chapter.mediaType,
      textLength: chapter.textLength,
      wordCount: chapter.wordCount,
      isCjk: chapter.isCjk,
      blockCount: chapter.blockCount || 0,
      skippedBlocks,
      imageCount: info.imageCount || 0,
    });
  }

  // 4) metadata
  const now = new Date().toISOString();
  const metadata = {
    bookId,
    title: book.title || safeName.replace(/\.epub$/i, ''),
    authors: book.creators?.length ? book.creators : findAuthorsFromChapters(book),
    language: book.metadata.language || '',
    publisher: book.metadata.publisher || '',
    date: book.metadata.date || '',
    description: (book.metadata.description || '').slice(0, 4000),
    subjects: book.metadata.subjects || [],
    identifiers: book.metadata.identifiers || [],
    sourceFileName: safeName,
    sourceSize: buffer.length,
    epubVersion: book.version || '',
    opfPath: book.opfPath,
    opfDir: book.opfDir,
    navPath: book.navItem?.href || '',
    ncxPath: book.ncxItem?.href || '',
    chapterCount: chapterSummaries.length,
    totalChars,
    totalWords,
    chapters: chapterSummaries,
    toc: book.toc.slice(0, 2000),
    warnings: book.warnings || [],
    createdAt: now,
    updatedAt: now,
    // 记录元数据版本，方便以后给老书做一次性升级（见 upgradeBookMetadata）
    schemaVersion: ws.CURRENT_METADATA_VERSION,
  };
  await ws.writeBookMetadata(bookId, metadata);

  // 5) 空记忆 + 空反馈骨架
  await ws.writeBookMemory(bookId, ws.blankBookMemory());
  await ws.writeBookFeedback(bookId, ws.blankFeedback());

  return metadata;
}

function assertLooksLikeZip(buffer) {
  if (buffer.length < 22) throw new EpubError('文件太小，不是有效的 EPUB');
  const sig = buffer.readUInt32LE(0);
  // PK\x03\x04 或 PK\x05\x06（空包）
  if (sig !== 0x04034b50 && sig !== 0x06054b50) {
    throw new EpubError('文件不是 ZIP/EPUB 格式（文件头不正确）');
  }
}

/**
 * 元数据里没有作者时，从章首导航表的「作者：鲁迅」补一个。
 *
 * 维基文库导出的 EPUB 基本都不写 dc:creator，元数据里的作者是空的 ——
 * 读者看不到作者，后面做补讲也认不出「鲁迅怎样怎样」这种第三人称旁白。
 * 只看前几章，找到就返回，找不到就留空（不猜）。
 */
function findAuthorsFromChapters(book) {
  const items = (book.toc || []).filter((t) => t.href && book.zip?.has(t.href)).slice(0, 7);
  for (const item of items) {
    try {
      const raw = book.zip.readXmlText(item.href).text;
      const { author } = cleanChapterXhtml(raw, { lang: book.metadata?.language || 'zh' });
      const name = String(author || '').replace(/[（(].*?[）)]/g, '').trim();
      if (name && name.length <= 24) return [name];
    } catch {
      // 某一章读不出来不影响导入
    }
  }
  return [];
}

function countWordsSafe(text) {  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const words = (rest.match(/[A-Za-z0-9\u00c0-\u024f][A-Za-z0-9\u00c0-\u024f'’\-]*/g) || []).length;
  return cjk + words;
}

/**
 * 提取一章：写出 original.xhtml / chunks.json / status.json。
 * @param {string} bookId
 * @param {number} chapterIndex
 * @param {{force?: boolean, targetCharsPerChunk?: number, maxCharsPerChunk?: number}} [opts]
 */
export async function extractChapter(bookId, chapterIndex, opts = {}) {
  const metadata = await ws.readBookMetadata(bookId);
  const chapter = metadata.chapters.find((c) => c.index === chapterIndex);
  if (!chapter) throw new NotFoundError(`章节不存在: ${chapterIndex}`);

  const paths = ws.chapterPaths(bookId, chapterIndex);
  if (!opts.force && (await exists(paths.chunks))) {
    const chunks = await readJson(paths.chunks, []);
    const status = await ws.readChapterStatus(bookId, chapterIndex);
    return { cached: true, chunks, status };
  }

  const originalPath = ws.bookPaths(bookId).original;
  const buffer = await fsp.readFile(originalPath);
  const book = readEpub(buffer);
  /**
   * 交给模型之前，先把「网页外壳」拿掉（维基文库这类来源必带）：
   * 章首导航表（上一章 / 作者 / 下一章）、「姊妹计划」、页脚的许可声明、
   * 封面上的导出水印，以及本该显示、却写成空标签的繁简转换文字。
   *
   * 不拿掉的后果是「模型把导航表当正文改写」，成品每章开头都顶着
   * 「←上一章 本章 作者：某人 下一章→ 姊妹计划: 数据项」。
   * 清理是**读取时**做的，原书文件一个字节都不改（导出时未改写的章节照原样）。
   */
  const rawXhtml = book.zip.readXmlText(chapter.href).text;
  const cleaned = cleanChapterXhtml(rawXhtml, {
    lang: book.metadata.language || metadata.language || 'zh',
  });
  const xhtml = cleaned.xhtml;
  const doc = parseXml(xhtml);
  const { blocks, skipped } = extractBlocks(doc);
  const { chunkChapter } = await import('./chunker.js');
  const chunks = chunkChapter(blocks, {
    targetChars: opts.targetCharsPerChunk,
    maxChars: opts.maxCharsPerChunk,
    chapterTitle: chapter.title,
  });

  const bodyText = doc.documentElement?.textContent || '';
  const info = analyzeChapterDocument(doc);
  const status = ws.blankChapterStatus(chapter);
  status.stage = (await exists(paths.rewrittenHtml)) ? 'completed' : 'pending';
  status.chunkTotal = chunks.length;
  status.chunkDone = 0;
  status.originalChars = bodyText.replace(/\s+/g, '').length;
  status.blockCount = blocks.length;
  status.skippedBlockCount = skipped.length;
  status.kind = info.kind;
  status.extractedAt = new Date().toISOString();
  if (!isRewritable(info.kind)) {
    // 纯图片页 / 空白页：没有任何可交给模型的正文。
    // 明确标成 skipped，既省掉无意义的 API 调用，也避免模型往
    // 只有 <div><img></div> 的页面里塞文字、反而破坏结构。
    status.stage = 'skipped';
    status.note = noTextReason(info.kind) + '（导出时会原样保留）';
  }
  await ws.saveChapterExtraction(bookId, chapterIndex, {
    originalXhtml: xhtml,
    chunks: chunks.map((c) => ({
      index: c.index,
      id: c.id,
      headingPath: c.headingPath,
      nextHeading: c.nextHeading,
      charCount: c.charCount,
      blockIndexes: c.blockIndexes,
    })),
    status,
  });

  return { cached: false, chunks, status, skipped, info };
}

/**
 * 规划里标了 `digest`、而且**真的已经压完**的章节号。
 *
 * 用来让「阅读路径」页上的那句话说实话：规划只是打算压缩，
 * 只有状态里落了 `digest: true` 才算压过了。
 */
async function collectDigestedIndexes(bookId, plan) {
  const out = new Set();
  for (const e of plan?.entries || []) {
    if (e.strategy !== 'digest') continue;
    const status = await ws.readChapterStatus(bookId, e.index).catch(() => null);
    if (status?.digest && status.stage === 'completed') out.add(e.index);
  }
  return out;
}

/**
 * 每章**真的**删掉了几段（第二遍补讲/删段的结果）。
 *
 * 阅读路径页要在对应章节下写「本章已删去 N 段」。这个数只能读实际状态：
 * 规划里的 `fillerParts` 只是「这里可能有水分」的估计，
 * 拿估计写成事实，页面就会和书里的正文对不上 —— 这正是这一版要修的东西。
 *
 * @returns {Promise<Map<number, number>>} 章号 -> 删除段数
 */
async function collectDroppedParagraphs(bookId, plan) {
  const out = new Map();
  for (const e of plan?.entries || []) {
    if (e.strategy !== 'keep') continue;
    const status = await ws.readChapterStatus(bookId, e.index).catch(() => null);
    const count = Number(status?.stats?.dropped || 0);
    if (count > 0) out.set(e.index, count);
  }
  return out;
}

/**
 * 哪些章**不能删**，以及为什么。
 *
 * 判据只有一条：**还有别人指着它吗**。删掉一个被链接指向的章节，
 * 那些链接就会落到一个不在 spine 里的文件上 —— 有的阅读器照常打开，
 * 有的直接没反应，行为不一致本身就是 bug，而且不报错。
 *
 * 关键细节：要用「导出时真正会用的那一版」来算。
 * 用户那本书的目录页（第 8 章）原本指向每一章开头，压成提要之后
 * 那 85 个块连同链接一起没了 —— 拿原书快照算，会把一堆其实已经
 * 没人指向的章节误判成「有人指着」，删不掉。
 *
 * @returns {Promise<Map<string,string>>} manifest id -> 拒绝理由
 */
async function collectDropBlockers(bookId, metadata, plan) {
  const blocked = new Map();
  const dropEntries = (plan?.entries || []).filter((e) => e.strategy === 'drop');
  if (!dropEntries.length) return blocked;

  const paths = ws.bookPaths(bookId);
  const book = readEpub(await fsp.readFile(paths.original));
  const chapters = [];
  for (const c of metadata.chapters || []) {
    const rewritten = await ws.readChapterRewritten(bookId, c.index);
    chapters.push({
      index: c.index,
      href: c.href,
      xhtml: rewritten ?? (book.zip.has(c.href) ? book.zip.readXmlText(c.href).text : ''),
    });
  }
  const { inbound } = analyzeInboundLinks(chapters);

  for (const e of dropEntries) {
    const links = inbound.get(e.index) || [];
    if (!links.length) continue;
    const froms = [...new Set(links.map((l) => l.from))].sort((a, b) => a - b);
    const chapter = book.chapters.find((x) => x.index === e.index);
    if (!chapter) continue;
    blocked.set(
      chapter.id,
      `有 ${links.length} 条链接从第 ${froms.slice(0, 5).join('、')}${froms.length > 5 ? ' 等' : ''} 章指向它，删掉会让这些链接点不动`,
    );
  }
  return blocked;
}

/**
 * 算清楚：哪些注释已经**真的**融进正文了。
 *
 * 不能一刀切「把尾注全删掉」。用户这本书里第 13 章是**压缩成提要**的
 * （它引用 23 条注释），压缩走的是另一条链路，不做脚注就地化 ——
 * 那 23 条注释的引用点还在正文里，尾注条目也还得留着，否则内容就真丢了。
 *
 * 判据因此是「**这个引用点在成品正文里还活着吗**」：
 *   · 活着（第 13 章那种）=> 尾注条目保留，回链也还能用；
 *   · 没了（就地化把它融进句子了）=> 尾注条目纯重复，删掉。
 *
 * @returns {Promise<Set<string>>} 可以删掉的注释锚点 id 集合
 */
async function collectInlinedNoteAnchors(bookId, metadata, book, replacements) {
  const { notes, refToNote, ownerIndex } = await buildBookNoteRefs(bookId);
  if (!notes.size || ownerIndex == null) return new Set();

  /** 注释锚点 -> 正文引用点 */
  const noteToRef = new Map();
  for (const [refId, anchorId] of refToNote) noteToRef.set(anchorId, refId);

  /** 成品正文里还活着的引用点 */
  const aliveRefs = new Set();
  for (const c of metadata.chapters || []) {
    if (c.index === ownerIndex) continue; // 尾注章自己不参与判断
    const replaced = replacements.get(c.href);
    const text = replaced ?? (book.zip.has(c.href) ? book.zip.readXmlText(c.href).text : '');
    for (const m of text.matchAll(/id="(jzyy_[^"]+)"/g)) aliveRefs.add(m[1]);
  }

  const strippable = new Set();
  for (const [anchorId] of notes) {
    const refId = noteToRef.get(anchorId);
    if (!refId || !aliveRefs.has(refId)) strippable.add(anchorId);
  }
  return strippable;
}

/**
 * 把尾注汇编章里的注释条目整块删掉，只留下**不是注释**的内容。
 *
 * ## 为什么必须做这一步
 *
 * 脚注就地化之后，每一条注释都已经融进了正文里它该在的位置。
 * 而尾注汇编章（用户这本书是第 28 章「延伸阅读」）还整整齐齐列着
 * 全部 483 条 —— 内容 100% 重复，占 64,638 字（全书的 9%）。
 *
 * 更要命的是它的**回链**：每条注释开头都有一个
 * `<a href="text00015.html#jzyy_1_28">(1)</a>` 指回正文里的引用点。
 * 而就地化会把正文里的引用点 `<a>` 丢掉（`blockToPlainText` 故意不把
 * 它们放进 marks），于是这 483 条回链全部指向不存在的锚点 ——
 * 阅读器不报错，读者点一下什么都不会发生。
 *
 * 所以：注释融进正文之后，尾注列表就该退场。
 * 但它**不是整章都是注释** —— 开头还有一段「延伸阅读」书单，
 * 那是独立内容，必须留下。所以按块删，不是整章删。
 *
 * @param {string} xhtml 尾注汇编章的原文
 * @param {Set<string>} noteAnchors 注释条目的锚点 id（`jz_*`）
 * @returns {{xhtml: string, removedBlocks: number, keptBlocks: number, keptChars: number}}
 */
export function stripNoteEntries(xhtml, noteAnchors) {
  const doc = parseXml(xhtml);
  const { blocks } = extractBlocks(doc);
  const dirtyParents = new Set();
  let removedBlocks = 0;
  let keptBlocks = 0;

  for (const block of blocks) {
    const el = block.element;
    const ids = [];
    const own = el.getAttribute?.('id');
    if (own) ids.push(own);
    for (const node of el.descendants ? el.descendants() : []) {
      const id = node.getAttribute?.('id');
      if (id) ids.push(id);
    }
    if (ids.some((id) => noteAnchors.has(id))) {
      const parent = el.parentNode;
      if (parent) dirtyParents.add(parent);
      el.detach();
      removedBlocks += 1;
      continue;
    }
    keptBlocks += 1;
  }

  /**
   * 和 applyDigest 同一个坑：光 `detach()` 不够。
   * 这套 DOM 是字节保真的，没标成 rebuilt 的父节点序列化时会按源区间
   * 把删掉的段落原样回填 —— 删了等于没删。
   */
  for (const parent of dirtyParents) {
    parent.rebuilt = true;
    parent.touch();
  }

  const out = doc.serialize();
  const keptChars = out.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
  return { xhtml: out, removedBlocks, keptBlocks, keptChars };
}

/**
 * 全书脚注索引：哪条注释、正文在哪里引用、注释正文是什么。
 *
 * 和 `analyzeBookInboundLinks` 一样，**必须读原始 EPUB**：
 * 脚注是「正文里的引用点」和「尾注里的注释条目」**成对互指**才认得出来
 * （见 footnotes.buildNoteIndex 的说明），只看一章是拼不出来的。
 *
 * 返回的 `noteRefs` 直接喂给 `rewriteChapter({ noteRefs })`，
 * 让模型在**原位**看到注释正文，从而决定是融进句子还是丢掉。
 *
 * @param {string} bookId
 * @returns {Promise<{noteRefs: Map<string, object>, notes: Map<string, object>,
 *                    refToNote: Map<string, string>, totalNotes: number,
 *                    ownerIndex: number|null}>}
 *        ownerIndex：注释条目所在的那一章（用户这本书是第 28 章「延伸阅读」）
 */
export async function buildBookNoteRefs(bookId) {
  const metadata = await ws.readBookMetadata(bookId);
  const buffer = await fsp.readFile(ws.bookPaths(bookId).original);
  const book = readEpub(buffer);
  const chapters = (metadata.chapters || []).map((c) => ({
    index: c.index,
    href: c.href,
    xhtml: book.zip.has(c.href) ? book.zip.readXmlText(c.href).text : '',
  }));
  const { notes, refToNote, totalNotes } = buildNoteIndex(chapters);

  /**
   * `blockToPlainText` 要的是 **Map<引用点 id, 注释对象>** ——
   * 它在遇到 `<a id="jzyy_1_28" href="…#jz_1_28">` 时会先拿 `id` 查表。
   * 所以这里要把「引用点 -> 注释锚点 -> 注释正文」两层压成一层。
   */
  const noteRefs = new Map();
  for (const [refId, anchorId] of refToNote) {
    const note = notes.get(anchorId);
    if (note) noteRefs.set(refId, { anchor: anchorId, ...note });
  }

  /** 注释条目最多、引用点最少的那一章就是尾注汇编章 */
  let ownerIndex = null;
  let best = 0;
  const ownerCount = new Map();
  for (const [, note] of notes) {
    ownerCount.set(note.chapter, (ownerCount.get(note.chapter) || 0) + 1);
  }
  for (const [chapter, count] of ownerCount) {
    const refCount = [...refToNote.keys()].filter((refId) => chapters.find((c) => c.index === chapter)?.xhtml.includes(`id="${refId}"`)).length;
    if (count > best && count > refCount) {
      best = count;
      ownerIndex = chapter;
    }
  }

  return { noteRefs, notes, refToNote, totalNotes, ownerIndex };
}

/**
 * 全书入链分析：谁指着谁、指着哪个锚点。
 *
 * 直接读**原始 EPUB**，不依赖各章是否已经「提取」过 ——
 * 压缩一章之前必须问一次「有没有人指着它」，这个答案不能因为
 * 某个中间文件缺失就少算（少算 = 把别人要跳过来的锚点删掉，
 * 而阅读器不会报错，读者点一下什么都不发生）。
 *
 * @param {string} bookId
 * @returns {Promise<{inbound: Map<number, Array<{from:number,anchor:string}>>,
 *                    anchorHits: Map<number, Set<string>>, totalLinks: number}>}
 */
export async function analyzeBookInboundLinks(bookId) {
  const metadata = await ws.readBookMetadata(bookId);
  const buffer = await fsp.readFile(ws.bookPaths(bookId).original);
  const book = readEpub(buffer);
  const chapters = (metadata.chapters || []).map((c) => ({
    index: c.index,
    href: c.href,
    xhtml: book.zip.has(c.href) ? book.zip.readXmlText(c.href).text : '',
  }));
  return analyzeInboundLinks(chapters);
}

/**
 * 导出 EPUB。
 *
 * - includeRewritten 为空 => 纯搬运（Phase 1 验收：input.epub -> output.epub 能打开）
 * - 否则只替换列出的章节，其余条目字节级搬运
 *
 * @param {Object} args
 * @param {string} args.bookId
 * @param {number[]} [args.chapters]       要写入改写内容的章节序号
 * @param {string} [args.fileName]
 * @param {object} [args.extra]
 */
export async function exportBook({ bookId, chapters = [], fileName, extra = {} }) {
  const metadata = await ws.readBookMetadata(bookId);
  const paths = ws.bookPaths(bookId);
  const buffer = await fsp.readFile(paths.original);
  const book = readEpub(buffer);
  /** 有规划就把「阅读路径」页插到最前面（见 insertReadingPath） */
  const plan = await ws.readBookPlan(bookId).catch(() => null);

  const replacements = new Map();
  const included = [];
  const missing = [];
  const keptOriginal = [];
  const chapterByIndex = new Map(book.chapters.map((c) => [c.index, c]));
  /**
   * 规划里标了 `skip`（原样保留，不处理）的章节，导出时**必须用原文**。
   *
   * 不管的话会出一个很难发现的不一致：这些章在更早的时候被改写过
   * （那时还没有规划），磁盘上留着 rewritten.xhtml，导出时就会被顶上去。
   * 于是成品里的内容是改写过的，而「阅读路径」页上写着「原样保留 2 章」——
   * 说的和做的对不上。用户那本书的第 2 章（卷首题词）和第 28 章
   * （延伸阅读与尾注）就是这种情况。
   */
  const skipSet = new Set(
    (plan?.entries || []).filter((e) => e.strategy === 'skip').map((e) => e.index),
  );
  const planTitleOf = (index) =>
    plan?.entries?.find((e) => Number(e.index) === Number(index))?.displayTitle || '';
  /** 每章最终用的标题（已和正文对齐），导出后要同步到目录和阅读路径页 */
  const titleByIndex = new Map();
  const lang = book.metadata?.language || metadata.language || 'zh';
  /**
   * 「原样保留」指的是**正文不动**，不是把网页外壳一起搬进成品。
   *
   * 维基文库的书，每一章的章名在章首导航表里、页脚是许可声明、扉页带一句
   * 导出水印。这些在成品里一个都不该出现 —— 但它们属于「没被改写的章节」，
   * 以前走的是字节级搬运，于是最新一版成品里：合集页整页繁体 + 「←上一篇
   * 姊妹计划:数据项」原样留着，封面还写着「以2026年11月17日从维基文库导出」。
   *
   * 只做结构性清理（导航 / 姊妹计划 / 许可 / 水印 / 空段），一个字都不改正文。
   */
  const cleanedOriginal = (chapter) => {
    const raw = book.zip.has(chapter.href) ? book.zip.readXmlText(chapter.href).text : '';
    if (!raw) return null;
    const cleaned = cleanChapterXhtml(raw, { lang });
    return cleaned.xhtml || null;
  };

  /**
   * 「原样保留」的章节收尾：洗外壳之后，还要跟全书用同一种字、补上章名。
   *
   * 「原样保留」说的是**内容不改写**，不是原封不动地把繁体正文摆进一本
   * 简体书里 —— 读者翻到封面或版权页，会看到整本书只有那一两页是另一种字。
   * 字形归一放在这里做（不改文意），正文一个字都不增删。
   */
  const finalizeOriginal = (chapter) => {
    const cleaned = cleanedOriginal(chapter);
    if (!cleaned) return null;
    const index = Number(chapter.index);
    const body =
      bookScript === 'simplified' && hanScriptOf(plainBodyText(cleaned)) === 'traditional'
        ? simplifyTextNodes(cleaned)
        : cleaned;
    const rawTitle = planTitleOf(index) || chapter.title || '';
    const title =
      bookScript === 'simplified' ? toSimplified(rawTitle) : alignTitleToBody(rawTitle, plainBodyText(body));
    titleByIndex.set(index, title);
    return ensureChapterTitle(alignForeignHeading(body, title), title);
  };

  /**
   * 先把改写结果收集起来，再统一决定「整本书用哪种字」。
   *
   * 模型改写同一本书时会摇摆：《朝花夕拾》实测 9 章改写里 8 章简体、
   * 1 章繁体（它跟着原书抄）。逐章各管各的，成品就是一本字不一样的书。
   * 一本书只能有一种字形，判定要放在整本书这一层。
   */
  const pending = [];
  /** 「原样保留」的章节也先排队 —— 字形要等整本书判完才知道用哪种。 */
  const keepPending = [];
  for (const index of chapters) {
    const chapter = chapterByIndex.get(Number(index));
    if (!chapter) {
      missing.push({ index, reason: '章节不存在' });
      continue;
    }
    if (skipSet.has(Number(index))) {
      keepPending.push({ index: Number(index), chapter });
      keptOriginal.push(Number(index));
      continue;
    }
    const rewritten = await ws.readChapterRewritten(bookId, Number(index));
    if (!rewritten) {
      missing.push({ index, reason: '尚未改写' });
      continue;
    }
    /**
     * 章节文件不许覆盖「这次新生成的阅读路径页」。
     *
     * 老版本导入的书里可能还有一章就叫 pbe-reading-path.xhtml（导入侧现在
     * 已经不再收它了，但已经建好的书还在）。这里再拦一道：新目录页写在
     * `additions` 里，如果章节也往同一个路径写 `replacements`，
     * 谁后写谁赢 —— 实测那次是改写结果赢了，目录页被换成一副空架子。
     */
    if (/pbe-reading-path\.xhtml$/i.test(chapter.href)) {
      keptOriginal.push(Number(index));
      continue;
    }
    pending.push({ index: Number(index), chapter, rewritten });
  }

  /**
   * 整本书的字形：改写结果里占多数的那个。
   *
   * `mixed`（大部分简体夹几个繁体）算简体；没有改写结果时默认简体 ——
   * 繁体章节靠 `toTraditional` 反推是不可能的（一简对多繁），
   * 所以只有「多数是繁体」时才不归一到简体。
   */
  const scriptCount = { simplified: 0, traditional: 0 };
  for (const p of pending) {
    const s = hanScriptOf(plainBodyText(p.rewritten));
    if (s === 'traditional') scriptCount.traditional += 1;
    else if (s === 'simplified' || s === 'mixed') scriptCount.simplified += 1;
  }
  const bookScript = scriptCount.traditional > scriptCount.simplified ? 'traditional' : 'simplified';

  for (const { index, chapter, rewritten } of pending) {
    const planTitle =
      plan?.entries?.find((e) => Number(e.index) === Number(index))?.displayTitle ||
      chapter.title ||
      '';
    /**
     * 标题要和正文用同一种字 —— 模型给标题抄的是原书目录（繁体），
     * 正文却是它自己改写的简体，一个标题里两种字看起来就是排版坏了。
     * 见 `alignTitleToBody`。
     */
    const alignedTitle = bookScript === 'simplified'
      ? toSimplified(planTitle)
      : alignTitleToBody(planTitle, plainBodyText(rewritten));
    titleByIndex.set(index, alignedTitle);
    /**
     * 改写结果偶尔夹进一两个繁体字（模型抄原书时带出来的，如「画的書」），
     * 偶尔整章都是繁体。整本书以简体为主时，这些一律归一到简体 ——
     * 只替换标签之间的文字，属性、id、锚点一个都不碰。
     */
    const unified = bookScript === 'simplified' ? simplifyTextNodes(rewritten) : rewritten;
    const titled = ensureChapterTitle(unified, alignedTitle);
    replacements.set(chapter.href, withPersonalizedNote(titled, metadata, extra));
    included.push(index);
  }

  for (const { chapter } of keepPending) {
    const finalized = finalizeOriginal(chapter);
    if (finalized) replacements.set(chapter.href, withPersonalizedNote(finalized, metadata, extra));
  }

  /**
   * 规划里「原样保留」的章节可能根本不在 `chapters` 里 —— 一键整理只把
   * 「处理成功」的章节传进来（jobs.js）。漏掉它们的后果很实在：
   * 封面、版权页会带着「以…从维基文库导出」的水印和导航表直接进成品。
   */
  for (const entry of plan?.entries || []) {
    if (entry.strategy !== 'skip') continue;
    const index = Number(entry.index);
    if (chapters.map(Number).includes(index)) continue;
    const chapter = chapterByIndex.get(index);
    if (!chapter) continue;
    if (keepPending.some((k) => k.index === index)) continue;
    const finalized = finalizeOriginal(chapter);
    if (finalized) replacements.set(chapter.href, withPersonalizedNote(finalized, metadata, extra));
    if (!keptOriginal.includes(index)) keptOriginal.push(index);
  }

  /**
   * 尾注汇编章：注释已经融进正文的部分，在这里删掉。
   *
   * 不做的话会留下两个问题：内容 100% 重复（64,638 字，全书的 9%），
   * 以及 483 条指向正文、但正文那边锚点已经没了的回链 ——
   * 阅读器不报错，读者点一下什么都不会发生。
   */
  let endnoteStrip = null;
  let noteInline = null;
  try {
    const info = await buildBookNoteRefs(bookId);
    if (info.ownerIndex != null) {
      const owner = chapterByIndex.get(info.ownerIndex);
      const strippable = await collectInlinedNoteAnchors(bookId, metadata, book, replacements);
      if (owner && strippable.size) {
        const original = book.zip.readXmlText(owner.href).text;
        const stripped = stripNoteEntries(original, strippable);
        replacements.set(owner.href, withPersonalizedNote(stripped.xhtml, metadata, extra));
        endnoteStrip = {
          index: info.ownerIndex,
          totalNotes: info.totalNotes,
          strippedNotes: strippable.size,
          ...stripped,
        };
      }
      noteInline = { total: info.totalNotes, stripped: strippable.size };
    }
  } catch (err) {
    console.warn('[export] 尾注汇编章处理跳过：', err.message);
  }

  /**
   * 合并「正文替换」与「插入阅读路径页」两部分改动。
   *
   * **必须合并，不能直接展开覆盖**。第一版写的是
   * `repackEpub(book, { replacements, ...insertReadingPath(...) })` ——
   * 而 insertReadingPath 自己也返回一个 `replacements`（只含 OPF 一项），
   * 展开时把正文替换整个**盖掉**了。结果是：导出的书里插进了阅读路径页，
   * 但 24 章改写内容全部退回了原文，而且不报任何错。
   *
   * 是校验脚本里那句「替换 1 个文件」露的馅 —— 一本改过 24 章的书
   * 只替换 1 个文件，本身就说不通。
   */
  /**
   * 目录和阅读路径页上的章名，用**和正文同一种字**的那一版。
   *
   * 只改导出这一份副本，磁盘上的方案仍是模型给的原话 ——
   * 界面该怎么标还怎么标，成品里不出现「繁体标题 + 简体正文」。
   */
  const planWithAlignedTitles = plan
    ? {
        ...plan,
        entries: (plan.entries || []).map((e) =>
          titleByIndex.has(Number(e.index))
            ? { ...e, displayTitle: titleByIndex.get(Number(e.index)) }
            : e,
        ),
      }
    : plan;

  const pathPage = applyPlanToStructure(book, planWithAlignedTitles, metadata, {
    digestedIndexes: await collectDigestedIndexes(bookId, plan),
    /** 每章实际删掉几段：阅读路径页上要写实数，不写估计 */
    droppedParagraphs: await collectDroppedParagraphs(bookId, plan),
    /**
     * 删除之前必须知道「谁还指着谁」—— 而且要用**导出时真正会用的那一版**算：
     * 改写过就用改写版，否则用原文。用原书快照算会算错：
     * 用户那本书的目录页（第 8 章）原本指向每一章，压成提要之后这些链接
     * 就没了，拿旧快照会让一堆本来能删的章节显示「有人指着」。
     */
    dropBlocked: await collectDropBlockers(bookId, metadata, plan),
    /** 脚注的去向，写在阅读路径页上 */
    noteInline,
    /**
     * 整本书用哪种字。阅读路径页上的说明文字是模型写的，
     * 它会顺手把原书目录里的繁体章名抄进来（「第4章《阿長與〈山海經〉》」），
     * 一页里两种字。这一页本来就是生成的，按全书字形归一即可。
     */
    script: bookScript,
  });
  const allReplacements = new Map(replacements);
  for (const [href, text] of pathPage.replacements || []) allReplacements.set(href, text);

  /**
   * 想删但被护栏拦下的章节（通常是「还有别的章指着它」）。
   *
   * 它留在书里、正文不动 —— 但同样不该带着网页外壳留在成品里。
   * 按「原样保留」的同一套处理：只清外壳，不碰正文。
   */
  for (const refused of pathPage.dropped?.refused || []) {
    const chapter = chapterByIndex.get(Number(refused.index));
    if (!chapter || allReplacements.has(chapter.href)) continue;
    const finalized = finalizeOriginal(chapter);
    if (finalized) allReplacements.set(chapter.href, withPersonalizedNote(finalized, metadata, extra));
  }

  const result = repackEpub(book, { replacements: allReplacements, additions: pathPage.additions });

  const taken = new Set((await ws.listExports(bookId)).map((e) => e.name.toLowerCase()));
  /**
   * 文件名必须说清楚「这是什么版本」。
   *
   * 两个坑都在这里：
   *  1. 只有**真的替换了正文**才配叫 AI 重写；一章都没换时用【未改写副本】。
   *  2. 标记放在最前面。原来的 ` - Personalized` 后缀被后面的
   *     长度截断砍掉了最后一个字母，成品文件名看起来和原文件一模一样，
   *     用户根本认不出这是 AI 改过的版本。
   */
  const name =
    fileName ||
    personalizedFileName(metadata.sourceFileName || `${metadata.title}.epub`, taken, {
      marker: included.length > 0 ? AI_MARKER : PLAIN_MARKER,
    });

  const saved = await ws.saveExport(bookId, name, result.buffer, {
    bookId,
    title: metadata.title,
    chapters: included,
    replacedCount: result.replacedCount,
    copiedCount: result.copiedCount,
    personalized: included.length > 0,
    ...extra,
  });

  return {
    ...saved,
    replacedCount: result.replacedCount,
    copiedCount: result.copiedCount,
    addedCount: result.addedCount || 0,
    includedChapters: included,
    skippedChapters: missing,
    /** 按规划原样保留（未被替换）的章节 */
    keptOriginalChapters: [...new Set(keptOriginal)],
    /** 尾注汇编章的处理结果（脚注就地化之后它就成了纯重复） */
    endnoteStrip,
    /** 真的删掉的章节 / 想删但被护栏拦下的章节 */
    droppedChapters: (pathPage.dropped?.removed || []).map((r) => r.index),
    refusedDrops: pathPage.dropped?.refused || [],
    issues: [...result.issues, ...(pathPage.issues || [])],
  };
}

/**
 * 目录里每一章该显示的名字。
 *
 * 优先用 `entries[].displayTitle` —— 导出时它已经被对齐成和正文同一种字
 * （见 `alignTitleToBody`）；方案里没有条目时才退回 `names` 名字表。
 */
function tocRenameMap(book, plan) {
  const byIndex = new Map((plan?.entries || []).map((e) => [Number(e.index), e]));
  const out = new Map();
  for (const c of book.chapters) {
    const entry = byIndex.get(c.index);
    const name = entry?.displayTitle || plan?.names?.[String(c.index)];
    if (name) out.set(c.href, String(name));
  }
  return out;
}

/**
 * 把规划施加到书的结构上：重排阅读顺序 + 插入「重构版阅读路径」页。
 *
 * 两个改动都作用在同一份 OPF DOM 上（spine 重排 + 新页插到最前面），
 * 所以必须**顺序调用、最后统一 serialize** —— 各序列化一次的话，
 * 后一次会覆盖前一次。
 *
 * 重排是**排列操作**：文件名不变、内容不动。EPUB 里所有链接都是
 * 「文件名 + 锚点」形式、不含位置信息，所以一条链接都不会失效。
 * 真正危险的是搬内容（合并/拆分/删章），那不在这一步做。
 *
 * 顺序错了就整件事不做（宁可不排，不能产出缺章的书）。
 *
 * @returns {{replacements?: Map<string,string>, additions?: Map<string,string>,
 *            readingPath?: object, spineOrder?: number[], issues: string[]}}
 */
function applyPlanToStructure(book, plan, metadata, opts = {}) {
  const issues = [];
  const replacements = new Map();
  const additions = new Map();
  let readingPath = null;
  let spineOrder = null;
  let tocRenamed = false;

  /* ------------------------------------------------------ 1) 重排 -- */
  if (Array.isArray(plan?.order) && plan.order.length) {
    try {
      const { order: wanted, moved, reason } = buildSpineOrder(
        metadata.chapters.map((c) => ({ index: c.index })),
        plan.order,
      );
      if (moved) {
        /**
         * 章节序号 -> manifest id。spine 里除了正文文档还可能有别的
         * XHTML（封面页、版权页、说明页），它们不在 metadata.chapters 里，
         * 重排时按它们在**原书 spine 里的位置**跟着相邻章节走：
         *
         *   · 后面还有正文章节 —— 贴在它后面第一个正文章节**前面**
         *     （封面在第一章前，分册扉页在下一章前，都是这个位置）；
         *   · 后面再没有正文章节 —— 留在最后（「关于本书」这类）。
         *
         * 第一版把所有非正文章节一股脑追加到末尾，成品里封面就排到了
         * 第 10 页 —— 打开书先看到目录页，封面反而在结尾。
         */
        const byIndex = new Map(book.chapters.map((c) => [c.index, c.id]));
        const orderedIds = wanted.map((i) => byIndex.get(i)).filter(Boolean);
        const chapterIds = new Set(orderedIds);
        const finalIds = attachRestToChapters(book.spine.map((s) => s.idref), chapterIds, orderedIds);

        const { opfText } = reorderSpine(book, finalIds);
        replacements.set(book.opfPath, opfText);
        spineOrder = wanted;

        // 目录顺序必须一起改，否则读者看到两套矛盾的顺序
        const finalHrefs = finalIds.map((id) => book.manifestById.get(id)?.href).filter(Boolean);
        // 目录里显示的名字也要换掉，否则读者在目录面板里看到的还是原名
        const renameByHref = tocRenameMap(book, plan);
        const toc = reorderToc(book, finalHrefs, { renameByHref });
        for (const [href, text] of toc.updates) replacements.set(href, text);
        issues.push(...toc.issues);
        if (toc.issues.length) console.warn('[export] 目录重排有问题：', toc.issues.join('；'));
        tocRenamed = true;
      } else {
        issues.push(reason);
      }
    } catch (err) {
      // 重排失败不能让整个导出挂掉 —— 正文改写才是主体
      console.warn('[export] 重排阅读顺序失败，保持原顺序：', err.message);
      issues.push(`重排跳过：${err.message}`);
    }
  }

  /**
   * 1b) 目录改名：**顺序没变也要改**。
   *
   * 「重排」和「改名」是两个独立的愿望，只是共用同一段目录代码。
   * 第一版把它们绑在 `if (moved)` 里 —— 模型认为原顺序已经合理时
   * 整件事都不执行，于是目录面板里还是「阿長與《山海經》」这种原名，
   * 正文标题却已经换成了按内容起的人话名字，两边对不上。
   */
  if (!tocRenamed) {
    const renameByHref = tocRenameMap(book, plan);
    if (renameByHref.size) {
      try {
        const currentHrefs = book.spine.map((s) => s.item?.href).filter(Boolean);
        const toc = reorderToc(book, currentHrefs, { renameByHref });
        for (const [href, text] of toc.updates) replacements.set(href, text);
        issues.push(...toc.issues);
        tocRenamed = true;
      } catch (err) {
        // 改名失败同样不能拖垮导出：目录里还是原名，正文已经改好
        console.warn('[export] 目录改名失败：', err.message);
        issues.push(`目录改名跳过：${err.message}`);
      }
    }
  }

  /* ------------------------------------------------ 2) 整章删除 -- */
  /**
   * 必须在重排之后：删除改的是同一批结构（spine / NCX），
   * 而且要靠 `replacements` 接着改过的那份目录往下写，
   * 否则会把重排结果覆盖回原样（见 parseTocDoc）。
   */
  let dropped = { removed: [], refused: [] };
  const dropEntries = (plan?.entries || []).filter((e) => e.strategy === 'drop');
  if (dropEntries.length) {
    try {
      const list = dropEntries
        .map((e) => {
          const c = book.chapters.find((x) => x.index === e.index);
          return c ? { id: c.id, href: c.href, index: e.index, title: plan.names?.[String(e.index)] || e.title } : null;
        })
        .filter(Boolean);
      const result = dropChapters(book, list, { replacements, blocked: opts.dropBlocked });
      replacements.set(book.opfPath, result.opfText);
      for (const [href, text] of result.tocUpdates || []) replacements.set(href, text);
      issues.push(...result.issues);
      dropped = { removed: result.removed, refused: result.refused };
      for (const r of result.refused) {
        // 没删成必须留痕：界面上要显示「第 N 章没能删掉，因为…」，
        // 而不是悄悄保留一章然后让用户以为自己看错了
        issues.push(`第 ${r.index} 章未删除：${r.reason}`);
      }
      if (result.refused.length) {
        console.warn('[export] 有章节没能删掉：', result.refused.map((r) => `第${r.index}章 ${r.reason}`).join('；'));
      }
    } catch (err) {
      // 删不掉不能让整个导出挂掉 —— 保留全文总比产不出书好
      console.warn('[export] 删除章节失败，已跳过：', err.message);
      issues.push(`删除跳过：${err.message}`);
    }
  }

  /* -------------------------------------------- 3) 阅读路径页 -- */
  if (plan?.entries?.length) {
    try {
      const page = (() => {
        const rendered = renderReadingPathPage(plan, {
        bookTitle: metadata.title,
        generatedAt: plan.updatedAt || plan.createdAt || new Date(),
        /**
         * 章号 -> 该章文件的路径，供目录页生成链接。
         *
         * **必须是相对该页所在目录的路径**，不能直接用 ZIP 内路径：
         * 这一页插在 OPF 同级目录（OEBPS/），章节也在 OEBPS/ 下，
         * 所以链接要写 `text00014.html`。第一版直接塞了
         * `OEBPS/text00014.html`，解析出来变成 `OEBPS/OEBPS/text00014.html`，
         * 28 条链接全死 —— 是导出后的链接体检抓出来的。
         *
         * 不带锚点：指向文件开头本来就是章节的起始位置，
         * 而且这样不依赖文件内部有没有锚点。
         */
        hrefByIndex: new Map(
          book.chapters.map((c) => {
            const prefix = book.opfDir ? `${book.opfDir}/` : '';
            const rel = prefix && c.href.startsWith(prefix) ? c.href.slice(prefix.length) : c.href;
            return [c.index, rel];
          }),
        ),
        /**
         * **真的**已经压缩完成的章节。
         *
         * 不能拿规划里的 `strategy === 'digest'` 直接当事实：规划写完、
         * 压缩还没跑的时候，页面上那句「已压缩成一页提要」就是假的，
         * 而导出的书里那些章还是全文 —— 说的和做的对不上。
         */
        digestedIndexes: opts.digestedIndexes || new Set(),
        droppedIndexes: new Set(dropped.removed.map((r) => r.index)),
        droppedParagraphs: opts.droppedParagraphs || new Map(),
        noteInline: opts.noteInline || null,
      });
        return opts.script === 'simplified' ? simplifyTextNodes(rendered) : rendered;
      })();
      // 注意顺序：重排先做，插页后做（插页会把新页放到 spine 第一位）
      const inserted = insertFrontPage(book, {
        id: READING_PATH_ID,
        href: READING_PATH_HREF,
        title: READING_PATH_TOC_TITLE,
        xhtml: page,
      });
      // 重排和插页共用同一份 OPF DOM，这里再序列化一次拿到最终结果
      replacements.set(book.opfPath, inserted.opfText);
      const zipPath = book.opfDir ? `${book.opfDir}/${READING_PATH_HREF}` : READING_PATH_HREF;
      additions.set(zipPath, page);
      /**
       * 还要在目录里加一条，否则读者翻遍目录面板也找不到这一页 ——
       * 只能靠手动往前翻。用户的原话是「没看到目录这个分类」。
       *
       * 调用顺序不能动：**必须在重排之后**。reorderToc 按「子树里最小的
       * 名次」排序，新条目指向的文件不在名次表里，会被排到最后一名。
       * 同时要把 replacements 传进去，让它接着改过的那份目录往下写，
       * 不然会把重排结果覆盖回原样（parseTocDoc 有详细说明）。
       */
      const tocEntry = insertTocEntry(
        book,
        {
          id: `${READING_PATH_ID}-toc`,
          href: READING_PATH_HREF,
          tocHref: READING_PATH_HREF,
          title: READING_PATH_TOC_TITLE,
        },
        { replacements },
      );
      for (const [href, text] of tocEntry.updates) replacements.set(href, text);
      issues.push(...tocEntry.issues);
      readingPath = { href: zipPath, title: READING_PATH_TOC_TITLE, inToc: tocEntry.inserted };
    } catch (err) {
      console.warn('[export] 插入阅读路径页失败，已跳过：', err.message);
      issues.push(`插入阅读路径页失败：${err.message}`);
    }
  }

  return { replacements, additions, readingPath, spineOrder, dropped, issues };
}

/**
 * 在改写后的章节里加一段「这是个人化版本」的注释。
 * 用 XML 注释而不是可见文字，避免影响阅读体验与目录结构。
 */
function withPersonalizedNote(xhtml, metadata, extra) {
  /**
   * 排版样式在这里统一补，先补再打标记。
   *
   * 顺序很要紧：老写法是「打标记那一行在前、样式在后」，于是**重复导出**
   * 时会在第一行就 return，样式永远补不进去 —— 已经带过标记的书再也
   * 拿不到新版式。`injectPbeStyle` 自己幂等，放在判断前面没有副作用。
   */
  const xhtmlStyled = injectPbeStyle(String(xhtml || ''));
  const stamp = new Date().toISOString();
  const note = `<!-- Personalized Edition | book: ${escapeComment(metadata.title)} | generated: ${stamp} | editor: AI Personal Book Editor -->\n`;
  if (xhtmlStyled.includes('Personalized Edition |')) return xhtmlStyled;
  // 插到 XML 声明之后（如果没有声明就放最前面）
  const declEnd = xhtmlStyled.indexOf('?>');
  if (declEnd >= 0 && xhtmlStyled.trimStart().startsWith('<?xml')) {
    const insertAt = xhtmlStyled.indexOf('?>') + 2;
    return `${xhtmlStyled.slice(0, insertAt)}\n${note}${xhtmlStyled.slice(insertAt).replace(/^\s*\n/, '\n')}`;
  }
  return note + xhtmlStyled;
}

function escapeComment(text) {
  return String(text).replace(/--/g, '-').replace(/>/g, '');
}

/**
 * 一章正文的纯文字（只用来判断「这一章是简体还是繁体」）。
 * 样式和脚本不算正文 —— 维基文库把许可横幅的 CSS 写在 `<body>` 里。
 */
function plainBodyText(xhtml) {
  const m = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(String(xhtml || ''));
  const body = m ? m[1] : String(xhtml || '');
  return body
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * 给这一章补一个**正文里的**标题。
 *
 * 很多来源（维基文库最典型）把章节标题只放在页面顶部的导航表里，
 * 正文里根本没有 `<h1>`。那张导航表在清洗时被拿掉了 —— 于是成品里
 * 每一章都是「开门见山一段话」，读者翻页不知道自己在读哪一篇；
 * 目录里却有名字，两边对不上。
 *
 * 做法：正文开头（前三个块）已经有一个和标题对得上的 h1~h3 就什么都不做；
 * 否则在 `<body>` 后面补一个 `<h1 class="pbe-chapter-title">`。
 * 标题文字来自整理方案（`displayTitle`，是模型按内容起的那个人话名字），
 * 没有方案时退回原书目录里的标题。
 *
 * @param {string} xhtml
 * @param {string} title
 * @returns {string}
 */
export function ensureChapterTitle(xhtml, title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  if (!clean) return xhtml;
  /**
   * 先把 `<head><title>` 同步过来。
   *
   * 它和 `<h1>` 原本是两套说法：`<title>` 抄自原书（繁体），`<h1>` 是
   * 方案起的名字（简体）。阅读器顶栏、书签、状态栏读的是 `<title>` ——
   * 于是读者在目录里看到简体标题，翻进去顶栏却是繁体的原名。
   */
  const doc = syncHeadTitle(xhtml, clean);
  const bodyMatch = /<body\b[^>]*>/i.exec(doc);
  if (!bodyMatch) return doc;
  const bodyStart = bodyMatch.index + bodyMatch[0].length;

  /**
   * 已经有了就不再插：拿正文开头 400 字和标题比一次（去掉空白和标点）。
   * 只比开头，是因为正文中段的小标题和我们补的章节标题不是一回事。
   */
  const head = doc.slice(bodyStart, bodyStart + 400);
  const headText = head.replace(/<[^>]+>/g, '').replace(/[\s\p{P}]/gu, '');
  const wantText = clean.replace(/[\s\p{P}]/gu, '');
  if (wantText && headText.slice(0, 120).includes(wantText)) return doc;
  /**
   * 正文开头已经有一个短标题（`<h2>小引</h2>`）就不要再加一个。
   *
   * 整理方案给这一章起的名字往往比原标题长（「小引：鲁迅的自序」），
   * 文字对不上，但标题**已经有了** —— 再加一个就变成
   * 「小引：鲁迅的自序」下面紧接一个「小引」，看着像排版事故。
   */
  if (/<h[1-3]\b[^>]*>[^<]{1,60}<\/h[1-3]>/i.test(head)) return doc;

  const escaped = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const h1 = `<h1 class="pbe-chapter-title">${escaped}</h1>`;
  return `${doc.slice(0, bodyStart)}${h1}${doc.slice(bodyStart)}`;
}

/** 把 `<head><title>` 和章节标题对齐 —— 但只在**明显不对**的时候动。
 *
 * 章节里本来就有 `<title>`（阅读器顶栏、书签、状态栏读它），它有两种毛病：
 *
 *   · 抄自原书的繁体标题，而章节标题是方案起的简体名字 ——
 *     目录里写简体、顶栏里是繁体，看着像没排好版；
 *   · MediaWiki 的系统消息键（`MediaWiki:Wsexport_about`）——
 *     维基文库的「导出说明」页标题就是这样，直接印在阅读器顶栏上。
 *
 * 其余情况一个字都不碰（包括改写阶段自己写进去的标题）。
 */
const SYSTEM_TITLE_RE = /^(?:MediaWiki|Template|Category|File|Image|Special|Help|Portal|Module)\s*:|wsexport/i;

/**
 * 「原样保留」章节里印在正文开头的**外文标题**，换成方案里的中文名。
 *
 * 维基文库每本书末尾都附一页导出说明，标题叫
 * 「About this digital edition」，正文也是英文。目录里写的是
 * 「关于：维基文库来源、CC BY-SA 3.0 授权与贡献者名单」，翻进去却顶着
 * 一个英文大标题 —— 读者会以为这一页是排版漏进来的。
 *
 * 只在两件事**同时**成立时才改：原标题一个汉字都没有、方案标题有汉字。
 * 英文书、日文书、中英混排的版权页都不会被误改。
 */
export function alignForeignHeading(xhtml, title) {
  const want = String(title || '').trim();
  if (!want || !/\p{Script=Han}/u.test(want)) return xhtml;
  const bodyMatch = /<body\b[^>]*>/i.exec(xhtml);
  if (!bodyMatch) return xhtml;
  const start = bodyMatch.index + bodyMatch[0].length;
  const head = xhtml.slice(start, start + 1200);
  const m = /<h([1-4])\b([^>]*)>([\s\S]*?)<\/h\1>/i.exec(head);
  if (!m) return xhtml;
  const text = m[3].replace(/<[^>]+>/g, ' ').trim();
  if (!text || /\p{Script=Han}/u.test(text)) return xhtml;
  const escaped = want.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const replaced = `<h${m[1]}${m[2]}>${escaped}</h${m[1]}>`;
  return xhtml.slice(0, start + m.index) + replaced + xhtml.slice(start + m.index + m[0].length);
}

function syncHeadTitle(xhtml, title) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(xhtml);
  if (!m) return xhtml;
  const current = m[1].replace(/<[^>]+>/g, '').trim();
  const hasTrad = toSimplified(current) !== current;
  /**
   * 原书名本身就是简体时（`<title>藤野先生</title>`），上面那条判不出来，
   * 于是目录里是「藤野先生：讲义批改、匿名信与幻灯片事件、弃医从文」，
   * 阅读器顶栏却只写「藤野先生」——同一章两套名字。
   * 只有一种情况改成方案名：方案名是在原标题后面接着写下去的（原标题是它的前缀），
   * 这正好是「原标题 + 副题」的形状，不会误改已经写好的别家标题。
   */
  const isShortOriginal = current.length >= 2 && title.length > current.length && title.startsWith(current);
  if (!hasTrad && !SYSTEM_TITLE_RE.test(current) && !isShortOriginal) return xhtml;
  const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return xhtml.replace(m[0], `<title>${escaped}</title>`);
}

/**
 * 只替换**正文**里标签之间文字中的繁体字，标签和属性一根指头都不碰。
 *
 * 直接对整篇 XHTML 跑转换是危险的：id、class、href 里的字也可能被改，
 * 锚点一改，目录和脚注链接就全断了。`<head>` 也不动 —— 那里的
 * `<title>` 由 `syncHeadTitle` 换成方案起的完整章名，先转掉就比不出来了。
 */
function simplifyTextNodes(xhtml) {
  const headEnd = /<\/head\s*>/i.exec(xhtml);
  const cut = headEnd ? headEnd.index + headEnd[0].length : 0;
  const head = xhtml.slice(0, cut);
  const body = xhtml.slice(cut);
  return head + body.replace(/>([^<>]+)</g, (m, text) => (text.trim() ? `>${toSimplified(text)}<` : m));
}

/** 读取原书内容用于 UI 预览（Original 视图）。 */
export async function readChapterPreview(bookId, chapterIndex) {
  const metadata = await ws.readBookMetadata(bookId);
  const chapter = metadata.chapters.find((c) => c.index === Number(chapterIndex));
  if (!chapter) throw new NotFoundError(`章节不存在: ${chapterIndex}`);
  const paths = ws.bookPaths(bookId);
  const buffer = await fsp.readFile(paths.original);
  const book = readEpub(buffer);
  const xhtml = book.zip.readXmlText(chapter.href).text;
  return { chapter, xhtml };
}

/**
 * 这本书「导入时冻结的那份画像」。
 *
 * 需求第四/十四节要求处理一本书时把当时的画像冻结成快照，
 * 之后改画像不影响已处理的内容。界面必须能看到这份快照，
 * 否则用户会以为自己填的画像没生效（这个误解真实发生过）。
 *
 * @param {string} bookId
 * @param {object} [liveProfile] 当前画像，用于比对是否已经改过
 */
export async function readProfileSnapshot(bookId, liveProfile = null) {
  const snapshot = await ws.readProfileSnapshot(bookId);
  const snapshotProfile = snapshot?.profile || null;
  const current = liveProfile
    ? {
        isCurrent:
          snapshotProfile !== null &&
          JSON.stringify(normalizeProfile(snapshotProfile)) === JSON.stringify(normalizeProfile(liveProfile)),
      }
    : null;
  return {
    capturedAt: snapshot?.capturedAt || null,
    profile: snapshotProfile,
    // 与当前画像是否一致；false 表示「这本书用的是旧画像，重新处理才会用新的」
    isCurrent: current ? current.isCurrent : null,
  };
}

/** 把一章的文本抽出来（用于 diff / 质量展示）。 */
export async function readChapterTexts(bookId, chapterIndex) {
  const paths = ws.chapterPaths(bookId, chapterIndex);
  const original = (await exists(paths.originalHtml)) ? await fsp.readFile(paths.originalHtml, 'utf8') : null;
  const rewritten = (await exists(paths.rewrittenHtml))
    ? await fsp.readFile(paths.rewrittenHtml, 'utf8')
    : null;
  return { original, rewritten };
}

export { ws as workspace, personalizedFileName };
