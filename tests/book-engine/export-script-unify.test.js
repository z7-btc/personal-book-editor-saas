/**
 * 一本书只能有一种字。
 *
 * 真实成品（《朝花夕拾》导出后）：9 章改写里 8 章简体、第 4 章整章繁体 ——
 * 模型改写时跟着原书抄，同一批请求里也会摇摆。逐章各管各的，
 * 读者翻到中间那一章会以为拿到了另一本书。
 *
 * 所以判定放在整本书这一层：改写结果里占多数的那种字，全书照它走。
 * 这里 3 章里 2 章简体、1 章繁体 → 成品必须全简体（标题、正文、目录一致）。
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
    <dc:identifier id="pub-id">urn:uuid:99999999-2222-3333-4444-555555555555</dc:identifier>
    <dc:title>朝花夕拾（字形样本）</dc:title>
    <dc:creator>魯迅</dc:creator>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">2026-11-17T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="text/c3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:99999999-2222-3333-4444-555555555555"/></head>
  <docTitle><text>朝花夕拾（字形样本）</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>第一章</text></navLabel><content src="text/c1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>第二章</text></navLabel><content src="text/c2.xhtml"/></navPoint>
    <navPoint id="np3" playOrder="3"><navLabel><text>第三章</text></navLabel><content src="text/c3.xhtml"/></navPoint>
  </navMap>
</ncx>`;

const ORIGINAL = (title) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><title>${title}</title></head>
<body><h1>${title}</h1><p>長媽媽，已經說過，是一個一向帶領著我的女工。</p></body></html>`;

const REWRITTEN = (headTitle) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><title>${headTitle}</title></head>
<body><p>长妈妈，前面已经说过，她是一个一向带着我的女工。她喜欢切切察察，向人们低声絮说些什么事。</p></body></html>`;

/** 模型漂移出来的那一章：整章繁体。 */
const REWRITTEN_TRADITIONAL = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><title>第三章</title></head>
<body><p>我常想在紛擾中尋出一點閒靜來，然而委實不容易。目前的離奇與蕪雜，也許委實是例外。</p></body></html>`;

test('★ 同一本书里某一章漂成繁体时，整本书按多数派的字归一', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-script-unify-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: writeEpubZip([
        { name: 'META-INF/container.xml', data: CONTAINER },
        { name: 'OEBPS/content.opf', data: OPF },
        { name: 'OEBPS/toc.ncx', data: NCX },
        { name: 'OEBPS/text/c1.xhtml', data: ORIGINAL('第一章') },
        { name: 'OEBPS/text/c2.xhtml', data: ORIGINAL('第二章') },
        { name: 'OEBPS/text/c3.xhtml', data: ORIGINAL('第三章') },
      ]),
      fileName: 'script.epub',
      profile: blankProfile(),
    });
    await ws.saveChapterRewritten(metadata.bookId, 1, REWRITTEN('第一章'));
    await ws.saveChapterRewritten(metadata.bookId, 2, REWRITTEN('阿長與《山海經》'));
    await ws.saveChapterRewritten(metadata.bookId, 3, REWRITTEN_TRADITIONAL);
    await ws.writeBookPlan(metadata.bookId, {
      entries: [
        { index: 1, title: '第一章', displayTitle: '狗·猫·鼠', strategy: 'keep', value: 'core' },
        { index: 2, title: '第二章', displayTitle: '阿長與《山海經》', strategy: 'keep', value: 'core' },
        { index: 3, title: '第三章', displayTitle: '二十四孝圖', strategy: 'keep', value: 'core' },
      ],
    });

    const result = await exportBook({ bookId: metadata.bookId, chapters: [1, 2, 3] });
    const buf = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, result.fileName));
    const zip = new ZipReader(buf);
    const out = readEpub(buf);

    const href = (index) => metadata.chapters.find((c) => c.index === index).href;

    // 漂移的那一章：正文归一成简体
    const c3 = zip.readText(href(3));
    assert.ok(c3.includes('我常想在纷扰中寻出一点闲静来'), `繁体章要归一成简体：${c3.slice(0, 300)}`);
    assert.ok(!c3.includes('紛擾'), `不该还剩繁体字：${c3.slice(0, 300)}`);

    // 标题跟着整本书走，而不是跟着这一章自己的正文走
    const c3Body = c3.slice(c3.indexOf('<body'));
    assert.ok(c3Body.includes('二十四孝图'), `章名要跟全书同一种字：${c3Body.slice(0, 200)}`);

    // 其它两章本身是简体，不能被反过来转成繁体
    const c1 = zip.readText(href(1));
    assert.ok(c1.includes('长妈妈，前面已经说过'), '简体章保持简体');

    // 目录和章节 <head><title> 也要一致
    const ncx = zip.readText(out.ncxItem.href);
    assert.ok(ncx.includes('阿长与《山海经》'), `NCX 标题要是简体：${ncx}`);
    assert.ok(!ncx.includes('阿長與'), `NCX 里不该再有繁体标题：${ncx}`);
    const c2Head = zip.readText(href(2)).slice(0, zip.readText(href(2)).indexOf('<body'));
    assert.ok(c2Head.includes('阿长与《山海经》'), `章节 <title> 要是简体：${c2Head}`);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
