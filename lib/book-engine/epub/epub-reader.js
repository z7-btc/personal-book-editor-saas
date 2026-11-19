/**
 * EPUB 读取：解析容器 -> OPF -> metadata / manifest / spine / TOC，
 * 然后定位「真正的正文」。
 *
 * 只读，不修改任何东西。所有写出操作都在 writer 里。
 */

import path from 'node:path';
import { ZipReader } from './zip-reader.js';
import { parseXml, NODE, decodeEntities } from './xml-dom.js';
import { queryAll } from './selector.js';
import { EpubError } from '../util/errors.js';

/* ------------------------------------------------------------ 路径工具 -- */

/** ZIP 内部路径：统一 POSIX，并解析 ../ 与 ./ */
export function normalizeZipPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** 以 base 文件为基准解析相对路径。 */
export function resolveZipPath(baseFile, rel) {
  const decoded = safeDecode(rel).split('#')[0].split('?')[0];
  if (!decoded) return normalizeZipPath(baseFile);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return null; // 绝对 URL，跳过
  const baseDir = path.posix.dirname(normalizeZipPath(baseFile));
  const joined = decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(baseDir, decoded);
  return normalizeZipPath(joined);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* ------------------------------------------------------------ 语言判断 -- */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** 估算字数：CJK 按字计，其他按词计。 */
export function countWords(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const words = (rest.match(/[A-Za-z0-9\u00c0-\u024f][A-Za-z0-9\u00c0-\u024f'’\-]*/g) || []).length;
  return cjk + words;
}

export function isCjkText(text) {
  if (!text) return false;
  const sample = text.slice(0, 4000);
  const cjk = (sample.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk / Math.max(1, sample.length) > 0.15 || CJK_RE.test(sample);
}

/* -------------------------------------------------------------- 读取 -- */

/**
 * @typedef {Object} ManifestItem
 * @property {string} id
 * @property {string} href       ZIP 内完整路径
 * @property {string} mediaType
 * @property {string} properties
 * @property {string} rawHref    OPF 里的原始 href（用于写回）
 * @property {string} opfDir     OPF 所在目录
 */

/**
 * @typedef {Object} ChapterInfo
 * @property {number} index
 * @property {string} id
 * @property {string} href       ZIP 内完整路径
 * @property {string} mediaType
 * @property {string} title
 * @property {string} [navTitle]
 * @property {string} [idref]
 * @property {boolean} linear
 * @property {number} textLength
 * @property {number} wordCount
 * @property {boolean} isCjk
 * @property {number} blockCount
 */

const XHTML_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'application/x-dtbook+xml',
  'application/xml',
  'text/xml',
]);

/**
 * 打开 EPUB，建立可在内存里长期复用的结构。
 * @param {Buffer} buffer
 * @returns {EpubBook}
 */
export function readEpub(buffer) {
  const zip = new ZipReader(buffer);

  // 1) mimetype（宽容处理：缺失或带空白都只警告）
  const warnings = [];
  const mimetypeEntry = zip.getEntry('mimetype');
  if (!mimetypeEntry) {
    warnings.push('缺少 mimetype 条目');
  } else {
    const value = zip.read('mimetype').toString('utf8').trim();
    if (value !== 'application/epub+zip') {
      warnings.push(`mimetype 内容异常: ${JSON.stringify(value)}`);
    }
  }

  // 2) container.xml -> rootfile
  const containerPath = 'META-INF/container.xml';
  if (!zip.has(containerPath)) {
    throw new EpubError('不是合法的 EPUB：缺少 META-INF/container.xml');
  }
  const containerDoc = parseXml(zip.readXmlText(containerPath).text);
  const rootfileEl = queryAll(containerDoc.documentElement, 'rootfile')[0];
  if (!rootfileEl) throw new EpubError('container.xml 中没有 <rootfile>');
  const opfPath = normalizeZipPath(rootfileEl.getAttribute('full-path') || '');
  if (!opfPath || !zip.has(opfPath)) {
    throw new EpubError(`OPF 文件不存在: ${opfPath || '(空)'}`);
  }

  // 3) OPF
  const opfText = zip.readXmlText(opfPath).text;
  const opfDoc = parseXml(opfText);
  const pkg = opfDoc.documentElement;
  if (!pkg || pkg.name.toLowerCase() !== 'package') {
    throw new EpubError('OPF 根元素不是 <package>');
  }
  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);
  const version = pkg.getAttribute('version') || '2.0';
  const uniqueIdentifierId = pkg.getAttribute('unique-identifier');

  // 4) metadata
  const metadataEl = queryAll(pkg, 'metadata')[0] || null;
  const metadata = extractMetadata(metadataEl, uniqueIdentifierId);

  // 5) manifest
  /** @type {Map<string, ManifestItem>} */
  const manifestById = new Map();
  /** @type {Map<string, ManifestItem>} */
  const manifestByHref = new Map();
  const manifestEl = queryAll(pkg, 'manifest')[0];
  if (!manifestEl) throw new EpubError('OPF 中缺少 <manifest>');
  for (const itemEl of queryAll(manifestEl, 'item')) {
    const id = itemEl.getAttribute('id');
    const rawHref = itemEl.getAttribute('href');
    if (!id || !rawHref) continue;
    const href = resolveZipPath(opfPath, rawHref);
    if (!href) continue;
    /** @type {ManifestItem} */
    const item = {
      id,
      href,
      rawHref,
      opfDir,
      mediaType: (itemEl.getAttribute('media-type') || '').trim(),
      properties: (itemEl.getAttribute('properties') || '').trim(),
      element: itemEl,
    };
    if (!manifestById.has(id)) manifestById.set(id, item);
    if (!manifestByHref.has(href)) manifestByHref.set(href, item);
  }

  // 6) spine
  const spineEl = queryAll(pkg, 'spine')[0];
  if (!spineEl) throw new EpubError('OPF 中缺少 <spine>');
  const spineTocId = spineEl.getAttribute('toc');
  /** @type {Array<{idref: string, linear: boolean, item: ManifestItem|undefined, element: any}>} */
  const spine = [];
  for (const refEl of queryAll(spineEl, 'itemref')) {
    const idref = refEl.getAttribute('idref');
    if (!idref) continue;
    spine.push({
      idref,
      linear: (refEl.getAttribute('linear') || 'yes').toLowerCase() !== 'no',
      properties: (refEl.getAttribute('properties') || '').trim(),
      element: refEl,
      item: manifestById.get(idref),
    });
  }
  if (!spine.length) throw new EpubError('OPF 的 <spine> 为空');

  // 7) TOC：EPUB3 nav 优先，其次 NCX
  const navItem =
    [...manifestById.values()].find((i) => i.properties.split(/\s+/).includes('nav')) ||
    manifestByHref.get(normalizeZipPath(`${opfDir ? `${opfDir}/` : ''}nav.xhtml`)) ||
    null;
  const ncxItem =
    (spineTocId ? manifestById.get(spineTocId) : null) ||
    [...manifestById.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml') ||
    null;

  let toc = [];
  if (navItem && zip.has(navItem.href)) {
    try {
      toc = parseNavDoc(zip.readXmlText(navItem.href).text, navItem.href);
    } catch (err) {
      warnings.push(`nav 目录解析失败：${err.message}`);
    }
  }
  if (!toc.length && ncxItem && zip.has(ncxItem.href)) {
    try {
      toc = parseNcx(zip.readXmlText(ncxItem.href).text, ncxItem.href);
    } catch (err) {
      warnings.push(`NCX 目录解析失败：${err.message}`);
    }
  }

  // 8) 章节 = spine 里的 XHTML 文档
  /** @type {ChapterInfo[]} */
  const chapters = [];
  let index = 0;
  for (const spineEntry of spine) {
    const item = spineEntry.item;
    if (!item) {
      warnings.push(`spine 引用了不存在的 manifest id: ${spineEntry.idref}`);
      continue;
    }
    if (!XHTML_TYPES.has(item.mediaType) && !/\.x?html?$/i.test(item.href)) {
      continue; // 不是正文文档（比如图片 / 音频）
    }
    if (!zip.has(item.href)) {
      warnings.push(`spine 指向的文件在压缩包中不存在: ${item.href}`);
      continue;
    }
    /**
     * 跳过「上一版导出的阅读路径页」。
     *
     * 用户把优化过的书再上传一次时（很常见：想在新画像下再优化一遍），
     * 上一版导出时插进去的 `pbe-reading-path.xhtml` 也在 spine 里。
     * 它会被当成一章重新规划、改写、压缩，导出时再和新生成的目录页
     * 撞同一个路径 —— 实测目录页被改写结果整页覆盖，只剩一副空架子
     * （ol/ul 里一个 li 都没有）。它不是原书内容，直接不认。
     */
    if (/(^|\/)pbe-reading-path\.xhtml$/i.test(item.href)) {
      warnings.push('跳过上一版生成的阅读导航页（pbe-reading-path.xhtml），不当作原书章节');
      continue;
    }
    index += 1;
    const tocEntry = toc.find((t) => t.href === item.href) || null;
    chapters.push({
      index,
      id: item.id,
      href: item.href,
      mediaType: item.mediaType,
      title: tocEntry?.title || fallbackTitle(item.href, index),
      navTitle: tocEntry?.title || null,
      linear: spineEntry.linear,
      spineProperties: spineEntry.properties,
      textLength: 0,
      wordCount: 0,
      isCjk: false,
      blockCount: 0,
      element: item.element,
    });
  }

  if (!chapters.length) throw new EpubError('没有找到任何可处理的正文文档（spine 中没有 XHTML）');

  return new EpubBook({
    zip,
    opfPath,
    opfDir,
    opfDoc,
    opfText,
    version,
    metadata,
    manifestById,
    manifestByHref,
    spine,
    navItem,
    ncxItem,
    toc,
    chapters,
    warnings,
  });
}

function fallbackTitle(href, index) {
  const base = path.posix.basename(href).replace(/\.[^.]+$/, '');
  return base || `Section ${index}`;
}

function extractMetadata(metadataEl, uniqueIdentifierId) {
  const out = {
    title: '',
    creators: [],
    publisher: '',
    language: '',
    date: '',
    description: '',
    subjects: [],
    identifiers: [],
    rights: '',
    series: '',
    raw: {},
  };
  if (!metadataEl) return out;
  const text = (el) => (el ? el.textContent.trim() : '');
  const find = (name) => queryAll(metadataEl, name);
  const all = (name) => find(name).map(text).filter(Boolean);

  out.title = text(find('title')[0]);
  out.creators = all('creator');
  out.publisher = all('publisher')[0] || '';
  out.language = all('language')[0] || '';
  out.date = all('date')[0] || '';
  out.description = all('description')[0] || '';
  out.subjects = all('subject');
  out.rights = all('rights')[0] || '';
  out.series = all('meta')
    .filter(() => false)
    .join('');

  const metas = find('meta');
  for (const meta of metas) {
    const property = meta.getAttribute('property') || meta.getAttribute('name') || '';
    const value = meta.getAttribute('content') ?? meta.textContent.trim();
    if (!property) continue;
    out.raw[property] = value;
    if (property === 'calibre:series' || property === 'belongs-to-collection') out.series = value;
  }
  for (const idEl of find('identifier')) {
    out.identifiers.push({
      id: idEl.getAttribute('id') || '',
      scheme: idEl.getAttribute('scheme') || '',
      value: text(idEl),
      isUnique: Boolean(uniqueIdentifierId) && idEl.getAttribute('id') === uniqueIdentifierId,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- TOC -- */

function parseNavDoc(text, navHref) {
  const doc = parseXml(text);
  const entries = [];
  const root = doc.documentElement;
  // 只取第一个 nav（epub:type="toc" 优先）
  const navs = queryAll(root, 'nav');
  const tocNav =
    navs.find((n) => (n.getAttribute('epub:type') || n.getAttributeLoose('type') || '').includes('toc')) ||
    navs[0] ||
    root;
  for (const anchor of queryAll(tocNav, 'a')) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    entries.push({
      title: anchor.textContent.replace(/\s+/g, ' ').trim(),
      href: resolveZipPath(navHref, href),
      fragment: href.includes('#') ? href.slice(href.indexOf('#') + 1) : '',
      level: depthOf(anchor, tocNav),
    });
  }
  return entries;
}

function depthOf(el, root) {
  let depth = 0;
  let cur = el.parentNode;
  while (cur && cur !== root) {
    if (cur.kind === NODE.ELEMENT && ['ol', 'ul'].includes(cur.name.toLowerCase())) depth += 1;
    cur = cur.parentNode;
  }
  return depth;
}

function parseNcx(text, ncxHref) {
  const doc = parseXml(text);
  const entries = [];
  const root = doc.documentElement;
  for (const navPoint of queryAll(root, 'navPoint')) {
    const labelEl = queryAll(navPoint, 'navLabel')[0];
    const contentEl = queryAll(navPoint, 'content')[0];
    if (!contentEl) continue;
    const src = contentEl.getAttribute('src') || '';
    entries.push({
      title: labelEl ? labelEl.textContent.replace(/\s+/g, ' ').trim() : '',
      href: resolveZipPath(ncxHref, src),
      fragment: src.includes('#') ? src.slice(src.indexOf('#') + 1) : '',
      level: 0,
    });
  }
  return entries;
}

/* -------------------------------------------------------------- 书籍 -- */

export class EpubBook {
  constructor(fields) {
    Object.assign(this, fields);
    /** 章节 XHTML 的解析缓存（惰性） */
    this._domCache = new Map();
  }

  get title() {
    return this.metadata.title || this.opfPath.replace(/\.[^.]+$/, '');
  }

  get creators() {
    return this.metadata.creators;
  }

  /** 取原始字节（未改动的条目用这个搬运）。 */
  readRawBytes(href) {
    return this.zip.read(href);
  }

  /** 取该文档的 DOM（带缓存）。 */
  getDocument(href) {
    if (this._domCache.has(href)) return this._domCache.get(href);
    const { text } = this.zip.readXmlText(href);
    const doc = parseXml(text);
    this._domCache.set(href, doc);
    return doc;
  }

  /** 该条目是否被修改过（决定重打包时是搬运还是重写）。 */
  serializeDocument(href) {
    const doc = this.getDocument(href);
    return doc.serialize();
  }

  /** 列出所有条目（用于重打包）。 */
  listEntries() {
    return this.zip.list();
  }

  /** 统计每章的字数（Stage 1 展示用）。 */
  async measureChapters(measure) {
    for (const chapter of this.chapters) {
      try {
        const doc = this.getDocument(chapter.href);
        const body = queryAll(doc.documentElement, 'body')[0] || doc.documentElement;
        const text = body.textContent;
        chapter.textLength = text.replace(/\s+/g, '').length;
        chapter.wordCount = countWords(text);
        chapter.isCjk = isCjkText(text);
        chapter.blockCount = measure ? measure(doc) : 0;
      } catch {
        chapter.textLength = 0;
        chapter.wordCount = 0;
      }
    }
    return this.chapters;
  }
}

export { parseXml, decodeEntities };
