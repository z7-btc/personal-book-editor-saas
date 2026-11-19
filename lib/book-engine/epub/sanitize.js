/**
 * 【核心模块】正文安全提取 与 写回 XHTML。
 *
 * 工程原则：
 *  1. 只碰「语义块」的**行内内容**，块级元素本身（标签名 / class / id / epub:type）
 *     永远由我们控制，AI 不能新增或删除块。
 *  2. `<pre> <code> <svg> <math> <table>` 等结构整块跳过，绝不发给模型。
 *  3. 行内元素（`<a> <em> <sup> <img> ...`）不交给模型改写：
 *     提取时替换成 `⟦n⟧`（自闭合）/ `⟦n⟧…⟦/n⟧`（有内容）占位符，
 *     写回时再换回**原来那个 DOM 节点对象**。
 *     => 链接、脚注、图片、锚点、专名标记天然不可能被模型改坏。
 *  4. 写回后立即自检：HTML 是否可解析、行内元素是否丢失、是否产生新块级嵌套。
 *
 * 这是「AI 不容易把原书内容改没」在代码层的兜底。
 */

import { NODE, XmlText, XmlElement } from './xml-dom.js';
import { stripTrailingNoteAttribution } from './footnotes.js';

/** 提取时代表行内元素的占位符（正文里几乎不可能出现的字符）。 */
export const PLACEHOLDER_OPEN = '⟦';
export const PLACEHOLDER_CLOSE = '⟧';
export const PLACEHOLDER_END_MARK = '/';

/** 可以被当作「正文段落」处理的块级元素。 */
export const DEFAULT_BLOCK_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'dt',
  'dd',
  'blockquote',
  'figcaption',
  'caption',
  'td',
  'th',
  'div',
];

/** 整块保护，永不交给模型。 */
export const PROTECTED_TAGS = new Set([
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'textarea',
  'script',
  'style',
  'svg',
  'math',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'object',
  'iframe',
  'canvas',
  'video',
  'audio',
  'map',
  'area',
  'select',
  'form',
  'input',
  'button',
  'template',
  'noscript',
]);

/** 允许出现在语义块内部、需要占位符保护的行内元素。 */
export const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'acronym',
  'b',
  'bdi',
  'bdo',
  'big',
  'br',
  'cite',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'img',
  'ins',
  'mark',
  'meter',
  'q',
  'rb',
  'rp',
  'rt',
  'ruby',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'wbr',
  'label',
  'output',
  'progress',
]);

/** void 元素（没有结束标记）。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 这些标签内部的空白有意义，不要规范化。 */
const WHITESPACE_SENSITIVE = new Set(['pre', 'code', 'kbd', 'samp', 'textarea', 'script', 'style']);

function localName(name) {
  return String(name).toLowerCase();
}

/** 元素是否属于某个标签集合（忽略命名空间前缀）。 */
function tagIn(el, set) {
  return set.has(localName(el.name));
}

/**
 * @typedef {Object} Block
 * @property {string} id          稳定 id（c{chapter}-{seq}）
 * @property {XmlElement} element
 * @property {XmlElement} container 直接父元素
 * @property {number} index       在文档中的顺序
 * @property {string} tag
 * @property {boolean} isHeading
 * @property {string} path        给模型看的路径提示，如 "body > div.chapter > p"
 * @property {number} textLength
 * @property {number} elementCount 占位符数量
 * @property {string|null} note   跳过的原因
 */

/**
 * 从一章 XHTML 里提取可处理的语义块。
 * @param {import('./xml-dom.js').XmlDocument} doc
 * @param {{blockTags?: string[], minTextLength?: number, onlyBlocks?: boolean}} [opts]
 * @returns {{blocks: Block[], skipped: Array<{tag: string, reason: string, textLength: number}>}}
 */
export function extractBlocks(doc, opts = {}) {
  const blockTags = new Set((opts.blockTags || DEFAULT_BLOCK_TAGS).map(localName));
  const minTextLength = opts.minTextLength ?? 1;
  const root = doc.documentElement;
  const blocks = [];
  const skipped = [];
  if (!root) return { blocks, skipped };

  const visit = (el, pathParts) => {
    const name = localName(el.name);
    const path = [...pathParts, describe(el)].join(' > ');

    if (PROTECTED_TAGS.has(name)) {
      skipped.push({ tag: name, reason: 'protected', path, textLength: el.textContent.length });
      return;
    }

    const isBlockTag = blockTags.has(name);
    const childElements = el.childElements;
    const hasBlockChild = childElements.some((c) => blockTags.has(localName(c.name)) || PROTECTED_TAGS.has(localName(c.name)));

    if (isBlockTag && !hasBlockChild && !isEffectivelyEmpty(el)) {
      const text = el.textContent;
      const hasInline = el.childElements.length > 0;
      if (text.trim().length < minTextLength && !hasInline) {
        skipped.push({ tag: name, reason: 'too-short', path, textLength: text.trim().length });
      } else {
        blocks.push({
          id: '',
          element: el,
          container: el.parentNode,
          index: blocks.length,
          tag: name,
          isHeading: /^h[1-6]$/.test(name),
          path,
          textLength: text.trim().length,
          elementCount: 0,
          note: null,
        });
      }
      // 语义块内部不再向下递归找块（避免 p 里面又找 p）
      return;
    }

    for (const child of childElements) visit(child, [...pathParts, describe(el)]);
  };

  if (root.firstElementChild) {
    visit(root.firstElementChild, [describe(root)]);
    for (const extra of root.childElements.slice(1)) visit(extra, [describe(root)]);
  }

  blocks.forEach((b, i) => {
    b.index = i;
    b.elementCount = countInlineElements(b.element);
  });
  return { blocks, skipped };
}

function describe(el) {
  const cls = el.getAttribute('class');
  const id = el.getAttribute('id');
  let out = localName(el.name);
  if (id) out += `#${id}`;
  if (cls) out += `.${cls.trim().split(/\s+/).slice(0, 2).join('.')}`;
  return out;
}

/** 完全没有内容的块（既无文本也无行内元素）才算空。 */
function isEffectivelyEmpty(el) {
  if (el.childElements.length > 0) return false;
  return el.textContent.trim() === '';
}

function countInlineElements(el) {
  let n = 0;
  const stack = [...el.children];
  while (stack.length) {
    const node = stack.shift();
    if (node.kind !== NODE.ELEMENT) continue;
    n += 1;
    stack.unshift(...node.children);
  }
  return n;
}

/* ------------------------------------------------- 提取：变成纯文本 -- */

/**
 * @typedef {Object} InlineMark
 * @property {number} n         占位符编号
 * @property {XmlElement} element 原 DOM 节点
 * @property {boolean} selfClosing
 * @property {string} name
 */

/**
 * 脚注标记在正文里的写法：`⟦注3⟧注释正文…⟦/注3⟧`
 *
 * 刻意不用 `⟦3⟧` 那套数字占位符，原因有两个：
 *  1. 数字占位符的语义是「原样保留这个结构」，而脚注是**要就地化然后删掉**的，
 *     语义相反，混在一起会让模型困惑；
 *  2. 数字占位符会被 rebuildBlockChildren 配对还原成原 DOM 节点，
 *     而脚注元素恰恰**不能**被还原（还原了链接就还在，就不算「删掉标记」）。
 *     用一套数字正则匹配不到的符号，它天然就不会进入还原流程。
 */
export const NOTE_OPEN = '⟦注';
export const NOTE_OPEN_END = '⟦/注';
export const NOTE_CLOSE = '⟧';
const NOTE_TOKEN_RE = /⟦注(\d+)⟧([\s\S]*?)⟦\/注\1⟧|⟦\/?注\d+⟧/g;

/**
 * 把语义块转成「带占位符的纯文本」。
 *
 * - 行内元素 -> `⟦n⟧` / `⟦n⟧…⟦/n⟧`（嵌套行内元素也会各自编号，保证结构可精确还原）
 * - `<br>` -> 换行符
 * - 空白规范化（连续空白折叠成单个空格）
 *
 * ## 脚注（opts.noteRefs）
 *
 * 传了 `noteRefs` 时，脚注引用会被展开成 `⟦注N⟧注释正文⟦/注N⟧` ——
 * 让模型**在原位**看到注释内容，从而决定是把它融进句子还是丢掉。
 * 这些标记**不进入 marks**，所以重建时不会被还原回原元素，
 * 「删掉标记」是自然发生的，不需要额外的可丢弃机制。
 *
 * @param {Block} block
 * @param {{noteRefs?: Map<string, {anchor: string, text: string, kind: string}>}} [opts]
 * @returns {{text: string, marks: InlineMark[], noteChars: number}}
 */
/**
 * 本身就「有内容」的标签：即使一个字都没有，也不能当作空元素跳过。
 *
 * `hr` 看着是条横线，但文学书里它是分节符（换场景、换时间），
 * 丢了读者会以为两段是一件事。
 */
const ALWAYS_VISIBLE = new Set([
  'img', 'image', 'svg', 'math', 'video', 'audio', 'object', 'iframe', 'hr',
]);

/**
 * 这个元素是不是「读者看不见、也没有任何功能」的空壳。
 *
 * 为什么要这一步：维基文库（MediaWiki/Parsoid）用
 * `<span typeof="mw:Entity">　</span>` 这类空标签来占排版空格，
 * 一章里能有几十个。它们每个都会被编成一个 `⟦n⟧` 占位符，
 * 模型改写时当然只留文字、不留这些没意义的编号 —— 于是
 * 「丢失占位符」的检查把好好的段落判成 `corrupted`，
 * 整段退回繁体原文。实测《朝花夕拾》一章 75 个标记里 48 个是这种空格，
 * 成品因此一半简体、一半繁体，读起来像两本书拼起来的。
 *
 * 判定只看结构，不看类名：没有文字、没有链接/图片/锚点，
 * 删掉之后读者什么都感觉不到 —— 那就不该占用模型的一个编号。
 */
function isInvisibleShell(node, name) {
  if (ALWAYS_VISIBLE.has(name)) return false;
  for (const attr of ['href', 'src', 'id', 'name', 'alt', 'aria-label']) {
    if (String(node.getAttribute?.(attr) || '').trim()) return false;
  }
  if (String(node.textContent || '').trim()) return false;
  return !(node.descendants?.() || []).some((d) => ALWAYS_VISIBLE.has(localName(d.name)));
}

export function blockToPlainText(block, opts = {}) {
  /** @type {InlineMark[]} */
  const marks = [];
  const out = [];
  let counter = 0;
  let noteCounter = 0;
  let noteChars = 0;
  const noteRefs = opts.noteRefs || null;

  const walk = (node) => {
    if (node.kind === NODE.TEXT) {
      out.push(node.value);
      return;
    }
    if (node.kind === NODE.CDATA) {
      out.push(node.data);
      return;
    }
    if (node.kind !== NODE.ELEMENT) return;

    const name = localName(node.name);
    if (name === 'br') {
      out.push('\n');
      return;
    }

    /**
     * 脚注引用：展开成带注释正文的标记，并且**不开数字占位符**。
     * 判定只看结构（id / href 落在 noteRefs 里），不猜类名。
     */
    if (noteRefs && name === 'a') {
      const id = node.getAttribute?.('id');
      const href = node.getAttribute?.('href');
      const ref =
        (id && noteRefs.get(id)) ||
        (href && href.includes('#') && noteRefs.get(href.split('#').pop()));
      if (ref) {
        noteCounter += 1;
        /**
         * **送进模型之前就把脚注署名剥掉**（「……第35页。——罗杰·洛温斯坦注」）。
         * 署名是「这是一条脚注」的外壳，不是内容 —— 用户要求融进正文之后
         * 不要再标注它是脚注。署名来自原书，模型搬注释时会一起搬走，
         * 所以必须在它看见之前就拿掉，而不是指望它记得别写。
         */
        const body = stripTrailingNoteAttribution(ref.text).text;
        // 整条注释只有署名、没有内容 —— 那就等于没有这条注释，不必给模型看。
        if (!body) return;
        /**
         * 注意闭合标记是 `⟦/注N⟧`（斜杠在前），和 `⟦/N⟧` 的写法保持一致。
         * 第一版写成了 `⟦注/N⟧`，跟 stripNoteMarkers 的正则对不上 ——
         * 因为模型通常会把标记直接删掉，这个 bug 一直没暴露出来，
         * 是单元测试把它抓出来的。
         */
        out.push(
          `${NOTE_OPEN}${noteCounter}${NOTE_CLOSE}${body}${NOTE_OPEN_END}${noteCounter}${NOTE_CLOSE}`,
        );
        noteChars += body.length;
        return; // 不再往下走，也不给它编号 —— 这个元素最终会被丢掉
      }
    }

    /**
     * 空壳行内元素（`<span typeof="mw:Entity">　</span>` 这类排版占位）
     * 不编号、不占位、不往下走 —— 见 `isInvisibleShell` 的注释。
     */
    if (isInvisibleShell(node, name)) return;

    if (!INLINE_TAGS.has(name)) {
      // 未知 / 块级元素：整块保护，用不透明占位符包住，
      // 只让模型看到它存在，看不到也改不了里面的内容。
      counter += 1;
      const n = counter;
      const selfClosing = node.selfClosing || VOID_TAGS.has(name);
      marks.push({ n, element: node, selfClosing, name, opaque: true });
      out.push(`${PLACEHOLDER_OPEN}${n}${PLACEHOLDER_CLOSE}`);
      if (!selfClosing) out.push(`${PLACEHOLDER_OPEN}${PLACEHOLDER_END_MARK}${n}${PLACEHOLDER_CLOSE}`);
      return;
    }

    counter += 1;
    const n = counter;
    const selfClosing = node.selfClosing || VOID_TAGS.has(name);
    marks.push({ n, element: node, selfClosing, name, opaque: false });
    out.push(`${PLACEHOLDER_OPEN}${n}${PLACEHOLDER_CLOSE}`);
    if (!selfClosing) {
      for (const child of node.children) walk(child);
      out.push(`${PLACEHOLDER_OPEN}${PLACEHOLDER_END_MARK}${n}${PLACEHOLDER_CLOSE}`);
    }
  };

  for (const child of block.element.children) walk(child);

  const text = normalizeWhitespace(out.join(''));
  return { text, marks, noteChars };
}

/**
 * 把模型输出里的脚注标记处理掉。
 *
 * - 模型保留了 `⟦注N⟧正文⟦/注N⟧`（说明它把注释留在了原位）
 *   => 剥掉包装，**保留正文**。这是最安全的兜底：即使模型没听懂
 *      「融进句子」，注释内容也不会丢，只是原地变成正文。
 * - 只剩孤零零的标记（内容被模型拿走了，通常是融进句子了）
 *   => 直接删掉标记。
 *
 * 顺带把 `⟦注…⟧` 前后的空格压一压，避免留下「痛苦   （1）」这种双空格。
 *
 * @param {string} text
 * @returns {{text: string, keptInPlace: number, droppedMarkers: number}}
 */
export function stripNoteMarkers(text) {
  let keptInPlace = 0;
  let droppedMarkers = 0;
  const out = String(text ?? '').replace(NOTE_TOKEN_RE, (_all, _n, body) => {
    if (body === undefined) {
      droppedMarkers += 1;
      return '';
    }
    const trimmed = String(body).trim();
    if (!trimmed) {
      droppedMarkers += 1;
      return '';
    }
    keptInPlace += 1;
    return ` ${trimmed} `;
  });
  return { text: out.replace(/[ \t]{2,}/g, ' '), keptInPlace, droppedMarkers };
}

/** 折叠空白（不动占位符本身）。 */
export function normalizeWhitespace(text) {
  return String(text)
    .replace(/[ \t\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------- 写回：文本 -> DOM -- */

/**
 * @typedef {Object} RebuildResult
 * @property {XmlNode[]} nodes           新的子节点序列（已挂好 parentNode）
 * @property {InlineMark[]} used         成功还原的行内元素
 * @property {InlineMark[]} missing      被模型丢掉的占位符（原元素会被补回块尾）
 * @property {InlineMark[]} duplicated   被模型重复输出的占位符
 * @property {number} unbalanced         配对不完整 / 顺序错乱的占位符数量
 * @property {number} unknown            模型编造出来的占位符编号数量
 * @property {boolean} changed           内容是否真的变化
 */

/**
 * 用模型返回的文本重建块的子节点。
 *
 * 关键性质：
 *  - 行内元素用的是**原来那个 DOM 节点对象**，所以 href / id / class /
 *    脚注标记 / 图片资源全部原样保留，模型没有任何机会改坏它们。
 *  - 嵌套关系由占位符的配对结构还原（`⟦1⟧<em>⟦2⟧x⟦/2⟧</em>⟦/1⟧` 依然正确嵌套）。
 *  - 占位符丢失 / 错配 / 编造都不会导致内容丢失：
 *    丢失的元素会被补回块尾，编造的编号被忽略并计入 unbalanced。
 *
 * @param {string} modelText
 * @param {InlineMark[]} marks
 * @param {{autoRepair?: boolean}} [opts]
 * @returns {RebuildResult}
 */
export function rebuildBlockChildren(modelText, marks, opts = {}) {
  const autoRepair = opts.autoRepair !== false;
  /**
   * 先把脚注标记处理掉，再走占位符还原。
   *
   * 顺序很重要：脚注标记里**含有成段的注释正文**，如果不先剥掉，
   * 它会被当成普通文本参与长度统计，也会混进最终输出里
   * （读者会看到 `⟦注1⟧…⟦/注1⟧` 这种字面量）。
   *
   * 剥的方式是「保留正文、去掉包装」—— 模型即使没把注释融进句子，
   * 内容也只是原地变成正文，不会丢。
   */
  const noteStripped = stripNoteMarkers(modelText);
  const text = noteStripped.text;
  const byN = new Map(marks.map((m) => [m.n, m]));

  /* ---- 1) 扫描占位符，同时得到「去掉占位符后的纯文本 + 偏移换算」 ---- */
  const tokenRe = /⟦(\/?)(\d+)⟧/g;
  let stripped = '';
  let sourceCursor = 0;
  /** @type {Array<{pos: number, n: number, close: boolean}>} */
  const tokens = [];
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    stripped += text.slice(sourceCursor, match.index);
    tokens.push({ pos: stripped.length, n: Number(match[2]), close: match[1] === '/' });
    sourceCursor = match.index + match[0].length;
  }
  stripped += text.slice(sourceCursor);
  const total = stripped.length;

  /* ---- 2) 配对成 item（用栈，保留嵌套结构） ---- */
  /** @type {Array<{n: number, start: number, end: number|null, selfClosing: boolean, parent: object|null, itemIndex: number}>} */
  const items = [];
  const stack = [];
  const openSeen = new Set();
  const closedSeen = new Set();
  let unbalanced = 0;
  let unknown = 0;

  for (const token of tokens) {
    const mark = byN.get(token.n);
    if (!mark) {
      unknown += 1;
      continue;
    }
    if (mark.selfClosing) {
      if (openSeen.has(token.n)) {
        unbalanced += 1; // 自闭合元素被重复输出
        continue;
      }
      openSeen.add(token.n);
      closedSeen.add(token.n);
      const item = { n: token.n, start: token.pos, end: token.pos, selfClosing: true, parent: null, itemIndex: items.length };
      items.push(item);
      continue;
    }
    if (!token.close) {
      if (openSeen.has(token.n)) {
        unbalanced += 1; // 开标记重复
        continue;
      }
      openSeen.add(token.n);
      const item = { n: token.n, start: token.pos, end: null, selfClosing: false, parent: null, itemIndex: items.length };
      items.push(item);
      stack.push(item);
      continue;
    }
    // 关闭标记：从栈顶向下找同号开标记
    const idx = stack.map((s) => s.n).lastIndexOf(token.n);
    if (idx < 0) {
      unbalanced += 1; // 孤儿关闭标记
      continue;
    }
    if (idx !== stack.length - 1) unbalanced += 1; // 跨层错配，尽量修复
    const [open] = stack.splice(idx, 1);
    open.end = token.pos;
    closedSeen.add(token.n);
  }

  /* ---- 3) 建树：按开标记顺序（= 配对顺序）确定父子 ----
   *
   * 必须用 itemIndex 排序，不能用 start 排序。
   * 嵌套元素的 start 是相同的（`⟦1⟧⟦2⟧x⟦/2⟧⟦/1⟧` 里 1 和 2 的正文起点都在 x 前面），
   * 按 start 排序时同分情况会被打乱，父子关系就会反过来。
   * itemIndex 就是开标记在括起来的文本里的先后顺序，天然满足「父在子前」。
   */
  const ordered = items.slice().sort((a, b) => a.itemIndex - b.itemIndex);
  const roots = [];
  const treeStack = [];
  for (const item of ordered) {
    while (treeStack.length) {
      const top = treeStack[treeStack.length - 1];
      const topEnd = top.end === null ? total : top.end;
      if (item.start >= topEnd) treeStack.pop();
      else break;
    }
    item.parent = treeStack.length ? treeStack[treeStack.length - 1] : null;
    (item.parent ? (item.parent.children ||= []) : roots).push(item);
    if (!item.selfClosing) treeStack.push(item);
  }

  /* ---- 4) 渲染：用原 DOM 节点对象重建子树 ---- */
  const used = [];
  const missing = [];
  const duplicated = [];
  const renderedOk = new Set();
  const orphanNodes = [];

  const render = (nodes, from, to, out) => {
    let cursor = from;
    for (const item of nodes) {
      const start = Math.max(item.start, cursor);
      const end = item.end === null ? to : Math.max(item.end, start);
      const mark = byN.get(item.n);
      if (renderedOk.has(item.n)) {
        // 同一编号被渲染两次 => 模型重复输出
        duplicated.push(mark);
        if (start > cursor) out.push(makeText(stripped.slice(cursor, start)));
        cursor = Math.max(cursor, end);
        continue;
      }
      if (start > cursor) out.push(makeText(stripped.slice(cursor, start)));
      renderedOk.add(item.n);
      used.push(mark);
      const el = mark.element;
      // 先把原节点自己的内容摘干净，再重建。
      // 顺序很关键：一定要在挂新子节点之前清掉旧 children，
      // 否则 attach() 里的 detach() 会误删刚挂上去的新子节点。
      const oldChildren = el.children;
      el.children = [];
      const inner = [];
      render(item.children || [], start, end, inner);
      for (const child of inner) attach(child, el);
      for (const old of oldChildren) old.parentNode = null;
      out.push(el);
      cursor = Math.max(cursor, end);
    }
    if (to > cursor) out.push(makeText(stripped.slice(cursor, to)));
  };

  /** @type {XmlNode[]} */
  const newNodes = [];
  render(roots, 0, total, newNodes);

  /* ---- 5) 判定：这是「轻微丢失」还是「整块被破坏」 ----
   *
   * 这条判定很重要。修好掉队的元素（补回块尾）能保住脚注，
   * 但如果模型把整段重写成一句话、把所有标记都丢了，
   * 「补回块尾」反而会把原元素的内容重新拼进来，
   * 结果是：模型摘要化的内容 + 一堆孤立的原元素，
   * 字数看起来没少，质量检查反而检测不到内容缩水。
   *
   * 所以：
   *  - 只丢了少数标记（大多数标记还在，或丢的正好是解析时"本来就缺配对"的自闭合标签）
   *    => 补回块尾，保住脚注 / 链接
   *  - 丢了一大半（>= 3 个且丢掉超过 1/3）
   *    => 判定为「整块被破坏」，调用方应当回退使用原文
   */
  /* ---- 5) 先把「模型没保留的标记」算清楚 ----
   * 这一步必须在判定之前做完：missing 既是质量报告的数据来源，
   * 也是判断「整块被破坏」的依据。之前的写法把它塞在补回分支里，
   * 结果一旦判定为破坏就再也统计不到丢失数量，质量检查就失灵了。
   */
  for (const mark of marks) {
    if (!renderedOk.has(mark.n)) missing.push(mark);
  }

  const presentCount = renderedOk.size;
  const totalMarks = marks.length;
  const missingCount = missing.length;
  const droppedRatio = totalMarks > 0 ? missingCount / totalMarks : 0;

  // 「结构化元素基本丢光」：>=3 个标记，丢掉超过 2/3，且留下来的比丢掉的还少
  const corrupted = missingCount >= 3 && droppedRatio > 0.66 && presentCount < missingCount;

  // 摘要式破坏：把整段压成极短的一句话。
  //
  // 必须拿**原文长度**做基准（opts.sourceLength），不能用模型输出的长度：
  // 一段 300 字的正文被压成「这一段主要讲了一件事。」时，
  // 模型输出本身就"很短"，跟它自己比是比不出问题的。
  //  - 如果这段本来还有行内元素，丢失它们本身就是证据（missingCount >= 1）
  //  - 如果这段没有任何标记（很常见：纯文字段落），就只能靠长度骤降来判断
  const originLen = Number(opts.sourceLength) > 0 ? Number(opts.sourceLength) : total;
  const textLen = newNodes.reduce((sum, n) => sum + textLengthOf(n), 0);
  const summaryCollapse =
    originLen >= 200 &&
    textLen < originLen * 0.4 &&
    (missingCount >= 1 || totalMarks === 0);

  // 轻微丢失：把掉队的元素接回去，保住脚注 / 链接 / 锚点
  const dedupedOrphans = [];
  const wrappedBack = [];
  if (autoRepair && !corrupted && !summaryCollapse) {
    const renderedEls = new Set();
    for (const n of renderedOk) {
      const el = byN.get(n)?.element;
      if (el) renderedEls.add(el);
    }

    /**
     * 找这个没渲染出来的元素身上，有没有「还活在成品里」的后代。
     *
     * **不能靠 token 树找** —— 缺了外层标记时，外层根本不在 token 里，
     * 也就没有对应的 item，它的子树是断的。
     * 得直接看**原 DOM 的嵌套关系**：内层元素本来就是外层元素的子节点。
     */
    const findRenderedInner = (el) => {
      for (const node of el.descendants ? el.descendants() : []) {
        if (renderedEls.has(node)) return node;
      }
      return null;
    };

    /** 在成品节点树里就地替换（元素可能还没挂到 DOM 上，parentNode 是空的）。 */
    const replaceIn = (list, target, replacement) => {
      const idx = list.indexOf(target);
      if (idx >= 0) {
        list[idx] = replacement;
        return true;
      }
      for (const n of list) {
        if (n.kind === NODE.ELEMENT && n.children?.length && replaceIn(n.children, target, replacement)) {
          return true;
        }
      }
      return false;
    };

    /**
     * 补回之前先试着**套回原位**。
     *
     * 真实事故（第 16 章全书 43 处）：脚注标记是两层嵌套
     * `<a id="jzyy_1_181" href="…"><sup>(79)</sup></a>`。
     * 模型只丢掉外层 `<a>` 的占位符、内层 `<sup>` 留在原地。
     *
     * 第一版直接把外层补到块尾 —— 读者看到 `…债券投资的选择。(79)(79)`。
     * 第二版改成「内容已在正文里就不补」—— 不重复了，但 `<a>` 上的
     * **id 和 href 一起没了**，尾注跳不回正文（实测丢了 8 个锚点）。
     *
     * 正确做法是两者都要：把外层元素**套回到还在原地的内层元素身上**。
     * 这样编号只出现一次，锚点和链接也一个不少。
     */
    for (const mark of missing) {
      const innerEl = findRenderedInner(mark.element);
      /**
       * 只在**成品节点树**里就地替换，不用 `innerEl.parentNode`。
       *
       * 那个 parentNode 往往还指着**源 DOM** 里的老父亲 —— 也就是
       * 正要套回去的这个元素本身。照它 insertBefore 等于把元素插进自己，
       * 直接死循环（实测挂住了）。
       */
      if (innerEl && replaceIn(newNodes, innerEl, mark.element)) {
        mark.element.children = [innerEl];
        innerEl.parentNode = mark.element;
        wrappedBack.push(mark);
        continue;
      }

      /** 内层也没了 —— 只能补回块尾（这时候正文里确实没有这个编号） */
      const el = mark.element;
      const label = (el.textContent || '').replace(/\s+/g, '').trim();
      if (label && collectNodeText(newNodes).replace(/\s+/g, '').includes(label)) {
        dedupedOrphans.push(mark);
        continue;
      }
      el.detach();
      if (!mark.selfClosing) {
        const inner = [];
        for (const child of [...el.children]) {
          child.detach();
          inner.push(child);
        }
        el.children = inner;
      }
      orphanNodes.push(el);
    }
  }
  if (orphanNodes.length) newNodes.push(...orphanNodes);

  const finalNodes = newNodes.filter((n) => !(n.kind === NODE.TEXT && n.value === ''));

  return {
    nodes: finalNodes,
    used,
    missing,
    duplicated,
    unbalanced,
    unknown,
    corrupted: corrupted || summaryCollapse,
    presentCount,
    totalMarks,
    /** 因为「内容已经在正文里」而没补回块尾的标记（否则会印出两个编号） */
    dedupedOrphans,
    /** 套回原位的标记（外层丢了、内层还在 —— 这样链接和锚点都保得住） */
    wrappedBack,
    /** 脚注就地化的结果：原地保留了几条、只删掉标记的有几条 */
    notesKeptInPlace: noteStripped.keptInPlace,
    notesDropped: noteStripped.droppedMarkers,
  };
}

/** 把一个节点列表的文字拼起来（用于「这段内容是不是已经在了」的判断）。 */
function collectNodeText(nodes) {
  let out = '';
  for (const n of nodes || []) {
    if (n.kind === NODE.TEXT) out += n.value || '';
    else if (n.kind === NODE.ELEMENT) out += collectNodeText(n.children);
  }
  return out;
}

function textLengthOf(node) {
  if (node.kind === NODE.TEXT) return node.value.length;
  if (node.kind === NODE.ELEMENT) {
    return node.children.reduce((sum, child) => sum + textLengthOf(child), 0);
  }
  return 0;
}

function makeText(value) {
  const t = new XmlText(String(value));
  t.start = 0;
  t.end = 0;
  return t;
}

/**
 * 挂到父节点上，并清掉源区间。
 *
 * 清源区间是必须的：行内元素是从原树里摘下来重挂的，
 * 如果保留原来的 [start,end]，序列化时会直接吐出**旧的**源片段，
 * 里面嵌套的文本修改就全部丢失了（表现为「改写结果被还原成原文」）。
 * 清掉之后，元素会按当前 DOM 状态重新序列化。
 */
function attach(node, parent) {
  node.detach();
  node.parentNode = parent;
  node.start = 0;
  node.end = 0;
  node.source = '';
  node.dirty = true;
  parent.children.push(node);
}

/* ----------------------------------------------------------- 写回操作 -- */

/**
 * 把重建结果写回 DOM。返回内容是否真的发生了变化。
 * @param {Block} block
 * @param {RebuildResult} result
 * @returns {{changed: boolean}}
 */
export function applyRebuild(block, result) {
  const el = block.element;
  // 关键：在改结构之前先把文档标记为已修改。
  // 后续 rebuild 会把行内节点摘下来重挂，脱离树后再 markDirty 就到不了文档了。
  el.touch();
  el.children = [];
  el.rebuilt = true;
  for (const node of result.nodes) attach(node, el);
  el.touch();
  return { changed: true };
}

/* --------------------------------------------------------- 结构自检 -- */

/**
 * 写回后的结构自检。
 * @param {import('./xml-dom.js').XmlDocument} doc
 * @param {{parseXml: Function}} deps 传入 parseXml 以便重新解析校验
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateDocument(doc, deps) {
  const errors = [];
  const warnings = [];
  const root = doc.documentElement;
  if (!root) return { ok: false, errors: ['文档没有根元素'], warnings };

  if (localName(root.name) !== 'html') {
    // 不是 XHTML 正文（例如 nav / ncx），跳过结构检查
    return { ok: true, errors, warnings };
  }

  // 1) 重新解析，确认仍是合法 XML（这是「EPUB 不容易损坏」的硬保证）
  const serialized = doc.serialize();
  try {
    deps.parseXml(serialized);
  } catch (err) {
    errors.push(`序列化结果无法被重新解析为合法 XML：${err.message}`);
  }

  // 2) body 必须存在且非空
  const body = root.descendants().find((el) => localName(el.name) === 'body');
  if (!body) {
    errors.push('缺少 <body> 元素');
  } else if (!body.textContent.trim() && body.descendants().length === 0) {
    errors.push('<body> 为空');
  }

  // 3) 只检查「对话式块级嵌套」——也就是模型最可能搞出来的非法结构。
  //    注意 <blockquote><p>…</p></blockquote>、<li><p>…</p></li> 是合法 HTML，
  //    不能误报，否则每次改写都会刷一堆没用的告警。
  const NESTING_RULES = {
    p: ['p', 'div', 'section', 'blockquote', 'ul', 'ol', 'table', 'pre'],
    h1: ['p', 'div', 'section', 'h1', 'h2', 'h3'],
    h2: ['p', 'div', 'section', 'h2', 'h3'],
    h3: ['p', 'div', 'section', 'h3'],
    h4: ['p', 'div', 'section', 'h4'],
    h5: ['p', 'div', 'section', 'h5'],
    h6: ['p', 'div', 'section', 'h6'],
    caption: ['p', 'div', 'section'],
    figcaption: ['p', 'div', 'section'],
  };
  for (const el of root.descendants()) {
    const name = localName(el.name);
    const forbidden = NESTING_RULES[name];
    if (!forbidden) continue;
    const bad = el.childElements.find((c) => forbidden.includes(localName(c.name)));
    if (bad) {
      warnings.push(`<${name}> 内部出现了非法块级子元素 <${localName(bad.name)}>`);
    }
  }

  // 4) 空块检查
  const empties = root
    .descendants()
    .filter((el) => localName(el.name) === 'p' && el.textContent.trim() === '' && el.descendants().length === 0);
  if (empties.length) warnings.push(`存在 ${empties.length} 个空 <p>`);

  return { ok: errors.length === 0, errors, warnings };
}
