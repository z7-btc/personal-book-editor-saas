/**
 * 「压缩成提要」的执行层。
 *
 * 规划阶段可能给某些章节标了 `strategy: digest`（用户这本书是前面 6 章：
 * 题引、推荐序一/二、目录页、第2版前言、第6版引言、第6版跋）。
 * 这里负责把这些章节**真的**压成一页提要。
 *
 * ## 为什么不能简单粗暴地清空重写
 *
 * 因为**别人会指向这一章**。实测这本书有 1051 条跨文件链接，
 * 其中目录页指向每一章的开头锚点（`text00004.html#pre4_4`）。
 * 如果压缩时把带锚点的那个块删掉，目录点进去就是空白 ——
 * 而 EPUB 阅读器**不会报错**。
 *
 * 所以规则是：**带入链锚点的块原样保留，其余块换成提要**。
 * 这样既压缩了，又不会产生死链。
 *
 * ## 与脚注就地化的配合
 *
 * 脚注就地化会把正文里的 `jzyy_*` 标记删掉，而脚注汇编那一章正是
 * 靠这些标记被"反向引用"的。也就是说：**就地化之后，脚注汇编章的
 * 入链锚点会大幅减少**，它才可能被安全压缩。
 * 所以链接风险必须在**执行时**重新算，不能用规划时的快照。
 */

import { chatCompletion } from '../llm/client.js';
import { loadPromptTemplate, renderTemplate, splitPromptTemplate } from '../llm/prompts.js';
import { extractBlocks } from '../epub/sanitize.js';
import { parseXml } from '../epub/xml-dom.js';
import { queryAll } from '../epub/selector.js';

/**
 * 从**已经提取好的块**里挑出「带入链锚点」的那些 —— 这些块必须原样保留。
 *
 * 注意这个函数接收的是 `blocks`，不是 xhtml。原因是一次真实的 bug：
 * 第一版让 applyDigest 先 `extractBlocks(parseXml(xhtml))` 拿到 blocks，
 * 再调用一个「传 xhtml 进来、内部重新 parse 一遍」的版本。
 * 两次 parse 产生的是**两批不同的 DOM 对象**，`keep.has(block)` 永远为 false，
 * 于是所有块都被当成"可以删" —— 入链锚点连同段落一起消失，
 * 而单元测试正好把这一步挡住了。
 *
 * @param {Array<object>} blocks
 * @param {Set<string>} inboundAnchors 别人指向本章的锚点 id 集合
 * @returns {Set<object>}
 */
export function markBlocksWithInboundAnchors(blocks, inboundAnchors) {
  const keep = new Set();
  if (!inboundAnchors || !inboundAnchors.size) return keep;
  for (const block of blocks) {
    const el = block.element;
    const ids = [];
    if (typeof el?.getAttribute === 'function' && el.getAttribute('id')) ids.push(el.getAttribute('id'));
    // 锚点也可能挂在这一块内部的元素上（比如段落里某个 <a id="...">）
    for (const child of el?.descendants ? el.descendants() : []) {
      const id = child.getAttribute?.('id');
      if (id) ids.push(id);
    }
    if (ids.some((id) => inboundAnchors.has(id))) keep.add(block);
  }
  return keep;
}

/**
 * 便捷版本：直接从 xhtml 算。
 * **不要**在已经 parse 过的地方用它 —— 那会产生两批 DOM 对象，
 * 比对必然失败（踩过一次，见上面 markBlocksWithInboundAnchors 的注释）。
 */
export function blocksWithInboundAnchors(xhtml, inboundAnchors) {
  if (!inboundAnchors || !inboundAnchors.size) return new Set();
  const { blocks } = extractBlocks(parseXml(xhtml));
  return markBlocksWithInboundAnchors(blocks, inboundAnchors);
}

/**
 * 生成一章的提要。
 *
 * @param {object} args
 * @param {string} args.xhtml 原文
 * @param {object} args.provider
 * @param {object} args.profile
 * @param {string} args.projectRoot
 * @param {number} args.chapterIndex
 * @param {string} [args.chapterTitle]
 * @param {object} [args.bookContext]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{text: string, usage: object|null}>}
 */
export async function buildDigest({ xhtml, provider, profile, projectRoot, chapterIndex, chapterTitle, bookContext, signal }) {
  const loaded = await loadPromptTemplate(projectRoot, 'prompts/digest-system.txt');
  const { system, user } = splitPromptTemplate(loaded.template);

  // 提要是「读全文写摘要」，输入可以大；但输出很小，不需要留很多 token
  const plain = String(xhtml || '')
    /**
     * 先把 `<?xml?>`、`<head>`、`<style>`、`<script>` 整段拿掉，再去标签。
     *
     * 只做 `.replace(/<[^>]+>/g, '')` 是不够的：它只删标签本身，
     * `<style>` 里的 CSS 正文会原样留在提示里 —— 白送几千 token 的
     * 样式规则给模型读，还可能被当成正文写进提要。
     */
    .replace(/<\?xml[\s\S]*?\?>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/⟦\/?\d+⟧/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const messages = [
    { role: 'system', content: system || String(loaded.template) },
    {
      role: 'user',
      content: renderTemplate(user || String(loaded.template), {
        READER_PROFILE: renderProfile(profile),
        BOOK_CONTEXT: bookContext || '（无）',
        CHAPTER_INDEX: String(chapterIndex),
        CHAPTER_TITLE: chapterTitle || '（无标题）',
        SOURCE_TEXT: plain,
      }),
    },
  ];

  const result = await chatCompletion(messages, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    temperature: 0.3,
    maxTokens: 2000,
    timeoutMs: provider.timeoutMs,
    maxRetries: 2,
    reasoningEffort: provider.reasoningEffort,
    signal,
  });

  return { text: String(result.text || '').trim(), usage: result.usage };
}

function renderProfile(profile) {
  if (!profile) return '（未填写画像）';
  const parts = [];
  if (profile.reading_goal) parts.push(`阅读目标：${profile.reading_goal}`);
  if (profile.about_me) parts.push(`关于我：${String(profile.about_me).slice(0, 400)}`);
  if (profile.preferred_style?.length) parts.push(`偏好：${profile.preferred_style.slice(0, 6).join('；')}`);
  return parts.join('\n') || '（未填写画像）';
}

/**
 * 把提要写回章节：保留带锚点的块，其余替换成提要段落。
 *
 * @param {object} args
 * @param {string} args.xhtml 原文
 * @param {string} args.digestText 提要正文
 * @param {Set<string>} [args.inboundAnchors] 别人指向本章的锚点
 * @returns {{xhtml: string, keptBlocks: number, replacedBlocks: number, digestParagraphs: number}}
 */
export function applyDigest({ xhtml, digestText, inboundAnchors }) {
  const doc = parseXml(xhtml);
  const { blocks } = extractBlocks(doc);
  // 必须用同一批 blocks 算保留集，不能再 parse 一次（见 markBlocksWithInboundAnchors 的注释）
  const keep = markBlocksWithInboundAnchors(blocks, inboundAnchors);
  /**
   * 小标题**永远保留**，哪怕没人指向它。
   *
   * 这是单元测试逼出来的：没有入链锚点的章节，所有块都会被提要取代，
   * 连 `<h1>推荐序一</h1>` 都没了 —— 读者只会看到一段孤零零的提要，
   * 不知道自己在读什么；而且书的章节结构也就断了。
   * 小标题本来就短，留下来只会让提要更好读。
   */
  for (const block of blocks) {
    if (block.isHeading) keep.add(block);
  }

  /**
   * 但**悬空的小标题**要拿掉：它后面一段正文都没留，留着就是一个
   * 空荡荡的「後記」「一、为什么」挂在提要下面 —— 读者以为这里
   * 少了内容，实际是压缩时把这一节整段换成了提要。
   *
   * 第一个标题（章节标题）永远保留：提要就插在它后面，
   * 没有它读者不知道这一页是什么。
   */
  const keptBodies = new Set(blocks.filter((b) => !b.isHeading && keep.has(b)));
  const firstHeading = blocks.find((b) => b.isHeading) || null;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block.isHeading || block === firstHeading) continue;
    let hasBody = false;
    for (let j = i + 1; j < blocks.length; j += 1) {
      if (blocks[j].isHeading) break;
      if (keptBodies.has(blocks[j])) {
        hasBody = true;
        break;
      }
    }
    if (!hasBody) keep.delete(block);
  }

  const paragraphs = String(digestText || '')
    .split(/\n{2,}|\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  /**
   * 提要段落插在**第一个被保留的块之后**（通常是标题），
   * 这样读者先看到章节标题，再看到「这一章是什么、可以跳过」。
   * 如果没有保留块，就插在最前面。
   */
  const docRoot = doc.documentElement;
  const bodyLike = queryAll(docRoot, 'body')[0] || docRoot;

  /**
   * 改结构之前必须先 touch()。
   *
   * 这套 DOM 是「字节保真」的：没被标记修改的节点直接输出原文片段。
   * 光把孩子 detach 掉是不够的 —— 父节点序列化时会按源区间回填"缝隙"，
   * 被删掉的段落会**原样又冒出来**（第一版就是这样，单元测试抓到的）。
   * 正确的做法和 applyRebuild 一致：把父节点标成 rebuilt，让它纯按
   * 当前 DOM 状态重建，同时先 touch() 保证修改能传到文档上。
   */
  bodyLike.touch();

  let keptBlocks = 0;
  let replacedBlocks = 0;
  /** @type {object|null} 提要要插在哪个节点后面 */
  let anchorNode = null;
  /** 被改动过的父节点，最后统一标 rebuilt */
  const dirtyParents = new Set();

  for (const block of blocks) {
    if (keep.has(block)) {
      keptBlocks += 1;
      if (!anchorNode) anchorNode = block.element;
      continue;
    }
    const parent = block.element.parentNode;
    if (parent && parent !== docRoot) dirtyParents.add(parent);
    block.element.detach();
    replacedBlocks += 1;
  }

  /**
   * 提要段落用「解析一小段 XHTML」拿到现成节点。
   *
   * XmlDocument 没有 createElement，但也不需要 —— 这些段落本来就要
   * 整段新插入，没有源区间要保留，解析出来直接用最简单可靠。
   */
  const fragmentHtml = paragraphs.map((t) => `<p>${escapeXml(t)}</p>`).join('');
  const wrapper = parseXml(
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${fragmentHtml}</body></html>`,
  );
  const bodyEl = queryAll(wrapper.documentElement, 'body')[0];
  const inserted = [...(bodyEl?.children || [])];

  /**
   * 插在**第一个被保留的块之后**（通常是章节标题）：
   * 读者先看到标题，再看到「这一章是什么、可以跳过」。
   * 没有保留块（没有入链锚点）就插在正文最前面。
   *
   * 位置要**自己往后推**：每插一段，后面的段落就该排在它后面。
   * 第一版每段都插在 children[0]，结果提要段落的顺序被整个倒过来
   * （读者先看到最后一段）—— 也是单元测试抓到的。
   */
  const host = anchorNode && anchorNode.parentNode && anchorNode.parentNode !== docRoot
    ? anchorNode.parentNode
    : bodyLike;
  let insertAt = anchorNode && anchorNode.parentNode === host ? host.children.indexOf(anchorNode) + 1 : 0;
  for (const node of inserted) {
    node.detach();
    host.insertBefore(node, host.children[insertAt] || null);
    insertAt += 1;
  }
  dirtyParents.add(host);

  // 被改过的父节点统一标 rebuilt，让它们按当前 DOM 状态重建
  for (const parent of dirtyParents) {
    parent.rebuilt = true;
    parent.touch();
  }

  return {
    xhtml: doc.serialize(),
    keptBlocks,
    replacedBlocks,
    digestParagraphs: inserted.length,
  };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
