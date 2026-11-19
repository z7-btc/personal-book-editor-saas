/**
 * EPUB 读取 + 无损重打包测试（Phase 1 的核心验收）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readEpub, resolveZipPath, normalizeZipPath, countWords, isCjkText } from '../../lib/book-engine/epub/epub-reader.js';
import { repackEpub, personalizedFileName, AI_MARKER, insertFrontPage } from '../../lib/book-engine/epub/epub-writer.js';
import * as writeEpubZipModule from '../../lib/book-engine/epub/zip-writer.js';
import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { queryAll } from '../../lib/book-engine/epub/selector.js';
import { makeFixtureEpub } from './fixture-epub.js';

test('解析 EPUB：metadata / manifest / spine / TOC / 章节', () => {
  const book = readEpub(makeFixtureEpub());
  assert.equal(book.title, '测试之书：个人化编辑验证');
  assert.deepEqual(book.creators, ['测试作者']);
  assert.equal(book.metadata.language, 'zh-CN');
  assert.equal(book.version, '3.0');
  assert.equal(book.opfPath, 'OEBPS/content.opf');
  assert.equal(book.chapters.length, 4);

  const titles = book.chapters.map((c) => c.title);
  assert.deepEqual(titles, ['第一章 起点', '第二章 深入', '第三章 表格与代码', '注释']);

  assert.ok(book.navItem, '应当识别 EPUB3 nav');
  assert.ok(book.ncxItem, '应当识别 NCX');
  assert.ok(book.toc.length >= 4);
  assert.equal(book.warnings.length, 0);
});

test('没有 nav 的纯 EPUB2 也能解析（走 NCX 目录）', () => {
  const book = readEpub(makeFixtureEpub({ legacy: true }));
  assert.equal(book.version, '2.0');
  assert.equal(book.navItem, null);
  assert.ok(book.ncxItem);
  assert.equal(book.chapters.length, 4);
  assert.equal(book.chapters[0].title, '第一章 起点');
});

test('章节统计：字数 / CJK 判断', () => {
  const book = readEpub(makeFixtureEpub());
  const ch1 = book.chapters[0];
  const doc = book.getDocument(ch1.href);
  const text = doc.documentElement.textContent;
  assert.ok(countWords(text) > 100);
  assert.equal(isCjkText(text), true);
  assert.ok(text.includes('安全边际'));
});

test('★ Phase 1 验收：不经过 AI 重打包后，EPUB 仍然合法且内容完全一致', () => {
  const original = makeFixtureEpub();
  const book = readEpub(original);
  const { buffer, replacedCount, copiedCount, issues } = repackEpub(book);

  assert.equal(replacedCount, 0, '没有替换任何文件');
  assert.equal(issues.length, 0);
  assert.ok(copiedCount > 0);

  // 1) 输出可以被重新解析
  const reread = readEpub(buffer);
  assert.equal(reread.title, book.title);
  assert.equal(reread.chapters.length, book.chapters.length);

  // 2) 每个条目内容逐一比对
  const a = new ZipReader(original);
  const b = new ZipReader(buffer);
  const namesA = a.list().filter((e) => !e.isDirectory).map((e) => e.name).sort();
  const namesB = b.list().filter((e) => !e.isDirectory).map((e) => e.name).sort();
  assert.deepEqual(namesB, namesA, '条目列表必须一致');
  for (const name of namesA) {
    assert.deepEqual(b.read(name), a.read(name), `条目内容不一致: ${name}`);
  }

  // 3) mimetype 规范
  assert.equal(b.list()[0].name, 'mimetype');
  assert.equal(b.list()[0].method, 0);
});

test('重打包：只替换指定章节，其他条目字节级不变', () => {
  const original = makeFixtureEpub();
  const book = readEpub(original);
  const ch1 = book.chapters[0];
  const modified = book.zip.readXmlText(ch1.href).text.replace('第一章 起点', '第一章 起点（个人化）');

  const { buffer, replacedCount } = repackEpub(book, { replacements: new Map([[ch1.href, modified]]) });
  assert.equal(replacedCount, 1);

  const a = new ZipReader(original);
  const b = new ZipReader(buffer);
  assert.equal(b.readText(ch1.href).includes('（个人化）'), true);
  // CSS / 图片 / OPF / NCX / nav 必须逐字节相同
  for (const name of ['OEBPS/content.opf', 'OEBPS/toc.ncx', 'OEBPS/nav.xhtml', 'OEBPS/styles/main.css', 'OEBPS/images/cover.png']) {
    assert.deepEqual(b.read(name), a.read(name), `${name} 不应被改动`);
  }
  // 其他章节也不动
  assert.deepEqual(b.read(book.chapters[1].href), a.read(book.chapters[1].href));
});

test('重打包：替换路径不在原包中时直接报错（防止产出损坏文件）', () => {
  const book = readEpub(makeFixtureEpub());
  assert.throws(
    () => repackEpub(book, { replacements: new Map([['OEBPS/text/nope.xhtml', '<html/>']]) }),
    /不在原 EPUB 中/,
  );
});

test('重打包：ZIP 内存搬运确实没有重新压缩（字节复用）', () => {
  const original = makeFixtureEpub();
  const book = readEpub(original);
  const { buffer } = repackEpub(book);
  const a = new ZipReader(original);
  const b = new ZipReader(buffer);
  // 对每个未改动条目，压缩后的字节序列应当完全一致
  for (const entry of a.list().filter((e) => !e.isDirectory && e.name !== 'mimetype')) {
    const rawA = a.readRaw(entry);
    const rawB = b.readRaw(b.getEntry(entry.name));
    assert.deepEqual(rawB, rawA, `${entry.name} 的压缩字节被重写了`);
  }
});

test('OPF / manifest / spine 在重打包后完全不变', () => {
  const original = makeFixtureEpub();
  const book = readEpub(original);
  const ch2 = book.chapters[1];
  const { buffer } = repackEpub(book, {
    replacements: new Map([[ch2.href, book.zip.readXmlText(ch2.href).text.replace('深入', '更深入')]]),
  });
  const before = parseXml(new ZipReader(original).readText('OEBPS/content.opf'));
  const after = parseXml(new ZipReader(buffer).readText('OEBPS/content.opf'));
  assert.equal(after.serialize(), before.serialize());

  const spine = queryAll(after.documentElement, 'itemref').map((el) => el.getAttribute('idref'));
  assert.deepEqual(spine, ['ch1', 'ch2', 'ch3', 'notes']);
});

test('图片与 CSS 在重打包后仍然可被引用（路径不变）', () => {
  const book = readEpub(makeFixtureEpub());
  const { buffer } = repackEpub(book);
  const reader = new ZipReader(buffer);
  assert.ok(reader.has('OEBPS/images/figure1.png'));
  assert.ok(reader.has('OEBPS/styles/main.css'));
  const ch1 = reader.readText('OEBPS/text/chapter1.xhtml');
  assert.ok(ch1.includes('../images/figure1.png'));
  assert.ok(ch1.includes('../styles/main.css'));
});

test('resolveZipPath / normalizeZipPath 处理相对路径与 ../', () => {
  assert.equal(normalizeZipPath('./a/../b/c.xhtml'), 'b/c.xhtml');
  assert.equal(resolveZipPath('OEBPS/content.opf', 'text/ch1.xhtml'), 'OEBPS/text/ch1.xhtml');
  assert.equal(resolveZipPath('OEBPS/text/ch1.xhtml', '../images/a.png'), 'OEBPS/images/a.png');
  assert.equal(resolveZipPath('OEBPS/nav.xhtml', 'text/ch1.xhtml#sec'), 'OEBPS/text/ch1.xhtml');
  assert.equal(resolveZipPath('OEBPS/nav.xhtml', 'https://example.com/x'), null);
  assert.equal(resolveZipPath('OEBPS/nav.xhtml', 'text/%E4%B8%AD%E6%96%87.xhtml'), 'OEBPS/text/中文.xhtml');
});

test('personalizedFileName 生成带 AI 标记的下载名', () => {
  assert.equal(personalizedFileName('The Intelligent Investor.epub'), '【AI重写】The Intelligent Investor.epub');
  assert.equal(
    personalizedFileName('book.epub', ['【AI重写】book.epub']),
    '【AI重写】book (2).epub',
  );
  assert.ok(personalizedFileName('a/b:c.epub').startsWith('【AI重写】'));
  assert.ok(personalizedFileName('a/b:c.epub').endsWith('.epub'));
});

test('★ 回归：超长书名也要保住 AI 标记，不能被截断成原文件名', () => {
  // 用户真实遇到的书名（111 个字符 + 版本 + 来源站点）
  const longName =
    '证券分析：原书第6版(经典畅销版全两册)(投资者的圣经！巴菲特灵魂导师、“华尔街教父”！' +
    '本杰明·格雷厄姆 不朽著作！巴曙松领衔专业人士全新... (z-library.sk, 1lib.sk, z-lib.sk).epub';

  const name = personalizedFileName(longName, []);

  /**
   * 旧实现在这里出过一个「一个字母」的事故：
   * 先拼出 `原名 - Personalized.epub`（121 字符），
   * 再被 sanitizeFileName 截到 120 —— 正好砍掉 `Personalized` 的 `d`，
   * 结果文件名看起来和原文件一模一样，用户以为没加标记。
   */
  assert.ok(name.startsWith('【AI重写】'), `AI 标记必须在最前面（截断也砍不到）：${name}`);
  assert.ok(name.endsWith('.epub'), `扩展名必须完整：${name}`);
  assert.ok(name.length <= 120, `文件名不能长到被系统截断，实际 ${name.length} 字符`);
  assert.ok(name.includes('证券分析'), '书名主体要保留，用户还得认得出是哪本书');
  assert.ok(name.includes('…'), '过长时从中间省略，而不是丢掉整段尾巴');
  // 关键：不能只是「看起来像」，一个字都不能少
  assert.ok(name.startsWith(AI_MARKER), `标记必须一字不差，实际开头：${name.slice(0, AI_MARKER.length)}`);
});

test('重名时加序号，且序号不能把 AI 标记挤掉', () => {
  const longName = `${'很长很长'.repeat(30)}.epub`;
  const first = personalizedFileName(longName, []);
  const second = personalizedFileName(longName, [first]);
  assert.notEqual(second, first);
  assert.ok(second.startsWith('【AI重写】'));
  assert.match(second, / \(2\)\.epub$/);
  assert.ok(second.length <= 120, `加序号后也不能超长，实际 ${second.length}`);
});

test('★ 在最前面插一页「阅读路径」：只增不改，原书一个字都不能动', () => {
  const source = makeFixtureEpub();
  const book = readEpub(source);

  const before = {
    chapters: book.chapters.map((c) => ({ index: c.index, href: c.href, id: c.id })),
    spineIds: book.spine.map((s) => s.idref),
    manifestIds: [...book.manifestById.keys()].sort(),
  };

  const pageHref = 'text/pbe-reading-path.xhtml';
  const pageXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>阅读路径</title>
<link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>
<body><h1>这本书怎么读</h1><p>前面几篇推荐序已压缩成提要，直接从第一章开始。</p></body></html>`;

  const inserted = insertFrontPage(book, {
    id: 'pbe-reading-path',
    href: pageHref,
    title: '阅读路径',
    xhtml: pageXhtml,
  });

  const out = repackEpub(book, {
    replacements: new Map([[book.opfPath, inserted.opfText]]),
    additions: new Map([[`OEBPS/${pageHref}`, pageXhtml]]),
  });
  assert.equal(out.addedCount, 1);
  assert.equal(out.replacedCount, 1, '只应该替换 OPF 这一个文件');

  const after = readEpub(out.buffer);

  // 1) 新页在 spine 最前面 —— 打开书就是它
  //    注意 readEpub 给出的 chapter.href 是「规范化后的 ZIP 内路径」，
  //    不是相对 OPF 的路径
  //
  //    这一页**不进 chapters**：它是我们自己的导航页，不是原书章节。
  //    重新导入成品时如果把它当章节，它会跟着规划/改写/压缩再走一遍，
  //    导出时又和新目录页撞同一个路径（实测整页被覆盖成空壳）。
  //    所以位置要看 spine，章节列表要看 chapters。
  const pageZipPath = `OEBPS/${pageHref}`;
  assert.equal(after.spine[0].item?.href, pageZipPath, `第一页应该是阅读路径，实际 ${after.spine[0].item?.href}`);
  assert.equal(after.spine.length, before.spineIds.length + 1, 'spine 只多一页，不能少');
  assert.equal(after.chapters.length, before.chapters.length, '阅读路径页不算原书章节');

  /**
   * 2) 原有章节**一页不少、序号不乱、href 不变**。
   *    这是「只增不改」的核心保证：位置没动，指向它们的链接就不会失效。
   */
  const shifted = after.chapters.map((c) => ({ href: c.href, id: c.id }));
  assert.deepEqual(
    shifted.map((c) => c.href),
    before.chapters.map((c) => c.href),
    '原有章节的顺序和路径必须完全不变',
  );
  assert.deepEqual(shifted.map((c) => c.id), before.chapters.map((c) => c.id));

  // 3) spine / manifest 只增加一项
  assert.deepEqual(after.spine.map((s) => s.idref), ['pbe-reading-path', ...before.spineIds]);
  const addedManifest = [...after.manifestById.keys()].filter((k) => !before.manifestIds.includes(k));
  assert.deepEqual(addedManifest, ['pbe-reading-path']);

  // 4) 原书其它条目必须逐字节没动
  const zipA = new ZipReader(source);
  const zipB = new ZipReader(out.buffer);
  for (const name of ['OEBPS/nav.xhtml', 'OEBPS/toc.ncx', 'OEBPS/styles/main.css', 'OEBPS/images/figure1.png']) {
    assert.ok(zipB.read(name).equals(zipA.read(name)), `${name} 必须逐字节不变`);
  }

  // 5) 新页真的能读出来
  assert.ok(zipB.readText(pageZipPath).includes('这本书怎么读'));
});

test('★ 新增文件不允许覆盖已有条目（走错门要报错，不能改坏原书）', () => {
  const book = readEpub(makeFixtureEpub());
  assert.throws(
    () => repackEpub(book, { additions: new Map([['OEBPS/text/chapter1.xhtml', '<html/>']]) }),
    /重名/,
    '想改已有文件必须走 replacements，走 additions 要直接报错',
  );
});

test('★ 重复插入阅读路径要报错，不能插出两个', () => {
  const book = readEpub(makeFixtureEpub());
  const page = { id: 'pbe-reading-path', href: 'text/x.xhtml', title: 'x', xhtml: '<html><body>x</body></html>' };
  insertFrontPage(book, page);
  assert.throws(() => insertFrontPage(book, { ...page, href: 'text/y.xhtml' }), /已经有 id/);
});

test('缺少 container.xml / OPF 时给出可读错误', () => {
  const { writeEpubZip } = writeEpubZipModule;
  const noContainer = writeEpubZip([{ name: 'OEBPS/content.opf', data: '<package/>' }]);
  assert.throws(() => readEpub(noContainer), /container\.xml/);

  const badOpf = writeEpubZip([
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/missing.opf"/></rootfiles></container>' },
  ]);
  assert.throws(() => readEpub(badOpf), /OPF 文件不存在/);
});

test('mimetype 缺失或异常只产生告警，不阻止解析', () => {
  const { writeEpubZip } = writeEpubZipModule;
  const original = new ZipReader(makeFixtureEpub());
  const entries = original
    .list()
    .filter((e) => !e.isDirectory && e.name !== 'mimetype')
    .map((e) => ({ name: e.name, data: original.read(e) }));
  const book = readEpub(writeEpubZip(entries, { mimetype: 'application/zip' }));
  assert.ok(book.warnings.some((w) => w.includes('mimetype')));
  assert.equal(book.chapters.length, 4);
});
