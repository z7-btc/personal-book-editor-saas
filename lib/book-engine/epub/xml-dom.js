/**
 * 零依赖的 XML/XHTML 解析器 + 序列化器。
 *
 * 设计目标（这是整个项目最重要的工程约束）：
 *
 *  1. **未改动的子树必须字节级回写原文**。
 *     每个节点都记录了自己在源文本里的 [start, end) 区间（raw slice）。
 *     只要节点没被标记 dirty，序列化时就原样吐出源片段，
 *     不重新拼接、不重新转义、不改变空白与实体写法。
 *     => 「编辑正文，而不是重新生成整个 EPUB」在 DOM 层就有了保证。
 *
 *  2. **被改动的节点按规范化方式重建**，但仍严格继承原标签名、原属性、
 *     原命名空间前缀，不发明新结构。
 *
 *  3. 支持 DOCTYPE / CDATA / 注释 / 处理指令 / 实体引用 / 自闭合标签，
 *     这些结构全部当作「不可交给 LLM 的东西」保真携带。
 *
 * 为什么不用第三方 HTML 解析器：HTML 解析器会把 XHTML 当 HTML 纠错
 * （补 tbody、丢自闭合、改属性大小写），那会直接破坏 EPUB。
 */

import { EpubError } from '../util/errors.js';

/* ------------------------------------------------------------ 节点类型 -- */

export const NODE = {
  DOCUMENT: 1,
  ELEMENT: 2,
  TEXT: 3,
  COMMENT: 4,
  CDATA: 5,
  PI: 6, // <?xml-stylesheet ... ?>
  DOCTYPE: 7,
};

/** XML 预定义实体 + XHTML 常用的几个（解析时解码，避免结构被误判）。 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  shy: '\u00ad',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  times: '\u00d7',
  divide: '\u00f7',
  middot: '\u00b7',
  laquo: '\u00ab',
  raquo: '\u00bb',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  plusmn: '\u00b1',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  sup2: '\u00b2',
  sup3: '\u00b3',
  bull: '\u2022',
  dagger: '\u2020',
  prime: '\u2032',
  Prime: '\u2033',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  larr: '\u2190',
  rarr: '\u2192',
  harr: '\u2194',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  minus: '\u2212',
  infin: '\u221e',
  alpha: '\u03b1',
  beta: '\u03b2',
  gamma: '\u03b3',
  delta: '\u03b4',
  pi: '\u03c0',
  sigma: '\u03c3',
  omega: '\u03c9',
  Omega: '\u03a9',
  eacute: '\u00e9',
  egrave: '\u00e8',
  agrave: '\u00e0',
  ccedil: '\u00e7',
  uuml: '\u00fc',
  ouml: '\u00f6',
  auml: '\u00e4',
  szlig: '\u00df',
};

/* ----------------------------------------------------------------- Node -- */

export class XmlNode {
  constructor(kind) {
    this.kind = kind;
    /** @type {XmlElement|null} */
    this.parentNode = null;
    this.start = 0;
    this.end = 0;
    this.source = '';
    this.dirty = false;
  }

  get isElement() {
    return this.kind === NODE.ELEMENT;
  }

  /** 未改动时原文精确片段。 */
  raw() {
    return this.source.slice(this.start, this.end);
  }

  /**
   * 序列化。基类实现服务于文本 / 注释 / CDATA / PI。
   *
   * 判定顺序：
   *  1. 有源区间，且该片段解码后与当前内容一致 => 输出原文片段
   *     （字节保真：`&nbsp;` 不会被改写成 `&#160;`，实体写法完全保留）
   *  2. 否则                                  => 按类型规范化输出
   *
   * 第 1 步刻意用「内容等价」而不是「dirty 标志」判断，
   * 这样即使有人直接写 node.value = 'x'（忘了 markDirty），也不会静默丢失修改。
   * XmlElement 会覆盖这个方法。
   * @param {string} source
   */
  serialize(source) {
    const src = this.source || source;
    if (src && this.end > this.start) {
      const slice = String(src).slice(this.start, this.end);
      const current = rawFormOf(this);
      if (slice === current) return slice;
      // 只在「解码后等价」时才回退到原文，避免遗漏真实修改
      if (this.kind === NODE.TEXT && !this.dirty && slice !== current) {
        if (decodeEntities(slice) === this.value) return slice;
      }
    }
    return serializeNewNode(this, this.source || source);
  }

  remove() {
    this.detach();
    return this;
  }

  /** 从父节点摘下自己（不发出删除事件，由调用方决定是否标记 dirty）。 */
  detach() {
    if (!this.parentNode) return this;
    const siblings = this.parentNode.children;
    const idx = siblings.indexOf(this);
    // 只在父节点确实还持有自己时才 splice。
    // 否则（父节点已经换过 children 数组）会误删父节点的新子节点。
    if (idx >= 0) siblings.splice(idx, 1);
    this.parentNode = null;
    return this;
  }

  /**
   * 标记自身及所有祖先为 dirty（内容变化）。
   * 文档对象会被打上 modified，从而让 serialize() 走「重建」而不是「返回原文」。
   */
  markDirty() {
    this.dirty = true;
    let p = this.parentNode;
    while (p) {
      p.dirty = true;
      if (p.modified !== undefined) p.modified = true;
      p = p.parentNode;
    }
    return this;
  }
}

/** 把文档对象标记为已修改（用于脱离树的节点变更）。 */
export function markDocumentModified(node) {
  let p = node;
  while (p) {
    if (p.modified !== undefined) {
      p.modified = true;
      return p;
    }
    p = p.parentNode;
  }
  return null;
}

export class XmlText extends XmlNode {
  constructor(value) {
    super(NODE.TEXT);
    this.value = value;
    /** 是否为实体引用（解析时记录，未改动时按原文回写）。 */
    this.entity = null;
    this.cdata = false;
    /** 解析期把一个文本区段切成的多个片段（实体边界）。 */
    this._parts = null;
  }

  /** 修改文本内容：清空源区间，保证序列化时输出新值而不是原文。 */
  setValue(value) {
    this.value = String(value);
    this.entity = null;
    this.source = '';
    this.start = 0;
    this.end = 0;
    // `touch()` 只定义在 XmlElement 上（它还要处理「脱离树」的情况）；
    // 文本节点挂在父节点里，用基类的 markDirty 就能把改动传到文档。
    this.markDirty();
    return this;
  }

  get sourceSpan() {
    return this.source.slice(this.start, this.end);
  }
}

export class XmlComment extends XmlNode {
  constructor(data) {
    super(NODE.COMMENT);
    this.data = data;
  }
}

export class XmlCdata extends XmlNode {
  constructor(data) {
    super(NODE.CDATA);
    this.data = data;
  }
}

export class XmlPi extends XmlNode {
  constructor(target, data) {
    super(NODE.PI);
    this.target = target;
    this.data = data;
  }
}

export class XmlDoctype extends XmlNode {
  constructor(raw) {
    super(NODE.DOCTYPE);
    this.rawText = raw;
  }
}

export class XmlAttribute {
  /**
   * @param {string} name 原始写法（可能含命名空间前缀，如 epub:type）
   * @param {string} value 已解码的值
   * @param {string} quote 原始引号字符
   * @param {number} start
   * @param {number} end
   */
  constructor(name, value, quote = '"', start = 0, end = 0) {
    this.name = name;
    this.value = value;
    this.quote = quote;
    this.start = start;
    this.end = end;
  }
}

export class XmlElement extends XmlNode {
  constructor(name) {
    super(NODE.ELEMENT);
    this.name = name;
    /** @type {XmlNode[]} */
    this.children = [];
    /** @type {XmlAttribute[]} */
    this.attributes = [];
    this.selfClosing = false;
    this.startTagEnd = 0;
    this.endTagStart = 0;
    /** 属性是否被改动（改动后 start tag 需要重建）。 */
    this.attrsDirty = false;
    /** 内容是否被整体替换过（替换后关闭"缝隙回填"，避免原文被重复输出）。 */
    this.rebuilt = false;
  }

  /**
   * 无论节点当前是否挂在树上，都能保证「文档被标记为已修改」。
   * 走到根后如果是 XmlDocument（带 modified 字段），直接打标；
   * 否则退化为沿祖先链 markDirty。
   */
  touch() {
    this.dirty = true;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 沿祖先链逐级打标，必须从 this 起步
    let p = this;
    while (p) {
      p.dirty = true;
      if (p.modified !== undefined) {
        p.modified = true;
        return this;
      }
      p = p.parentNode;
    }
    return this;
  }

  /* ------------------------------------------------------------ 属性 -- */

  /** @param {string} name */
  getAttribute(name) {
    const attr = this.attributes.find((a) => a.name === name);
    return attr ? attr.value : null;
  }

  hasAttribute(name) {
    return this.attributes.some((a) => a.name === name);
  }

  /** 大小写无关 + 忽略命名空间前缀的属性查找（找 class / id 用）。 */
  getAttributeLoose(name) {
    const lower = name.toLowerCase();
    for (const a of this.attributes) {
      const local = a.name.includes(':') ? a.name.slice(a.name.indexOf(':') + 1) : a.name;
      if (local.toLowerCase() === lower) return a.value;
      if (a.name.toLowerCase() === lower) return a.value;
    }
    return null;
  }

  setAttribute(name, value) {
    const attr = this.attributes.find((a) => a.name === name);
    if (attr) {
      if (attr.value === value) return this;
      attr.value = String(value);
    } else {
      this.attributes.push(new XmlAttribute(name, String(value), '"'));
    }
    this.attrsDirty = true;
    this.markDirty();
    return this;
  }

  removeAttribute(name) {
    const idx = this.attributes.findIndex((a) => a.name === name);
    if (idx >= 0) {
      this.attributes.splice(idx, 1);
      this.attrsDirty = true;
      this.markDirty();
    }
    return this;
  }

  /* ------------------------------------------------------------ 子节点 -- */

  /** @param {XmlNode} node */
  appendChild(node) {
    node.detach();
    node.parentNode = this;
    // 新节点没有源区间，插到元素内容末尾
    node.start = this.endTagStart;
    node.end = this.endTagStart;
    this.children.push(node);
    node.markDirty();
    return node;
  }

  /** @param {XmlNode} node @param {XmlNode} ref */
  insertBefore(node, ref) {
    const idx = this.children.indexOf(ref);
    if (idx < 0) return this.appendChild(node);
    node.detach();
    node.parentNode = this;
    node.start = ref.start;
    node.end = ref.start;
    this.children.splice(idx, 0, node);
    node.markDirty();
    return node;
  }

  /**
   * 用若干节点替换某个子节点。
   *
   * 源区间处理很关键：最后一个新节点的 end 必须延伸到被替换节点的 end，
   * 否则子节点序列化时会把「被替换节点之后的那段原文」当成新的缝隙重新输出，
   * 造成内容重复或丢失边界空白。
   */
  replaceChild(newNodes, oldNode) {
    const list = Array.isArray(newNodes) ? newNodes : [newNodes];
    const idx = this.children.indexOf(oldNode);
    if (idx < 0) throw new Error('replaceChild: 目标不是子节点');

    // 被替换的是文本节点时，把它的首尾空白捐给新节点。
    // 否则「段 1 <em>x</em>」这类结构在替换后会粘在一起（段 1<em>x</em>）。
    if (list.length && oldNode.kind === NODE.TEXT && typeof oldNode.value === 'string') {
      const lead = /^\s*/.exec(oldNode.value)[0];
      const trail = /\s*$/.exec(oldNode.value)[0];
      if (lead) {
        const first = list[0];
        if (first.kind === NODE.TEXT) first.value = lead + first.value;
        else list.unshift(new XmlText(lead));
      }
      if (trail) {
        const last = list[list.length - 1];
        if (last.kind === NODE.TEXT) last.value = `${last.value}${trail}`;
        else list.push(new XmlText(trail));
      }
    }

    list.forEach((node, i) => {
      node.detach();
      node.parentNode = this;
      node.start = oldNode.start;
      node.end = i === list.length - 1 ? oldNode.end : oldNode.start;
      node.markDirty();
    });
    this.children.splice(idx, 1, ...list);
    oldNode.parentNode = null;
    this.rebuilt = true;
    return this;
  }

  /** 把一批节点追加到末尾（一次 markDirty）。 */
  appendChildren(nodes) {
    for (const node of nodes) this.appendChild(node);
    return this;
  }

  /** 清空所有子节点（标记 dirty）。 */
  clearChildren() {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.markDirty();
    return this;
  }

  /** 用一个纯文本替换全部内容（会重建，失去内部标记）。 */
  setText(text) {
    this.clearChildren();
    this.appendChild(new XmlText(String(text)));
    return this;
  }

  /* ------------------------------------------------------------ 遍历 -- */

  get childElements() {
    return this.children.filter((c) => c.kind === NODE.ELEMENT);
  }

  get firstElementChild() {
    return this.children.find((c) => c.kind === NODE.ELEMENT) || null;
  }

  get lastElementChild() {
    const els = this.childElements;
    return els.length ? els[els.length - 1] : null;
  }

  /** 递归文本内容（含未改动子树的原文）。 */
  get textContent() {
    if (!this.dirty) return extractTextFromRaw(this.source.slice(this.startTagEnd, this.endTagStart));
    let out = '';
    for (const c of this.children) {
      if (c.kind === NODE.TEXT) out += c.value;
      else if (c.kind === NODE.CDATA) out += c.data;
      else if (c.kind === NODE.ELEMENT) out += c.textContent;
    }
    return out;
  }

  /** 深度优先遍历（含自身）。 */
  walk(visit) {
    visit(this);
    for (const c of this.children) if (c.kind === NODE.ELEMENT) c.walk(visit);
  }

  /** 所有后代元素（不含自身），文档序（先序）。 */
  descendants() {
    const out = [];
    const collect = (el) => {
      for (const child of el.children) {
        if (child.kind === NODE.ELEMENT) {
          out.push(child);
          collect(child);
        }
      }
    };
    collect(this);
    return out;
  }

  /* --------------------------------------------------- 序列化（核心） -- */

  /**
   * 把节点序列化回 XHTML 文本。
   *
   * 未 dirty 的节点：直接输出源片段（字节保真）。
   * dirty 的节点：用「按子节点源区间推进」的算法重建，
   *   保证未改动的子节点依然走字节保真路径，
   *   只有真正新插入/修改的内容才被重新转义拼接。
   *
   * @param {string} source 原始源文本
   * @returns {string}
   */
  serialize(source) {
    if (!this.dirty) return source.slice(this.start, this.end);
    if (this.kind !== NODE.ELEMENT) return serializeNewNode(this, source);

    // 源信息一旦被丢弃（source === ''，说明节点是重建出来的），
    // 就必须完全按当前 DOM 状态重建，不能再从源文本里切片。
    const hasSource = Boolean(this.source) && this.end > this.start;
    const raw = hasSource ? this.source : '';

    const startTag =
      !hasSource || this.attrsDirty || this.startTagEnd <= this.start
        ? buildStartTag(this)
        : this.rawStartTag(raw);
    if (this.selfClosing && this.children.length === 0) return startTag;

    const inner = this.serializeChildren(raw);
    const endTag =
      hasSource && this.endTagStart > 0 ? raw.slice(this.endTagStart, this.end) : `</${this.name}>`;
    return startTag + inner + endTag;
  }

  rawStartTag(source) {
    if (this.startTagEnd > this.start) return source.slice(this.start, this.startTagEnd);
    return buildStartTag(this);
  }

  /**
   * 重建 innerHTML：按子节点在源文本中的区间推进游标。
   *  - 位于游标之后的、未改动的内容 => 原样输出源片段
   *  - 新插入的节点（没有有效源区间） => 规范化输出
   *
   * `rebuilt` 是关键开关：一旦这个元素的内容被整体替换过
   * （applyRebuild / replaceChild / clearChildren 之后），
   * 子节点的源区间就不再能代表"哪些源文本还没被输出"，
   * 这时必须关闭缝隙回填，否则会把原文再吐一遍，造成内容重复。
   */
  serializeChildren(source) {
    if (this.rebuilt) {
      return this.children.map((child) => serializeNewNode(child, source)).join('');
    }

    let out = '';
    let cursor = this.startTagEnd;
    const limit = this.endTagStart || this.end;

    for (const child of this.children) {
      if (child.start >= cursor) {
        // 输出两个节点之间的「缝隙」原文（空白、未纳入树的文本等）
        if (child.start > cursor) out += source.slice(cursor, Math.min(child.start, limit));
      }
      if (child.start >= limit) {
        // 新节点：规范化输出
        out += serializeNewNode(child, source);
        continue;
      }
      const childEnd = Math.max(child.end, child.start);
      out += child.serialize(source);
      cursor = Math.max(cursor, childEnd);
    }
    if (cursor < limit) out += source.slice(cursor, limit);
    return out;
  }
}

export class XmlDocument {
  constructor(source) {
    this.source = source;
    /** @type {XmlNode[]} */
    this.children = [];
    /** @type {XmlElement|null} */
    this.documentElement = null;
    /** 是否发生过任何修改（未修改 => serialize() 直接返回原文）。 */
    this.modified = false;
  }

  /**
   * 把节点挂到文档上。
   * 关键点：documentElement 的 parentNode 必须指向本对象，
   * 否则 markDirty() 沿祖先链上行时会断在根元素上，
   * 导致「改了内容但 serialize() 仍然返回原文」。
   */
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    if (node.kind === NODE.ELEMENT && !this.documentElement) this.documentElement = node;
    return node;
  }

  /** 文档序言（XML 声明 + DOCTYPE + 注释），按原文回写。 */
  serializeProlog() {
    let out = '';
    for (const c of this.children) {
      if (c.kind === NODE.ELEMENT) break;
      out += c.raw();
    }
    return out;
  }

  /**
   * 序列化整篇文档。
   * 没有任何修改时直接返回输入源字符串（字节级不变）。
   */
  serialize() {
    if (!this.modified) return this.source;
    const src = this.source;
    const root = this.documentElement;
    if (!root) return src;
    let out = '';
    for (const c of this.children) {
      if (c === root) break;
      out += c.raw();
    }
    out += root.serialize(src);
    // 根元素之后的内容（尾随注释 / 空白）按原文补回，避免重复输出
    out += src.slice(root.end);
    return out;
  }
}

/* --------------------------------------------------------- 序列化辅助 -- */

/** 节点在源文本里的「规范化写法」，用于判断源片段是否仍然代表当前内容。 */
function rawFormOf(node) {
  switch (node.kind) {
    case NODE.TEXT:
      return node.cdata ? `<![CDATA[${node.data ?? node.value}]]>` : escapeText(node.value);
    case NODE.CDATA:
      return `<![CDATA[${node.data}]]>`;
    case NODE.COMMENT:
      return `<!--${node.data}-->`;
    case NODE.PI:
      return `<?${node.target}${node.data ? ` ${node.data}` : ''}?>`;
    case NODE.DOCTYPE:
      return node.rawText;
    default:
      return null;
  }
}

function serializeNewNode(node, source) {
  switch (node.kind) {
    case NODE.ELEMENT:
      return node.serialize(source);
    case NODE.TEXT:
      return node.cdata ? `<![CDATA[${node.data ?? node.value}]]>` : escapeText(node.value);
    case NODE.CDATA:
      return `<![CDATA[${node.data}]]>`;
    case NODE.COMMENT:
      return `<!--${node.data}-->`;
    case NODE.PI:
      return `<?${node.target}${node.data ? ` ${node.data}` : ''}?>`;
    case NODE.DOCTYPE:
      return node.rawText;
    default:
      return '';
  }
}

function buildStartTag(el) {
  let out = `<${el.name}`;
  for (const attr of el.attributes) {
    out += ` ${attr.name}="${escapeAttr(attr.value)}"`;
  }
  out += el.selfClosing && el.children.length === 0 ? '/>' : '>';
  return out;
}

export function escapeText(text) {
  return String(text).replace(/[&<>\u00a0]/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    return '&#160;';
  });
}

/**
 * 属性值转义。
 * 有意做得「最小化」：不把 &nbsp; 写成 &#160;，也不给引号做多余转义，
 * 这样重建 start tag 时不会顺带改动属性值的写法。
 */
export function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

/** 从原文片段里提取纯文本（用于未改动子树的 textContent）。 */
function extractTextFromRaw(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const lt = raw.indexOf('<', i);
    if (lt < 0) {
      out += decodeEntities(raw.slice(i));
      break;
    }
    if (lt > i) out += decodeEntities(raw.slice(i, lt));
    // 跳过标签 / 注释 / CDATA
    if (raw.startsWith('<!--', lt)) {
      const end = raw.indexOf('-->', lt);
      i = end < 0 ? raw.length : end + 3;
      continue;
    }
    if (raw.startsWith('<![CDATA[', lt)) {
      const end = raw.indexOf(']]>', lt);
      out += end < 0 ? raw.slice(lt + 9) : raw.slice(lt + 9, end);
      i = end < 0 ? raw.length : end + 3;
      continue;
    }
    const gt = raw.indexOf('>', lt);
    if (gt < 0) {
      i = lt + 1;
      continue;
    }
    i = gt + 1;
  }
  return out;
}

/** 解码 XML 实体（命名实体 + 数字实体）。 */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/* --------------------------------------------------------------- 解析 -- */

/**
 * 解析 XML / XHTML 文本。
 * @param {string} source
 * @param {{lenient?: boolean}} [opts] lenient: 容忍未闭合标签（默认 false）
 * @returns {XmlDocument}
 */
export function parseXml(source, opts = {}) {
  const parser = new XmlParser(String(source), opts);
  return parser.parseDocument();
}

/**
 * 一份 XHTML 里**正文**有多少字（`<body>` 纯文本，去掉所有空白）。
 *
 * ## 为什么要专门有这个函数
 *
 * 「这一章多少字」这件事，代码里曾经有**三种量法**：
 *   · `src/epub/epub-reader.js:437` 取 `<body>` 的文本（原书 `textLength`）；
 *   · `src/pipeline/rewrite.js:822` 取改写后 `<body>` 的文本（`rewrittenChars`）；
 *   · `src/pipeline/jobs.js` 的提要分支却取了 `documentElement.textContent`，
 *     把 `<head><title>` 也算进去了。
 *
 * 后果：同一本书里，压缩章的「字数」比别的章多算了一个标题（实测 6 章共多 24 字），
 * 于是「分类相加」和「成品实际」对不上，整理结果报告看着像在胡说。
 * 现在统一走这一个函数 —— 想改口径就只改这里。
 *
 * @param {string} xhtml
 * @returns {number}
 */
export function bodyTextLength(xhtml) {
  const doc = parseXml(String(xhtml));
  const root = doc.documentElement;
  const body = root ? (root.descendants?.() || []).find((n) => n.name === 'body') : null;
  return ((body || root)?.textContent || '').replace(/\s+/g, '').length;
}

export class XmlParser {
  constructor(source, opts = {}) {
    this.src = source;
    this.pos = 0;
    this.len = source.length;
    this.lenient = Boolean(opts.lenient);
  }

  error(message) {
    const line = this.src.slice(0, this.pos).split('\n').length;
    throw new EpubError(`XML 解析失败（第 ${line} 字符 ${this.pos}）：${message}`, {
      code: 'XML_PARSE',
    });
  }

  parseDocument() {
    const doc = new XmlDocument(this.src);
    const stack = [];
    let root = null;

    while (this.pos < this.len) {
      if (this.src[this.pos] !== '<') {
        const start = this.pos;
        const next = this.src.indexOf('<', this.pos);
        this.pos = next < 0 ? this.len : next;
        const texts = this.makeText(start, this.pos);
        for (const text of texts) {
          if (stack.length) pushChild(stack[stack.length - 1], text);
          else doc.appendChild(text);
        }
        continue;
      }

      // 结束标签
      if (this.src.startsWith('</', this.pos)) {
        const closeStart = this.pos;
        const gt = this.src.indexOf('>', this.pos);
        if (gt < 0) this.error('未闭合的结束标签');
        const name = this.src.slice(this.pos + 2, gt).trim();
        let el = stack.pop();
        if (!el) this.error(`多余的结束标签 </${name}>`);
        if (el.name !== name) {
          if (!this.lenient) this.error(`标签不匹配：期望 </${el.name}>，实际 </${name}>`);
          // 宽容模式：找回匹配的祖先
          while (stack.length && el.name !== name) {
            const parent = stack[stack.length - 1];
            el.end = closeStart;
            el.endTagStart = closeStart;
            el = parent;
            stack.pop();
          }
        }
        el.endTagStart = closeStart;
        el.end = gt + 1;
        this.pos = gt + 1;
        continue;
      }

      // 注释
      if (this.src.startsWith('<!--', this.pos)) {
        const start = this.pos;
        const endIdx = this.src.indexOf('-->', this.pos + 4);
        if (endIdx < 0) this.error('未闭合的注释');
        const node = new XmlComment(this.src.slice(this.pos + 4, endIdx));
        node.start = start;
        node.end = endIdx + 3;
        node.source = this.src;
        this.pos = node.end;
        if (stack.length) pushChild(stack[stack.length - 1], node);
        else doc.appendChild(node);
        continue;
      }

      // CDATA
      if (this.src.startsWith('<![CDATA[', this.pos)) {
        const start = this.pos;
        const endIdx = this.src.indexOf(']]>', this.pos + 9);
        if (endIdx < 0) this.error('未闭合的 CDATA');
        const node = new XmlCdata(this.src.slice(this.pos + 9, endIdx));
        node.start = start;
        node.end = endIdx + 3;
        node.source = this.src;
        this.pos = node.end;
        if (stack.length) pushChild(stack[stack.length - 1], node);
        else doc.appendChild(node);
        continue;
      }

      // DOCTYPE
      if (/^<!DOCTYPE/i.test(this.src.slice(this.pos, this.pos + 10))) {
        const start = this.pos;
        const end = this.scanDoctype();
        const node = new XmlDoctype(this.src.slice(start, end));
        node.start = start;
        node.end = end;
        node.source = this.src;
        this.pos = end;
        if (stack.length) pushChild(stack[stack.length - 1], node);
        else doc.appendChild(node);
        continue;
      }

      // 处理指令
      if (this.src.startsWith('<?', this.pos)) {
        const start = this.pos;
        const endIdx = this.src.indexOf('?>', this.pos + 2);
        if (endIdx < 0) this.error('未闭合的处理指令');
        const body = this.src.slice(this.pos + 2, endIdx);
        const sp = body.search(/\s/);
        const target = sp < 0 ? body : body.slice(0, sp);
        const data = sp < 0 ? '' : body.slice(sp + 1);
        const node = new XmlPi(target, data);
        node.start = start;
        node.end = endIdx + 2;
        node.source = this.src;
        this.pos = node.end;
        if (stack.length) pushChild(stack[stack.length - 1], node);
        else doc.appendChild(node);
        continue;
      }

      // 普通开始标签
      const el = this.parseElement();
      if (stack.length) pushChild(stack[stack.length - 1], el);
      else {
        doc.appendChild(el);
        if (!root) root = el;
      }
      if (!el.selfClosing) stack.push(el);
    }

    if (stack.length && !this.lenient) {
      this.error(`存在未闭合的标签：<${stack[stack.length - 1].name}>`);
    }
    while (stack.length) {
      const el = stack.pop();
      el.endTagStart = this.len;
      el.end = this.len;
    }
    return doc;
  }

  scanDoctype() {
    let i = this.pos + 9;
    let depth = 0;
    while (i < this.len) {
      const ch = this.src[i];
      if (ch === '[') depth += 1;
      else if (ch === ']') depth -= 1;
      else if (ch === '>' && depth <= 0) return i + 1;
      i += 1;
    }
    return this.len;
  }

  parseElement() {
    const start = this.pos;
    this.pos += 1; // 吃掉 '<'
    const nameStart = this.pos;
    while (this.pos < this.len && !/[\s/>]/.test(this.src[this.pos])) this.pos += 1;
    const name = this.src.slice(nameStart, this.pos);
    if (!name) this.error('标签名为空');
    const el = new XmlElement(name);
    el.start = start;
    el.source = this.src;

    // 属性
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.len) this.error(`标签 <${name}> 未闭合`);
      const ch = this.src[this.pos];
      if (ch === '/') {
        if (this.src[this.pos + 1] !== '>') this.error(`标签 <${name}> 中出现了孤立的 '/'`);
        el.selfClosing = true;
        el.startTagEnd = this.pos + 2;
        el.endTagStart = el.startTagEnd;
        el.end = el.startTagEnd;
        this.pos += 2;
        return el;
      }
      if (ch === '>') {
        el.startTagEnd = this.pos + 1;
        this.pos += 1;
        return el;
      }
      // 属性名
      const attrStart = this.pos;
      while (this.pos < this.len && !/[\s=/>]/.test(this.src[this.pos])) this.pos += 1;
      if (this.pos === attrStart) this.error(`标签 <${name}> 属性解析失败`);
      const attrName = this.src.slice(attrStart, this.pos);
      this.skipWhitespace();
      let value = '';
      let quote = '"';
      if (this.src[this.pos] === '=') {
        this.pos += 1;
        this.skipWhitespace();
        const q = this.src[this.pos];
        if (q === '"' || q === "'") {
          quote = q;
          this.pos += 1;
          const valStart = this.pos;
          const valEnd = this.src.indexOf(q, this.pos);
          if (valEnd < 0) this.error(`属性 ${attrName} 的引号未闭合`);
          value = decodeEntities(this.src.slice(valStart, valEnd));
          this.pos = valEnd + 1;
        } else {
          const valStart = this.pos;
          while (this.pos < this.len && !/[\s/>]/.test(this.src[this.pos])) this.pos += 1;
          value = decodeEntities(this.src.slice(valStart, this.pos));
        }
      } else {
        // 无值属性（HTML 风格），保留
        value = attrName;
      }
      el.attributes.push(new XmlAttribute(attrName, value, quote, attrStart, this.pos));
    }
  }

  skipWhitespace() {
    while (this.pos < this.len && /\s/.test(this.src[this.pos])) this.pos += 1;
  }

  /**
   * 生成文本节点：内容能原样回写时就是一个节点；
   * 只有在「源文写法与解码值不一致」（通常含实体）时才切成多片，
   * 但每一片仍然是完整、独立的文本节点，序列化语义与输入完全等价。
   * @returns {XmlText[]}
   */
  makeText(start, end) {
    if (end <= start) return [];
    const raw = this.src.slice(start, end);
    const whole = new XmlText(decodeEntities(raw));
    whole.start = start;
    whole.end = end;
    whole.source = this.src;

    // 快速路径：绝大多数文本没有需要重写的实体
    if (decodeEntities(raw) === raw) return [whole];

    // 慢路径：按实体引用切片，每片各自可精确回写
    const parts = [];
    const re = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) parts.push(this.sliceText(start + last, start + m.index));
      const t = new XmlText(decodeEntities(m[0]));
      t.entity = m[0];
      t.start = start + m.index;
      t.end = start + m.index + m[0].length;
      t.source = this.src;
      parts.push(t);
      last = m.index + m[0].length;
    }
    if (last < raw.length) parts.push(this.sliceText(start + last, end));
    return parts.length ? parts : [whole];
  }

  sliceText(start, end) {
    const t = new XmlText(decodeEntities(this.src.slice(start, end)));
    t.start = start;
    t.end = end;
    t.source = this.src;
    return t;
  }
}

function pushChild(parent, node) {
  node.parentNode = parent;
  parent.children.push(node);
}
