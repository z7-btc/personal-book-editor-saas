/**
 * Chunk 切分。
 *
 * 不能机械按字符数切断。优先级：
 *   1. HTML block（语义块，blockToPlainText 的产物）
 *   2. section
 *   3. paragraph
 *   4. heading
 *
 * 每个 chunk 携带少量前后文（上一块摘要 / 下一个标题），避免上下文断裂。
 */

import { blockToPlainText } from '../epub/sanitize.js';

/**
 * @typedef {Object} Chunk
 * @property {number} index
 * @property {string} id
 * @property {number[]} blockIndexes   包含的 block 序号（对应 chapter.chunks.json）
 * @property {string} text             发给模型的原文（含占位符）
 * @property {string} headingPath      所属小标题路径
 * @property {string} nextHeading      下一个标题（上下文提示）
 * @property {number} charCount
 */

/**
 * @param {import('../epub/sanitize.js').Block[]} blocks
 * @param {{targetChars?: number, maxChars?: number, minChars?: number, chapterTitle?: string,
 *          noteRefs?: Map<string, object>}} [opts]
 * @returns {Chunk[]}
 */
export function chunkChapter(blocks, opts = {}) {
  const targetChars = opts.targetChars ?? 2800;
  const maxChars = opts.maxChars ?? 6000;
  const minChars = opts.minChars ?? 200;
  /** 脚注索引：把注释正文就地展开给模型看（见 sanitize.blockToPlainText） */
  const noteRefs = opts.noteRefs || null;

  /** @type {Chunk[]} */
  const chunks = [];
  /** @type {Array<{block: object, text: string, marks: object[], headingPath: string}>} */
  const entries = [];

  let headingStack = [];
  /** @type {Array<{level: number, text: string}>} 本章出现过的小标题（按顺序，用于给模型章节骨架） */
  const headings = [];
  for (const block of blocks) {
    const { text, marks } = blockToPlainText(block, { noteRefs });
    if (block.isHeading) {
      const level = Number(block.tag.slice(1)) || 1;
      headingStack = headingStack.filter((h) => h.level < level);
      const clean = text
        .replace(/⟦\d+⟧|⟦\/\d+⟧/g, '')
        .replace(/⟦注\d+⟧[\s\S]*?⟦\/注\d+⟧/g, '')
        .slice(0, 80);
      headingStack.push({ level, text: clean });
      headings.push({ level, text: clean });
    }
    entries.push({
      block,
      text,
      marks,
      headingPath: headingStack.map((h) => h.text).join(' / '),
    });
  }

  let current = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const size = entry.text.length;
    if (!current) {
      current = { entries: [], chars: 0, headingPath: entry.headingPath };
    }
    const wouldOverflow = current.chars > 0 && current.chars + size > maxChars;
    const reachedTarget = current.chars >= targetChars;
    if (wouldOverflow || (reachedTarget && size > minChars)) {
      chunks.push(finalize(current, chunks.length, entries, opts));
      current = { entries: [], chars: 0, headingPath: entry.headingPath };
    }
    current.entries.push(entry);
    current.chars += size;
  }
  if (current && current.entries.length) chunks.push(finalize(current, chunks.length, entries, opts));

  /**
   * 把「本章有哪些小节」告诉每一块。
   *
   * 起因是用户的疑问：「他改到中间的时候，会考虑前面写的吗？这是一整章，
   * 肯定有互相衔接的内容」。查下来每一块只看得见自己那段正文 +
   * 上一块的 500 字左右 —— 第 4 块完全不知道第 1、2 块写了什么。
   *
   * 把章节骨架（所有小标题，按顺序）发给每一块，代价只有一两百字，
   * 但模型至少知道：这一章总共有哪几节、自己在哪一节、后面还有什么。
   * 这样它就不会在第二节里把第五节才该展开的东西提前讲掉，
   * 也不会把前面已经交代过的背景再交代一遍。
   */
  const headingTexts = headings.map((h) => h.text);
  for (const chunk of chunks) chunk.chapterHeadings = headingTexts;

  return chunks;
}

function finalize(group, index, allEntries, opts) {
  const first = group.entries[0];
  const last = group.entries[group.entries.length - 1];
  const lastPos = allEntries.indexOf(last);
  const nextHeading = allEntries
    .slice(lastPos + 1)
    .find((e) => e.block.isHeading);

  const text = group.entries.map((e) => e.text).join('\n\n');
  return {
    index,
    id: `c${String(index + 1).padStart(3, '0')}`,
    blockIndexes: group.entries.map((e) => e.block.index),
    /**
     * 每个块的 {block, text, marks}。
     * 这里同时保留 entries 与 blockIndexes：
     *  - blockIndexes 用于跟章节的块列表对齐、给 UI 看；
     *  - entries 是改写阶段真正需要的数据（每块的原文与占位符）。
     *    （之前只留 blockIndexes，导致 materializeChunk 拿不到东西。）
     */
    entries: group.entries,
    headingPath: group.headingPath || opts.chapterTitle || '',
    chapterTitle: opts.chapterTitle || '',
    nextHeading: nextHeading ? nextHeading.text.replace(/⟦\d+⟧|⟦\/\d+⟧/g, '').slice(0, 80) : '',
    text,
    charCount: text.length,
    firstBlockIndex: first.block.index,
    lastBlockIndex: last.block.index,
  };
}

/**
 * 构建发给模型的「当前 chunk 上下文」。
 *
 * 这里有一段血泪：原来只写了「本段序号：3」，模型于是把这一块
 * **当成了一整节**，按 Reader Profile 的「先给结论」给每段都贴上
 * 「这一节的核心结论是：」。用户拿到成品，一章 16k 字里出现了 20 次，
 * 连着 8 段每段一次，读起来「一段一段的」。
 *
 * 修法是把实情告诉模型：你在写第几块、一块不是一节、
 * 前面已经写了什么（给原话而不是摘要）、后面还要接着写。
 * 再配合 style-guard.js 的确定性清理兜底。
 *
 * @param {Object} args
 * @param {Chunk} args.chunk
 * @param {string} [args.bookTitle]
 * @param {string} [args.chapterTitle]
 * @param {number} [args.chunkTotal]       本章一共切了几块
 * @param {string} [args.previousSummary]  上一块的原文摘录
 * @param {string} [args.previousTail]     上一块**改写后**的结尾原话
 * @param {object} [args.bookMemory]       长期记忆（人物 / 术语 / 作者立场）
 */
export function buildChunkContext({
  chunk,
  bookTitle,
  chapterTitle,
  chunkTotal,
  previousSummary,
  previousTail,
  bookMemory,
}) {
  const lines = [];
  if (bookTitle) lines.push(`书名：${bookTitle}`);
  if (chapterTitle) lines.push(`当前章节：${chapterTitle}`);
  if (chunk.headingPath) lines.push(`当前小节：${chunk.headingPath}`);
  if (chunk.nextHeading) lines.push(`下一小节标题：${chunk.nextHeading}`);

  /**
   * 本章结构图：让每一块都知道整章有哪几节、自己在哪一节。
   * 不加这个的话，第 4 块完全不知道第 1、2 块写了什么（实测只看得见 10.6%）。
   */
  if (chunk.chapterHeadings?.length > 1) {
    const current = String(chunk.headingPath || '').split(' / ').pop();
    lines.push('');
    lines.push('## 本章结构（★ 是你正在写的这一节）');
    chunk.chapterHeadings.forEach((h, i) => {
      lines.push(`${i + 1}. ${h === current ? '★ ' : ''}${h}`);
    });
  }

  const total = Number(chunkTotal) || 1;
  const position = chunk.index + 1;
  if (total > 1) {
    lines.push('');
    lines.push(`## 你正在写的位置（很重要）`);
    lines.push(`本章太长，被切成了 ${total} 块分多次处理。你现在写的是**第 ${position} 块**。`);
    lines.push(`- 这一块**不是完整的一节，也不是完整的章节**，只是中间的一段连续正文。`);
    if (position === 1) {
      lines.push(`- 你是全章的第一块：可以在开头用一句话点题，但**只允许一次**，之后就直接进入正文。`);
    } else {
      lines.push(
        `- 前 ${position - 1} 块已经写好了，后面还有 ${total - position} 块要接着写。`,
      );
      lines.push(
        `- **不要重新起头**：不要写导语、不要写「这一节」「本节」「综上所述」「核心结论是」这类开场，` +
          `直接接着上文往下讲，就像同一个人在同一次写作里继续往下写。`,
      );
      lines.push(`- **不要重复前文已经讲过的内容**。前文说过的结论，这里不再复述。`);
    }
  }

  if (previousTail) {
    lines.push('');
    lines.push(`## 你上一块写出来的最后几句（原话，用来接住语气和话头）`);
    lines.push(previousTail);
    lines.push(`↑ 接着这里往下写，不要重复它。`);
  } else if (previousSummary) {
    lines.push(`前文摘要：${previousSummary}`);
  }

  if (bookMemory) {
    const parts = [];
    if (bookMemory.important_concepts?.length) {
      parts.push(`已出现的重要概念：${bookMemory.important_concepts.slice(-20).join('、')}`);
    }
    if (bookMemory.terminology?.length) {
      parts.push(
        `术语对照：${bookMemory.terminology
          .slice(-15)
          .map((t) => (typeof t === 'string' ? t : `${t.term}=${t.translation || ''}`))
          .join('；')}`,
      );
    }
    /**
     * 人物是 { name, note } 对象，不是字符串。
     *
     * 原来直接 .join('、')，于是每一次调用都把
     * 「已出现的人物：[object Object]、[object Object]、…（20 个）」
     * 发给模型 —— 一整本书、每一次调用都这样。既白烧 token，
     * 又等于没给模型任何信息。这类「对象被当成字符串」的 bug
     * 不会报错，只会安静地烂在提示词里。
     */
    if (bookMemory.people?.length) {
      const names = bookMemory.people
        .slice(-20)
        .map((p) => (typeof p === 'string' ? p : p?.name || ''))
        .filter(Boolean);
      if (names.length) parts.push(`已出现的人物：${names.join('、')}`);
    }
    if (bookMemory.author_positions?.length) {
      parts.push(`作者已表达过的立场：${bookMemory.author_positions.slice(-8).join('；')}`);
    }
    if (parts.length) lines.push(parts.join('\n'));
  }
  lines.push(`本段序号：${position}${total > 1 ? ` / ${total}` : ''}`);
  return lines.join('\n');
}
