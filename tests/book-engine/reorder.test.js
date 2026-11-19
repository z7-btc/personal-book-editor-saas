/**
 * 重排阅读顺序（spine + 目录）的测试。
 *
 * 这件事被我自己误判过一次：一开始把它和「合并章节」当成一类风险。
 * 实际上**重排只是排列**——文件名不变、内容不动，而 EPUB 里所有链接
 * 都是「文件名 + 锚点」形式、不含位置信息，所以一条链接都不会失效。
 * 真正危险的是搬内容（合并/拆分/删章）。
 *
 * 但重排有一个必须守住的硬约束：**顺序必须是完整排列**。
 * 少一项就是丢一章，而且阅读器不会报错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readEpub } from '../../lib/book-engine/epub/epub-reader.js';
import { repackEpub, reorderSpine, reorderToc, insertFrontPage } from '../../lib/book-engine/epub/epub-writer.js';
import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import { makeFixtureEpub } from './fixture-epub.js';

const spineIds = (book) => book.spine.map((s) => s.idref);

test('★ 重排 spine：顺序变了，但一章不少、链接全部可解析', () => {
  const source = makeFixtureEpub();
  const book = readEpub(source);
  const before = spineIds(book);
  assert.deepEqual(before, ['ch1', 'ch2', 'ch3', 'notes']);

  // 把注释挪到最前面（模拟"把前置挪到后面"的反向操作）
  const wanted = ['notes', 'ch3', 'ch1', 'ch2'];
  const { opfText } = reorderSpine(book, wanted);

  const out = repackEpub(book, { replacements: new Map([[book.opfPath, opfText]]) });
  const after = readEpub(out.buffer);

  assert.deepEqual(spineIds(after), wanted, 'spine 顺序应为目标顺序');
  assert.equal(after.chapters.length, book.chapters.length, '章节数不能变');
  assert.deepEqual(
    after.chapters.map((c) => c.href).sort(),
    book.chapters.map((c) => c.href).sort(),
    '文件集合必须一模一样（只是换了次序）',
  );

  // 内容一个字节都不能动
  const zipIn = new ZipReader(source);
  const zipOut = new ZipReader(out.buffer);
  for (const name of ['OEBPS/text/chapter1.xhtml', 'OEBPS/text/endnotes.xhtml', 'OEBPS/styles/main.css']) {
    assert.ok(zipOut.read(name).equals(zipIn.read(name)), `${name} 不该被改动`);
  }

  // 交叉引用照样能用：第 1 章的脚注链接指向 endnotes
  const ch1 = zipOut.readText('OEBPS/text/chapter1.xhtml');
  assert.ok(ch1.includes('endnotes.xhtml#n1'), '正文里的链接还在');
  assert.ok(zipOut.readText('OEBPS/text/endnotes.xhtml').includes('id="n1"'), '锚点也还在');
});

test('★ 重排顺序少了 / 多了 / 重复了，都必须直接报错（否则会丢章节）', () => {
  const book = readEpub(makeFixtureEpub());

  assert.throws(() => reorderSpine(book, ['ch1', 'ch2', 'ch3']), /项数不对/, '少一项必须报错');
  assert.throws(() => reorderSpine(book, ['ch1', 'ch2', 'ch3', 'notes', 'ch9']), /项数不对/, '多一项必须报错');
  assert.throws(() => reorderSpine(book, ['ch1', 'ch1', 'ch3', 'notes']), /重复/, '重复必须报错');
  assert.throws(() => reorderSpine(book, ['ch1', 'ch2', 'ch3', 'nope']), /不存在/, '不存在的项必须报错');
});

test('★ 同步重排 NCX 目录，让目录顺序和翻页顺序一致', () => {
  const book = readEpub(makeFixtureEpub());
  const wanted = ['OEBPS/text/chapter3.xhtml', 'OEBPS/text/chapter1.xhtml', 'OEBPS/text/chapter2.xhtml', 'OEBPS/text/endnotes.xhtml'];

  const { updates, issues } = reorderToc(book, wanted);
  assert.deepEqual(issues, [], `不该有跳过：${issues.join('；')}`);
  assert.ok(updates.has('OEBPS/toc.ncx'), 'NCX 应被重排');

  const out = repackEpub(book, { replacements: updates });

  /**
   * 断言用**解析后的目录**，不用正则。
   * 第一版拿正则去配 navPoint 和 content，遇到嵌套的 navPoint
   * （第二章下面有 2.1 子节）就配错了对，测出来少一项 ——
   * 那是测试写错，不是重排错了。用阅读器自己解析出来的结果最接近真实。
   */
  const after = readEpub(out.buffer);
  const topHrefs = after.toc.map((t) => t.href.split('#')[0]);
  assert.equal(topHrefs[0], 'OEBPS/text/chapter3.xhtml', `目录第一条应是第三章，实际 ${topHrefs[0]}`);

  // 三级验证：spine 一起改过之后，目录里出现的章节，相对顺序必须跟 spine 一致
  const { opfText } = reorderSpine(after, ['ch3', 'ch1', 'ch2', 'notes']);
  const both = readEpub(repackEpub(after, { replacements: new Map([[after.opfPath, opfText]]) }).buffer);
  const spineHrefs = both.chapters.map((c) => c.href);
  const tocHrefs = [...new Set(both.toc.map((t) => t.href.split('#')[0]))];
  assert.deepEqual(
    tocHrefs.filter((h) => spineHrefs.includes(h)),
    spineHrefs.filter((h) => tocHrefs.includes(h)),
    '目录里出现的章节，顺序应与 spine 一致',
  );

  // playOrder 要连续，否则有阅读器按 playOrder 排序，等于白改
  const ncx = new ZipReader(out.buffer).readText('OEBPS/toc.ncx');
  const plays = [...ncx.matchAll(/playOrder="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(plays, plays.map((_, i) => i + 1), `playOrder 应重排为 1..n，实际 ${plays.join(',')}`);

  /**
   * EPUB3 的 nav 也要一起重排，而且**嵌套的子节点必须跟着父节点走**。
   * 这个 fixture 里第二章下面挂着 2.1 子节，重排时不能把它弄丢。
   */
  assert.ok(updates.has('OEBPS/nav.xhtml'), 'nav 也应被重排');
  const nav = new ZipReader(out.buffer).readText('OEBPS/nav.xhtml');
  assert.ok(nav.includes('sec-2-1'), '导航里的子节点锚点必须保留');
  const navOrder = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(navOrder[0].split('#')[0], 'text/chapter3.xhtml', 'nav 第一条应是第三章');
  assert.ok(navOrder.some((h) => h.includes('#sec-2-1')), '子节条目还在');
});

test('★ 重排之后再插页，新页仍然在最前面（queryAll 会按源位置排序，不能用它找"第一个"）', () => {
  const book = readEpub(makeFixtureEpub());
  // 先重排，把 notes 挪到第一位
  const { opfText } = reorderSpine(book, ['notes', 'ch3', 'ch1', 'ch2']);
  const step1 = repackEpub(book, { replacements: new Map([[book.opfPath, opfText]]) });
  const mid = readEpub(step1.buffer);
  assert.equal(mid.spine[0].idref, 'notes');

  // 再往最前面插一页
  const pageHref = 'text/pbe-reading-path.xhtml';
  const page = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>怎么读</h1></body></html>';
  const inserted = insertFrontPage(mid, { id: 'pbe-reading-path', href: pageHref, title: '怎么读', xhtml: page });
  const out = repackEpub(mid, {
    replacements: new Map([[mid.opfPath, inserted.opfText]]),
    additions: new Map([[`OEBPS/${pageHref}`, page]]),
  });
  const after = readEpub(out.buffer);

  /**
   * 这里曾经出过 bug：insertFrontPage 用 queryAll(spineEl,'itemref')[0]
   * 找"当前第一个"，而 queryAll 按**源文本位置**排序 ——
   * 重排之后数组顺序和源位置不一致，它返回的是「原本排第一」的那个，
   * 新页于是被插到了书中间（实测插到了第 15 章前面）。
   */
  assert.equal(after.spine[0].idref, 'pbe-reading-path', `新页必须在第一位，实际 ${after.spine[0].idref}`);
  assert.deepEqual(after.spine.map((s) => s.idref), ['pbe-reading-path', 'notes', 'ch3', 'ch1', 'ch2'], '重排结果不能被插页破坏');
});

test('目录里认不出的条目不会被丢掉，只是排到最后', () => {
  const book = readEpub(makeFixtureEpub());
  // 只声明一部分文件顺序，其余应保持原相对次序排在最后
  const { updates, issues } = reorderToc(book, ['OEBPS/text/chapter3.xhtml']);
  assert.deepEqual(issues, []);
  const ncx = new ZipReader(repackEpub(book, { replacements: updates }).buffer).readText('OEBPS/toc.ncx');
  const srcs = [...ncx.matchAll(/<content[^>]*src="([^"]+)"/g)].map((m) => m[1].split('#')[0]);
  assert.equal(srcs[0], 'text/chapter3.xhtml', '指定的排最前');
  assert.equal(new Set(srcs).size, srcs.length, '一条都不能重复');
  assert.ok(srcs.includes('text/chapter1.xhtml'), '没指定的不能消失');
});

/**
 * 目录改名要**同时**落到 NCX 和 EPUB3 nav 上。
 *
 * 实测：NCX（目录面板）改成了「阿长与《山海经》：…」，nav（Apple Books、
 * KOBO 读的那一份）还是繁体原名 —— 同一个文件只改到第一份。
 * 原因是「一个文件只改第一条」的去重集合在 NCX 跑完后没有清空，
 * nav 里每条都被当成重复跳过了。
 */
test('★ 目录改名：NCX 和 EPUB3 nav 两份都要改，且各自只改章节级那条', () => {
  const book = readEpub(makeFixtureEpub());
  const rename = new Map([
    ['OEBPS/text/chapter3.xhtml', '第三章：表格与代码的排法'],
  ]);
  const wanted = book.chapters.map((c) => c.href);
  const { updates, issues } = reorderToc(book, wanted, { renameByHref: rename });
  assert.deepEqual(issues, []);

  const zip = new ZipReader(repackEpub(book, { replacements: updates }).buffer);
  const ncx = zip.readText('OEBPS/toc.ncx');
  const nav = zip.readText('OEBPS/nav.xhtml');

  assert.ok(ncx.includes('第三章：表格与代码的排法'), `NCX 没改名：${ncx}`);
  assert.ok(nav.includes('第三章：表格与代码的排法'), `nav 没改名：${nav}`);
  assert.ok(!nav.includes('>第三章 表格与代码<'), `nav 里不该还留着旧名：${nav}`);
});
