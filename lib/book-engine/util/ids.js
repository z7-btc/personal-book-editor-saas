/**
 * ID / 文件名工具。
 */

import crypto from 'node:crypto';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 生成短、可读、按时间有序的 book id：b_<base36 time>_<rand> */
export function newBookId() {
  const t = Date.now().toString(36);
  let r = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) r += ID_ALPHABET[b % ID_ALPHABET.length];
  return `b_${t}_${r}`;
}

export function shortHash(input, len = 10) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, len);
}

/** 章节目录名：001, 002 ... */
export function chapterDirName(index) {
  return String(index).padStart(3, '0');
}

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 清理成安全的文件名（用于下载的 EPUB 文件名，不用于磁盘内部路径）。
 *
 * `maxLength` 默认 120。**调用方要注意**：这是「从尾巴上砍」，
 * 砍掉的很可能是有意义的后缀（比如 AI 标记）。真实事故：
 * 导出名先被拼成 121 个字符，再在这里被截到 120，
 * 正好把 `Personalized` 的最后一个 `d` 砍掉，用户的成品文件名
 * 看起来和原文件一模一样。需要保留后缀的场景请先压缩主体，
 * 或者显式传一个够大的 maxLength。
 *
 * @param {string} name
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @param {number} [maxBytes] UTF-8 字节上限。字符数不等于字节数：一个汉字
 *        3 个字节，ext4/APFS 的单个文件名上限是 255 **字节**。
 *        所以「240 个字符」的中文书名实际是 720 字节，写盘直接
 *        ENAMETOOLONG（真实事故：长书名导出失败，见 test/regression.test.js）。
 *        默认 200 字节，给 `.epub`、原子写的 `.<名字>.123456.tmp` 后缀留出余量。
 */
export function sanitizeFileName(name, fallback = 'book', maxLength = 120, maxBytes = 200) {
  let out = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!out) out = fallback;
  if (WINDOWS_RESERVED.has(out.toUpperCase())) out = `_${out}`;
  if (out.length > maxLength) out = out.slice(0, maxLength).trim();
  out = truncateToBytes(out, maxBytes);
  return out;
}

/**
 * 按 UTF-8 字节数截断，**保头也保尾**。
 *
 * 只从尾巴砍会砍掉「 - Personalized」这类标记，用户就分不清成品和原书；
 * 从中间切掉、两头保留，标记和书名都能看见。按 code point 切，
 * 不会把 emoji / 生僻字切成半个（那会得到 U+FFFD）。
 */
export function truncateToBytes(text, maxBytes) {
  const src = String(text || '');
  if (Buffer.byteLength(src, 'utf8') <= maxBytes) return src;
  const chars = [...src];
  const ellipsis = '…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  let headBytes = 0;
  let tailBytes = 0;
  let headEnd = 0;
  let tailStart = chars.length;
  // 62% 给头（书名、AI 标记都在开头），38% 给尾（版本、Personalized 这类后缀）
  const headBudget = Math.floor(budget * 0.62);
  const tailBudget = budget - headBudget;
  while (headEnd < chars.length) {
    const b = Buffer.byteLength(chars[headEnd], 'utf8');
    if (headBytes + b > headBudget) break;
    headBytes += b;
    headEnd += 1;
  }
  while (tailStart > headEnd) {
    const b = Buffer.byteLength(chars[tailStart - 1], 'utf8');
    if (tailBytes + b > tailBudget) break;
    tailBytes += b;
    tailStart -= 1;
  }
  const head = chars.slice(0, headEnd).join('').trim();
  const tail = chars.slice(tailStart).join('').trim();
  return `${head}${ellipsis}${tail}`;
}

/** 校验 bookId 格式，避免路径穿越。 */
export function assertSafeBookId(id) {
  if (typeof id !== 'string' || !/^b_[a-z0-9]+_[a-z0-9]+$/.test(id)) {
    const err = new Error(`非法 bookId: ${String(id)}`);
    err.status = 400;
    err.expose = true;
    throw err;
  }
  return id;
}
