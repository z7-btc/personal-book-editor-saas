/**
 * 改写编排器。
 *
 * 一次 chunk 的完整链路：
 *
 *   提取块 -> 加占位符 -> 套 Prompt -> 调 LLM -> 解析【段 N】-> 还原行内元素
 *   -> 写回 DOM -> 结构自检 -> 质量检查 -> （可选）Review -> 立即落盘
 *
 * 关键设计：
 *  - 「段级回退」：整块失败时逐段重试，避免一次坏输出毁掉整章；
 *  - 「原文兜底」：极端情况下某段无法还原，就保留该段原文，
 *    永远不会出现「原文被改没了」；
 *  - 每完成一个 chunk 立刻写 status.json / rewritten.xhtml。
 */

import path from 'node:path';
import { parseXml } from '../epub/xml-dom.js';
import {
  extractBlocks,
  blockToPlainText,
  rebuildBlockChildren,
  applyRebuild,
  validateDocument,
  DEFAULT_BLOCK_TAGS,
} from '../epub/sanitize.js';
import { countWords, isCjkText } from '../epub/epub-reader.js';
import { chunkChapter, buildChunkContext } from './chunker.js';
import { stripTemplateLeadIns, MIN_REMAINDER_CHARS, MIN_REMAINDER_CHARS_HEADING } from './style-guard.js';
import { collectNoteAttributions, stripNoteAttributions } from '../epub/footnotes.js';
import { checkQuality } from './quality.js';
import { explainChunk, applyExplainResults, MAX_EXPLAIN_RATIO } from './explain.js';
import { chatCompletion, extractJson, checkPromptBudget, estimateTokens } from '../llm/client.js';
import { loadPromptTemplate, renderTemplate, splitPromptTemplate } from '../llm/prompts.js';
import { renderProfileForPrompt } from '../config/profile.js';
import { effectiveApiKey } from '../config/providers.js';
import { AbortedError, LlmError } from '../util/errors.js';
import { ensureDir, writeJson } from '../util/fsx.js';

export const BLOCK_MARKER_RE = /【\s*段\s*(\d+)\s*】/g;

/**
 * 原文块的结束标记。
 * 模板里 {{SOURCE_TEXT}} 之后还有「输出要求」等文字，
 * 没有明确边界的话，模型（尤其是弱模型）会把后面的模板文字也当成原文的一部分。
 * 这里用一个不可能出现在正文里的符号做硬边界，并在解析时按它截断。
 */
export const SOURCE_END_MARK = '⟪原文结束⟫';

/** 从模型输出里切掉「原文结束」标记及其之后的内容（模型偶尔会把它抄回来）。 */
export function stripSourceEndMark(text) {
  const raw = String(text ?? '');
  // 用 lastIndexOf：模板正文里也会提到这个标记（用于说明），
  // 真正的边界是最后一个。用 indexOf 会误切到说明文字处，把改写结果全丢掉。
  const index = raw.lastIndexOf(SOURCE_END_MARK);
  if (index < 0) return raw;
  return raw.slice(0, index);
}

/* --------------------------------------------------------- 章节准备 -- */

/**
 * 解析一章 XHTML，提取语义块并切分 chunk。
 * @param {string} xhtml
 * @param {{maxCharsPerChunk?: number, targetCharsPerChunk?: number, chapterTitle?: string}} [opts]
 */
export function prepareChapter(xhtml, opts = {}) {
  const doc = parseXml(xhtml);
  const { blocks, skipped } = extractBlocks(doc, { blockTags: DEFAULT_BLOCK_TAGS });
  const chunks = chunkChapter(blocks, {
    targetChars: opts.targetCharsPerChunk,
    maxChars: opts.maxCharsPerChunk,
    chapterTitle: opts.chapterTitle,
    // 脚注就地化：把注释正文展开到正文里，让模型在原位看到它
    noteRefs: opts.noteRefs,
  });
  return { doc, blocks, skipped, chunks };
}

/**
 * 把 chunker 产出的 entries 固化成改写阶段需要的三个平行数组。
 * @param {import('./chunker.js').Chunk} chunk
 */
export function materializeChunk(chunk) {
  const seen = new Set();
  const blocks = [];
  const blockTexts = [];
  const marksByBlock = [];
  for (const entry of chunk.entries || []) {
    if (seen.has(entry.block.index)) continue;
    seen.add(entry.block.index);
    blocks.push(entry.block);
    blockTexts.push(entry.text);
    marksByBlock.push(entry.marks);
  }
  chunk.blocks = blocks;
  chunk.blockTexts = blockTexts;
  chunk.marksByBlock = marksByBlock;
  delete chunk.entries;
  return chunk;
}

/**
 * 把 chunk 序列化成发给模型的「【段 N】」文本。
 * @param {import('./chunker.js').Chunk} chunk
 */
export function serializeChunkSource(chunk) {
  return chunk.blockTexts.map((text, i) => `【段 ${i + 1}】${text}`).join('\n\n');
}

/** 解析模型返回的「【段 N】…」结构。 */
export function parseSegments(modelText, expectedCount) {
  const text = stripSourceEndMark(modelText);
  const parts = new Array(expectedCount).fill(null);
  const matches = [];
  BLOCK_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_MARKER_RE.exec(text)) !== null) {
    matches.push({ n: Number(m[1]), start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const content = text.slice(cur.contentStart, end).trim();
    if (cur.n >= 1 && cur.n <= expectedCount) {
      if (parts[cur.n - 1] === null) parts[cur.n - 1] = content;
      else parts[cur.n - 1] += `\n${content}`; // 重复标记：合并而不是丢弃
    }
  }
  return parts;
}

/* ------------------------------------------------------------ 改写 -- */

/**
 * @typedef {Object} ChunkRewriteResult
 * @property {number} chunkIndex
 * @property {Record<number, string>} segmentTexts  段号(0-based) -> 模型输出文本
 * @property {object} usage
 * @property {number} attempts
 * @property {string|null} error
 */

/**
 * 改写一个 chunk。
 * @param {Object} args
 * @param {import('./chunker.js').Chunk} args.chunk
 * @param {string} args.chunkSource
 * @param {object} args.systemPrompt
 * @param {object} args.provider
 * @param {string} [args.bookContext]
 * @param {string} [args.chapterContext]
 * @param {string} [args.previousContext]
 * @param {string} [args.readerProfileBlock]
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.maxRetries]
 * @param {number} [args.retryBaseDelayMs]
 * @param {(info: object) => void} [args.onRetry]
 */
export async function rewriteChunk(args) {
  const { chunk, systemPrompt, provider } = args;
  const blockCount = chunk.blockTexts.length;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let attempts = 0;

  const userPrompt = renderTemplate(args.userTemplate, {
    READER_PROFILE: args.readerProfileBlock || '（无）',
    BOOK_CONTEXT: args.bookContext || '（无）',
    CHAPTER_CONTEXT: args.chapterContext || '（无）',
    PREVIOUS_CONTEXT: args.previousContext || '（无）',
    SOURCE_TEXT: args.chunkSource,
  });

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // 发出去之前先做一次体积预算检查。
  // Reader Profile 很长（几千字）时，加上原文有可能超出模型上下文，
  // 与其让 API 报一个难懂的 400，不如在这里给出可操作的提示。
  const budget = checkPromptBudget(messages, {
    maxInputChars: args.maxInputChars ?? provider.maxInputChars ?? undefined,
  });
  if (!budget.ok) {
    throw new LlmError(budget.message, { code: 'PROMPT_TOO_LARGE', status: 400 });
  }

  const callOptions = {
    baseUrl: provider.baseUrl,
    apiKey: effectiveApiKey(provider),
    model: provider.model,
    temperature: args.temperature ?? provider.temperature,
    topP: provider.topP,
    reasoningEffort: provider.reasoningEffort,
    maxTokens: provider.maxTokens,
    timeoutMs: provider.timeoutMs,
    maxRetries: args.maxRetries ?? 3,
    retryBaseDelayMs: args.retryBaseDelayMs ?? 2000,
    signal: args.signal,
    onRetry: args.onRetry,
  };

  // 第一次：整块处理
  attempts += 1;
  try {
    const result = await chatCompletion(messages, callOptions);
    addUsage(usage, result.usage);
    const segments = parseSegments(result.text, blockCount);
    const missing = segments.filter((s) => s === null).length;
    if (missing === 0) {
      return {
        chunkIndex: chunk.index,
        segmentTexts: toRecord(segments),
        usage,
        attempts,
        // 输出被 max_tokens 截断但侥幸凑齐了段数：内容可能不完整，交给质量检查判断
        error: result.truncated ? '模型输出被 max_tokens 截断（finish_reason=length），结果可能不完整' : null,
      };
    }
    // 缺段：进入逐段回退
    const reason = result.truncated
      ? `模型输出被 max_tokens 截断，只返回了 ${blockCount - missing}/${blockCount} 段，改为逐段重写`
      : `模型只返回了 ${blockCount - missing}/${blockCount} 段，改为逐段重写`;
    args.onRetry?.({ reason });
    const repaired = await rewriteIndividually({
      ...args,
      callOptions,
      segments,
      usage,
    });
    attempts += repaired.attempts;
    return {
      chunkIndex: chunk.index,
      segmentTexts: toRecord(repaired.segments),
      usage,
      attempts,
      error: repaired.error || (result.truncated ? `部分段落因输出截断而逐段重写：${reason}` : null),
    };
  } catch (err) {
    if (err instanceof AbortedError) throw err;
    if (blockCount <= 1) {
      return { chunkIndex: chunk.index, segmentTexts: {}, usage, attempts, error: err.message };
    }
    args.onRetry?.({ reason: `整块调用失败（${err.message}），改为逐段重写` });
    const repaired = await rewriteIndividually({ ...args, callOptions, segments: new Array(blockCount).fill(null), usage });
    attempts += repaired.attempts;
    return { chunkIndex: chunk.index, segmentTexts: toRecord(repaired.segments), usage, attempts, error: repaired.error };
  }
}

/**
 * 补写缺掉的段落。
 *
 * ## 先整批补，补不齐的才逐段补
 *
 * 第一版是**直接逐段**处理的：一个 91 段的块如果整块调用缺了 30 段，
 * 就发 30 次请求，每次都要带上完整的 system prompt + 读者画像（约 7000 token）。
 * 实测见过一次 16k 字的章节烧掉 **43 万输入 token**、耗时 225 秒 ——
 * 从外面完全看不出来，界面上只显示「已完成」。
 *
 * 「缺段」通常不是模型不会写，而是它没按 `【段 N】` 格式输出。
 * 这种情况再用一次**小而聚焦**的请求（只给缺的那几段）就能补齐，
 * 概率上比第一次整块调用高得多，成本却只有逐段的 1/N。
 * 整批也补不齐时，才退回逐段 —— 那条路依旧保留，只是不再当第一选择。
 *
 * 段号要**重新从 1 开始编**：模型看到 `【段 5】【段 9】【段 12】` 会自作主张
 * 「纠正」成 1、2、3，解析回来就错位了。所以请求里编 1..k，拿回来按位置映射。
 */
async function rewriteIndividually(args) {
  const { chunk, callOptions, usage } = args;
  const segments = [...args.segments];
  let attempts = 0;
  const errors = [];

  const missingIndexes = [];
  for (let i = 0; i < chunk.blockTexts.length; i += 1) if (segments[i] === null) missingIndexes.push(i);
  if (!missingIndexes.length) return { segments, attempts, error: null };

  if (missingIndexes.length > 1) {
    attempts += 1;
    try {
      const source = missingIndexes
        .map((i, k) => `【段 ${k + 1}】${chunk.blockTexts[i]}`)
        .join('\n\n');
      const result = await chatCompletion(
        [
          { role: 'system', content: args.systemPrompt },
          {
            role: 'user',
            content: renderTemplate(args.userTemplate, {
              READER_PROFILE: args.readerProfileBlock || '（无）',
              BOOK_CONTEXT: args.bookContext || '（无）',
              CHAPTER_CONTEXT: args.chapterContext || '（无）',
              PREVIOUS_CONTEXT: args.previousContext || '（无）',
              SOURCE_TEXT: source,
            }),
          },
        ],
        callOptions,
      );
      addUsage(usage, result.usage);
      const parsed = parseSegments(result.text, missingIndexes.length);
      for (let k = 0; k < missingIndexes.length; k += 1) {
        if (parsed[k]) segments[missingIndexes[k]] = parsed[k];
      }
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      errors.push(`整批补写失败: ${err.message}`);
    }
  }

  for (let i = 0; i < chunk.blockTexts.length; i += 1) {
    if (segments[i] !== null) continue;
    attempts += 1;
    try {
      const single = `【段 1】${chunk.blockTexts[i]}`;
      const result = await chatCompletion(
        [
          { role: 'system', content: args.systemPrompt },
          {
            role: 'user',
            content: renderTemplate(args.userTemplate, {
              READER_PROFILE: args.readerProfileBlock || '（无）',
              BOOK_CONTEXT: args.bookContext || '（无）',
              CHAPTER_CONTEXT: args.chapterContext || '（无）',
              PREVIOUS_CONTEXT: args.previousContext || '（无）',
              SOURCE_TEXT: single,
            }),
          },
        ],
        callOptions,
      );
      addUsage(usage, result.usage);
      const parsed = parseSegments(result.text, 1);
      if (parsed[0]) segments[i] = parsed[0];
      else errors.push(`段 ${i + 1}: 模型未按格式返回`);
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      errors.push(`段 ${i + 1}: ${err.message}`);
    }
  }
  return { segments, attempts, error: errors.length ? errors.join('; ') : null };
}

function toRecord(list) {
  const out = {};
  list.forEach((value, index) => {
    if (value !== null && value !== undefined) out[index] = value;
  });
  return out;
}

function addUsage(target, usage) {
  if (!usage) return;
  target.promptTokens += usage.promptTokens || 0;
  target.completionTokens += usage.completionTokens || 0;
  target.totalTokens += usage.totalTokens || 0;
}

/* ------------------------------------------------- 把结果写回 XHTML -- */

/**
 * 把模型输出还原进 DOM。
 *
 * 每个块单独判定：
 *  - 正常           => 写回改写结果
 *  - 占位符严重丢失 => 判定该块被破坏，**保留原文**（宁可少改一块，也不能把内容改没）
 *
 * @param {Object} args
 * @param {import('../epub/xml-dom.js').XmlDocument} args.doc
 * @param {import('./chunker.js').Chunk} args.chunk
 * @param {Record<number, string>} args.segmentTexts
 * @param {number} [args.chunkOffset] 段号偏移（多 chunk 合并时用）
 * @param {Set<string>} [args.signatures] 这本书注释用到的署名闭集
 * @returns {{stats: object, perBlock: object[]}}
 */
export function applyChunkResults({ doc, chunk, segmentTexts, chunkOffset = 0, signatures = null }) {
  const stats = {
    applied: 0,
    fallback: 0,
    corrupted: 0,
    missing: 0,
    unbalanced: 0,
    unknown: 0,
    /** 被文风守卫剥掉的模板腔引导语数量 */
    leadInStripped: 0,
    /** 被剥掉的脚注署名（「——某某注」）数量 */
    noteAttrStripped: 0,
    /** 因为「内容已经在正文里」而没有补回块尾的标记（否则会印出两个脚注编号） */
    dedupedOrphans: 0,
    /** 外层丢了、内层还在 —— 套回原位而不是补到块尾的数量 */
    wrappedBack: 0,
  };
  const perBlock = [];

  chunk.blocks.forEach((block, localIndex) => {
    const rawModelText = segmentTexts[chunkOffset + localIndex];
    const originalText = chunk.blockTexts[localIndex];
    const marks = chunk.marksByBlock[localIndex];

    if (rawModelText === undefined || rawModelText === null || rawModelText.trim() === '') {
      stats.fallback += 1;
      perBlock.push({ blockIndex: block.index, status: 'fallback', reason: 'no-output' });
      return;
    }

    /**
     * 文风守卫：删掉模型自作主张贴上的「这一节的核心结论是：」这类标签。
     *
     * 用户的实际反馈是一章里出现了 20 次，连着 8 段每段一次，
     * 读起来「一段一段的」。提示词里写「请不要」是概率性的，
     * 这里做的是确定性检查 —— 而且判据保证不吃掉作者自己的话。
     *
     * 标题用更低的下限：标题本来就短，若也要求「剩 8 个字」，
     * 贴到 <h1> 上的脏标签就永远清不掉，会直接印在成品的小标题上。
     */
    const guarded = stripTemplateLeadIns(rawModelText, originalText, {
      minRemainder: block.isHeading ? MIN_REMAINDER_CHARS_HEADING : MIN_REMAINDER_CHARS,
    });
    stats.leadInStripped += guarded.stripped;

    /**
     * 脚注署名守卫：剥掉模型贴回来的「——罗杰·洛温斯坦注」。
     *
     * 输入端（`blockToPlainText`）已经把原书注释里的署名拿掉了，
     * 这里拦的是模型**自己补**上去的那种 —— 提示词里说了不要写，
     * 但那只是概率性的。用户的要求很直白（User said (m01869)）：
     * 「我让你融进文字之中……你就不用标注它是脚注了。」
     */
    const deAttr = stripNoteAttributions(guarded.text, { signatures });
    const modelText = deAttr.text;
    stats.noteAttrStripped += deAttr.stripped;

    const result = rebuildBlockChildren(modelText, marks, {
      // 把原文长度传进去，否则「纯文字段落被压成一句话」检测不出来
      sourceLength: originalText.length,
    });
    stats.missing += result.missing.length;
    stats.dedupedOrphans += (result.dedupedOrphans || []).length;
    stats.wrappedBack += (result.wrappedBack || []).length;
    stats.unbalanced += result.unbalanced;
    stats.unknown += result.unknown;

    if (result.corrupted) {
      // 严重丢失行内元素：这一块的改写不可信，保留原文
      stats.corrupted += 1;
      stats.fallback += 1;
      perBlock.push({
        blockIndex: block.index,
        status: 'fallback',
        reason: 'placeholder-loss',
        missing: result.missing.length,
        total: result.totalMarks,
      });
      return;
    }

    applyRebuild(block, result);
    stats.applied += 1;
    perBlock.push({
      blockIndex: block.index,
      status: 'rewritten',
      origChars: originalText.length,
      leadInStripped: guarded.stripped,
      missing: result.missing.length,
      unbalanced: result.unbalanced,
      unknown: result.unknown,
    });
  });

  return { stats, perBlock };
}

/**
 * 单章完整改写（含质量检查与可选 Review）。
 *
 * @param {Object} args
 * @param {string} args.xhtml            该章 XHTML 原文
 * @param {object} args.provider
 * @param {object} args.profile
 * @param {object} args.settings
 * @param {string} args.projectRoot
 * @param {object} [args.bookContext]
 * @param {object} [args.bookMemory]
 * @param {string} [args.chapterTitle]
 * @param {AbortSignal} [args.signal]
 * @param {(progress: object) => void|Promise<void>} [args.onProgress]
 * @param {(chapterState: object) => void|Promise<void>} [args.onChunkDone]
 * @param {object} [args.providerForReview]
 * @param {Record<number, Record<number, string>>} [args.resumeChunkResults]
 *        已经完成过的 chunk 结果（chunkIndex -> 段号 -> 模型输出）。
 *        中断恢复时传入，这些 chunk 会被直接应用、不再调用模型。
 * @returns {Promise<object>}
 */
export async function rewriteChapter(args) {
  const {
    xhtml,
    provider,
    settings,
    projectRoot,
    signal,
    onProgress,
    onChunkDone,
  } = args;

  const t0 = Date.now();
  const resumeResults = args.resumeChunkResults || {};
  const promptFiles = settings.prompt || {};
  const rewritePrompt = await loadPromptTemplate(projectRoot, promptFiles.systemFile || 'prompts/rewrite-system.txt');
  const reviewPrompt = await loadPromptTemplate(projectRoot, promptFiles.reviewFile || 'prompts/review-system.txt');

  const chunkPlan = planChunkSizes({
    targetCharsPerChunk: settings.processing?.targetCharsPerChunk,
    maxCharsPerChunk: settings.processing?.maxCharsPerChunk,
    maxOutputTokens: provider.maxTokens,
  });

  const prepared = prepareChapter(xhtml, {
    targetCharsPerChunk: chunkPlan.target,
    maxCharsPerChunk: chunkPlan.max,
    chapterTitle: args.chapterTitle,
    // 脚注就地化：这一章引用到的注释会展开到正文里（见 sanitize.blockToPlainText）
    noteRefs: args.noteRefs,
  });

  /**
   * 这本书注释用到的署名闭集（「格兰特注」「译者注」…）。
   *
   * 输入端已经把这些署名从注释正文里剥掉了，但模型有时会自己补一个
   * 「（卡拉曼的注：……）」上去。有闭集才能只剥真署名、不误伤
   * 「赌注」「关注」「脚注」这些正常用词。
   */
  const signatures = args.noteRefs?.size
    ? collectNoteAttributions([...args.noteRefs.values()].map((r) => r?.text ?? ''))
    : null;

  // 把 chunker 的输出（entries）固化成「块数组 + 每块文本 + 每块占位符」，
  // 这是后续改写与写回唯一需要的数据结构。
  for (const chunk of prepared.chunks) materializeChunk(chunk);

  /**
   * 这一章是不是第一人称，按**整章**判一次，别按块判。
   *
   * 一块常常只有一两千字，对话多或引文多的一块里「我」不到三次，
   * 按块判就会漏掉，补讲里「鲁迅认为……」照样插得进去。
   */
  const chapterFirstPerson =
    (prepared.blocks.map((b) => b.element?.textContent || '').join('').match(/我/g) || []).length >= 3;

  /**
   * 质量对比的「原文」必须是**正文**，不能是整份文档。
   *
   * `collectText(doc)` 取的是 `documentElement.textContent`，它把 `<head>`
   * 也算进去了：里面的 `<style>` 内联 CSS（`.mw-parser-output{...}`、
   * `width:100%`、`#8888aa`）会变成「原文里的数字与专名」。
   * 而改写后的文本是从 `<body>` 里抽的，于是每一章都必然「数字全部丢失」——
   * 实测《朝花夕拾》6 章全部因此被判 fail，改写结果被整章丢弃。
   * 两边都用正文，比较才成立。
   */
  const originalBodyText = extractBodyText(xhtml) || collectText(prepared.doc);
  const warnings = [];
  if (rewritePrompt.warning) warnings.push(rewritePrompt.warning);
  // 块被压小了要让用户知道原因，否则他只会看到「怎么调用次数变多了」
  if (chunkPlan.reason) warnings.push(chunkPlan.reason);

  /**
   * 没有任何可改写的正文：直接返回，不调用模型、不做质量检查。
   *
   * 整页插图 / 空白页会走到这里。上游（jobs.js）已经会跳过它们，
   * 但这里再兜一层：因为函数被直接调用时（测试、脚本、以后的新入口）
   * 也应该得到「跳过」而不是「失败」。
   */
  if (prepared.blocks.length === 0) {
    return {
      xhtml,
      skipped: true,
      skipReason: '这一页没有可改写的正文内容（通常是整页图片）',
      chunks: [],
      blockCount: 0,
      skippedBlocks: prepared.skipped,
      stats: { applied: 0, fallback: 0, corrupted: 0, missing: 0, unbalanced: 0, unknown: 0 },
      quality: { verdict: 'ok', score: 100, issues: [], metrics: { emptySource: true } },
      review: null,
      explain: { enabled: false, paragraphs: 0, dropped: 0, rejected: 0, chunks: 0, error: null },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      attempts: 0,
      warnings,
      durationMs: Date.now() - t0,
      originalBodyText,
      rewrittenBodyText: originalBodyText,
      originalChars: 0,
      rewrittenChars: 0,
    };
  }

  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const stats = {
    applied: 0,
    fallback: 0,
    corrupted: 0,
    missing: 0,
    unbalanced: 0,
    unknown: 0,
    /** 被文风守卫剥掉的模板腔引导语（「这一节的核心结论是：」这类） */
    leadInStripped: 0,
    /** 被剥掉的脚注署名（「——某某注」） */
    noteAttrStripped: 0,
    /** 第二遍补讲的段落数 */
    explained: 0,
    /** 第二遍删掉的段落数 */
    dropped: 0,
  };
  let previousSummary = args.previousContext || '';
  /** 上一块**改写后**的结尾原话：让模型接着自己写的话头往下写，而不是重新起头 */
  let previousTail = '';
  const chunkReports = [];
  /** 每个 chunk 的模型输出，随进度一起落盘，供中断后恢复。 */
  const chunkResults = {};
  const chunkTotal = prepared.chunks.length;
  /**
   * 每个 chunk 里「改写失败、保留原文」的段落（按 block.index）。
   *
   * 这些段落还是原书的字（繁体、旧白话），跟改写结果不是一个面貌；
   * 再往它们中间插简体讲解，会读成一段拼起来的东西。
   * 补讲只处理真正被改写过的段落。
   */
  const fallbackByChunk = new Map();
  const noteFallbacks = (chunkIndex, perBlock) => {
    if (!Array.isArray(perBlock) || !perBlock.length) return;
    const set = new Set(perBlock.filter((b) => b.status === 'fallback').map((b) => b.blockIndex));
    if (set.size) fallbackByChunk.set(chunkIndex, set);
  };
  let attempts = 0;
  let resumedChunks = 0;

  for (const chunk of prepared.chunks) {
    if (signal?.aborted) throw new AbortedError();

    /**
     * 中断恢复：这个 chunk 上次已经完成过，直接复用结果，不再调用模型。
     *
     * 这是「可以暂停和恢复」这条需求的真正实现。之前虽然每个 chunk 都落盘了，
     * 但只存了计数、没存内容，所以恢复时整章从头重跑 ——
     * 用户跑到第 15 章（11 个 chunk）的第 9 个时暂停，前 8 个就白做了。
     * 那 8 个 chunk 是实打实的 API 花费。
     */
    const saved = resumeResults[chunk.index];
    if (saved && Object.keys(saved).length > 0) {
      resumedChunks += 1;
      chunkResults[chunk.index] = saved;
      const appliedResume = applyChunkResults({
        doc: prepared.doc,
        chunk,
        segmentTexts: saved,
        signatures,
      });
      stats.applied += appliedResume.stats.applied;
      stats.fallback += appliedResume.stats.fallback;
      stats.corrupted += appliedResume.stats.corrupted;
      stats.missing += appliedResume.stats.missing;
      stats.unbalanced += appliedResume.stats.unbalanced;
      stats.unknown += appliedResume.stats.unknown;
      stats.leadInStripped += appliedResume.stats.leadInStripped;
      stats.noteAttrStripped += appliedResume.stats.noteAttrStripped;
      noteFallbacks(chunk.index, appliedResume.perBlock);
      chunkReports.push({
        chunk: chunk.index,
        blocks: chunk.blocks.length,
        applied: appliedResume.stats.applied,
        fallback: appliedResume.stats.fallback,
        corrupted: appliedResume.stats.corrupted,
        leadInStripped: appliedResume.stats.leadInStripped,
        noteAttrStripped: appliedResume.stats.noteAttrStripped,
        error: null,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        resumed: true,
      });
      // 滚动上下文与正常路径保持一致，后面 chunk 的上下文才不会断层
      previousSummary = buildRollingSummary(chunk, args.chapterTitle);
      previousTail = tailOfChunk(chunk);
      continue;
    }

    const chunkSource = serializeChunkSource(chunk);
    const chunkContext = buildChunkContext({
      chunk,
      bookTitle: args.bookContext?.title,
      chapterTitle: args.chapterTitle,
      chunkTotal,
      previousSummary,
      previousTail,
      bookMemory: args.bookMemory,
    });

    const chunkResult = await rewriteChunk({
      chunk,
      chunkSource,
      systemPrompt: buildRewriteSystemPrompt(rewritePrompt.template),
      userTemplate: buildRewriteUserTemplate(rewritePrompt.template),
      provider,
      readerProfileBlock: renderProfileForPrompt(args.profile),
      bookContext: renderBookContext(args.bookContext),
      chapterContext: chunkContext,
      previousContext: previousSummary,
      temperature: settings.processing?.temperature ?? provider.temperature,
      maxRetries: settings.processing?.maxRetries,
      retryBaseDelayMs: settings.processing?.retryBaseDelayMs,
      signal,
      onRetry: (info) => onProgress?.({ phase: 'retry', chunk: chunk.index, ...info }),
    });

    addUsage(usage, chunkResult.usage);
    attempts += chunkResult.attempts;
    chunkResults[chunk.index] = chunkResult.segmentTexts;

    const applied = applyChunkResults({
      doc: prepared.doc,
      chunk,
      segmentTexts: chunkResult.segmentTexts,
      signatures,
    });
    stats.applied += applied.stats.applied;
    stats.fallback += applied.stats.fallback;
    stats.corrupted += applied.stats.corrupted;
    stats.missing += applied.stats.missing;
    stats.unbalanced += applied.stats.unbalanced;
    stats.unknown += applied.stats.unknown;
    stats.leadInStripped += applied.stats.leadInStripped;
    stats.dedupedOrphans += applied.stats.dedupedOrphans || 0;
    stats.noteAttrStripped += applied.stats.noteAttrStripped || 0;
    noteFallbacks(chunk.index, applied.perBlock);

    const report = {
      chunk: chunk.index,
      blocks: chunk.blocks.length,
      applied: applied.stats.applied,
      fallback: applied.stats.fallback,
      corrupted: applied.stats.corrupted,
      leadInStripped: applied.stats.leadInStripped,
      noteAttrStripped: applied.stats.noteAttrStripped || 0,
      dedupedOrphans: applied.stats.dedupedOrphans || 0,
      wrappedBack: applied.stats.wrappedBack || 0,
      /**
       * 这一块实际发了几次请求。
       *
       * 必须暴露出来：整块调用「缺段」时会退化成**逐段重写**，
       * 一个 91 段的块最坏能变成 91 次调用（每次都要带上完整的
       * system prompt 和画像）。实测见过一次 16k 字的章节烧掉
       * 43 万输入 token —— 就是这个退化路径，而且从外面完全看不出来。
       */
      attempts: chunkResult.attempts,
      error: chunkResult.error,
      usage: chunkResult.usage,
    };
    chunkReports.push(report);
    if (applied.stats.corrupted > 0) {
      warnings.push(
        `chunk ${chunk.index + 1}: 有 ${applied.stats.corrupted} 段因行内元素（脚注/链接）大量丢失，已保留原文`,
      );
    }
    if (chunkResult.error) warnings.push(`chunk ${chunk.index + 1}: ${chunkResult.error}`);

    // 立即落盘（崩溃可恢复）
    await onChunkDone?.({
      chunkIndex: chunk.index,
      chunkTotal: prepared.chunks.length,
      doc: prepared.doc,
      reports: chunkReports,
      usage,
      // 已完成 chunk 的模型输出：落盘后，中断再恢复就能跳过这些 chunk
      chunkResults,
      resumedChunks,
    });

    // 极简「前文摘要」：用原文前 N 字做锚点，保证不引入新事实
    previousSummary = buildRollingSummary(chunk, args.chapterTitle);
    // 改写后的结尾原话：下一块要接着这个话头写，而不是重新起头
    previousTail = tailOfChunk(chunk);
  }

  /* ---- 第二遍：读者补讲 / 删段 ---- */
  /**
   * 为什么是独立一遍：把「讲清楚」的要求塞进改写调用，实测只会得到
   * 「照抄原文再补白话」或「换几个同义词」，两种都不是读者要的。
   * 输入是改写好的文字，任务只剩「哪里读者会卡住」——模型反而做得好。
   * 见 src/pipeline/explain.js 顶部的对照实验数据。
   */
  const explainSummary = { enabled: false, paragraphs: 0, dropped: 0, rejected: 0, chunks: 0, error: null };
  if (settings.processing?.explainPass !== false) {
    explainSummary.enabled = true;
    const explainPrompt = await loadPromptTemplate(
      projectRoot,
      promptFiles.explainFile || 'prompts/explain-system.txt',
    );
    if (explainPrompt.warning) warnings.push(explainPrompt.warning);
    const explainSystem = splitPromptTemplate(explainPrompt.template);
    const profileBlock = renderProfileForPrompt(args.profile);
    const bookBlock = renderBookContext(args.bookContext);

    for (const chunk of prepared.chunks) {
      if (signal?.aborted) throw new AbortedError();
      const untouched = fallbackByChunk.get(chunk.index);
      const glossable = untouched ? chunk.blocks.filter((b) => !untouched.has(b.index)) : chunk.blocks;
      const entries = glossable.map((block) => ({ block, ...blockToPlainText(block) }));
      onProgress?.({ phase: 'explain', chunk: chunk.index, blocks: entries.length });
      const result = await explainChunk({
        entries,
        provider,
        systemPrompt: explainSystem.system,
        userTemplate: explainSystem.user,
        readerProfileBlock: profileBlock,
        bookContext: bookBlock,
        chapterContext: buildChunkContext({
          chunk,
          bookTitle: args.bookContext?.title,
          chapterTitle: args.chapterTitle,
          chunkTotal,
          previousSummary: '',
          previousTail: '',
          bookMemory: args.bookMemory,
        }),
        maxInputChars: provider.maxInputChars,
        temperature: settings.processing?.temperature ?? provider.temperature,
        maxRetries: settings.processing?.maxRetries,
        retryBaseDelayMs: settings.processing?.retryBaseDelayMs,
        signal,
        onRetry: (info) => onProgress?.({ phase: 'retry', chunk: chunk.index, ...info }),
      });
      addUsage(usage, result.usage);
      attempts += result.attempts;
      explainSummary.chunks += 1;
      if (result.error) {
        explainSummary.error = result.error;
        warnings.push(`第 ${chunk.index + 1} 块补讲失败（不影响改写结果）：${result.error}`);
        continue;
      }
      if (result.empty) {
        /**
         * 模型两次都没给出可解析的补讲条目 —— 这一块没有讲解。
         * 不能当成「成功但零条」悄悄过掉：读者看到的是少了讲解的正文，
         * 报告里必须留一条，事后能查。
         */
        explainSummary.empty = (explainSummary.empty || 0) + 1;
        const head = String(result.rawHead || '').replace(/\s+/g, ' ').slice(0, 60);
        warnings.push(
          `第 ${chunk.index + 1} 块补讲没有产出（模型两次都没按格式给出条目），这一块按原文保留。` +
            (head ? `模型回复开头：${head}` : '模型回复是空的。'),
        );
      }
      const appliedExplain = applyExplainResults({
        entries,
        inserts: result.inserts,
        drops: result.drops,
        maxRatio: MAX_EXPLAIN_RATIO,
        authorNames: args.bookContext?.authors || [],
        firstPerson: chapterFirstPerson,
      });
      explainSummary.paragraphs += appliedExplain.stats.explained;
      explainSummary.dropped += appliedExplain.stats.dropped;
      explainSummary.rejected += appliedExplain.stats.rejected;
      stats.explained += appliedExplain.stats.explained;
      stats.dropped += appliedExplain.stats.dropped;
      for (const note of appliedExplain.notes.slice(0, 3)) {
        warnings.push(`chunk ${chunk.index + 1}: ${note}`);
      }
      const report = chunkReports.find((r) => r.chunk === chunk.index);
      if (report) {
        report.explained = appliedExplain.stats.explained;
        report.dropped = appliedExplain.stats.dropped;
        report.explainRejected = appliedExplain.stats.rejected;
        report.explainError = null;
      }
      if (appliedExplain.stats.explained > 0 || appliedExplain.stats.dropped > 0) {
        await onChunkDone?.({
          chunkIndex: chunk.index,
          chunkTotal: prepared.chunks.length,
          doc: prepared.doc,
          reports: chunkReports,
          usage,
          chunkResults,
          resumedChunks,
          phase: 'explain',
        });
      }
    }
  }

  /* ---- 结构自检 ---- */
  const htmlCheck = validateDocument(prepared.doc, { parseXml });

  /* ---- 质量检查 ---- */
  const serialized = prepared.doc.serialize();
  const rewrittenBodyText = extractBodyText(serialized);
  const quality = checkQuality(
    {
      originalText: originalBodyText,
      rewrittenText: rewrittenBodyText,
      htmlCheck,
      pipelineStats: {
        missing: stats.missing,
        unbalanced: stats.unbalanced,
        unknown: stats.unknown,
        corrupted: stats.corrupted,
        applied: stats.applied,
        blocks: stats.applied + stats.fallback,
        totalBlocks: stats.applied + stats.fallback,
      },
    },
    {
      minRatio: settings.quality?.minLengthRatio,
      maxRatio: settings.quality?.maxLengthRatio,
      minFailedRatio: settings.quality?.failLengthRatio,
      numberKeepRatio: settings.quality?.numberKeepRatio,
      entityKeepRatio: settings.quality?.entityKeepRatio,
    },
  );

  /* ---- 可选 AI Review ---- */
  let review = null;
  if (settings.review?.enabled && args.providerForReview) {
    try {
      review = await reviewChapter({
        originalText: originalBodyText,
        rewrittenText: rewrittenBodyText,
        provider: args.providerForReview,
        promptTemplate: reviewPrompt.template,
        profile: args.profile,
        chapterContext: args.chapterTitle,
        signal,
      });
      if (review?.usage) addUsage(usage, review.usage);
      if (review?.verdict === 'revise') {
        quality.issues.push({
          type: 'review',
          severity: 'warn',
          message: `AI Reviewer 建议修改：${review.summary || ''}`,
          details: review,
        });
      }
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      warnings.push(`Review 失败（不影响结果）：${err.message}`);
    }
  }

  return {
    xhtml: serialized,
    chunks: prepared.chunks.map((c) => ({
      index: c.index,
      id: c.id,
      headingPath: c.headingPath,
      charCount: c.charCount,
      blockIndexes: c.blockIndexes,
    })),
    blockCount: prepared.blocks.length,
    skipped: prepared.skipped,
    stats,
    explain: explainSummary,
    quality,
    review,
    usage,
    attempts,
    resumedChunks,
    chunkResults,
    warnings,
    durationMs: Date.now() - t0,
    originalBodyText,
    rewrittenBodyText,
    originalChars: originalBodyText.replace(/\s+/g, '').length,
    rewrittenChars: rewrittenBodyText.replace(/\s+/g, '').length,
  };
}

/**
 * 中文「一个 token 大约对应几个字」——实测值，不是估的。
 *
 * 来源：scripts/probe-model-limits.mjs + scripts/experiment-whole-chapter.mjs
 *   · 输入：600,000 个中文字，服务端记账 284,245 token → 2.11 字/token
 *   · 输出：一章改写后约 16,300 字，completion_tokens 9,850 → 1.66 字/token
 * 输出侧更"费 token"（数字、专名、标点混合），所以取偏小的那个再留余量。
 *
 * 为什么必须用实测值：estimateTokens() 按「中文 1 字 = 1 token」估算，
 * 对**预算告警**来说保守一点是好事，但用它来反推「一块能放多少字」
 * 就会把块压掉一半还多 —— 第一版就是这么把用户的 9000 字上限压到 5913 的。
 */
const OUTPUT_CHARS_PER_TOKEN = 1.5;

/**
 * 按模型的输出上限，把 chunk 尺寸压到「不可能被截断」的范围内。
 *
 * 需要这一步的场景：模型 max_tokens 很小（例如 4000），而处理方式
 * 允许单块 9000 字。截断的后果不是报错，而是静默降级 ——
 * 模型只返回了前几段，剩下的段落保留原文，用户看到的是
 * 「这本书有些地方没被改」，而且完全不知道为什么。
 *
 * 反过来，模型输出上限很大时这里也不会主动把块放大 ——
 * 那属于「花更多钱换更少接缝」的取舍，而且实测表明块越大
 * 模型越倾向于照抄（见 docs/PHASES.md 的实测数据）。
 *
 * @param {{targetCharsPerChunk?: number, maxCharsPerChunk?: number, maxOutputTokens?: number}} args
 * @returns {{target: number, max: number, targetChanged: boolean, reason: string|null}}
 */
export function planChunkSizes({ targetCharsPerChunk, maxCharsPerChunk, maxOutputTokens }) {
  const target = Number(targetCharsPerChunk) || 5000;
  const max = Math.max(Number(maxCharsPerChunk) || 9000, target);
  const outTokens = Number(maxOutputTokens);
  const known = Number.isFinite(outTokens) && outTokens > 0;
  // 拿不到输出上限就按 8000 这个主流默认值算
  const budget = known ? outTokens : 8000;

  /**
   * 输出会比原文长一点（要补机制、补类比、补解释），留 15% 余量；
   * 再只用掉 85% 的输出额度，剩下的留给「模型偶尔啰嗦一下」。
   */
  const safeOutputChars = Math.floor((budget * OUTPUT_CHARS_PER_TOKEN * 0.85) / 1.15);

  /**
   * 只压 max，不压 target。
   *
   * max 是切分的硬上限：一个块真的可能长到 max，所以它必须落在安全线内。
   * 而 target 是「切到这么多就开始找断点」，正常块都停在 target 附近，
   * 离输出上限还有距离 —— 用户选的 5000 是安全的，没有被压的理由。
   */
  const newMax = Math.max(1200, Math.min(max, safeOutputChars));
  const newTarget = Math.min(target, newMax);
  const targetChanged = newTarget < target;

  if (!targetChanged && newMax === max) return { target, max, targetChanged: false, reason: null };

  let reason = null;
  if (targetChanged) {
    reason = known
      ? `模型单次输出上限 ${budget} token，单块最多只能放约 ${newMax} 字，` +
        `已从 ${target} 字压到 ${newTarget} 字，调用次数会相应变多。`
      : `读不到模型的输出上限，按保守值 ${budget} token 估算，单块从 ${target} 字压到 ${newTarget} 字。` +
        `如果这个模型支持更长的输出，可以在 Provider 里填上正确的 max tokens。`;
  }
  return { target: newTarget, max: newMax, targetChanged, reason };
}

/** 极简的滚动上下文：只从原文抽取，不生成新内容。 */
function buildRollingSummary(chunk, chapterTitle) {
  const plain = chunk.blockTexts
    .join(' ')
    .replace(/⟦\/?\d+⟧/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const head = plain.slice(0, 240);
  return `${chapterTitle ? `${chapterTitle}：` : ''}上一段内容要点（原文摘录）：${head}${plain.length > 240 ? '…' : ''}`;
}

/**
 * 取出这一块**改写之后**的结尾原话。
 *
 * 为什么不能用原文摘录当「前文」：模型要接着写的是**它自己刚写出来的那段话**，
 * 而不是原文。给它改写后的原话，它才知道自己已经说过什么、用什么语气说的、
 * 话说到哪儿了 —— 这正是「不要重新起头、不要重复前文」能落地的前提。
 *
 * 长度取 500 字：实测 260 字时，模型的「跨块记忆」总共只有 500 字出头，
 * 一整章 16k 字里它只看得见自己那块（第 4 块只看得见 10.6%）。
 * 500 字大约是一个自然段多一点，足够接住话头和语气，又不至于挤占正文预算。
 *
 * 注意必须在 applyChunkResults 之后调用：那时块里的文本才已经是改写结果。
 *
 * @param {import('./chunker.js').Chunk} chunk
 * @param {number} [maxChars] 只要结尾这么多个字，太长了反而稀释重点
 */
function tailOfChunk(chunk, maxChars = 500) {
  const texts = chunk.blocks
    .map((block) => {
      try {
        return blockToPlainText(block).text;
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n')
    .replace(/⟦\/?\d+⟧/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (texts.length <= maxChars) return texts;
  return `…${texts.slice(-maxChars)}`;
}

/**
 * system prompt = 模板里「角色 + 规则 + 输出格式」那一段（第一个变量行之前）。
 * 变量块（读者画像 / 书籍 / 章节 / 原文）由 user message 承载，
 * 这样：
 *  - 规则只出现一次，不会在 system 和 user 里重复两遍（省 token，避免歧义）；
 *  - system 是稳定前缀，同一次任务内不变，便于服务端 prompt 缓存命中。
 */
export function buildRewriteSystemPrompt(template) {
  const { system } = splitPromptTemplate(template);
  return system || String(template || '').trim();
}

/** user prompt = 模板里变量区那一部分（渲染后即为画像 + 上下文 + 原文）。 */
export function buildRewriteUserTemplate(template) {
  const { user } = splitPromptTemplate(template);
  const trimmed = user || String(template || '');
  return trimmed.includes('{{SOURCE_TEXT}}') ? trimmed : `${trimmed}\n\n{{SOURCE_TEXT}}`;
}

function renderBookContext(context) {
  if (!context) return '';
  const lines = [];
  if (context.title) lines.push(`书名：${context.title}`);
  if (context.authors?.length) lines.push(`作者：${context.authors.join('、')}`);
  if (context.language) lines.push(`原书语言：${context.language}`);
  if (context.chapterCount) lines.push(`共 ${context.chapterCount} 章`);
  if (context.summary) lines.push(`全书概要（来自已有记忆）：${context.summary}`);
  return lines.join('\n');
}

function collectText(doc) {
  const root = doc.documentElement;
  if (!root) return '';
  return root.textContent.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 从序列化后的 XHTML 里抽正文文本（用于质量对比）。 */
export function extractBodyText(xhtml) {
  try {
    const doc = parseXml(xhtml);
    const root = doc.documentElement;
    if (!root) return '';
    const body = root.children.find((c) => c.kind === 2 && c.name.toLowerCase() === 'body') || root;
    return body.textContent.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------ Review -- */

/**
 * 可选的 AI Review（需求第十六节）。只判断问题，不改写。
 */
export async function reviewChapter(args) {
  const userPrompt = renderTemplate(args.promptTemplate, {
    READER_PROFILE: renderProfileForPrompt(args.profile),
    CHAPTER_CONTEXT: args.chapterContext || '（无）',
    SOURCE_TEXT: truncate(args.originalText, 24000),
    REWRITTEN_TEXT: truncate(args.rewrittenText, 24000),
  });
  const result = await chatCompletion(
    [
      { role: 'system', content: '你是严格的内容审校员，只输出 JSON。' },
      { role: 'user', content: userPrompt },
    ],
    {
      baseUrl: args.provider.baseUrl,
      apiKey: effectiveApiKey(args.provider),
      model: args.provider.model,
      temperature: 0,
      maxTokens: Math.min(args.provider.maxTokens || 4000, 4000),
      timeoutMs: args.provider.timeoutMs,
      maxRetries: args.maxRetries ?? 2,
      signal: args.signal,
    },
  );
  const json = extractJson(result.text);
  return {
    score: Number(json.score) || 0,
    verdict: json.verdict === 'pass' ? 'pass' : 'revise',
    issues: Array.isArray(json.issues) ? json.issues.slice(0, 50) : [],
    summary: String(json.summary || '').slice(0, 500),
    usage: result.usage,
  };
}

function truncate(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  const head = value.slice(0, Math.floor(max * 0.6));
  const tail = value.slice(-Math.floor(max * 0.4));
  return `${head}\n\n…（中间省略 ${value.length - max} 字）…\n\n${tail}`;
}

/* ---------------------------------------------------- Book Memory -- */

/**
 * 用 LLM 更新一本书的长期记忆（需求第八节）。
 *
 * 设计要点（都是踩过坑之后改的）：
 *  1. **只返回增量**，不要求模型把累积记忆整个抄回来。
 *     否则输出长度随书的厚度增长，迟早撞上 max_tokens 被截断成空字符串
 *     （典型症状：finish_reason=length），整个记忆更新失败。
 *  2. 输出上限按**剩余预算**算，不再固定 4000。中文 JSON 很占 token，
 *     一本书读到后面光是为了抄回旧记忆就用光了额度。
 *  3. 失败不影响主流程：记忆只是「后续章节保持一致」的辅助。
 */
export async function updateBookMemory(args) {
  const provider = args.provider;
  const systemContent = String(args.promptTemplate || '');
  const userPrompt = renderTemplate(systemContent, {
    BOOK_MEMORY: JSON.stringify(args.memory, null, 2),
    BOOK_CONTEXT: renderBookContext(args.bookContext),
    CHAPTER_CONTEXT: args.chapterTitle || '（无）',
    CHAPTER_INDEX: String(args.chapterIndex ?? ''),
    CHAPTER_TEXT: truncate(args.chapterText, 12000),
  });

  const promptTokens = estimateTokens(systemContent + userPrompt);
  // 输出上限：不超过 provider 设定，同时留出「输入 + 输出」的总预算空间。
  // 增量式输出通常几百 token 就够，这里给足余量但不无限放大。
  const configured = provider.maxTokens || 4000;
  const budgetLeft = Math.max(1000, 120000 - promptTokens);
  const maxTokens = Math.min(configured, 8000, budgetLeft);

  const result = await chatCompletion(
    [
      { role: 'system', content: systemContent },
      { role: 'user', content: userPrompt },
    ],
    {
      baseUrl: provider.baseUrl,
      apiKey: effectiveApiKey(provider),
      model: provider.model,
      reasoningEffort: provider.reasoningEffort,
      temperature: 0,
      maxTokens,
      timeoutMs: provider.timeoutMs,
      maxRetries: args.maxRetries ?? 1,
      signal: args.signal,
    },
  );
  const json = extractJson(result.text);
  return {
    memory: json,
    usage: result.usage,
    truncated: Boolean(result.truncated),
  };
}

/** 供 UI / 测试使用的统计工具。 */
export function chapterStats(text) {
  return {
    chars: String(text).replace(/\s+/g, '').length,
    words: countWords(text),
    isCjk: isCjkText(text),
  };
}
