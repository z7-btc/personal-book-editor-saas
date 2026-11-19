/**
 * ZIP 读写往返测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import { writeZip, writeEpubZip, crc32 } from '../../lib/book-engine/epub/zip-writer.js';

const SAMPLE = [
  { name: 'hello.txt', data: 'Hello 世界' },
  { name: 'nested/dir/file.xml', data: '<a>1</a>' },
  { name: 'binary.bin', data: Buffer.from([0, 1, 2, 253, 254, 255]) },
  { name: 'empty.txt', data: '' },
];

test('writeZip -> ZipReader 往返：内容与条目名一致', () => {
  const buf = writeZip(SAMPLE);
  const reader = new ZipReader(buf);
  assert.equal(reader.list().filter((e) => !e.isDirectory).length, SAMPLE.length);
  for (const entry of SAMPLE) {
    assert.ok(reader.has(entry.name), `缺少条目 ${entry.name}`);
    const data = reader.read(entry.name);
    const expected = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    assert.deepEqual(data, expected);
  }
});

test('ZipReader 能读 Node 自己压缩出来的 deflate 条目', () => {
  const payload = 'x'.repeat(5000) + '这是一个会被压缩的条目';
  const buf = writeZip([{ name: 'big.txt', data: payload }]);
  const reader = new ZipReader(buf);
  assert.equal(reader.getEntry('big.txt').method, 8, '应当选择了 deflate');
  assert.equal(reader.readText('big.txt'), payload);
});

test('ZipReader 能读手工构造的 deflate 条目（模拟第三方工具产物）', () => {
  // 直接手搓一个最小 ZIP，确认解析器不是只认识自己写出来的东西
  const name = Buffer.from('manual.txt', 'utf8');
  const raw = Buffer.from('手动构造的内容 manual content', 'utf8');
  const deflated = zlib.deflateRawSync(raw);
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + deflated.length, 16);

  const zip = Buffer.concat([local, name, deflated, central, name, eocd]);
  const reader = new ZipReader(zip);
  assert.equal(reader.readText('manual.txt'), raw.toString('utf8'));
});

test('writeEpubZip 把 mimetype 放在第一个且 Store 且无 extra field', () => {
  const buf = writeEpubZip(SAMPLE);
  const reader = new ZipReader(buf);
  const first = reader.list()[0];
  assert.equal(first.name, 'mimetype');
  assert.equal(first.method, 0, 'mimetype 必须 Store');
  assert.equal(first.flags & 0x0800, 0x0800, '文件名必须标记 UTF-8');
  assert.equal(reader.read('mimetype').toString('utf8'), 'application/epub+zip');

  // 本地头 extra length 必须为 0
  const pos = first.localHeaderOffset;
  assert.equal(buf.readUInt16LE(pos + 28), 0);
});

test('readRaw 返回原始压缩字节，可用于原样搬运', () => {
  const buf = writeZip([{ name: 'a.txt', data: 'y'.repeat(4000) }]);
  const reader = new ZipReader(buf);
  const entry = reader.getEntry('a.txt');
  const rawSlice = reader.readRaw(entry);
  assert.equal(rawSlice.length, entry.compressedSize);
  assert.deepEqual(zlib.inflateRawSync(rawSlice), reader.read('a.txt'));
});

test('损坏的 ZIP 会抛出可读错误', () => {
  assert.throws(() => new ZipReader(Buffer.from('not a zip file at all')), /ZIP|中央目录/);
});

test('条目解压后长度不符会报错', () => {
  const buf = writeZip([{ name: 'ok.txt', data: 'abc' }]);
  const reader = new ZipReader(buf);
  reader.getEntry('ok.txt').uncompressedSize = 999;
  assert.throws(() => reader.read('ok.txt'), /大小不符/);
});
