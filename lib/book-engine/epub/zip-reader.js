/**
 * 零依赖 ZIP 读取器。
 *
 * 为什么自己写：EPUB 就是一个 ZIP。我们要做到「不重新生成整个 EPUB」，
 * 就必须能按条目（entry）字节级读写，并且对没改动过的条目原样搬运。
 * 只用 Node 内置 zlib，无第三方依赖。
 *
 * 支持：Store(0) / Deflate(8)、data descriptor（sizes=0 时从中央目录取值）、
 * Zip64（条目数、大小、local header offset）。加密条目会明确报错。
 */

import zlib from 'node:zlib';
import { ZipError } from '../util/errors.js';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const MAX_COMMENT = 0xffff;
const EOCD_MIN_SIZE = 22;

/** 计算 Zip64 extra field 里的 8 字节值。 */
function readUInt64LE(buf, offset) {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError('ZIP 条目过大，超出 JavaScript 安全整数范围');
  }
  return Number(value);
}

/** 扫描 EOCD（从尾部往前找，最多 64KB + 22 字节）。 */
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - MAX_COMMENT - EOCD_MIN_SIZE);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError('不是合法的 ZIP/EPUB 文件（找不到中央目录结束记录）');
}

/**
 * @typedef {Object} ZipEntry
 * @property {string} name        条目名（POSIX 风格）
 * @property {number} method      0=store 8=deflate
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} crc32
 * @property {number} localHeaderOffset
 * @property {number} dosTime
 * @property {number} dosDate
 * @property {number} externalAttributes
 * @property {number} flags
 * @property {string} comment
 * @property {boolean} isDirectory
 */

export class ZipReader {
  /** @param {Buffer} buffer */
  constructor(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new ZipError('ZipReader 需要 Buffer');
    this.buffer = buffer;
    /** @type {Map<string, ZipEntry>} */
    this.entries = new Map();
    this.entryList = [];
    this.comment = '';
    this._parse();
  }

  static from(buffer) {
    return new ZipReader(buffer);
  }

  _parse() {
    const buf = this.buffer;
    const eocdPos = findEocd(buf);
    let entryCount = buf.readUInt16LE(eocdPos + 10);
    let centralSize = buf.readUInt32LE(eocdPos + 12);
    let centralOffset = buf.readUInt32LE(eocdPos + 16);
    const commentLen = buf.readUInt16LE(eocdPos + 20);
    this.comment = buf.subarray(eocdPos + 22, eocdPos + 22 + commentLen).toString('utf8');

    // Zip64：EOCD 字段被写满时看 Zip64 EOCD locator
    const needZip64 =
      entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
    if (needZip64) {
      const locPos = eocdPos - 20;
      if (locPos >= 0 && buf.readUInt32LE(locPos) === SIG_EOCD64_LOC) {
        const z64Pos = readUInt64LE(buf, locPos + 8);
        if (buf.readUInt32LE(z64Pos) === SIG_EOCD64) {
          entryCount = readUInt64LE(buf, z64Pos + 32);
          centralSize = readUInt64LE(buf, z64Pos + 40);
          centralOffset = readUInt64LE(buf, z64Pos + 48);
        }
      }
    }

    let pos = centralOffset;
    for (let i = 0; i < entryCount; i += 1) {
      if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
        throw new ZipError(`中央目录损坏（第 ${i + 1} 条记录）`);
      }
      const flags = buf.readUInt16LE(pos + 8);
      const method = buf.readUInt16LE(pos + 10);
      const dosTime = buf.readUInt16LE(pos + 12);
      const dosDate = buf.readUInt16LE(pos + 14);
      const crc32 = buf.readUInt32LE(pos + 16);
      let compressedSize = buf.readUInt32LE(pos + 20);
      let uncompressedSize = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLength = buf.readUInt16LE(pos + 32);
      const externalAttributes = buf.readUInt32LE(pos + 38);
      let localHeaderOffset = buf.readUInt32LE(pos + 42);

      const nameStart = pos + 46;
      const rawName = buf.subarray(nameStart, nameStart + nameLen);
      const name = decodeEntryName(rawName, flags);
      const extra = buf.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
      const entryComment = buf
        .subarray(nameStart + nameLen + extraLen, nameStart + nameLen + extraLen + commentLength)
        .toString('utf8');

      // Zip64 extra field (0x0001) 按顺序补齐溢出的字段
      if (
        uncompressedSize === 0xffffffff ||
        compressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        let ep = 0;
        while (ep + 4 <= extra.length) {
          const headerId = extra.readUInt16LE(ep);
          const dataSize = extra.readUInt16LE(ep + 2);
          if (headerId === 0x0001) {
            let dp = ep + 4;
            if (uncompressedSize === 0xffffffff) {
              uncompressedSize = readUInt64LE(extra, dp);
              dp += 8;
            }
            if (compressedSize === 0xffffffff) {
              compressedSize = readUInt64LE(extra, dp);
              dp += 8;
            }
            if (localHeaderOffset === 0xffffffff) {
              localHeaderOffset = readUInt64LE(extra, dp);
              dp += 8;
            }
            break;
          }
          ep += 4 + dataSize;
        }
      }

      /** @type {ZipEntry} */
      const entry = {
        name,
        method,
        compressedSize,
        uncompressedSize,
        crc32,
        localHeaderOffset,
        dosTime,
        dosDate,
        externalAttributes,
        flags,
        comment: entryComment,
        isDirectory: name.endsWith('/'),
      };
      if (this.entries.has(name)) {
        // 重复条目：保留第一个（EPUB 里 mimetype 偶尔被重复写入）
        this.entryList.push(entry);
      } else {
        this.entries.set(name, entry);
        this.entryList.push(entry);
      }
      pos = nameStart + nameLen + extraLen + commentLength;
    }
  }

  has(name) {
    return this.entries.has(name);
  }

  getEntry(name) {
    return this.entries.get(name) || null;
  }

  list() {
    return this.entryList.slice();
  }

  /**
   * 读取条目原始（仍压缩）的字节切片。
   * @param {string|ZipEntry} entryOrName
   */
  readRaw(entryOrName) {
    const entry = typeof entryOrName === 'string' ? this.getEntry(entryOrName) : entryOrName;
    if (!entry) throw new ZipError(`ZIP 中不存在条目: ${String(entryOrName)}`);
    const buf = this.buffer;
    const pos = entry.localHeaderOffset;
    if (pos + 30 > buf.length || buf.readUInt32LE(pos) !== SIG_LOCAL) {
      throw new ZipError(`条目本地头损坏: ${entry.name}`);
    }
    if (entry.flags & 0x0001) {
      throw new ZipError(`条目被加密，无法读取: ${entry.name}`);
    }
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const dataStart = pos + 30 + nameLen + extraLen;
    return buf.subarray(dataStart, dataStart + entry.compressedSize);
  }

  /**
   * 解压并返回条目内容 Buffer。
   * @param {string|ZipEntry} entryOrName
   * @returns {Buffer}
   */
  read(entryOrName) {
    const entry = typeof entryOrName === 'string' ? this.getEntry(entryOrName) : entryOrName;
    if (!entry) throw new ZipError(`ZIP 中不存在条目: ${String(entryOrName)}`);
    const raw = this.readRaw(entry);
    let out;
    if (entry.method === METHOD_STORE) {
      out = Buffer.from(raw);
    } else if (entry.method === METHOD_DEFLATE) {
      try {
        out = zlib.inflateRawSync(raw);
      } catch (err) {
        throw new ZipError(`条目解压失败: ${entry.name} - ${err.message}`, { cause: err });
      }
    } else {
      throw new ZipError(`不支持的压缩方式 ${entry.method}（条目 ${entry.name}）`);
    }
    if (entry.uncompressedSize && out.length !== entry.uncompressedSize) {
      throw new ZipError(
        `条目解压后大小不符: ${entry.name}（期望 ${entry.uncompressedSize}，实际 ${out.length}）`,
      );
    }
    return out;
  }

  /** 以 UTF-8 文本读取条目。 */
  readText(entryOrName) {
    return this.read(entryOrName).toString('utf8');
  }

  /**
   * 读取条目，带 BOM 检测的文本（UTF-8 / UTF-16）。
   * XHTML 规范建议 UTF-8，但现实里存在 UTF-16 的老书。
   */
  readXmlText(entryOrName) {
    const buf = this.read(entryOrName);
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le', bom: true };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      // UTF-16BE：Node 没有内置解码，手工交换字节
      const swapped = Buffer.from(buf.subarray(2));
      swapped.swap16();
      return { text: swapped.toString('utf16le'), encoding: 'utf-16be', bom: true };
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8', bom: true };
    }
    return { text: buf.toString('utf8'), encoding: 'utf-8', bom: false };
  }
}

/** 文件名编码：flags bit 11 = UTF-8，否则按 CP437（这里退化为 latin1，够用）。 */
function decodeEntryName(raw, flags) {
  if (flags & 0x0800) return raw.toString('utf8');
  // 常见情况其实也是 UTF-8；先按 UTF-8 试，出现替换字符则退回 latin1
  const utf8 = raw.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return raw.toString('latin1');
}

export { METHOD_STORE, METHOD_DEFLATE };
