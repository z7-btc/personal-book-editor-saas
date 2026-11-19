/**
 * 极简 CSS 选择器（只实现 EPUB 处理真正需要的那一小撮）。
 * 支持：tag、.class、#id、[attr]、[attr=value]、逗号分组、后代组合（空格）。
 */

import { NODE } from './xml-dom.js';

/**
 * @param {import('./xml-dom.js').XmlElement} root
 * @param {string} selector
 * @returns {import('./xml-dom.js').XmlElement[]}
 */
export function queryAll(root, selector) {
  const groups = String(selector)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  const descendants = root.descendants();
  for (const group of groups) {
    const parts = group.split(/\s+/).filter(Boolean);
    let candidates = [root, ...descendants];
    for (let i = 0; i < parts.length; i += 1) {
      const matcher = compileSimple(parts[i]);
      if (i === 0) {
        candidates = candidates.filter(matcher);
      } else {
        // 后代组合
        const next = new Set();
        for (const c of candidates) {
          for (const d of c.descendants()) if (matcher(d)) next.add(d);
        }
        candidates = [...next];
      }
    }
    for (const c of candidates) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** @param {string} selector @returns {(el: import('./xml-dom.js').XmlElement) => boolean} */
export function compileSimple(selector) {
  // 标签名允许带命名空间前缀：dc:title / epub:type
  // 语义（有意设计成这样，因为 EPUB 里前缀写法差异很大）：
  //   'title'     匹配 <title> 与 <dc:title>
  //   'dc:title'  匹配 <dc:title> 与 <title>（前缀只是"更具体"的写法）
  const tagMatch = /^([a-zA-Z_][\w.-]*)(?::([a-zA-Z_][\w.-]*))?/.exec(selector);
  const tagPrefix = tagMatch ? (tagMatch[1] || '').toLowerCase() : null;
  const tagLocal = tagMatch ? (tagMatch[2] || tagMatch[1] || '').toLowerCase() : null;
  const classes = [];
  const ids = [];
  const attrs = [];
  const re = /\.([\w-]+)|#([\w-]+)|\[([\w:.-]+)(?:\s*([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m;
  while (m = re.exec(selector)) {
    if (m[1]) classes.push(m[1]);
    else if (m[2]) ids.push(m[2]);
    else if (m[3]) attrs.push({ name: m[3], op: m[4] || null, value: m[5] ?? m[6] ?? m[7] ?? null });
  }
  return (el) => {
    if (el.kind !== NODE.ELEMENT) return false;
    if (tagLocal) {
      const name = el.name.toLowerCase();
      const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
      if (local !== tagLocal) return false;
      // 明确写了前缀时，要求元素名里也带前缀（dc:title 不应匹配 <title>）
      if (tagMatch[2] && !name.includes(':') && !name.startsWith(`${tagPrefix}:`)) {
        const root = topElement(el);
        if (!hasNamespacePrefix(root, tagPrefix)) return false;
      }
    }
    if (ids.length) {
      const id = el.getAttribute('id');
      if (!id || !ids.includes(id)) return false;
    }
    if (classes.length) {
      const cls = (el.getAttribute('class') || '').split(/\s+/);
      if (!classes.every((c) => cls.includes(c))) return false;
    }
    for (const a of attrs) {
      const value = attributeLoose(el, a.name);
      if (value === null || value === undefined) return false;
      if (!a.op) continue;
      if (a.op === '=' && value !== a.value) return false;
      if (a.op === '~=' && !value.split(/\s+/).includes(a.value)) return false;
      if (a.op === '^=' && !value.startsWith(a.value)) return false;
      if (a.op === '$=' && !value.endsWith(a.value)) return false;
      if (a.op === '*=' && !value.includes(a.value)) return false;
      if (a.op === '|=' && value !== a.value && !value.startsWith(`${a.value}-`)) return false;
    }
    return true;
  };
}

/** 属性查找：先精确名，再按 local name（忽略前缀）。 */
function attributeLoose(el, name) {
  const exact = el.getAttribute(name);
  if (exact !== null) return exact;
  const lower = name.toLowerCase();
  for (const attr of el.attributes) {
    const attrName = attr.name.toLowerCase();
    const local = attrName.includes(':') ? attrName.slice(attrName.indexOf(':') + 1) : attrName;
    if (local === lower) return attr.value;
  }
  return null;
}

function topElement(el) {
  let cur = el;
  while (cur.parentNode) cur = cur.parentNode;
  return cur;
}

/** 根元素上是否声明了某个命名空间前缀（例如 xmlns:dc）。 */
function hasNamespacePrefix(root, prefix) {
  if (!root || root.kind !== NODE.ELEMENT) return false;
  return root.attributes.some(
    (a) => a.name.toLowerCase() === `xmlns:${prefix}` || a.name.toLowerCase() === `xmlns:${prefix.toLowerCase()}`,
  );
}

export function queryFirst(root, selector) {
  return queryAll(root, selector)[0] || null;
}
