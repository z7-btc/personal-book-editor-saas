/**
 * 零依赖 ZIP 写入器。
 *
 * 关键约束（EPUB 规范 OCF 3.x）：
 *  1. `mimetype` 必须是第一个条目；
 *  2. 必须使用 Store（不压缩）；
 *  3. 不能有 extra field（也就是「不填充」）。
 * 这里的 writer 把这三条固化下来，避免生成出「能解压但阅读器不认」的 EPUB。
 */

import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;
const VERSION_20 = 20;

/* ---------------------------------------------------------------- CRC32 -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/**
 * @param {Buffer|Uint8Array|string} input
 * @returns {number} 无符号 32 位 CRC
 */
export function crc32(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/* ------------------------------------------------------------ DOS time -- */

/** JS Date -> DOS date/time 两个 16 位值。 */
export function toDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

/** 把 ZIP 里的 DOS 时间还原成 ISO 字符串（供 UI 展示）。 */
export function fromDosDateTime(dosDate, dosTime) {
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = (dosDate >> 5) & 0x0f;
  const day = dosDate & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const minute = (dosTime >> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/* --------------------------------------------------------------- Writer -- */

/**
 * @typedef {Object} ZipWriteEntry
 * @property {string} name
 * @property {Buffer|Uint8Array|string} data
 * @property {number} [method]       默认 deflate；0 = store
 * @property {Buffer} [rawData]      已压缩的字节。给了它就**不再压缩**，直接搬运
 *                                   （用于「不重新生成整个 EPUB」的原字节复用）
 * @property {number} [uncompressedSize] rawData 提供时用于写头（默认取 data.length）
 * @property {number} [crc]          rawData 提供时可直接给 CRC，省一次计算
 * @property {number} [dosTime]
 * @property {number} [dosDate]
 * @property {number} [externalAttributes]
 * @property {boolean} [directory]
 */

/**
 * 生成 ZIP 字节。
 * @param {ZipWriteEntry[]} entries
 * @param {{comment?: string, level?: number}} [options]
 * @returns {Buffer}
 */
export function writeZip(entries, options = {}) {
  const level = options.level ?? 9;
  const now = new Date();
  const { dosTime: nowTime, dosDate: nowDate } = toDosDateTime(now);

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeName(entry.name);
    const nameBuf = Buffer.from(name, 'utf8');
    const isDirectory = entry.directory === true || name.endsWith('/');
    const data = isDirectory ? Buffer.alloc(0) : toBuffer(entry.data);

    let payload;
    let finalMethod;
    let uncompressedSize = data.length;
    let crc;

    if (entry.rawData) {
      // 原字节搬运：完全跳过压缩，压缩方式由调用方指定
      payload = toBuffer(entry.rawData);
      finalMethod = entry.method === undefined ? METHOD_DEFLATE : entry.method;
      uncompressedSize = entry.uncompressedSize ?? data.length;
      crc = entry.crc ?? crc32(data);
    } else {
      const requested = entry.method === METHOD_STORE || isDirectory ? METHOD_STORE : METHOD_DEFLATE;
      if (requested === METHOD_STORE) {
        payload = data;
        finalMethod = METHOD_STORE;
      } else {
        payload = zlib.deflateRawSync(data, { level });
        // 压缩没收益时退化为 Store（很多 zip 工具的做法，也更安全）
        if (payload.length >= data.length) {
          payload = data;
          finalMethod = METHOD_STORE;
        } else {
          finalMethod = METHOD_DEFLATE;
        }
      }
      crc = crc32(data);
    }

    const dosTime = entry.dosTime ?? nowTime;
    const dosDate = entry.dosDate ?? nowDate;
    const externalAttributes = entry.externalAttributes ?? (isDirectory ? 0x41ed0010 : 0x81a40000);

    // ---- local file header ----
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(finalMethod, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field 长度必须为 0（mimetype 要求不填充）
    localChunks.push(local, nameBuf, payload);

    // ---- central directory record ----
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION_20 | (3 << 8), 4); // made by: unix
    central.writeUInt16LE(VERSION_20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(finalMethod, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralOffset = offset;
  const centralBuf = Buffer.concat(centralChunks);
  const commentBuf = Buffer.from(options.comment || '', 'utf8');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([...localChunks, centralBuf, eocd, commentBuf]);
}

/**
 * 生成「EPUB 合法」的 ZIP：mimetype 强制第一个且 Store。
 * @param {ZipWriteEntry[]} entries 不含 mimetype
 * @param {{mimetype?: string, level?: number, comment?: string}} [options]
 */
export function writeEpubZip(entries, options = {}) {
  const mimetype = options.mimetype || 'application/epub+zip';
  const rest = entries.filter((e) => normalizeName(e.name) !== 'mimetype');
  return writeZip(
    [
      {
        name: 'mimetype',
        data: Buffer.from(mimetype, 'ascii'),
        method: METHOD_STORE,
      },
      ...rest,
    ],
    { level: options.level, comment: options.comment },
  );
}

function normalizeName(name) {
  return String(name).replace(/\\/g, '/').replace(/^\/+/, '');
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new TypeError('ZIP 条目数据必须是 Buffer / Uint8Array / string');
}

export { METHOD_STORE, METHOD_DEFLATE };
