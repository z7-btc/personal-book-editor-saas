/**
 * 章节分类与标题推断。
 *
 * 真实电子书（尤其 EPUB 2 的转换产物）里，spine 里的每个文件并不都是「一章」：
 *   - 分隔页 / 整页插图：正文是空的，文字全在图片里（`<div><img></div>`）
 *   - 装饰页：一句引文、一个二维码
 *   - 封面、版权页、目录
 * 这些如果按「章节」处理，会带来两个问题：
 *   1. 界面上显示「0 字」，用户不知道这是什么、要不要处理；
 *   2. 「Rewrite All」会把纯图片页也发给模型 —— 白花钱，还可能让模型
 *      往只有 `<div><img></div>` 的页面里塞文字，反而破坏结构。
 *
 * 另外，很多书（特别是这种转换产物）的 TOC 并不覆盖 spine 里的每个文件，
 * 于是标题只能回退成文件名 `text00027.html` —— 对用户毫无意义。
 * 这里改成从正文里推断一个能看懂的标题。
 */

import { extractBlocks } from './sanitize.js';

const BLOCK_TAGS = 'p|h1|h2|h3|h4|h5|h6|li|blockquote|td|th|figcaption|caption|div';

/**
 * @typedef {'content'|'image-only'|'empty'|'tiny'} ChapterKind
 */

/**
 * 判断一个章节文件的性质。
 * @param {import('./xml-dom.js').XmlDocument} doc
 * @returns {{kind: ChapterKind, textLength: number, blockCount: number, imageCount: number, firstText: string, heading: string}}
 */
export function analyzeChapterDocument(doc) {
  const root = doc.documentElement;
  if (!root) {
    return { kind: 'empty', textLength: 0, blockCount: 0, imageCount: 0, firstText: '', heading: '' };
  }
  const body = root.children.find((c) => c.kind === 2 && c.name.toLowerCase() === 'body') || root;
  const text = body.textContent.replace(/\s+/g, ' ').trim();
  const textLength = text.replace(/\s/g, '').length;

  let imageCount = 0;
  let heading = '';
  let firstText = '';
  const stack = [...body.children];
  while (stack.length) {
    const node = stack.shift();
    if (!node || node.kind !== 2) continue;
    const name = node.name.toLowerCase();
    if (name === 'img' || name === 'svg' || name === 'image') imageCount += 1;
    if (!heading && /^h[1-6]$/.test(name)) heading = node.textContent.replace(/\s+/g, ' ').trim();
    if (!firstText && /^(p|div|blockquote|li)$/.test(name)) {
      const t = node.textContent.replace(/\s+/g, ' ').trim();
      if (t) firstText = t;
    }
    stack.unshift(...node.children);
  }

  // 用真实的语义块数量判断「有没有可处理的正文」
  let blockCount = 0;
  try {
    const { blocks } = extractBlocks(doc);
    // 纯空白/纯换行的 <div> 不算正文块（分隔页常见）
    blockCount = blocks.filter((b) => b.element.textContent.replace(/\s+/g, '').length > 0).length;
  } catch {
    blockCount = 0;
  }

  // 纯提示页：一张图 + 一句「扫码获取 App」之类的说明。
  // 这句说明有文字，但不是书的内容，交给 AI 改写没有意义。
  const isPromptPage = /扫码|二维码|扫一扫|关注公众号/.test(text) && textLength < 200;

  let kind;
  if (isPromptPage) kind = 'prompt';
  else if (textLength === 0 && imageCount > 0) kind = 'image-only';
  else if (textLength === 0) kind = 'empty';
  else if (blockCount === 0) kind = 'image-only';
  else if (textLength < 80) kind = 'tiny';
  else kind = 'content';

  return { kind, textLength, blockCount, imageCount, firstText, heading };
}

/** 这类章节没有可改写的正文，不该进 AI 队列。 */
export function isRewritable(kind) {
  return kind === 'content' || kind === 'tiny';
}

/** 给用户解释「为什么不处理这一页」。 */
export function noTextReason(kind) {
  if (kind === 'image-only') return '这一页正文是整页图片，没有可改写的文字';
  if (kind === 'prompt') return '这一页是扫码／关注之类的图片提示，不是书的内容';
  if (kind === 'empty') return '这一页没有正文内容';
  return null;
}

/**
 * 为没有 TOC 条目的章节推断一个能看懂的标题。
 *
 * 优先级：TOC 标题 > 正文里的第一个标题元素 > 正文首句 > 「整页图片」> 「第 N 节」
 * @param {{title?: string, navTitle?: string, kind: ChapterKind, heading: string, firstText: string, index: number, href: string}} info
 */
export function inferChapterTitle(info) {
  const fromToc = (info.navTitle || info.title || '').trim();
  const looksLikeFileName = (s) => /^[a-z]*\d+$/i.test(s) || /^text\d+$/i.test(s) || /\.x?html?$/i.test(s);
  if (fromToc && !looksLikeFileName(fromToc)) return fromToc;

  if (info.heading) return clip(info.heading, 40);
  if (info.firstText) return clip(info.firstText, 30);
  if (info.kind === 'image-only') return '整页图片';
  if (info.kind === 'prompt') return '图片提示页';
  if (info.kind === 'empty') return '空白页';
  return `第 ${info.index} 节`;
}

function clip(text, max) {
  // 去掉结尾的标点再截断，避免出现「…重放异彩。」这种半截句加句号
  const t = String(text).replace(/\s+/g, ' ').trim().replace(/[。．.，,；;：:、]+$/, '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 给界面用的性质说明。 */
export const KIND_LABEL = {
  content: '',
  tiny: '短页',
  'image-only': '整页图片',
  prompt: '图片提示页',
  empty: '空白页',
};
