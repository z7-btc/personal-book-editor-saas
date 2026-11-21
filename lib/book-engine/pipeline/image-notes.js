/**
 * 图片说明（image notes）：改写之前，先让模型「看懂」这一章的图。
 *
 * 为什么要单独存一份：
 *  - 视觉模型调用比文字贵、也慢，同一张图在一本书里只应该识别一次；
 *  - 改写可能因为质量检查重跑、可能暂停后恢复，说明必须能复用；
 *  - 换模型 / 调参数重新识别时，缓存要能看出这条说明是谁写的（model 字段）。
 *
 * 缓存落在 `workspace/books/<bookId>/image-notes.json`，键是图片在 zip 里的路径。
 * 单张失败只记 `error` 并退回图注，绝不打断整章改写 —— 图片说明是「帮模型看懂」，
 * 不是改写的前置条件。
 */

import fsp from 'node:fs/promises';
import { readJson, writeJson } from '../util/fsx.js';
import * as ws from './workspace.js';
import { describeImage, isVisionUnsupportedError } from '../llm/vision.js';
import { collectChapterImages, imageMimeType } from '../epub/image-map.js';
import { parseXml } from '../epub/xml-dom.js';
import { readEpub } from '../epub/epub-reader.js';

/** 与 settings.js 里的 images 默认值保持一致（这里是兜底，settings 才是唯一来源）。 */
export const DEFAULT_IMAGE_SETTINGS = {
  describe: true,
  providerId: null,
  maxPerBook: 120,
  maxBytes: 4194304,
  maxDescriptionChars: 500,
};

/** 本进程内已经确认「不支持图片输入」的 Provider（baseUrl|model）。 */
const unsupportedVisionProviders = new Set();

export function resetVisionSupportCache() {
  unsupportedVisionProviders.clear();
}

export function resolveImageSettings(settings) {
  const src = settings?.images && typeof settings.images === 'object' ? settings.images : {};
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    describe: src.describe !== false,
    providerId: typeof src.providerId === 'string' && src.providerId ? src.providerId : null,
    // 0 = 不限
    maxPerBook: num(src.maxPerBook, DEFAULT_IMAGE_SETTINGS.maxPerBook, 0, 100000),
    maxBytes: num(src.maxBytes, DEFAULT_IMAGE_SETTINGS.maxBytes, 1024, 200 * 1024 * 1024),
    maxDescriptionChars: num(
      src.maxDescriptionChars,
      DEFAULT_IMAGE_SETTINGS.maxDescriptionChars,
      80,
      2000,
    ),
  };
}

export function imageNotesPath(bookId) {
  return ws.bookPaths(bookId).imageNotes;
}

export async function readImageNotes(bookId) {
  const data = await readJson(imageNotesPath(bookId), {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export async function writeImageNotes(bookId, notes) {
  await writeJson(imageNotesPath(bookId), notes);
}

/** 图注兜底说明。没有图注时用 alt；两者都没有就明说没识别出来。 */
export function fallbackDescription(image, maxChars = DEFAULT_IMAGE_SETTINGS.maxDescriptionChars) {
  const caption = String(image?.captionText || '').trim();
  if (caption) return `图注：${caption}`.slice(0, maxChars);
  const alt = String(image?.alt || '').trim();
  if (alt) return `图中替代文本：${alt}`.slice(0, maxChars);
  return '（没有图注，图片内容未识别）';
}

function countVisionEntries(cache) {
  return Object.values(cache).filter((v) => v && v.source === 'vision').length;
}

function providerKey(provider) {
  return `${provider?.baseUrl || ''}|${provider?.model || ''}`;
}

/**
 * 为一章生成（或从缓存读取）图片说明。
 *
 * @param {Object} args
 * @param {string} args.bookId
 * @param {string} [args.chapterHref] 章节路径（解析图片相对路径用）
 * @param {string} [args.xhtml]       章节原文；不给就用 doc
 * @param {object} [args.doc]         已解析的文档
 * @param {object} [args.zip]         readEpub() 里的 zip（省一次解压整个 EPUB）
 * @param {object} args.provider      视觉模型 Provider（没有就全部退回图注）
 * @param {object} args.settings
 * @param {AbortSignal} [args.signal]
 * @param {(info: object) => void} [args.onProgress]
 * @returns {Promise<{images: Array<object>, stats: object}>}
 */
export async function buildChapterImageNotes(args) {
  const { bookId, provider, settings, signal, onProgress } = args;
  const cfg = resolveImageSettings(settings);

  let doc = args.doc || null;
  if (!doc && args.xhtml) doc = parseXml(args.xhtml);
  const images = doc ? collectChapterImages(doc, args.chapterHref || '') : [];

  const cache = await readImageNotes(bookId);
  let visionCount = countVisionEntries(cache);
  let changed = false;
  let described = 0;
  let fromCache = 0;
  let captionFallback = 0;
  let failed = 0;
  let visionCalls = 0;
  /** 只有真要读图时才打开 EPUB（大多数章节没有图）。 */
  let zip = args.zip || null;
  const ensureZip = async () => {
    if (zip) return zip;
    const buffer = await fsp.readFile(ws.bookPaths(bookId).original);
    zip = readEpub(buffer).zip;
    return zip;
  };

  const out = [];
  for (const image of images) {
    if (signal?.aborted) break;
    const key = image.zipPath || `#${image.index}`;
    const hit = cache[key];

    /** 已经识别过（或明确记录过失败）的图片：直接用缓存，不再请求。 */
    if (hit && typeof hit.description === 'string' && hit.description.trim()) {
      if (hit.source === 'vision') fromCache += 1;
      out.push({ ...publicImage(image), description: hit.description, source: hit.source || 'caption', error: hit.error || null });
      continue;
    }

    const base = publicImage(image);
    const useVision =
      cfg.describe &&
      Boolean(provider?.baseUrl && provider?.model) &&
      !unsupportedVisionProviders.has(providerKey(provider)) &&
      (cfg.maxPerBook === 0 || visionCount < cfg.maxPerBook);

    if (!useVision) {
      /**
       * 不缓存「因为设置关掉 / 没有 Provider / 额度用完」的兜底结果 ——
       * 这些都是临时的，缓存下来会让用户补好 Provider 之后仍然看不到识别结果。
       */
      captionFallback += 1;
      out.push({ ...base, description: fallbackDescription(image, cfg.maxDescriptionChars), source: 'caption', error: null });
      continue;
    }

    let reason = '';
    let buf = null;
    if (!image.zipPath) {
      reason = '外部图片或 data URL，读不到字节';
    } else if (imageMimeType(image.zipPath) === 'image/svg+xml') {
      reason = 'SVG 图片不送视觉模型';
    } else {
      try {
        const reader = await ensureZip();
        if (!reader.has(image.zipPath)) {
          reason = `图片不在压缩包里：${image.zipPath}`;
        } else {
          buf = reader.read(image.zipPath);
          if (buf.length > cfg.maxBytes) {
            reason = `图片超过 ${Math.round(cfg.maxBytes / 1024)} KB（${Math.round(buf.length / 1024)} KB）`;
            buf = null;
          }
        }
      } catch (err) {
        reason = `读取图片失败：${err.message}`;
      }
    }

    if (!buf) {
      // 与图片文件本身有关的原因（文件不在、太大、SVG）是稳定的，缓存下来避免每次重试。
      failed += 1;
      const description = fallbackDescription(image, cfg.maxDescriptionChars);
      cache[key] = {
        description,
        source: 'caption',
        model: null,
        updatedAt: new Date().toISOString(),
        error: reason,
      };
      changed = true;
      out.push({ ...base, description, source: 'caption', error: reason });
      continue;
    }

    onProgress?.({ phase: 'image-notes', image: image.index + 1, total: images.length, label: image.label });
    try {
      const result = await describeImage({
        provider,
        base64: buf.toString('base64'),
        mime: imageMimeType(image.zipPath),
        label: image.label,
        caption: image.captionText,
        alt: image.alt,
        maxChars: cfg.maxDescriptionChars,
        signal,
      });
      visionCalls += 1;
      visionCount += 1;
      described += 1;
      cache[key] = {
        description: result.description,
        source: 'vision',
        model: result.model || provider.model || null,
        updatedAt: new Date().toISOString(),
        error: null,
      };
      changed = true;
      out.push({ ...base, description: result.description, source: 'vision', error: null, model: result.model || provider.model });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORTED') throw err;
      visionCalls += 1;
      failed += 1;
      const description = fallbackDescription(image, cfg.maxDescriptionChars);
      cache[key] = {
        description,
        source: 'caption',
        model: null,
        updatedAt: new Date().toISOString(),
        error: String(err?.message || err).slice(0, 300),
      };
      changed = true;
      if (isVisionUnsupportedError(err)) {
        /**
         * Provider 明确说「我不支持图片」：本进程内后面的图不再尝试，
         * 否则一本书 377 张图会挨 377 个 400。
         */
        unsupportedVisionProviders.add(providerKey(provider));
      }
      out.push({ ...base, description, source: 'caption', error: String(err?.message || err).slice(0, 300) });
    }
  }

  if (changed) {
    try {
      await writeImageNotes(bookId, cache);
    } catch {
      // 缓存写失败不影响改写：最坏情况是下次重新识别
    }
  }

  return {
    images: out,
    stats: {
      total: images.length,
      described,
      fromCache,
      captionFallback,
      failed,
      visionCalls,
      /** 缓存里已识别（含本次与历史）的图片总数 */
      visionCached: visionCount,
      maxPerBook: cfg.maxPerBook,
    },
  };
}

/** 去掉 DOM 引用，只留可序列化的字段。 */
function publicImage(image) {
  return {
    index: image.index,
    zipPath: image.zipPath,
    src: image.src,
    alt: image.alt,
    label: image.label,
    captionText: image.captionText,
    anchorBlockIndex: image.anchorBlockIndex,
    containerClass: image.containerClass,
  };
}
