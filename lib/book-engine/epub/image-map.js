/**
 * 图片地图：把一章里的图、表扫描图、公式图找出来，并标出「不能交给模型改写」的块。
 *
 * 为什么需要这一层（用户的实际反馈）：
 *  - 图注（`p.biaoti` / `p.tuti` / `p.biaozhu` / `figcaption`）原本是普通段落，
 *    会被模型当成正文扩写 —— 实测《证券分析》第 6 版 451 个图注块有 42 个被改，
 *    「表26-1」被写成「表 26-1」，图注一变长，版式和图片位置就对不上了；
 *  - 整页图 / 公式图的容器（`div.equation_img`、`div.sign_img-r`）在
 *    `blockToPlainText` 里只剩一个 `⟦n⟧` 占位符，模型收到一屏「只有编号的段落」，
 *    既浪费 token，又可能往里塞字，把图片挤走。
 *
 * 这里只做**结构判断**，不调模型、不读图片字节：
 *  - `collectChapterImages` 找 img，往上找最近的图片容器，取出图注与图号；
 *  - `annotateBlocks` 给块打 `preserve`（'image-caption' / 'image-only'）与
 *    `imageRefs`（块内直接含图的占位符编号），供 rewrite 阶段过滤。
 */

import { resolveZipPath as resolveEpubZipPath } from './epub-reader.js';

/** 图片容器：`<figure>`，或 class 里带这些词的元素。 */
export const IMAGE_CONTAINER_CLASS_RE = /img|figure|chatu|equation|table_img|pic/i;

/** 图注元素：标签或 class 命中其一即可。 */
const CAPTION_TAGS = new Set(['figcaption', 'caption']);
const CAPTION_CLASS_TOKENS = new Set([
  'biaoti', 'tuti', 'biaozhu', 'caption', 'figcaption',
  'figure-caption', 'table-caption', 'tablecaption', 'fig-caption',
]);

/** 图号：「表0-1」「图 12-3」「Figure 4-2」「Table 1」…… */
export const IMAGE_LABEL_RE = /^(表|图|图表|Figure|Table)\s*[A-Za-z0-9０-９.．-]+/;

function localName(el) {
  return String(el?.name || '').toLowerCase();
}

function classTokens(el) {
  const raw = String(el?.getAttributeLoose?.('class') ?? el?.getAttribute?.('class') ?? '');
  return raw.split(/\s+/).filter(Boolean);
}

function isInside(node, ancestor) {
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parentNode;
  }
  return false;
}

/** 元素本身是不是「图片容器」（只看结构，不猜正文）。 */
export function isImageContainer(el) {
  if (!el || el.kind !== 2) return false;
  if (localName(el) === 'figure') return true;
  const cls = String(el.getAttributeLoose?.('class') ?? el.getAttribute?.('class') ?? '');
  return Boolean(cls) && IMAGE_CONTAINER_CLASS_RE.test(cls);
}

/** 元素是不是图注块（figcaption / caption / p.biaoti / p.tuti / p.biaozhu …）。 */
export function isCaptionElement(el) {
  if (!el || el.kind !== 2) return false;
  if (CAPTION_TAGS.has(localName(el))) return true;
  return classTokens(el).some((t) => CAPTION_CLASS_TOKENS.has(t.toLowerCase()));
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\s 　]+/g, ' ')
    .trim();
}

/** 在一个容器里找图注元素，按可信度排序。 */
export function findCaptionElement(container) {
  if (!container) return null;
  const all = [container, ...(container.descendants?.() || [])].filter((el) => el?.kind === 2);
  const pick = (pred) => all.find(pred) || null;
  return (
    pick((el) => localName(el) === 'figcaption') ||
    pick((el) => localName(el) === 'caption') ||
    pick((el) => classTokens(el).some((t) => t.toLowerCase() === 'biaoti')) ||
    pick((el) => classTokens(el).some((t) => t.toLowerCase() === 'tuti')) ||
    pick((el) => classTokens(el).some((t) => /caption|figcaption/i.test(t))) ||
    pick((el) => classTokens(el).some((t) => t.toLowerCase() === 'biaozhu')) ||
    null
  );
}

/**
 * 把 `src` 解析成 EPUB 内的 zip 路径（相对章节文件）。
 *
 * 直接复用 `epub-reader.js` 的 `resolveZipPath`：它做了 URL 解码
 * （`%20` → 空格）和以 `/` 开头的绝对路径处理，和导出、目录解析
 * 用的是同一套规则。之前这里自己实现了一份，`../images/img%20one.jpg`
 * 和 `/images/a.jpg` 会解析错，图片静默跳过识图。
 *
 * 参数顺序保持原来的 `(src, chapterHref)`；外链 / data URL 返回空字符串
 * （读不到字节，只能退回图注）。
 */
export function resolveZipPath(src, chapterHref = '') {
  const raw = String(src ?? '').trim();
  if (!raw) return '';
  return resolveEpubZipPath(chapterHref, raw) || '';
}

/** 图片扩展名 → MIME。EPUB 里的图片绝大多数是 jpg/png/gif/svg。 */
export function imageMimeType(zipPath) {
  const ext = String(zipPath || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
  return 'application/octet-stream';
}

/**
 * 找出这一章里的所有图片。
 *
 * @param {import('./xml-dom.js').XmlDocument} doc
 * @param {string} chapterHref 章节在 zip 里的路径（用来解析相对 src）
 * @param {{blocks?: import('./sanitize.js').Block[]}} [opts] 传 blocks 时补上 anchorBlockIndex
 * @returns {Array<{
 *   index: number, zipPath: string, src: string, alt: string, label: string,
 *   captionText: string, anchorBlockIndex: number, containerClass: string|null,
 *   element: object, container: object|null, captionElement: object|null
 * }>}
 */
export function collectChapterImages(doc, chapterHref, opts = {}) {
  const root = doc?.documentElement;
  if (!root) return [];
  const blocks = opts.blocks || null;
  const out = [];
  const seen = new Set();

  root.walk((el) => {
    if (localName(el) !== 'img') return;
    if (seen.has(el)) return;
    seen.add(el);

    const src =
      el.getAttribute?.('src') ??
      el.getAttributeLoose?.('src') ??
      el.getAttribute?.('xlink:href') ??
      '';
    const alt = String(el.getAttribute?.('alt') ?? el.getAttributeLoose?.('alt') ?? '');

    /**
     * 向上找最近的图片容器。
     *
     * 有明确线索（figure / class 命中）就用它；没有线索时只接受
     * 「文本不超过 500 字、而且里面真有图注」的最近祖先 ——
     * 否则一段普通正文里的行内图片会把整章 body 当成容器。
     */
    let container = null;
    let cur = el.parentNode;
    let depth = 0;
    let fallback = null;
    while (cur && cur.kind === 2 && depth < 6) {
      const name = localName(cur);
      if (name === 'body' || name === 'html') break;
      if (isImageContainer(cur)) {
        container = cur;
        break;
      }
      if (!fallback && normalizeText(cur.textContent).length <= 500 && findCaptionElement(cur)) {
        fallback = cur;
      }
      cur = cur.parentNode;
      depth += 1;
    }
    if (!container && fallback) container = fallback;

    const captionElement = container ? findCaptionElement(container) : null;
    const captionText = normalizeText(captionElement?.textContent ?? '').slice(0, 400);
    // 图号优先从图注认；没有图注时看 alt（很多书的 alt 就写着「图0-2」）
    const labelMatch = captionText.match(IMAGE_LABEL_RE) || normalizeText(alt).match(IMAGE_LABEL_RE);

    let anchorBlockIndex = -1;
    if (blocks) {
      const captionBlock = captionElement
        ? blocks.find((b) => b.element === captionElement)
        : null;
      const containerBlock = container ? blocks.find((b) => b.element === container) : null;
      const containingImgBlock = blocks.find((b) => isInside(el, b.element));
      anchorBlockIndex =
        captionBlock?.index ?? containerBlock?.index ?? containingImgBlock?.index ?? -1;
    }

    out.push({
      index: out.length,
      zipPath: resolveZipPath(src, chapterHref),
      src: String(src),
      alt,
      label: labelMatch ? labelMatch[0].replace(/\s+$/, '') : '',
      captionText,
      anchorBlockIndex,
      containerClass: container
        ? String(container.getAttributeLoose?.('class') ?? container.getAttribute?.('class') ?? '') || null
        : null,
      element: el,
      container,
      captionElement,
    });
  });

  return out;
}

/** 去掉占位符之后还剩不剩字（只用来判断「这块是不是只有图」）。 */
function stripPlaceholders(text) {
  return String(text ?? '').replace(/⟦[^⟧]*⟧/g, '');
}

/**
 * 这一块是不是「某张图/表的图注」。
 *
 * `figcaption` / `caption` 标签本身就是图注；`p.biaozhu`（表注）天然属于表格。
 * 其余靠 class 认的（`p.biaoti` / `p.tuti` / `.caption`…）必须真挨着一张图
 * （在图容器里），或者文字本身就是「表6-1 …」这种图号开头 ——
 * 否则普通书里拿 `biaoti` 当小标题用的段落也会被误判成图注、不再改写。
 */
function isCaptionBlockForImage(block, images) {
  const el = block.element;
  if (CAPTION_TAGS.has(localName(el))) return true;
  if (!isCaptionElement(el)) return false;
  if (classTokens(el).some((t) => t.toLowerCase() === 'biaozhu')) return true;
  if (images.some((img) => img.container && isInside(el, img.container))) return true;
  return IMAGE_LABEL_RE.test(normalizeText(el.textContent));
}

/**
 * 给块打上「原样保留」标记，并给含图但不保留的块记下图片占位符。
 *
 * @param {import('./xml-dom.js').XmlDocument} doc
 * @param {import('./sanitize.js').Block[]} blocks
 * @param {{chapterHref?: string, images?: Array<object>}} [opts]
 * @returns {{images: Array<object>, stats: {imageCount: number, preservedCaptionBlocks: number, preservedImageBlocks: number}}}
 */
export function annotateBlocks(doc, blocks, opts = {}) {
  const images = opts.images || collectChapterImages(doc, opts.chapterHref || '', { blocks });
  const stats = { imageCount: images.length, preservedCaptionBlocks: 0, preservedImageBlocks: 0 };

  // 图片的锚块（图注块优先）补到 image 上，供 status / 提示词使用
  for (const img of images) {
    if (Number.isInteger(img.anchorBlockIndex) && img.anchorBlockIndex >= 0) continue;
    const inside = blocks.find((b) => isInside(img.element, b.element));
    img.anchorBlockIndex = inside ? inside.index : -1;
  }

  for (const block of blocks) {
    const blockImages = images.filter((img) => isInside(img.element, block.element));

    if (isCaptionBlockForImage(block, images)) {
      block.preserve = 'image-caption';
      block.imageRefs = [];
      stats.preservedCaptionBlocks += 1;
      continue;
    }

    if (!blockImages.length) continue;

    /**
     * 只有图的块：`<div class="equation_img"><img/></div>`、`<p><img/></p>`。
     * 判断看**去掉占位符之后的文本**，不看类名 —— 有些书根本不给类名。
     */
    // 延迟 import 会打断同步链路；这里直接内联等价逻辑（与 blockToPlainText 一致：
    // 图片等行内元素都会变成 ⟦n⟧，所以「只剩占位符」就是「没有文字」）。
    const text = block.element.textContent;
    let imageOnly = stripPlaceholders(normalizeText(text)).trim() === '';
    if (!imageOnly) {
      // 容器本身包着图（哪怕容器里还有一些排版空格），也当成整图块
      imageOnly = blockImages.some((img) => img.container === block.element) && !normalizeText(text);
    }

    if (imageOnly) {
      block.preserve = 'image-only';
      block.imageRefs = [];
      stats.preservedImageBlocks += 1;
      continue;
    }

    block.imageRefs = blockImages.map((img) => ({ image: img, n: null }));
  }

  return { images, stats };
}

/**
 * 把「已经识别的图片说明」（按 zipPath）合并回新解析出来的图片列表。
 *
 * `buildChapterImageNotes` 在自己的 doc 上找图，`prepareChapter` 又解析一次，
 * 两个 DOM 的节点对象不是同一批，只能按 zipPath 对上。
 *
 * @param {Array<object>} images prepareChapter 自己找到的图
 * @param {Array<object>} [enriched] buildChapterImageNotes 的产物
 */
export function mergeImageNotes(images, enriched) {
  if (!Array.isArray(enriched) || !enriched.length) return images;
  const byPath = new Map();
  enriched.forEach((img, i) => {
    if (img?.zipPath) byPath.set(img.zipPath, img);
    byPath.set(`#${i}`, img);
  });
  images.forEach((img, i) => {
    const hit = (img.zipPath && byPath.get(img.zipPath)) || byPath.get(`#${i}`);
    if (!hit) return;
    img.description = hit.description || '';
    img.descriptionSource = hit.source || '';
    img.descriptionError = hit.error || null;
  });
  return images;
}
