/**
 * EPUB 写出。
 *
 * 核心策略：**编辑正文，而不是重新生成整个 EPUB**。
 *
 *  - 除被明确替换的正文文档之外，所有条目（CSS / 图片 / 字体 / NCX / OPF /
 *    container.xml …）都从原 ZIP 里**原字节搬运**，连压缩方式都不变。
 *  - OPF / manifest / spine / nav / metadata 完全不动。
 *  - 输出时按 OCF 规范重写 ZIP：mimetype 第一个、Store、无 extra field。
 *
 * 这样「目录、图片、CSS、脚注、链接、封面基本一致」就是结构性保证，
 * 而不是靠事后祈祷。
 */

import { writeEpubZip } from './zip-writer.js';
import { queryAll } from './selector.js';
import { XmlElement, XmlText, parseXml } from './xml-dom.js';
import { resolveZipPath } from './epub-reader.js';
import { EpubError } from '../util/errors.js';
import { sanitizeFileName } from '../util/ids.js';

/**
 * 打开目录文档用于编辑。
 *
 * 关键：**优先用已经改过的那一份**（`replacements` 里带着的），
 * 而不是每次都从 ZIP 原文重新解析。
 *
 * 这个是踩出来的：目录重排（reorderToc）和「往目录里加一条」
 * （insertTocEntry）都要改同一个 NCX 文件。如果后者从原文重新解析，
 * 它序列化出来的就是**没有重排过的原文**，把前一步的结果整个盖掉 ——
 * 表现是「目录顺序又变回原样了」，而且不报任何错。
 *
 * @param {import('./epub-reader.js').EpubBook} book
 * @param {string} href ZIP 内路径
 * @param {Map<string,string>} [replacements]
 */
function parseTocDoc(book, href, replacements) {
  const prior = replacements instanceof Map ? replacements.get(href) : null;
  const text = typeof prior === 'string' ? prior : book.zip.readXmlText(href).text;
  return parseXml(text);
}

/**
 * 按 children 数组做深度优先遍历，把 navPoint / li 的序号重排。
 *
 * **不能用 queryAll** —— 它按**源文本位置**排序输出，而重排恰恰改的是
 * children 数组的顺序，两者不一致时会把原编号原样写回去（看起来改成功了，
 * 其实一个都没变）。
 */
function renumberNavPoints(nodes) {
  let n = 0;
  const walk = (list) => {
    for (const node of list || []) {
      if (node.name === 'navPoint') {
        n += 1;
        node.setAttribute('playOrder', String(n));
      }
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
}

/**
 * 往目录（NCX / EPUB3 nav）里插一条，放在**最前面**。
 *
 * ## 为什么需要它
 *
 * 「阅读路径」页（`pbe-reading-path.xhtml`）是插到 spine 第一位的，
 * 打开书就是它 —— 但**它不在目录里**。用户在阅读器里点开目录面板，
 * 从头翻到尾也找不到「这本书怎么读」这一条，只能靠手动往前翻页。
 * 他的原话是「没看到目录这个分类」。
 *
 * 一个读者无法从目录抵达的页面，等于不存在。
 *
 * ## 顺序上的两个坑
 *
 *  1. **必须在 reorderToc 之后调用。** reorderToc 按「子树里最小的名次」
 *     排序，新条目指向的文件不在名次表里，会被当成「认不出」排到最后。
 *  2. **必须传 replacements 进来**，否则会把重排结果覆盖掉（见 parseTocDoc）。
 *
 * @param {import('./epub-reader.js').EpubBook} book
 * @param {{href: string, title: string, id?: string, tocHref?: string}} entry
 *        href 是 OPF 目录内的相对路径（NCX 的 src 用这个）
 * @param {{replacements?: Map<string,string>}} [opts]
 * @returns {{updates: Map<string,string>, inserted: boolean, issues: string[]}}
 */
export function insertTocEntry(book, entry, opts = {}) {
  const updates = new Map();
  const issues = [];
  const title = String(entry.title || '').trim();
  if (!title) return { updates, inserted: false, issues };
  const src = String(entry.tocHref || entry.href || '');
  /**
   * 判重必须用 **ZIP 内路径**，不能拿 `entry.href` 直接比。
   *
   * `entry.href` 是「OPF 目录内的相对路径」（写进 `content src` 用的，
   * 比如 `pbe-reading-path.xhtml`），而 `resolveZipPath` 解出来的是
   * ZIP 内路径（`OEBPS/pbe-reading-path.xhtml`）。两者永远不相等，
   * 判重形同虚设 —— 每次调用都会再插一条。
   */
  const zipPath = book.opfDir ? `${book.opfDir}/${entry.href}` : String(entry.href);
  let inserted = false;

  /* ------------------------------------------------------------- NCX -- */
  const ncxHref = book.ncxItem?.href;
  if (ncxHref && book.zip.has(ncxHref)) {
    try {
      const doc = parseTocDoc(book, ncxHref, opts.replacements);
      const navMap = queryAll(doc.documentElement, 'navMap')[0];
      if (navMap) {
        const already = queryAll(navMap, 'navPoint').some((el) => {
          const c = queryAll(el, 'content')[0];
          return resolveZipPath(ncxHref, (c?.getAttribute('src') || '').split('#')[0]) === zipPath;
        });
        if (!already) {
          const point = new XmlElement('navPoint');
          point.setAttribute('id', entry.id || 'pbe-front-page');
          point.setAttribute('playOrder', '1');
          const label = new XmlElement('navLabel');
          const textEl = new XmlElement('text');
          textEl.appendChild(new XmlText(title));
          label.appendChild(textEl);
          point.appendChild(label);
          const content = new XmlElement('content');
          content.setAttribute('src', src);
          point.appendChild(content);

          const firstPoint = (navMap.children || []).find((c) => c.name === 'navPoint') || null;
          if (firstPoint) navMap.insertBefore(point, firstPoint);
          else navMap.appendChild(point);
          renumberNavPoints(navMap.children);
          updates.set(ncxHref, doc.serialize());
          inserted = true;
        }
      }
    } catch (err) {
      issues.push(`NCX 加目录项跳过：${err.message}`);
    }
  }

  /* ------------------------------------------------------------- nav -- */
  const navHref = book.navItem?.href;
  if (navHref && book.zip.has(navHref)) {
    try {
      const doc = parseTocDoc(book, navHref, opts.replacements);
      const navs = queryAll(doc.documentElement, 'nav');
      const tocNav = navs.find((el) => (el.getAttribute('epub:type') || '').includes('toc')) || navs[0];
      const ol = tocNav ? queryAll(tocNav, 'ol')[0] : null;
      if (ol) {
        const already = queryAll(ol, 'a').some(
          (a) => resolveZipPath(navHref, (a.getAttribute('href') || '').split('#')[0]) === zipPath,
        );
        if (!already) {
          const li = new XmlElement('li');
          const a = new XmlElement('a');
          a.setAttribute('href', src);
          a.appendChild(new XmlText(title));
          li.appendChild(a);
          const firstItem = (ol.children || []).find((c) => c.name === 'li') || null;
          if (firstItem) ol.insertBefore(li, firstItem);
          else ol.appendChild(li);
          updates.set(navHref, doc.serialize());
          inserted = true;
        }
      }
    } catch (err) {
      issues.push(`nav 加目录项跳过：${err.message}`);
    }
  }

  return { updates, inserted, issues };
}

/**
 * @typedef {Object} RepackOptions
 * @property {Map<string, string>|Record<string, string>} [replacements]
 *           路径 -> 新的 XHTML 文本（只放真正被改写过的文档）
 * @property {Map<string, string>|Record<string, string>} [additions]
 *           路径 -> 新文件内容。**只允许新增，不允许覆盖已有条目** ——
 *           覆盖应该走 replacements，走错门直接报错，免得悄悄改坏原书。
 * @property {(href: string, data: Buffer) => Buffer} [transform]
 *           可选的字节级后处理
 * @property {boolean} [verbose]
 */

/**
 * @typedef {Object} RepackResult
 * @property {Buffer} buffer
 * @property {number} replacedCount
 * @property {number} copiedCount
 * @property {Array<{entry: string, reason: string}>} issues
 */

/**
 * 把若干章从书里**拿掉**。
 *
 * ## 这是全套操作里唯一不可逆的一刀
 *
 * 压缩至少还留下「这一章讲了什么」的几百字；删除之后读者再也看不到它。
 * 所以护栏比别处都硬，任何一条不满足就**不删**并给出理由：
 *
 *  1. **不许删还有别人指着的章。** 删掉之后那些链接会指向一个不在 spine 里的
 *     文件 —— 有的阅读器照常打开，有的直接不响应；行为不一致本身就是 bug。
 *     判据是入链数（指向这一章文件或锚点的链接条数），由调用方算好传进来。
 *  2. **必须留下内容。** 整本书都被标成 drop 时结果是一本空书 ——
 *     宁可报错，也不产出一个打不开的成品。
 *  3. 只能删 spine 里真实存在的项。
 *
 * ## 文件本身不删
 *
 * 只改三处：`spine` 里的 `<itemref>`、`manifest` 里的 `<item>`、
 * NCX 里对应的 `<navPoint>`。
 * **ZIP 里那个 XHTML 一个字节都不动** —— 万一还有别处以我们没识别出的方式
 * 引用它，文件还在原处；用户想从原书里找回来也找得到。
 *
 * @param {import('./epub-reader.js').EpubBook} book
 * @param {Array<{id: string, href: string, index: number, title?: string}>} entries
 * @param {{replacements?: Map<string,string>, blocked?: Map<string,string>}} [opts]
 *        blocked：manifest id -> 不能删的理由（通常是「有 N 条链接指着它」）
 * @returns {{opfText: string, removed: object[], refused: object[],
 *            tocUpdates: Map<string,string>, issues: string[]}}
 */
export function dropChapters(book, entries, opts = {}) {
  const issues = [];
  const removed = [];
  const refused = [];
  const { opfDoc } = book;
  if (!opfDoc) throw new EpubError('OPF 没有以可编辑的 DOM 形式加载，无法删除章节');

  const manifestEl = queryAll(opfDoc.documentElement, 'manifest')[0];
  const spineEl = queryAll(opfDoc.documentElement, 'spine')[0];
  if (!manifestEl || !spineEl) throw new EpubError('OPF 缺少 manifest 或 spine，已中止删除');

  const blockedMap = opts.blocked instanceof Map ? opts.blocked : new Map();
  const spineRefs = (spineEl.children || []).filter((el) => el.name === 'itemref');
  const manifestItems = (manifestEl.children || []).filter((el) => el.name === 'item');

  const plan = [];
  for (const entry of entries) {
    const ref = spineRefs.find((el) => el.getAttribute('idref') === entry.id);
    if (!ref) {
      refused.push({ ...entry, reason: 'spine 里找不到这一项' });
      continue;
    }
    const why = blockedMap.get(entry.id);
    if (why) {
      refused.push({ ...entry, reason: why });
      continue;
    }
    plan.push({ entry, ref });
  }

  /** 全删光就是一本空书。宁可报错，也不产出打不开的成品。 */
  if (spineRefs.length - plan.length < 1) {
    throw new EpubError(
      `不能把书删空：spine 共 ${spineRefs.length} 项，要删 ${plan.length} 项（至少保留 1 项）`,
    );
  }

  for (const { entry, ref } of plan) {
    ref.detach();
    const item = manifestItems.find((el) => el.getAttribute('id') === entry.id);
    if (item) item.detach();
    removed.push({ ...entry });
  }

  const tocUpdates = new Map();
  if (!removed.length) {
    return { opfText: opfDoc.serialize(), removed, refused, tocUpdates, issues };
  }
  /**
   * 光 `detach()` 是不够的 —— 这套 DOM 是**字节保真**的：
   * 没被标记成 rebuilt 的父节点序列化时会按源区间把"缝隙"回填，
   * 被删掉的 `<itemref>` 会**原样又冒出来**（applyDigest 踩过同一个坑）。
   * 必须显式告诉它「这一层按当前 DOM 状态重建」。
   */
  for (const el of [spineEl, manifestEl]) {
    el.rebuilt = true;
    el.touch();
  }

  const removedHrefs = new Set(removed.map((r) => r.href).filter(Boolean));

  /* ------------------------------------------------------------- NCX -- */
  const ncxHref = book.ncxItem?.href;
  if (ncxHref && book.zip.has(ncxHref) && removedHrefs.size) {
    try {
      const doc = parseTocDoc(book, ncxHref, opts.replacements);
      const navMap = queryAll(doc.documentElement, 'navMap')[0];
      if (navMap) {
        /**
         * 递归删目录条目。
         *
         * ## 一个差点毁掉整本书目录的坑
         *
         * 第一版写成「匹配到就 `detach()`」。对**叶子**条目没问题，
         * 但这本书的 NCX 是**分层**的：全书正文（第一~第八部分、52 章）
         * 整个挂在「证券分析（上）」「证券分析（下）」这两个顶层条目下面。
         * 而这两条恰好指向分册扉页 —— 整页图片，被判为 filler 删掉了。
         *
         * 于是 `detach()` 把**整棵子树**一起带走：成品的目录从 89 条
         * 掉到 7 条，读者打开目录只看到附录、推荐序、跋，正文 52 章全没了。
         * 而且不报错 —— 是导出后的体检脚本（现在会数条目数了）抓出来的。
         *
         * 正确语义：**删掉的条目如果是个容器，要把它的子条目提上来**，
         * 而不是连子条目一起丢。删的只是「这一页」，不是「这一页下面的一切」。
         */
        let touched = false;
        const prune = (node) => {
          const kids = node.children || [];
          const next = [];
          for (const child of kids) {
            if (child.name !== 'navPoint') {
              next.push(child);
              continue;
            }
            // 先处理孙辈，再判断自己
            if (child.children?.length) prune(child);
            const c = queryAll(child, 'content')[0];
            const href = resolveZipPath(ncxHref, (c?.getAttribute('src') || '').split('#')[0]);
            if (href && removedHrefs.has(href)) {
              touched = true;
              const inner = (child.children || []).filter((x) => x.name === 'navPoint');
              // 容器被删：子条目提到这一层，正文目录不能跟着一起没
              if (inner.length) next.push(...inner);
              continue;
            }
            next.push(child);
          }
          if (touched) {
            node.children = next;
            node.rebuilt = true;
            node.touch();
          }
        };
        prune(navMap);
        if (touched) {
          renumberNavPoints(navMap.children);
          // 同上：不回填缝隙，否则删掉的 navPoint 会原样回来
          navMap.rebuilt = true;
          navMap.touch();
          tocUpdates.set(ncxHref, doc.serialize());
        }
      }
    } catch (err) {
      issues.push(`NCX 删除条目跳过：${err.message}`);
    }
  }

  /* ------------------------------------------------------------- nav -- */
  const navHref = book.navItem?.href;
  if (navHref && book.zip.has(navHref) && removedHrefs.size) {
    try {
      const doc = parseTocDoc(book, navHref, opts.replacements);
      const navs = queryAll(doc.documentElement, 'nav');
      const tocNav = navs.find((el) => (el.getAttribute('epub:type') || '').includes('toc')) || navs[0];
      const ol = tocNav ? queryAll(tocNav, 'ol')[0] : null;
      if (ol) {
        let touched = false;
        for (const li of [...(ol.children || [])]) {
          if (li.name !== 'li') continue;
          const a = queryAll(li, 'a')[0];
          const href = resolveZipPath(navHref, (a?.getAttribute('href') || '').split('#')[0]);
          if (href && removedHrefs.has(href)) {
            li.detach();
            touched = true;
          }
        }
        if (touched) {
          ol.rebuilt = true;
          ol.touch();
          tocUpdates.set(navHref, doc.serialize());
        }
      }
      /**
       * landmarks 里也会挂死链。
       *
       * `<nav epub:type="landmarks">` 是阅读器的「跳转」清单，里面常有
       * 「正文开始」→ 合集页/扉页 这类条目。删掉那一章以后，这条链接就
       * 指向一个已经不在 manifest 里的文件 —— 有的阅读器点它没反应，
       * epubcheck 直接报错。目录（toc）清干净了，这里也必须一起清。
       */
      const landmarkNav = navs.find((el) => (el.getAttribute('epub:type') || '').includes('landmarks'));
      const landmarkOl = landmarkNav ? queryAll(landmarkNav, 'ol')[0] : null;
      if (landmarkOl) {
        let touched = false;
        for (const li of [...(landmarkOl.children || [])]) {
          if (li.name !== 'li') continue;
          const a = queryAll(li, 'a')[0];
          const href = resolveZipPath(navHref, (a?.getAttribute('href') || '').split('#')[0]);
          if (href && removedHrefs.has(href)) {
            li.detach();
            touched = true;
          }
        }
        if (touched) {
          landmarkOl.rebuilt = true;
          landmarkOl.touch();
          tocUpdates.set(navHref, doc.serialize());
        }
      }
    } catch (err) {
      issues.push(`nav 删除条目跳过：${err.message}`);
    }
  }

  return { opfText: opfDoc.serialize(), removed, refused, tocUpdates, issues };
}

/**
 * 用原书结构重新打包 EPUB。
 * @param {import('./epub-reader.js').EpubBook} book
 * @param {RepackOptions} [options]
 * @returns {RepackResult}
 */
export function repackEpub(book, options = {}) {
  const replacements =
    options.replacements instanceof Map
      ? options.replacements
      : new Map(Object.entries(options.replacements || {}));

  /** @type {Array<{entry: string, reason: string}>} */
  const issues = [];
  const written = new Set();
  /** @type {Array<{name: string, data: Buffer, method: number, dosTime?: number, dosDate?: number, externalAttributes?: number, directory?: boolean}>} */
  const entries = [];

  let replacedCount = 0;
  let copiedCount = 0;

  for (const entry of book.listEntries()) {
    if (entry.name === 'mimetype') continue; // writeEpubZip 负责
    if (written.has(entry.name)) continue;
    written.add(entry.name);

    if (entry.isDirectory) {
      entries.push({
        name: entry.name,
        data: Buffer.alloc(0),
        method: 0,
        directory: true,
        dosTime: entry.dosTime,
        dosDate: entry.dosDate,
        externalAttributes: entry.externalAttributes,
      });
      continue;
    }

    let data;
    let method = entry.method;
    let rawData = null;
    if (replacements.has(entry.name)) {
      data = Buffer.from(replacements.get(entry.name), 'utf8');
      method = 8;
      replacedCount += 1;
    } else {
      if (entry.method !== 0 && entry.method !== 8) {
        issues.push({ entry: entry.name, reason: `不支持的压缩方式 ${entry.method}，已跳过` });
        continue;
      }
      try {
        // 关键：拿到【原始压缩字节】+ 未压缩字节。
        // 前者直接搬运（不重新压缩、不改变大小），后者用来计算 CRC。
        rawData = Buffer.from(book.zip.readRaw(entry));
        data = book.zip.read(entry);
        copiedCount += 1;
      } catch (err) {
        issues.push({ entry: entry.name, reason: `原样搬运失败，已跳过: ${err.message}` });
        continue;
      }
    }
    if (options.transform) {
      data = options.transform(entry.name, data);
      rawData = null; // 被改过就必须重新压缩
      method = entry.method === 0 ? 0 : 8;
    }

    entries.push({
      name: entry.name,
      data,
      method,
      ...(rawData
        ? { rawData, uncompressedSize: data.length, crc: entry.crc }
        : {}),
      dosTime: entry.dosTime,
      dosDate: entry.dosDate,
      externalAttributes: entry.externalAttributes,
    });
  }

  // 替换清单里出现了原包中没有的路径 => 属于严重问题，说明路径推导错了
  for (const name of replacements.keys()) {
    if (!book.zip.has(name)) {
      throw new EpubError(`要替换的文件不在原 EPUB 中：${name}（路径推导有误，已中止以免产出损坏文件）`);
    }
  }

  /**
   * 新增文件（例如「重构版阅读路径」那一页）。
   *
   * 这里刻意**只允许新增**：一个路径如果原包里已经有，说明调用方写错了，
   * 直接报错。想改已有文件必须走 replacements —— 那条路会重新计算 CRC、
   * 并且走的是「明确替换」的语义，不会有人不小心把原书某页覆盖掉。
   *
   * 新增的条目放在最后。EPUB 的阅读顺序由 OPF 的 spine 决定，
   * 跟 ZIP 里条目的物理顺序无关，所以放最后不会影响任何东西。
   */
  const additions =
    options.additions instanceof Map
      ? options.additions
      : new Map(Object.entries(options.additions || {}));
  let addedCount = 0;
  for (const [name, content] of additions) {
    if (written.has(name) || book.zip.has(name)) {
      throw new EpubError(`新增文件与原有条目重名：${name}（新增只允许真的新增，改已有文件请走 replacements）`);
    }
    written.add(name);
    entries.push({ name, data: Buffer.from(content, 'utf8'), method: 8 });
    addedCount += 1;
  }

  const buffer = writeEpubZip(entries, { mimetype: 'application/epub+zip', level: 9 });
  return { buffer, replacedCount, copiedCount, addedCount, issues };
}

/**
 * 只做「新增」的结构改动：插入一页到整本书的最前面。
 *
 * 为什么敢动结构：这是一个**纯增量**操作 ——
 *   · 不删任何条目、不改任何已有文件的路径；
 *   · 新页放在 spine 的第一位，所以打开书就是它；
 *   · 原有文件一个字节都不动，因此**所有交叉引用、脚注链接都不会失效**。
 * 相比之下，删章 / 合并 / 调序会牵动全局锚点，那是另一个风险等级的操作。
 *
 * 需要改的只有两处：OPF 的 `<manifest>` 加一个 `<item>`，
 * `<spine>` 的**最前面**加一个 `<itemref>`。其它全部原样搬运。
 *
 * @param {import('./epub-reader.js').EpubBook} book
 * @param {{id: string, href: string, title: string, xhtml: string}} page
 *        href 是相对 OPF 所在目录的路径
 * @returns {{opfText: string, href: string, id: string}}
 */
export function insertFrontPage(book, page) {
  const { opfDoc } = book;
  if (!opfDoc) throw new EpubError('OPF 没有以可编辑的 DOM 形式加载，无法插入页面');

  const manifestEl = queryAll(opfDoc.documentElement, 'manifest')[0];
  const spineEl = queryAll(opfDoc.documentElement, 'spine')[0];
  if (!manifestEl || !spineEl) throw new EpubError('OPF 缺少 manifest 或 spine，已中止');

  const id = page.id;
  if (queryAll(manifestEl, 'item').some((el) => el.getAttribute('id') === id)) {
    throw new EpubError(`manifest 里已经有 id=${id}，不能重复插入`);
  }

  const item = new XmlElement('item');
  item.setAttribute('id', id);
  item.setAttribute('href', page.href);
  item.setAttribute('media-type', 'application/xhtml+xml');
  manifestEl.appendChild(item);

  const itemref = new XmlElement('itemref');
  itemref.setAttribute('idref', id);
  /**
   * 插到 spine 的第一位：读者打开书看到的第一页就是它。
   *
   * **必须用 `children[0]`，不能用 `queryAll(spineEl,'itemref')[0]`。**
   * queryAll 是拿**源文本位置**排序输出的；一旦 spine 被重排过，
   * 数组顺序和源位置就对不上了 —— 那时 queryAll 会返回"原来排第一"
   * 的那个 itemref，新页于是被插到了书的中间（踩过一次：
   * 阅读路径页跑到第 15 章前面去了）。
   */
  const firstRef = spineEl.children.find((el) => el.name === 'itemref') || null;
  if (firstRef) spineEl.insertBefore(itemref, firstRef);
  else spineEl.appendChild(itemref);

  // appendChild / insertBefore 会把 dirty 沿祖先链传到 XmlDocument.modified，
  // serialize() 因此不会再走「未修改就直接返回原文」那条路
  return { opfText: opfDoc.serialize(), href: page.href, id };
}

/**
 * 重排阅读顺序（spine）。
 *
 * ## 为什么这件事是安全的
 *
 * 一开始我把「重排」和「合并章节」当成一类风险，是错的。区别在于：
 *
 *   · **重排**只是把 `<itemref>` 换个次序 —— 文件名不变、内容不动，
 *     而 EPUB 里所有链接都是「文件名 + 锚点」形式，**不含位置信息**，
 *     所以一条链接都不会失效。这是可逆的排列操作。
 *   · **合并 / 拆分 / 删章**要搬内容，锚点跟着内容走，一搬就全断。
 *
 * 实测用户这本书：966 条跨文件链接，没有一条依赖「它在书里第几个」。
 *
 * ## 但有一个硬约束
 *
 * `orderedIds` 必须是当前 spine 的**完整排列**：不能少（会丢章节）、
 * 不能多（会插入不存在的项）、不能重复。任何一条不满足就直接报错，
 * 绝不"尽力而为"地排一半 —— 那会产出一本缺章的书，而且阅读器不报错。
 *
 * @param {import('./epub-reader.js').EpubBook} book
 * @param {string[]} orderedIds manifest id 的目标顺序
 * @returns {{opfText: string, order: string[]}}
 */
export function reorderSpine(book, orderedIds) {
  const spineEl = queryAll(book.opfDoc.documentElement, 'spine')[0];
  if (!spineEl) throw new EpubError('OPF 缺少 <spine>，无法重排');

  const current = queryAll(spineEl, 'itemref');
  const currentIds = current.map((el) => el.getAttribute('idref')).filter(Boolean);
  const wanted = orderedIds.map(String);

  if (wanted.length !== currentIds.length) {
    throw new EpubError(
      `重排顺序的项数不对：spine 有 ${currentIds.length} 项，收到 ${wanted.length} 项（少一项就是丢一章，已中止）`,
    );
  }
  if (new Set(wanted).size !== wanted.length) {
    throw new EpubError('重排顺序里有重复项，已中止');
  }
  const known = new Set(currentIds);
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new EpubError(`重排顺序里出现了 spine 中不存在的项：${unknown.slice(0, 5).join('、')}`);
  }

  // 先 touch 再改结构：这套 DOM 是字节保真的，不标记就会被当成"没改过"
  spineEl.touch();
  const byId = new Map(current.map((el) => [el.getAttribute('idref'), el]));
  spineEl.children = wanted.map((id) => byId.get(id));
  spineEl.rebuilt = true;
  spineEl.touch();

  return { opfText: book.opfDoc.serialize(), order: wanted };
}

/**
 * 同步重排 NCX / nav 目录，让「目录面板里的顺序」和「翻页顺序」一致。
 *
 * 只调 spine 不调目录的话，读者会看到两套矛盾的顺序 —— 那比不重排还糟。
 *
 * 做法是**一律只动同一层的兄弟节点**：把顶层 `<navPoint>`（或 nav 里的
 * `<li>`）按目标文件的顺序重排，嵌套的子节点跟着父节点走。
 * 层级结构完全不动，所以不可能把目录树弄坏。
 *
 * 尽力而为：某一份目录结构不认识就跳过它并记一笔，不影响另一份。
 *
 * @param {import('./epub-reader.js').EpubBook} book
 * @param {string[]} orderedHrefs 目标文件顺序（ZIP 内路径）
 * @param {{renameByHref?: Map<string,string>}} [opts] 路径 -> 新的目录标题
 * @returns {{updates: Map<string,string>, issues: string[]}}
 */
export function reorderToc(book, orderedHrefs, opts = {}) {
  const updates = new Map();
  const issues = [];
  /** zip 内路径 -> 名次 */
  const rank = new Map(orderedHrefs.map((href, i) => [href, i]));
  /**
   * 章节改名：zip 内路径 -> 新名字。
   *
   * 用户的原话是「目录的名字也没改」—— 他对比原版和 AI 版目录，
   * 发现只有顺序变了、名字一模一样。对读者来说**目录里显示的那个名字
   * 才是目录**，只改顺序不改名字，等于没让他看出区别。
   * 所以这里把 NCX / nav 里对应条目的标题文本一并换掉。
   */
  const renameOf = opts.renameByHref instanceof Map ? opts.renameByHref : new Map();

  const sortByRank = (items, rankOf) =>
    items
      .map((el, i) => ({ el, i, rank: rankOf(el) }))
      // 认不出目标的项排在最后，且保持它们原本的相对次序（稳定排序）
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.el);

  /**
   * 一个目录条目的「名次」= **它整个子树里最小的那个名次**。
   *
   * 这一点很关键，是实测逼出来的：这本书的 NCX 是**分层**的 ——
   * 全书正文（15~24 章）整个挂在「证券分析（上）」「证券分析（下）」
   * 两个顶层条目下面。如果按条目**自己**指向的那个文件排名次，
   * 「上册」指的是分册扉页（排在第 25 位），于是整个正文被排到了
   * 版权页和目录后面 —— 读者打开目录看到的第一项是「附录」。
   *
   * 取子树最小值，等价于问「这一节最早出现的内容排在第几位」，
   * 这样整本书正文才会排在最前面。
   */
  const rankOfSubtree = (el, hrefOf) => {
    const self = hrefOf(el);
    let best = rank.has(self) ? rank.get(self) : Number.MAX_SAFE_INTEGER;
    for (const child of el.children || []) {
      if (child.name !== 'navPoint' && child.name !== 'li') continue;
      best = Math.min(best, rankOfSubtree(child, hrefOf));
    }
    return best;
  };

  /**
   * 把目录条目的标题文本换成新名字。
   *
   * 必须**先按标签名找到承载标题的那个元素**，再改它里面的文字节点。
   * 第一版是「在本条目下找第一个文字节点就改」—— 而 `<navLabel>` 的
   * 第一个子节点是**缩进用的空白文本**，新名字于是被写到了 `<text>` 外面：
   *
   *   <navLabel>证券分析（上）：整页图片…<text>证券分析（上）</text></navLabel>
   *
   * 读者看到的是「新名 + 旧名」粘在一起。
   */
  /** 记录「哪些文件的章节级条目已经改过名」—— 同一个文件的小节要保留自己的名字 */
  const renamedFiles = new Set();
  const applyRename = (el, hrefOf, textTags) => {
    const href = hrefOf(el);
    const name = href ? renameOf.get(href) : null;
    if (!name) return false;
    /**
     * **一个文件只改第一条**。
     *
     * 目录里同一个文件会出现很多次（章节标题 + 它下面的各个小节，
     * 都指向 `text00014.html#xxx`）。如果全都改成章节名，
     * 读者会看到「导读一/导读二/01 证券分析的范围…」全部变成
     * 同一个名字 —— 小节名全丢了。所以只改第一条（章节级），
     * 后面的小节保留自己的名字。
     */
    if (renamedFiles.has(href)) return false;
    renamedFiles.add(href);

    const findTag = (node) => {
      for (const child of node.children || []) {
        if (textTags.includes(child.name)) return child;
        const deeper = findTag(child);
        if (deeper) return deeper;
      }
      return null;
    };
    const target = findTag(el);
    if (!target) return false;
    const textNode = (target.children || []).find((c) => c.kind === 3 || c.nodeType === 3);
    if (!textNode) return false;
    textNode.value = name;
    textNode.dirty = true;
    textNode.markDirty?.();
    target.touch?.();
    return true;
  };

  /* ------------------------------------------------------------- NCX -- */
  const ncxHref = book.ncxItem?.href;
  if (ncxHref && book.zip.has(ncxHref)) {
    try {
      const doc = parseTocDoc(book, ncxHref, opts.replacements);
      const navMap = queryAll(doc.documentElement, 'navMap')[0];
      if (navMap) {
        const points = queryAll(navMap, 'navPoint').filter((el) => el.parentNode === navMap);
        const contentHref = (el) => {
          const c = queryAll(el, 'content')[0];
          const src = c?.getAttribute('src') || '';
          return resolveZipPath(ncxHref, src.split('#')[0]) || '';
        };
        /**
         * 改名要遍历**所有层级**的 navPoint，不能只改顶层。
         *
         * 这本书的目录是两层的：全书正文都嵌在「证券分析（上）（下）」
         * 两个顶层条目下面。只改顶层的话，读者在目录面板里看到的
         * 15~24 章还是原名 —— 等于没改。
         * （第一次就是这么错的，只改了 1 条。）
         */
        const renameAll = (nodes) => {
          for (const node of nodes || []) {
            if (node.name === 'navPoint') applyRename(node, contentHref, ['text']);
            if (node.children?.length) renameAll(node.children);
          }
        };
        renameAll(navMap.children);
        const sorted = sortByRank(points, (el) => rankOfSubtree(el, contentHref));
        navMap.touch();
        navMap.children = sorted;
        navMap.rebuilt = true;
        navMap.touch();
        /**
         * playOrder 必须跟着重排，否则有些阅读器按 playOrder 排序，白改。
         *
         * 注意这里**不能**用 queryAll 拿 navPoint：queryAll 是按**源文本位置**
         * 排序输出的，而重排恰恰改的是 children 数组的顺序 —— 两者不一致，
         * 结果是把原来的编号又原样写回去（1→np1、2→np2、3→np3），
         * 看起来"重排成功"，其实 playOrder 一点没变。
         */
        renumberNavPoints(navMap.children);
        updates.set(ncxHref, doc.serialize());
      }
    } catch (err) {
      issues.push(`NCX 重排跳过：${err.message}`);
    }
  }

  /* ------------------------------------------------------------- nav -- */
  const navHref = book.navItem?.href;
  if (navHref && book.zip.has(navHref)) {
    try {
      const doc = parseTocDoc(book, navHref, opts.replacements);
      const navs = queryAll(doc.documentElement, 'nav');
      const tocNav = navs.find((el) => (el.getAttribute('epub:type') || '').includes('toc')) || navs[0];
      const ol = tocNav ? queryAll(tocNav, 'ol')[0] : null;
      if (ol) {
        const items = queryAll(ol, 'li').filter((el) => el.parentNode === ol);
        const linkHref = (el) => {
          const a = queryAll(el, 'a')[0];
          const href = a?.getAttribute('href') || '';
          return resolveZipPath(navHref, href.split('#')[0]) || '';
        };
        /**
         * 改名去重必须**按文档各算各的**。
         *
         * `renamedFiles` 原本是 NCX 和 nav 共用一份：NCX 先跑完，把每个
         * href 都记成「已改名」，轮到 nav 时全被当成重复跳过 —— 结果
         * 目录面板（NCX）是简体新名字，EPUB3 nav（Apple Books、KOBO
         * 用的那一份）还是繁体原名，同一本书两个目录对不上。
         */
        renamedFiles.clear();
        for (const it of items) applyRename(it, linkHref, ['a']);
        const sorted = sortByRank(items, (el) => rankOfSubtree(el, linkHref));
        ol.touch();
        ol.children = sorted;
        ol.rebuilt = true;
        ol.touch();
        updates.set(navHref, doc.serialize());
      }
    } catch (err) {
      issues.push(`nav 重排跳过：${err.message}`);
    }
  }

  return { updates, issues };
}

/**
 * 导出文件名的 AI 标记。
 *
 * 为什么放在**最前面**而不是末尾加 ` - Personalized`：
 * 电子书文件名经常长到离谱（标题 + 译者 + 版本 + 来源站点），
 * 而所有文件管理器截断的都是**尾巴**。原来的 ` - Personalized` 后缀
 * 在用户的机器上就正好被截掉，看起来和原文件一模一样 ——
 * 用户的原话是「怎么还和上传的原文件名字一模一样」。
 * 放在开头，无论怎么截断都看得见。
 */
export const AI_MARKER = '【AI重写】';

/**
 * 没有替换任何正文时的标记。
 *
 * 这种情况只有「Phase 1 结构验收」那条路（不经过 AI 的导出）。
 * 它绝不能顶 `【AI重写】` 这个名字 —— 书里一个字都没改，
 * 标成 AI 重写就是骗人。
 */
export const PLAIN_MARKER = '【未改写副本】';

/** 文件名总长度上限（含标记与扩展名）。留足余量，避免被下游再截一刀。 */
const MAX_NAME_LENGTH = 110;

/**
 * 生成导出文件名：`【AI重写】原文件名.epub`（重名时加 ` (2)`）。
 *
 * 关键点：**先压缩原标题、再拼标记**，绝不能反过来。
 * 早先的实现是先拼好再交给 sanitizeFileName 截断，结果
 * 121 个字符的名字被砍到 120 —— 正好把 `Personalized` 的最后一个
 * `d` 砍掉，文件名变成 `... - Personalize.epub`。
 * 一个字的差别，看起来就像原文件名本身的一部分。
 *
 * @param {string} originalName
 * @param {Set<string>|string[]} [taken]
 * @param {{marker?: string}} [options] marker 默认 【AI重写】
 */
export function personalizedFileName(originalName, taken = [], options = {}) {
  const marker = String(options.marker || AI_MARKER);
  const takenSet = new Set([...taken].map((t) => String(t).toLowerCase()));
  const raw = String(originalName || '').replace(/\.epub$/i, '');
  const clean = sanitizeFileName(raw, 'book');
  const suffixLength = ' (99).epub'.length; // 给重名序号留出最宽的余量
  const budget = Math.max(20, MAX_NAME_LENGTH - marker.length - suffixLength);

  let base = clean;
  if (base.length > budget) {
    // 从中间省略，保留开头（书名）和结尾（版本 / 来源等辨识信息）
    const head = base.slice(0, Math.ceil(budget * 0.6));
    const tail = base.slice(-Math.floor(budget * 0.4) + 1);
    base = `${head}…${tail}`;
  }

  let candidate = `${marker}${base}.epub`;
  let n = 2;
  while (takenSet.has(candidate.toLowerCase())) {
    candidate = `${marker}${base} (${n}).epub`;
    n += 1;
  }
  return candidate;
}
