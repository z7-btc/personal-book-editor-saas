/**
 * 「整章删除」的测试。
 *
 * 这是全套操作里**唯一不可逆**的一刀：压缩至少还留下「这一章讲了什么」
 * 的几百字，删除之后读者再也看不到它。所以护栏比别处都硬，
 * 每一条都要有测试钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { dropChapters } from '../../lib/book-engine/epub/epub-writer.js';
import { readEpub } from '../../lib/book-engine/epub/epub-reader.js';
import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { queryAll } from '../../lib/book-engine/epub/selector.js';
import { normalizeCard, dropAllowed } from '../../lib/book-engine/pipeline/book-plan.js';
import { makeFixtureEpub } from './fixture-epub.js';

const chapterOf = (book, index) => book.chapters.find((c) => c.index === index);
const hrefsOf = (spineEl) =>
  (spineEl.children || []).filter((el) => el.name === 'itemref').map((el) => el.getAttribute('idref'));

test('删章会同时从 spine、manifest、NCX 里拿掉，但文件本身留着', () => {
  const epub = readEpub(makeFixtureEpub());
  const target = chapterOf(epub, 2);
  const before = epub.spine.length;

  const r = dropChapters(epub, [{ id: target.id, href: target.href, index: 2, title: '第二章' }]);
  assert.equal(r.removed.length, 1);
  assert.equal(r.refused.length, 0);

  const doc = parseXml(r.opfText);
  const spineEl = queryAll(doc.documentElement, 'spine')[0];
  const manifestEl = queryAll(doc.documentElement, 'manifest')[0];
  const ids = hrefsOf(spineEl);

  assert.equal(ids.length, before - 1, 'spine 要少一项');
  assert.ok(!ids.includes(target.id), 'spine 里不能再有它');
  assert.ok(
    !queryAll(manifestEl, 'item').some((el) => el.getAttribute('id') === target.id),
    'manifest 里也要清掉',
  );

  // NCX 里对应的 navPoint 必须一起消失，否则目录点进去是个不存在的页
  const ncxText = r.tocUpdates.get(epub.ncxItem.href);
  assert.ok(ncxText, 'NCX 要有更新');
  assert.ok(!ncxText.includes('text/chapter2.xhtml'), `NCX 里不该再指向它：${ncxText.slice(0, 300)}`);

  // playOrder 要连续，否则按 playOrder 排序的阅读器会出现空档
  const orders = [...ncxText.matchAll(/playOrder="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(orders, orders.map((_, i) => i + 1), `playOrder 要连续：${orders.join(',')}`);

  /**
   * ZIP 里的文件**一个字节都不能动**。
   * 万一还有别处以我们没识别出的方式引用它，文件还在原处；
   * 用户想从原书里核对也找得到。
   */
  const zip = new ZipReader(makeFixtureEpub());
  assert.ok(zip.has(target.href), '被删章节的文件仍应留在压缩包里');
});

test('★ 还有别人指着的章节不许删', () => {
  const epub = readEpub(makeFixtureEpub());
  const target = chapterOf(epub, 1);

  const r = dropChapters(
    epub,
    [{ id: target.id, href: target.href, index: 1, title: '第一章' }],
    { blocked: new Map([[target.id, '有 3 条链接从第 2 章指向它，删掉会让这些链接点不动']]) },
  );

  assert.equal(r.removed.length, 0, '被指着就不能删');
  assert.equal(r.refused.length, 1);
  assert.ok(r.refused[0].reason.includes('点不动'), `理由要说清楚：${r.refused[0].reason}`);

  // 什么都没动
  const doc = parseXml(r.opfText);
  assert.equal(hrefsOf(queryAll(doc.documentElement, 'spine')[0]).length, epub.spine.length);
});

test('★ 不能把整本书删空', () => {
  const epub = readEpub(makeFixtureEpub());
  const all = epub.chapters.map((c) => ({ id: c.id, href: c.href, index: c.index }));
  assert.throws(
    () => dropChapters(epub, all),
    /不能把书删空/,
    '与其产出一本打不开的空书，不如直接报错',
  );
});

test('★ 删掉的条目是「容器」时，必须把子条目提上来，不能连子树一起删', () => {
  /**
   * 真实事故，代价是把整本书的目录削掉了 92%。
   *
   * 用户那本书的 NCX 是**分层**的：全书正文（第一~第八部分、52 章）
   * 整个挂在「证券分析（上）」「证券分析（下）」两个顶层条目下面。
   * 而这两条恰好指向分册扉页 —— 整页图片，被判为 filler 删掉了。
   *
   * 第一版的 `detach()` 把**整棵子树**一起带走：成品的目录从 89 条
   * 掉到 7 条，读者打开目录只看到附录、推荐序、跋，正文 52 章全没了，
   * 而且不报任何错。所以这条测试必须钉死「容器被删时子条目要提上来」。
   */
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="x"/></head>
  <docTitle><text>测试书</text></docTitle>
  <navMap>
    <navPoint id="vol1" playOrder="1">
      <navLabel><text>上册（分册扉页，整页图片）</text></navLabel>
      <content src="text/divider.xhtml"/>
      <navPoint id="c1" playOrder="2">
        <navLabel><text>第一章</text></navLabel>
        <content src="text/chapter1.xhtml#h-1"/>
      </navPoint>
      <navPoint id="c2" playOrder="3">
        <navLabel><text>第二章</text></navLabel>
        <content src="text/chapter2.xhtml#h-2"/>
      </navPoint>
    </navPoint>
    <navPoint id="leaf" playOrder="4">
      <navLabel><text>第三章</text></navLabel>
      <content src="text/chapter3.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

  const epub = readEpub(makeFixtureEpub());
  const fake = {
    ...epub,
    ncxItem: { href: 'OEBPS/toc.ncx' },
    navItem: null,
    zip: {
      has: (n) => n === 'OEBPS/toc.ncx',
      readXmlText: (n) => ({ text: n === 'OEBPS/toc.ncx' ? ncx : '' }),
      readText: (n) => (n === 'OEBPS/toc.ncx' ? ncx : ''),
    },
  };

  /**
   * 删掉「上册」这个容器 —— 注意它指向的是**分册扉页**（独立文件），
   * 不是任何一章的正文。这正是真实书里的形状：
   * `证券分析（上）` → 整页图片的扉页，而全书 52 章挂在它下面。
   */
  const r = dropChapters(fake, [
    { id: epub.chapters[0].id, href: 'OEBPS/text/divider.xhtml', index: 1, title: '上册' },
  ]);

  const ncxText = r.tocUpdates.get('OEBPS/toc.ncx');
  assert.ok(ncxText, 'NCX 要有更新');
  const doc = parseXml(ncxText);
  const navMap = queryAll(doc.documentElement, 'navMap')[0];
  const points = queryAll(navMap, 'navPoint');

  assert.equal(
    points.length,
    3,
    `容器删了但子条目要留下 —— 期望 3 条（第一、二章 + 第三章），实际 ${points.length}`,
  );
  const labels = points.map((p) => queryAll(p, 'text')[0]?.textContent?.trim());
  assert.ok(labels.includes('第一章') && labels.includes('第二章'), `嵌套的两章必须还在：${labels.join(' | ')}`);
  assert.ok(!labels.includes('上册（整页图片）'), '容器自己要被删掉');

  const orders = points.map((p) => Number(p.getAttribute('playOrder')));
  assert.deepEqual(orders, [1, 2, 3], `playOrder 要连续：${orders.join(',')}`);
});

test('spine 里没有的项删不掉，如实报告而不是假装成功', () => {
  const epub = readEpub(makeFixtureEpub());
  const r = dropChapters(epub, [{ id: 'nope', href: 'x.xhtml', index: 99, title: '幽灵章' }]);
  assert.equal(r.removed.length, 0);
  assert.equal(r.refused[0].reason, 'spine 里找不到这一项');
});

test('★ drop 只对 filler 开放，其它价值档次一律降级', () => {
  /**
   * 用户的原话是「把那些和知识无关、纯粹吹牛赞美这本书的章节删掉」。
   * 那就严格按这个范围来 —— 判断代码不能比授权走得更远。
   * 推荐序、各版前言这类 `context` 里有作者自己交代的写作意图和版本差异，
   * 那是读书的钥匙，压成提要可以，删掉不行。
   */
  assert.equal(dropAllowed('filler'), true);
  for (const v of ['core', 'useful', 'context']) {
    assert.equal(dropAllowed(v), false, `${v} 不该允许删除`);
    const card = normalizeCard({ value: v, strategy: 'drop' }, { index: 1, title: 'x', textLength: 100 });
    assert.notEqual(card.strategy, 'drop', `${v} 被标 drop 时必须降级，实际 ${card.strategy}`);
  }

  // filler 确实可以删（否则这个功能就没用了）
  const filler = normalizeCard({ value: 'filler', strategy: 'drop' }, { index: 9, title: '版权页', textLength: 200 });
  assert.equal(filler.strategy, 'drop');
});

/* ------------------------------------------------------------ 端到端 -- */

test('★ 端到端：标了 drop 的章节要从成品里真的消失', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');
  const { importBook, exportBook } = await import('../../lib/book-engine/pipeline/book-service.js');
  const { blankProfile } = await import('../../lib/book-engine/config/profile.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-drop-e2e-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeFixtureEpub(),
      fileName: 'drop.epub',
      profile: blankProfile(),
    });

    /**
     * 第 3 章标成 drop。fixture 里没有任何东西指向它，
     * 所以护栏不该拦；它必须真的从 spine 和目录里消失。
     */
    await ws.writeBookPlan(metadata.bookId, {
      entries: [
        { index: 1, title: '第一章', chars: 600, value: 'useful', strategy: 'keep' },
        { index: 3, title: '第三章 表格与代码', chars: 200, value: 'filler', strategy: 'drop' },
      ],
      names: { 3: '第三章 表格与代码' },
    });

    const result = await exportBook({ bookId: metadata.bookId, chapters: [] });
    const outBuf = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, result.fileName));
    const zipOut = new ZipReader(outBuf);
    const out = readEpub(outBuf);

    const droppedHref = metadata.chapters.find((c) => c.index === 3).href;
    assert.ok(
      !out.chapters.some((c) => c.href === droppedHref),
      `成品里不该再有这一章：${out.chapters.map((c) => c.href).join(', ')}`,
    );
    // 阅读路径页在 spine 里但不进 chapters（它不是原书章节）
    assert.equal(out.chapters.length, metadata.chapterCount - 1, '原书 3 章 - 删 1（阅读路径页不算章节）');
    assert.ok(
      out.spine.some((s) => String(s.item?.href || '').endsWith('pbe-reading-path.xhtml')),
      '阅读路径页要留在 spine 里',
    );

    // 目录里也不能再有它
    const ncx = zipOut.readText(out.ncxItem.href);
    assert.ok(!ncx.includes('chapter3.xhtml'), 'NCX 里不该再有指向它的条目');

    // 文件本身还在（不删内容，只是不让它出现在书里）
    assert.ok(zipOut.has(droppedHref), '被删章节的文件仍应留在压缩包里');

    // 前言页要交代删了什么，不能让读者以为是自己漏看了
    const pathPage = zipOut.readText('OEBPS/pbe-reading-path.xhtml');
    assert.ok(pathPage.includes('已从本书中'), `阅读路径页要说明删除：${pathPage.slice(0, 200)}`);
    /**
     * 被删的章节只出现在「已移除」那张清单里，不能混进目录和逐章介绍。
     * 逐章介绍是给书里**还在**的章节写的，删掉的章要是也列在那里，
     * 读者照着一页目录往下找，怎么翻都翻不到。
     */
    const tocBlock = pathPage.slice(pathPage.indexOf('<ol class="rp-toc">'), pathPage.indexOf('</ol>'));
    assert.ok(!tocBlock.includes('第三章 表格与代码'), '删掉的章节不该出现在目录里');
    const chapterBlock = pathPage.slice(
      pathPage.indexOf('二、每一章讲什么'),
      pathPage.indexOf('三、为什么这么编排'),
    );
    assert.ok(!chapterBlock.includes('第三章 表格与代码'), '删掉的章节不该还出现在逐章清单里');
    const removedBlock = pathPage.slice(
      pathPage.indexOf('<ul class="rp-dropped">'),
      pathPage.indexOf('</ul>', pathPage.indexOf('<ul class="rp-dropped">')),
    );
    assert.ok(removedBlock.includes('第三章 表格与代码'), `「已移除」清单要点名删了哪一章：${removedBlock}`);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('★ 端到端：有链接指着的章节即使标了 drop 也删不掉，而且会说清原因', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');
  const { importBook, exportBook } = await import('../../lib/book-engine/pipeline/book-service.js');
  const { blankProfile } = await import('../../lib/book-engine/config/profile.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-drop-blocked-'));
  ws.setWorkspaceRoot(dir);
  try {
    /**
     * 第 2 章里有一条链接指向第 1 章的锚点 #h-1。
     * 这种章删了，那条链接就点不动了 —— 而阅读器不会报错。
     */
    const metadata = await importBook({
      buffer: makeFixtureEpub(),
      fileName: 'blocked-drop.epub',
      profile: blankProfile(),
    });
    await ws.writeBookPlan(metadata.bookId, {
      entries: [{ index: 1, title: '第一章', chars: 600, value: 'filler', strategy: 'drop' }],
    });

    const result = await exportBook({ bookId: metadata.bookId, chapters: [] });
    const outBuf = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, result.fileName));
    const out = readEpub(outBuf);
    const href = metadata.chapters.find((c) => c.index === 1).href;

    assert.ok(
      out.chapters.some((c) => c.href === href),
      '有人指着的章节必须保留，否则链接会静默失效',
    );
    assert.ok(
      (result.issues || []).some((i) => i.includes('删除') || i.includes('链接')),
      `要如实报告没删成：${JSON.stringify(result.issues)}`,
    );
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('★ 删掉的章不能在 landmarks 里留下死链（导航到不存在的文件）', () => {
  const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <ol>
        <li><a href="text/chapter1.xhtml">第一章</a></li>
        <li><a href="text/chapter2.xhtml">第二章</a></li>
      </ol>
    </nav>
    <nav epub:type="landmarks" id="guide">
      <ol>
        <li><a epub:type="bodymatter" href="text/chapter1.xhtml">正文开始</a></li>
        <li><a epub:type="copyright-page" href="text/chapter3.xhtml">版权页</a></li>
      </ol>
    </nav>
  </body>
</html>`;

  const epub = readEpub(makeFixtureEpub());
  const target = chapterOf(epub, 1);
  const fake = {
    ...epub,
    navItem: { href: 'OEBPS/nav.xhtml' },
    zip: {
      has: (n) => n === 'OEBPS/nav.xhtml',
      readXmlText: (n) => ({ text: n === 'OEBPS/nav.xhtml' ? NAV : '' }),
      readText: (n) => (n === 'OEBPS/nav.xhtml' ? NAV : ''),
    },
  };

  const r = dropChapters(fake, [{ id: target.id, href: target.href, index: 1, title: '第一章' }]);
  const navText = r.tocUpdates.get('OEBPS/nav.xhtml');
  assert.ok(navText, 'nav 要有更新');
  const doc = parseXml(navText);
  const navs = queryAll(doc.documentElement, 'nav');
  const landmarks = navs.find((el) => (el.getAttribute('epub:type') || '').includes('landmarks'));
  const links = queryAll(landmarks, 'a').map((a) => a.getAttribute('href'));
  assert.deepEqual(links, ['text/chapter3.xhtml'], `landmarks 里不能留下指向已删章节的链接：${links.join(' | ')}`);
  const tocLinks = queryAll(navs.find((el) => (el.getAttribute('epub:type') || '').includes('toc')), 'a').map((a) =>
    a.getAttribute('href'),
  );
  assert.deepEqual(tocLinks, ['text/chapter2.xhtml'], '目录里也要删干净');
});
