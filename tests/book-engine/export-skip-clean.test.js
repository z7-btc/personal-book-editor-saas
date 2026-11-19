/**
 * 导出时的两件事：**没被改写的章节不能带着网页外壳出门**，
 * 以及**标题要和正文用同一种字**。
 *
 * 这两条都是「成品看着不太对」的实际来源（《朝花夕拾》实测）：
 *
 *   · 合集页被判成「原样保留」之后，导出走的是字节级搬运 ——
 *     整页繁体，顶上还挂着「←彷徨 朝花夕拾 作者：魯迅 故事新編→
 *     姊妹计划:百科·粤典·图册分类·数据项」，扉页还写着
 *     「以2026年11月17日从维基文库导出」。用户翻到那一页会觉得
 *     自己拿到的是没处理过的网页快照。
 *
 *   · 章节标题是模型按原书目录起的（繁体），正文是它改写的简体：
 *     「阿長與《山海經》：阿长买来绘图《山海经》…」—— 一个标题里两种字。
 *
 * 所以这里用一本最小的「维基文库式」样本走一遍真实的导入 → 导出。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeEpubZip } from '../../lib/book-engine/epub/zip-writer.js';
import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import { readEpub } from '../../lib/book-engine/epub/epub-reader.js';
import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook, exportBook } from '../../lib/book-engine/pipeline/book-service.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="zh">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:11111111-2222-3333-4444-555555555555</dc:identifier>
    <dc:title>朝花夕拾（测试样本）</dc:title>
    <dc:creator>魯迅</dc:creator>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">2026-11-17T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:11111111-2222-3333-4444-555555555555"/></head>
  <docTitle><text>朝花夕拾（测试样本）</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>合集頁</text></navLabel><content src="text/c1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>阿長與《山海經》</text></navLabel><content src="text/c2.xhtml"/></navPoint>
  </navMap>
</ncx>`;

/** 维基文库式的一页：导航表 / 姊妹计划 / 许可声明 / 导出水印，正文是繁体。 */
const C1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>合集頁</title><style>.licensetpl{display:none}</style></head>
<body>
<section>
<div id="headerContainer-n1"><table><tbody><tr>
<td>←<a href="c0.xhtml">彷徨</a></td>
<td><b>朝花夕拾</b><br/><span>作者：</span><a href="a.xhtml">魯迅</a></td>
<td><a href="c3.xhtml">故事新編</a>→</td>
</tr></tbody></table></div>
<ul id="plainSister-n2"><li>姊妹计划: <a href="https://zh.wikipedia.org">百科</a>·<a href="https://www.wikidata.org">数据项</a></li></ul>
<h3></h3>
<p>我常想在紛擾中尋出一點閒靜來，然而委實不容易。</p>
<p>　　</p>
<p>目前的離奇與蕪雜，也許委實是例外。</p>
<div class="licenseContainer"><p><span class="licensetpl_short">Public domain</span>falsefalse</p></div>
<h6>以2026年11月17日从维基文库导出</h6>
</section>
</body></html>`;

/** 一章干净的简体正文，用来验证「标题跟着正文走」。 */
const C2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><title>阿長與《山海經》</title></head>
<body><h1>阿長與《山海經》</h1><p>長媽媽，已經說過，是一個一向帶領著我的女工。</p></body></html>`;

/** 假定模型改写出来的那一版（简体，没有正文标题 —— 标题在导航表里）。 */
const C2_REWRITTEN = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><title>阿長與《山海經》</title></head>
<body><p>长妈妈，前面已经说过，她是一个一向带着我的女工。她喜欢切切察察，向人们低声絮说些什么事。</p><p>此后我就更其搜集绘图的書，于是有了石印的《尔雅音图》。</p></body></html>`;

function makeWikisourceEpub() {
  return writeEpubZip([
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/toc.ncx', data: NCX },
    { name: 'OEBPS/text/c1.xhtml', data: C1 },
    { name: 'OEBPS/text/c2.xhtml', data: C2 },
  ]);
}

test('★ 原样保留的章节也不能带着维基文库的网页外壳出门', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-skip-clean-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeWikisourceEpub(),
      fileName: 'chaohuaxishi.epub',
      profile: blankProfile(),
    });
    await ws.saveChapterRewritten(metadata.bookId, 2, C2_REWRITTEN);
    await ws.writeBookPlan(metadata.bookId, {
      entries: [
        { index: 1, title: '合集頁', displayTitle: '朝花夕拾（合集页）', strategy: 'skip', value: 'filler' },
        { index: 2, title: '阿長與《山海經》', displayTitle: '阿長與《山海經》：阿长买来绘图《山海经》', strategy: 'keep', value: 'core' },
      ],
    });

    const result = await exportBook({ bookId: metadata.bookId, chapters: [1, 2] });
    const buf = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, result.fileName));
    const zip = new ZipReader(buf);
    const out = readEpub(buf);
    const c1Href = metadata.chapters.find((c) => c.index === 1).href;
    const c2Href = metadata.chapters.find((c) => c.index === 2).href;

    // 1. 保留的章节还在（「原样保留」不是「删掉」）
    assert.ok(out.chapters.some((c) => c.href === c1Href), '标了 skip 的章节必须留在书里');

    // 2. 但它身上的网页外壳必须清掉
    const c1 = zip.readText(c1Href);
    for (const junk of ['姊妹计划', 'headerContainer', 'plainSister', 'Public domain', '从维基文库导出']) {
      assert.ok(!c1.includes(junk), `「${junk}」不该出现在成品里：${c1}`);
    }

    // 3. 正文一个字都不能少（内容不改写；整本书是简体，这一章的字形也跟着归一）
    assert.ok(c1.includes('我常想在纷扰中寻出一点闲静来'), `正文一个字都不能少：${c1.slice(-300)}`);
    assert.ok(c1.includes('目前的离奇与芜杂'), '正文一个字都不能少');
    assert.ok(!c1.includes('紛擾中尋出'), '整本书是简体时，保留章节的繁体正文也要归一到同一种字');
    assert.ok(c1.includes('朝花夕拾'), '本该由导航表提供的章名，要补进正文当标题');
    assert.ok(!c1.includes('<p>　　</p>'), '空白占位段落不该留着');
    assert.ok(c1.includes('.licensetpl'), '<head> 里的排版 CSS 不能删');

    // 4. 改写过的章节：标题跟正文一起走简体
    const c2 = zip.readText(c2Href);
    assert.ok(c2.includes('长妈妈，前面已经说过'), '改写结果要写进去');
    assert.ok(
      c2.includes('阿长与《山海经》：阿长买来绘图《山海经》'),
      `标题要和简体正文一致，实际：${c2.slice(0, 400)}`,
    );
    const c2Body = c2.slice(c2.indexOf('<body'));
    assert.ok(!c2Body.includes('阿長與'), `正文里的标题不该还剩繁体：${c2Body.slice(0, 200)}`);
    // 5. 章节文件自己的 <head><title> 也要换过来（阅读器顶栏、书签读的是它）
    const c2Head = c2.slice(0, c2.indexOf('<body'));
    assert.ok(
      c2Head.includes('阿长与《山海经》：阿长买来绘图《山海经》'),
      `章节 <title> 要和正文一致：${c2Head}`,
    );

    // 6. 简体正文里夹的繁体字要归一（模型抄原书时常带出一两个）
    assert.ok(c2.includes('搜集绘图的书'), `夹进来的繁体字要换成简体：${c2.slice(-300)}`);
    assert.ok(!c2.includes('書'), `正文里不该还有繁体字：${c2.slice(-300)}`);

    // 5. 目录里也用同一版标题
    const ncx = zip.readText(out.ncxItem.href);
    assert.ok(ncx.includes('阿长与《山海经》'), `NCX 标题要和正文一致：${ncx}`);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/**
 * 真实故障（《朝花夕拾》24 章版）：一键整理只把**处理成功**的章节传给导出
 * （jobs.js），标了 skip 的章节往往不在这个名单里 —— 于是它整页原样被搬进
 * 成品，扉页上还挂着「以2026年11月17日从维基文库导出」。
 */
test('★ 没进处理名单的「原样保留」章节，导出时同样要洗外壳、补章名', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-skip-clean-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeWikisourceEpub(),
      fileName: 'chaohuaxishi.epub',
      profile: blankProfile(),
    });
    await ws.saveChapterRewritten(metadata.bookId, 2, C2_REWRITTEN);
    await ws.writeBookPlan(metadata.bookId, {
      entries: [
        { index: 1, title: '合集頁', displayTitle: '朝花夕拾（合集页）', strategy: 'skip', value: 'filler' },
        { index: 2, title: '阿長與《山海經》', displayTitle: '阿長與《山海經》：阿长买来绘图《山海经》', strategy: 'keep', value: 'core' },
      ],
    });

    // 只有第 2 章进了处理名单 —— 模拟 jobs.js 的真实调用
    const result = await exportBook({ bookId: metadata.bookId, chapters: [2] });
    const buf = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, result.fileName));
    const zip = new ZipReader(buf);
    const out = readEpub(buf);
    const c1Href = metadata.chapters.find((c) => c.index === 1).href;

    assert.ok(out.chapters.some((c) => c.href === c1Href), '没进名单的保留章节也要留在书里');
    const c1 = zip.readText(c1Href);
    for (const junk of ['姊妹计划', 'headerContainer', '从维基文库导出', 'Public domain']) {
      assert.ok(!c1.includes(junk), `「${junk}」不该出现在成品里：${c1}`);
    }
    assert.ok(c1.includes('我常想在纷扰中寻出一点闲静来'), `正文一个字都不能少：${c1.slice(-300)}`);
    assert.ok(c1.includes('朝花夕拾'), '章名要补进正文当标题');
    const ncx = zip.readText(out.ncxItem.href);
    assert.ok(ncx.includes('朝花夕拾'), `NCX 里也要有这一章的标题：${ncx}`);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/**
 * 方案里的章号存成字符串时，导出也必须听方案的。
 *
 * 真事故的伏笔：`skipSet` 是 `new Set(entries.map(e => e.index))`，
 * 没有过 `Number()`。手改过的方案文件、旧版本写出的方案、某些客户端
 * 提交的 JSON 都可能存成 `"1"` —— 而导出时比较的是数字 `1`，
 * `has(1)` 永远 false。于是「方案说原样保留」的那一章，
 * 成品里顶上去的却是磁盘上更早留下的改写结果，界面上还写着「原样保留」。
 * 不报错、不告警，只有读者能看出来那句话和方案对不上。
 */
test('方案里的章号是字符串时，原样保留的章节仍用原文', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-skip-clean-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeWikisourceEpub(),
      fileName: 'chaohuaxishi.epub',
      profile: blankProfile(),
    });
    /** 第 1 章也留了一份更早的改写结果：方案说不许用，它就不能出现在成品里 */
    await ws.saveChapterRewritten(
      metadata.bookId,
      1,
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><title>合集頁</title></head>
<body><p>这一章其实是改写过的（不该出现在成品里）</p></body></html>`,
    );
    await ws.saveChapterRewritten(metadata.bookId, 2, C2_REWRITTEN);
    await ws.writeBookPlan(metadata.bookId, {
      entries: [
        { index: '1', title: '合集頁', displayTitle: '朝花夕拾（合集页）', strategy: 'skip', value: 'filler' },
        { index: '2', title: '阿長與《山海經》', displayTitle: '阿長與《山海經》：阿长买来绘图《山海经》', strategy: 'keep', value: 'core' },
      ],
    });

    const result = await exportBook({ bookId: metadata.bookId, chapters: [1, 2] });
    const buf = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, result.fileName));
    const zip = new ZipReader(buf);
    const c1Href = metadata.chapters.find((c) => c.index === 1).href;

    const c1 = zip.readText(c1Href);
    assert.ok(
      !c1.includes('这一章其实是改写过的'),
      `方案要求原样保留的章节不能被旧改写顶上去：${c1.slice(-300)}`,
    );
    assert.ok(c1.includes('我常想在纷扰中寻出一点闲静来'), '要用原文');
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
