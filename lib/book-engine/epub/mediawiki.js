/**
 * MediaWiki / Wikisource 导出的 EPUB 有两个「内容会悄悄丢」的问题。
 *
 * 这两件事都不是这本《朝花夕拾》独有的 —— 维基文库导出的任何一本书都长这样，
 * 所以放在读取层统一处理，而不是在某一章的提示词里打补丁。
 *
 * ## 一、语言变体（`<span typeof="mw:LanguageVariant"/>`）
 *
 * 维基百科/文库的「繁简转换」在 Parsoid 输出里是一个**空标签**：
 *
 *     <span typeof="mw:LanguageVariant"
 *           data-mw-variant='{"twoway":[{"l":"zh-hans","t":"麻胡子"},
 *                                      {"l":"zh-hant","t":"麻胡子"}]}'/>
 *
 * 真正的字写在 `data-mw-variant` 属性里，由阅读器按语言选择显示。
 * 我们的解析器只认文本节点，于是这些字**在正文里凭空消失** ——
 * 实测《朝花夕拾》每章丢 2~6 个字，最难看的一处是：
 *
 *     正确地写起来，须是「____」。——「麻胡子」三个字没了
 *
 * 这种残缺会一路传下去：模型照着残缺句子改写，读起来就是「书印坏了」。
 * 所以在解析之前先把变体文字**摊平成正文**。
 *
 * 选哪个变体：优先按文档语言；文档只写 `zh`（维基文库默认）时，
 * 优先用 `zh` 条目、其次 `zh-hant` —— 因为标了 `zh` 的条目本身就是原文那一路的写法
 * （繁体原文里塞一句简体反而更怪）。繁体/简体都在改写阶段统一处理。
 *
 * ## 二、阅读器外壳（headerContainer / 姊妹计划 / 许可模板）
 *
 * 维基文库每一章的开头都有一张导航表（上一章 / 书名 / 作者 / 下一章），
 * 后面跟着「姊妹计划：百科·数据项」和页脚那段许可声明。这些在网页上是有用的，
 * 在电子书里全是重复的壳：
 *
 *   · 章节标题在壳里，正文里根本没有标题 —— 读完一章不知道自己在读哪篇；
 *   · 「姊妹计划: 数据项」被当成正文段落交给模型改写；
 *   · 页脚的机器可读字段拼成一行 `Public domainPublic domainfalsefalse`；
 *   · 每章末尾两百字版权法条，占篇幅、挤走正文。
 *
 * 这里只做**确定性的结构性清理**（按 class / id 认，不猜内容），
 * 清理的是「网页导航与许可模板」，不是正文。
 */

import { parseXml, NODE } from './xml-dom.js';

/* ------------------------------------------------ 语言变体摊平 -- */

const VARIANT_SPAN_RE = /<span\b([^>]*\btypeof\s*=\s*"mw:LanguageVariant"[^>]*)\/>/g;
const VARIANT_SPAN_PAIR_RE =
  /<span\b([^>]*\btypeof\s*=\s*"mw:LanguageVariant"[^>]*)>\s*<\/span>/g;

/**
 * 把 `mw:LanguageVariant` 空标签换成它应该显示的那几个字。
 *
 * @param {string} xhtml
 * @param {string} [lang] 文档语言（`zh`、`zh-Hant`、`zh-Hans` …）
 * @returns {{xhtml: string, expanded: number}}
 */
export function expandLanguageVariants(xhtml, lang = 'zh') {
  let expanded = 0;
  const replace = (all, attrs) => {
    const variant = parseVariantAttr(attrs);
    if (!variant) return all;
    const text = pickVariantText(variant, lang);
    if (!text) return all;
    expanded += 1;
    return escapeXmlText(text);
  };
  const out = String(xhtml ?? '')
    .replace(VARIANT_SPAN_RE, replace)
    .replace(VARIANT_SPAN_PAIR_RE, replace);
  return { xhtml: out, expanded };
}

/** 从 `<span ...>` 的属性串里取出并解析 `data-mw-variant`。 */
export function parseVariantAttr(attrs) {
  const m = /\bdata-mw-variant\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs || '');
  if (!m) return null;
  const raw = decodeEntities(m[1] ?? m[2] ?? '');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 从变体定义里挑出要显示的文字。
 *
 * 支持的结构：
 *   `{"disabled":{"t":"著"}}`                      —— 不转换，固定写法
 *   `{"twoway":[{"l":"zh-hans","t":"…"}, …]}`      —— 繁简两条
 *   `{"oneway":[{"l":"zh-cn","t":"…"}]}`           —— 单向
 */
export function pickVariantText(variant, lang = 'zh') {
  if (!variant || typeof variant !== 'object') return '';
  if (variant.disabled) return String(variant.disabled.t || '');
  const list = Array.isArray(variant.twoway)
    ? variant.twoway
    : Array.isArray(variant.oneway)
      ? variant.oneway
      : [];
  if (!list.length) return '';
  const want = String(lang || 'zh').toLowerCase();
  const order = want.includes('hant') || want.includes('-tw') || want.includes('-hk')
    ? ['zh-hant', 'zh-tw', 'zh-hk', 'zh']
    : want.includes('hans') || want.includes('-cn') || want.includes('-sg')
      ? ['zh-hans', 'zh-cn', 'zh-sg', 'zh']
      : // 文档只写了 zh：先认 zh（原文写法），再按繁体兜底
        ['zh', 'zh-hant'];
  for (const code of order) {
    const hit = list.find((entry) => String(entry?.l || '').toLowerCase() === code);
    if (hit && hit.t) return String(hit.t);
  }
  const first = list.find((entry) => entry?.t);
  return first ? String(first.t) : '';
}

/* ------------------------------------------------ 阅读器外壳清理 -- */

/** 整个删掉的容器：网页导航 / 姊妹计划 / 许可模板。 */
const CHROME_IDS = [/^headerContainer\b/i, /^plainSister\b/i, /^siteSub\b/i];
const CHROME_CLASSES = [/^licenseContainer$/i, /^licensetpl\b/i, /^mw-empty-elt$/i, /^ws-header$/i];

/**
 * `<body>` 里的 `<style>` / `<script>`。
 *
 * MediaWiki 把许可横幅的 CSS 直接写进正文（几千字的
 * `div:first-of-type{display:table…}`），样式块本身是给那张横幅用的 ——
 * 横幅已经删了，这段 CSS 留在正文里只会有两个后果：
 * 每章的字数虚高一大截（规划据此判断篇幅），而且各章内容看起来
 * 高度重复（同一段 CSS 人人都有）。它一个字都不能被当成正文。
 */
const CHROME_TAGS = new Set(['style', 'script']);

/** 空的就该删的块：这两类位置本来要显示一行字。 */
const EMPTY_BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** 有这些子元素就不算空（图片、分节符）。 */
const ALWAYS_VISIBLE_TAGS = new Set(['img', 'svg', 'hr', 'math', 'video', 'audio']);

/**
 * 维基文库的导出水印：封面页上的 `<h6>以2026年11月17日从维基文库导出</h6>`。
 *
 * 它记录的是「这份文件哪天下的」，和书本身没关系；留在成品里，
 * 读者在扉页看到一句生成日期，很像盗版扫描件上的水印。
 */
const EXPORT_STAMP_RES = [
  /从维基文库(?:导|匯|汇)出/,
  /匯出\s*自\s*维基文库/,
  /exported\s+from\s+wikisource/i,
];

/**
 * 删掉网页外壳。返回删除了什么，方便调用方记录（也方便测试断言）。
 *
 * @param {import('./xml-dom.js').XmlDocument} doc
 * @returns {{removed: {nav: number, sister: number, license: number, emptyParagraphs: number},
 *            title: string}}
 */
export function stripReaderChrome(doc) {
  const removed = { nav: 0, sister: 0, license: 0, styles: 0, emptyBlocks: 0, stamps: 0 };
  let title = '';
  let author = '';

  const all = doc.documentElement?.descendants ? doc.documentElement.descendants() : [];
  const targets = [];
  for (const el of all) {
    if (el.kind !== NODE.ELEMENT) continue;
    const id = el.getAttribute('id') || '';
    const classes = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (CHROME_TAGS.has(String(el.name).toLowerCase()) && insideBody(el)) {
      removed.styles += 1;
      targets.push(el);
      continue;
    }
    if (CHROME_IDS.some((re) => re.test(id))) {
      if (/^headerContainer\b/i.test(id)) removed.nav += 1;
      else removed.sister += 1;
      if (/^headerContainer\b/i.test(id) && !title) title = headerTitle(el);
      if (/^headerContainer\b/i.test(id) && !author) author = headerAuthor(el);
      targets.push(el);
      continue;
    }
    if (classes.some((c) => CHROME_CLASSES.some((re) => re.test(c)))) {
      if (classes.some((c) => /^ws-header$/i.test(c))) {
        // 另一种写法的章首导航表（`<table class="ws-header">`）：上一章 / 作者 / 下一章
        removed.nav += 1;
        if (!title) title = headerTitle(el);
        if (!author) author = headerAuthor(el);
      } else if (classes.some((c) => /^licenseContainer$/i.test(c) || /^licensetpl\b/i.test(c))) {
        removed.license += 1;
      }
      targets.push(el);
      continue;
    }
    /**
     * 导出水印：文字很短、而且是**叶子**节点（`<h6>以…从维基文库导出</h6>`）。
     *
     * 必须是叶子：`<body>` / `<html>` 的 textContent 也「包含」这句话，
     * 不判叶子就会把整页删掉 —— 实测封面页因此变成空白页。
     */
    const text = el.textContent.trim();
    if (
      text &&
      text.length <= 80 &&
      el.childElements.length === 0 &&
      EXPORT_STAMP_RES.some((re) => re.test(text))
    ) {
      removed.stamps += 1;
      targets.push(el);
    }
  }
  /**
   * 光 `detach()` 不够。
   *
   * 这套 DOM 是字节保真的：父节点没被标脏时，序列化直接吐原文，
   * 删掉的节点会原样回来；父节点标脏但不标 rebuilt 时，被删节点又会
   * 作为「两个子节点之间的缝隙」被回填。两条路都试过，只有
   * `rebuilt + touch()` 才是真的删掉（`digest.js` 里同一个坑）。
   */
  for (const el of targets) {
    const parent = el.parentNode;
    el.detach();
    if (parent?.rebuilt !== undefined) {
      parent.rebuilt = true;
      parent.touch?.();
    }
  }

  /**
   * 只剩空白/全角空格的空段落、空标题。
   *
   * 维基文库用 `<p>　　</p>` 做首行缩进占位；封面页还会留下
   * `<h3></h3><h5></h5>` 这种空壳标题。它们会被当成「正文段落」
   * 交给模型 —— 白花 token 换一句空话，空标题还会在成品里
   * 留下一个空荡荡的目录项。
   *
   * 只清 `p` 和 `h1~h6`：这两类是「读者本来要看到一行字」的位置，
   * 空的就一定是壳；`div`/`span` 可能承载锚点，不动。
   */
  for (const el of doc.documentElement?.descendants ? doc.documentElement.descendants() : []) {
    if (el.kind !== NODE.ELEMENT) continue;
    const name = String(el.name).toLowerCase();
    if (!EMPTY_BLOCK_TAGS.has(name)) continue;
    if (el.childElements.some((c) => ALWAYS_VISIBLE_TAGS.has(String(c.name).toLowerCase()))) continue;
    if (el.textContent.trim() !== '') continue;
    if (el.getAttribute('id') || el.getAttribute('name')) continue; // 可能是锚点
    removeNode(el);
    removed.emptyBlocks += 1;
  }

  return { removed, title, author };
}

/** 把节点从 DOM 里真的删掉（含字节保真序列化的两个坑，见上面）。 */
function removeNode(el) {
  const parent = el.parentNode;
  if (!parent) return;
  el.detach();
  if (parent.rebuilt !== undefined) {
    parent.rebuilt = true;
    parent.touch?.();
  }
}

/**
 * 元素在不在 `<body>` 里。
 *
 * `<head>` 里的 `<style>` 是这本书的正经排版样式，删了会掉字体和间距；
 * 只有写进正文的那段「许可横幅 CSS」才是垃圾。
 */
function insideBody(el) {
  let cur = el.parentNode;
  while (cur) {
    if (cur.kind === NODE.ELEMENT && String(cur.name).toLowerCase() === 'body') return true;
    cur = cur.parentNode;
  }
  return false;
}

/** 导航表中间那格 `<b>标题</b>` 就是本章标题。 */
function headerTitle(el) {
  const stack = [el];
  while (stack.length) {
    const node = stack.shift();
    for (const child of node.childElements || []) {
      const name = String(child.name || '').toLowerCase();
      if (name === 'b') {
        const text = child.textContent.replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      stack.push(child);
    }
  }
  return '';
}

/**
 * 章首导航表里「作者：鲁迅」那一格。
 *
 * 维基文库导出的 EPUB 大多**没有** dc:creator，元数据里的作者是空的；
 * 而每章导航表都写着作者。取出来补进元数据，读者看到的是正经的作者名，
 * 后面做补讲时也能认出「鲁迅怎样怎样」这种第三人称旁白。
 */
function headerAuthor(el) {
  const stack = [el];
  while (stack.length) {
    const node = stack.shift();
    for (const child of node.childElements || []) {
      const text = String(child.textContent || '').replace(/\s+/g, '');
      /**
       * 两种写法都很常见：
       *   `<span>作者：魯迅</span>`            —— 图和名在一格里
       *   `<span>作者：</span><a>魯迅</a>`     —— 标签和名字分成两个元素
       * 后者单独看这一格只有「作者：」，名字要从同一个单元格的整段文字里往后取。
       */
      const inline = text.match(/^作者[:：](.+)$/);
      if (inline) {
        const name = cleanAuthorName(inline[1]);
        if (name) return name;
      }
      if (/^作者[:：]$/.test(text) && child.parentNode) {
        const cell = String(child.parentNode.textContent || '').replace(/\s+/g, '');
        const at = cell.lastIndexOf('作者：') >= 0 ? cell.lastIndexOf('作者：') : cell.lastIndexOf('作者:');
        if (at >= 0) {
          const name = cleanAuthorName(cell.slice(at + 3));
          if (name) return name;
        }
      }
      stack.push(child);
    }
  }
  return '';
}

/**
 * 作者名后面常跟一排东西：「魯迅1928年9月」「魯迅　著」「魯迅（1881—1936）」。
 * 只留名字：去掉生卒年括号、日期、以及「著/編/譯」这类署名后缀。
 */
function cleanAuthorName(raw) {
  const name = String(raw || '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[0-9０-９].*$/, '')
    .replace(/[著编編譯译撰等述辑輯]+$/g, '')
    .replace(/[←→↑↓|｜·・]+$/g, '')
    .trim();
  return [...name].length >= 1 && [...name].length <= 24 ? name : '';
}

/* ------------------------------------------------------ 组合入口 -- */

/**
 * 读一章正文前的统一清洗：摊平语言变体 + 去掉网页外壳。
 *
 * 返回的是**字符串**，方便直接塞进现有的 `parseXml` 流程；
 * 只有真的改动了才重新序列化，没改动就原样返回（保证字节不变）。
 *
 * @param {string} xhtml
 * @param {{lang?: string}} [opts]
 * @returns {{xhtml: string, expandedVariants: number, removed: object, title: string, author: string}}
 */
export function cleanChapterXhtml(xhtml, opts = {}) {
  const { xhtml: expanded, expanded: expandedVariants } = expandLanguageVariants(xhtml, opts.lang || 'zh');
  if (!/<body\b/i.test(expanded)) {
    return { xhtml: expanded, expandedVariants, removed: null, title: '', author: '' };
  }
  const doc = parseXml(expanded);
  const { removed, title, author } = stripReaderChrome(doc);
  const changed = expandedVariants > 0 || Object.values(removed).some((n) => n > 0);
  return {
    xhtml: changed ? doc.serialize() : expanded,
    expandedVariants,
    removed,
    title,
    author,
  };
}

/* ------------------------------------------------------- 工具函数 -- */

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeXmlText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
