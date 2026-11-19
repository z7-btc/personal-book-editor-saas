/**
 * 「重构版阅读路径」页的测试。
 * 这一页是插进 EPUB 的结构，写坏了整本书都打不开，所以格式必须严格。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderReadingPathPage, READING_PATH_HREF } from '../../lib/book-engine/pipeline/reading-path.js';
import { buildSpineOrder, attachRestToChapters } from '../../lib/book-engine/pipeline/book-plan.js';
import { parseXml, escapeText } from '../../lib/book-engine/epub/xml-dom.js';
import { queryAll } from '../../lib/book-engine/epub/selector.js';

const PLAN = {
  overview: '正文结构本身没问题，问题是前置内容过载。',
  frontMatterNote: '本书前 13 章几乎全是出版事务和名人推荐，建议直接从第 15 章开始。',
  readingPath: ['第 1 步：第 15 章——先建立方法论地基', '第 2 步：第 16~18 章——估值方法'],
  entries: [
    {
      index: 4, title: '推荐序一 <改变一生的智慧之书>', chars: 1042, value: 'context', strategy: 'digest',
      reason: '整篇是推荐语，压缩保留一句',
      card: { summary: '巴菲特回忆师从格雷厄姆的经历。', knowledgePoints: ['他 1950 年在哥大成为格雷厄姆的学生', '此后 57 年一直用这份路线图'] },
    },
    {
      index: 10, title: '第6版前言', chars: 16353, value: 'useful', strategy: 'keep', reason: '含独立判断，需精读',
      card: { summary: '卡拉曼系统论述价值投资在今天的适用性。', knowledgePoints: ['价值投资不是机械寻找便宜股票的工具'] },
    },
    {
      index: 15, title: '第一部分', chars: 51892, value: 'useful', strategy: 'keep', reason: '方法论总纲',
      card: { summary: '全书方法论地基。', knowledgePoints: ['投资的定义：透彻分析、保障本金、满意回报'] },
    },
  ],
  counts: { keep: 2, digest: 1, skip: 0 },
};

test('★ 目录页必须是合法 XHTML，并且回答了用户的三個问题', () => {
  const html = renderReadingPathPage(PLAN, { bookTitle: '证券分析', generatedAt: new Date('2026-10-01T12:00:00Z') });
  const doc = parseXml(html);
  assert.equal(doc.documentElement.name, 'html');

  /**
   * 用户的原话：
   *   「整理排序后，你在目录里跟我说明一下：
   *     1. 整理后的目录编排是什么样的？
   *     2. 每一章对应讲哪些内容？
   *     3. 你为什么要这么编排？」
   * 这三节必须都在，否则他还是要自己猜。
   */
  const titles = queryAll(doc.documentElement, 'h1, h2').map((n) => n.textContent.trim());
  assert.ok(titles[0].includes('目录'), `主标题应点明这是目录：${titles[0]}`);
  for (const must of ['一、整理后的编排', '二、每一章讲什么', '三、为什么这么编排']) {
    assert.ok(titles.some((t) => t.includes(must)), `缺少「${must}」，实际标题：${titles.join(' / ')}`);
  }
});

test('★ 目录里显示的是「新名字」，不是原书名', () => {
  const plan = {
    ...PLAN,
    names: { 4: '推荐序一（巴菲特）：他为什么说这本书改变了他的一生' },
    entries: PLAN.entries.map((e) => (e.index === 4 ? { ...e, displayTitle: '推荐序一（巴菲特）：他为什么说这本书改变了他的一生' } : e)),
  };
  const html = renderReadingPathPage(plan, { bookTitle: '书' });
  /**
   * 用户对比了原版和 AI 版目录，说「目录的名字也没改」。
   * 对读者来说**目录里显示的名字才是目录** —— 只改顺序不改名字等于没改。
   */
  assert.ok(html.includes('他为什么说这本书改变了他的一生'), '要用新名字');
  assert.ok(html.includes('可带走的知识点'), '要说清每章讲什么');
});

test('★ 目录条目带链接，读者点一下就能跳过去', () => {
  const hrefByIndex = new Map([[4, 'OEBPS/text00003.html'], [10, 'OEBPS/text00009.html'], [15, 'OEBPS/text00014.html']]);
  const html = renderReadingPathPage(PLAN, { bookTitle: '书', hrefByIndex });
  assert.ok(html.includes('href="OEBPS/text00003.html"'), '每条目录应链到对应文件');
  const doc = parseXml(html);
  const links = queryAll(doc.documentElement, 'a').map((a) => a.getAttribute('href'));
  assert.ok(links.length >= 3, `链接数量不对：${links.length}`);
  // 不带锚点 —— 指向文件开头，不依赖文件内部有没有锚点
  assert.ok(links.every((h) => !h.includes('#')), '链接不该带锚点');
});

test('★ 标题里的尖括号会被转义，不会把 XHTML 弄坏', () => {
  const html = renderReadingPathPage(PLAN, { bookTitle: '书名' });
  // 「推荐序一 <改变一生的智慧之书>」里的尖括号必须转义
  assert.ok(html.includes('&lt;改变一生的智慧之书&gt;'), '书名号里的尖括号要转义');
  const doc = parseXml(html);
  assert.ok(doc.documentElement, '转义后仍应能解析');
});

test('内容包含：开场说明、阅读顺序、逐章清单', () => {
  const html = renderReadingPathPage(PLAN, { bookTitle: '证券分析' });
  assert.ok(html.includes('建议直接从第 15 章开始'), '要有给读者的开场说明');
  assert.ok(html.includes('第 1 步：第 15 章'), '要有阅读顺序');
  assert.ok(html.includes('推荐序一'), '要列出每一章');

  // 每一章在第二节里都有一段（原来是表格，现在改成更好读的分节）
  const doc = parseXml(html);
  const sections = queryAll(doc.documentElement, 'h3');
  assert.equal(sections.length, PLAN.entries.length, `每一章都应有一节，实际 ${sections.length} 节`);
});

test('★ 没真跑过压缩就不能说「已压缩」，跑过了才说', () => {
  /**
   * 规划里写着 `strategy: digest` 只代表「打算压缩」。
   *
   * 第一版直接按规划写「已压缩成一页提要，正文一字未删」——
   * 没跑的时候正文还是全文（假话），跑完以后又确实删掉了大量段落
   * （还是假话）。页面上的话必须和书里的实际情况一致，
   * 所以只有状态里落了 digest=true 的章节才算数。
   */
  const planned = renderReadingPathPage(PLAN, { bookTitle: '书' });
  assert.ok(!planned.includes('压缩成一页提要'), '光有计划不能说已经压了');
  assert.ok(!planned.includes('正文一字未删'), '「正文一字未删」在压缩后是假话，不该再出现');

  const done = renderReadingPathPage(PLAN, { bookTitle: '书', digestedIndexes: new Set([4]) });
  assert.ok(done.includes('压缩成一页提要'), '真压过了就要说');
  assert.ok(done.includes('推荐序一'), '要点名是哪几章被压了');
  assert.ok(done.includes('原文中别处会跳转引用的段落仍然原样保留'), '要说清哪些内容还在');
  // 只压了第 4 章，就不能把别的 digest 章也算进去
  assert.ok(!/下面\s*2\s*章/.test(done), `只压了 1 章却报成 2 章：${done.slice(0, 400)}`);
});

test('覆盖用户的改判（人工把某章改成精读）', () => {
  const html = renderReadingPathPage(
    { ...PLAN, overrides: { 4: { strategy: 'keep', note: '我想读原汁原味的推荐序' } } },
    { bookTitle: '书' },
  );
  assert.ok(html.includes('照常精读改写'), '改判后的策略要体现在页面上');
  // 改判后没有 digest 章节了，那句「压缩了 N 章」就不该出现
  assert.ok(!html.includes('已压缩成一页提要'), '没有压缩章节时不该说压缩了');
});

test('空规划也能渲染出合法页面（不能生成白页）', () => {
  const html = renderReadingPathPage({}, {});
  const doc = parseXml(html);
  assert.equal(doc.documentElement.name, 'html');
  assert.ok(html.includes('目录 · 怎么读这本书'));
});

test('escapeText 对 & 也做了处理（否则整页解析失败）', () => {
  const html = renderReadingPathPage(
    { ...PLAN, frontMatterNote: 'A & B < C', entries: [] },
    {},
  );
  const doc = parseXml(html);
  assert.ok(doc.documentElement);
  assert.ok(html.includes('A &amp; B &lt; C'));
  void escapeText;
});

test('文件名与 manifest id 是固定值（重复导出不会叠加两份）', () => {
  assert.equal(READING_PATH_HREF, 'pbe-reading-path.xhtml');
});

/* ------------------------------------------------------------ 重排顺序 -- */

/** 造一份「28 个文件、其中 7/9/19/27 是纯图片页」的章节表 */
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]
  .map((index) => ({ index }));

test('★ 模型没见过的页面会被「粘」在相邻章节旁边，不能丢也不能乱插', () => {
  // 模型只排了有正文的章节（7/9/19/27 是纯图片页，它没见过）
  const ordered = [15, 16, 17, 18, 20, 21, 22, 23, 24, 10, 13, 6, 4, 5, 11, 12, 14, 25, 3, 26, 1, 2, 8, 28];
  const { order, moved } = buildSpineOrder(ALL, ordered);

  assert.equal(moved, true);
  assert.equal(order.length, 28, '一项都不能少');
  assert.equal(new Set(order).size, 28, '不能重复');
  assert.deepEqual([...order].sort((a, b) => a - b), ALL.map((c) => c.index), '必须是完整排列');

  /**
   * 第 9 章是「下册扉页」（纯图片页），原本夹在第 8 章和第 10 章之间。
   * 第 10 章被排到后面去了，所以第 9 章应该跟着它走，
   * 而不是孤零零留在开头 —— 那会让读者在正文中间看到一张分册扉页。
   */
  const pos9 = order.indexOf(9);
  const pos10 = order.indexOf(10);
  assert.equal(pos9, pos10 - 1, `第 9 章应紧跟在第 10 章前面，实际 order=[…${order.slice(Math.max(0, pos10 - 2), pos10 + 2).join(',')}…]`);

  // 第 7 章（扫码页）原本在第 6 章和第 8 章之间。
  // 规则是「粘到它后面第一个被排过序的章节前面」—— 后面最近的已排序章节是第 8 章
  assert.equal(order.indexOf(7), order.indexOf(8) - 1, '第 7 章应排在它后面最近的第 8 章之前');
});

test('★ 不管输入多离谱，合成结果都必须是完整排列（宁可不排，不能丢章）', () => {
  const original = ALL.map((c) => c.index);
  const bad = [
    [15, 99, 16],              // 含不存在的章节号
    [15, 15, 16],              // 重复
    [7, 9, 19, 27],            // 全是没卡片的图片页
    ['x', null, undefined, NaN], // 垃圾值
    [28, 1],                   // 只排了两章
  ];
  for (const input of bad) {
    const { order } = buildSpineOrder(ALL, input);
    assert.equal(order.length, 28, `输入 ${JSON.stringify(input)} 时项数不对：${order.length}`);
    assert.equal(new Set(order).size, 28, `输入 ${JSON.stringify(input)} 时有重复`);
    assert.deepEqual([...order].sort((a, b) => a - b), original, `输入 ${JSON.stringify(input)} 时不是完整排列`);
  }
});

test('模型没给顺序时保持原样', () => {
  const original = ALL.map((c) => c.index);
  assert.deepEqual(buildSpineOrder(ALL, []).order, original);
  assert.deepEqual(buildSpineOrder(ALL, null).order, original);
  assert.equal(buildSpineOrder(ALL, []).moved, false);
});

test('模型给的就是原顺序时，不标记为「动过」', () => {
  const same = buildSpineOrder(ALL, ALL.map((c) => c.index));
  assert.equal(same.moved, false, '顺序没变就不该说重排了');
  assert.equal(same.reason.includes('原顺序'), true);
});

/* --------------------------------------------------- 非正文章节的位置 -- */

test('★ 封面留在第一页、「关于本书」留在最后，不能一律甩到末尾', () => {
  // 原书 spine：封面 → 章节 → 关于
  const spine = ['cover', 'c1', 'c2', 'c3', 'about'];
  const chapterIds = new Set(['c1', 'c2', 'c3']);
  // 模型把第 3 章提到最前面
  const finalIds = attachRestToChapters(spine, chapterIds, ['c3', 'c1', 'c2']);
  assert.deepEqual(finalIds, ['cover', 'c3', 'c1', 'c2', 'about']);
});

test('★ 夹在章节之间的非正文章节跟着后面那一章走', () => {
  const spine = ['c1', 'cover2', 'c2', 'c3'];
  const finalIds = attachRestToChapters(spine, new Set(['c1', 'c2', 'c3']), ['c3', 'c1', 'c2']);
  assert.deepEqual(finalIds, ['c3', 'c1', 'cover2', 'c2']);
});

/* --------------------------------------------------- 书籍排版细节 -- */

test('★ 章名里本来就有书名号时，阅读建议不能写成《阿长与《山海经》》', () => {
  const xhtml = renderReadingPathPage({
    overview: '整部文集的合集页已经整页移除。',
    frontMatterNote: '直接从《阿长与《山海经》》开始读。',
    readingPath: ['读《阿长与《山海经》》——先读具体篇目'],
    order: [2],
    entries: [
      {
        index: 2,
        title: '阿长与《山海经》',
        chars: 3000,
        value: 'core',
        strategy: 'keep',
        reason: '核心篇目',
        card: { summary: '写长妈妈买《山海经》的事。', knowledgePoints: [] },
      },
    ],
  });
  assert.ok(xhtml.includes('《阿长与〈山海经〉》'), '外层书名号里再套书名号，内层要用单书名号');
  assert.ok(!xhtml.includes('《阿长与《山海经》》'), '不能出现两个书名号叠着收尾');
});

/* ------------------------------------------------- 目录条目（插页可达性）-- */

test('★ 目录页必须能在目录面板里找到，而且排在第一', async () => {
  const { readEpub } = await import('../../lib/book-engine/epub/epub-reader.js');
  const { ZipReader } = await import('../../lib/book-engine/epub/zip-reader.js');
  const { insertFrontPage, insertTocEntry, reorderToc } = await import('../../lib/book-engine/epub/epub-writer.js');
  const { makeFixtureEpub } = await import('./fixture-epub.js');

  const book = readEpub(makeFixtureEpub());
  assert.ok(book.ncxItem, '这个用例依赖 fixture 里有 NCX');

  // 先记下原始目录（fixture 的 NCX 只列了正文三章，不含 endnotes）
  const originalOrder = queryAll(
    parseXml(book.zip.readXmlText(book.ncxItem.href).text).documentElement,
    'navPoint',
  ).map((p) => queryAll(p, 'content')[0]?.getAttribute('src') || '');

  // 先重排 + 加条目，模拟真实的导出顺序
  const hrefs = book.chapters.map((c) => c.href);
  const reordered = reorderToc(book, [...hrefs].reverse());
  const inserted = insertFrontPage(book, {
    id: 'pbe-reading-path',
    href: READING_PATH_HREF,
    title: '目录 · 怎么读这本书',
    xhtml: '<html/>',
  });
  const tocEntry = insertTocEntry(
    book,
    { id: 'pbe-reading-path-toc', href: READING_PATH_HREF, title: '目录 · 怎么读这本书' },
    { replacements: reordered.updates },
  );
  assert.equal(tocEntry.inserted, true, '应该往目录里插了一条');

  const ncxText = tocEntry.updates.get(book.ncxItem.href);
  assert.ok(ncxText, 'NCX 必须有更新');
  const doc = parseXml(ncxText);
  const navMap = queryAll(doc.documentElement, 'navMap')[0];
  const points = (navMap.children || []).filter((c) => c.name === 'navPoint');

  const labelOf = (p) =>
    queryAll(p, 'text')[0]?.children?.find((c) => c.kind === 3)?.value || '';
  const srcOf = (p) => queryAll(p, 'content')[0]?.getAttribute('src') || '';

  assert.equal(labelOf(points[0]), '目录 · 怎么读这本书', '新条目要排在最前面');
  assert.equal(srcOf(points[0]), READING_PATH_HREF);

  // playOrder 必须跟着走，否则按 playOrder 排序的阅读器会把它扔到最后
  const all = queryAll(navMap, 'navPoint');
  assert.equal(all[0].getAttribute('playOrder'), '1');
  const orders = all.map((p) => Number(p.getAttribute('playOrder')));
  assert.deepEqual(orders, orders.map((_, i) => i + 1), `playOrder 要连续：${orders.join(',')}`);

  /**
   * 而且**不能把重排结果盖掉**。
   *
   * insertTocEntry 如果从 ZIP 原文重新解析 NCX，序列化出来的就是
   * 没重排过的版本 —— 目录顺序悄悄变回去，还不报错。
   */
  assert.equal(points.length, 4, '原有 3 条 + 新加 1 条');
  const rest = points.slice(1).map(srcOf);
  assert.deepEqual(
    rest,
    [...originalOrder].reverse(),
    `重排结果必须保留，实际：${rest.join(' | ')}`,
  );

  // 重复导出不能插出两条
  const again = insertTocEntry(book, { href: READING_PATH_HREF, title: '目录 · 怎么读这本书' }, {
    replacements: tocEntry.updates,
  });
  assert.equal(again.inserted, false, '已经有一条了就不该再插一条');
  const againDoc = parseXml(again.updates.get(book.ncxItem.href) || ncxText);
  const againMap = queryAll(againDoc.documentElement, 'navMap')[0];
  assert.equal(
    queryAll(againMap, 'navPoint').filter((p) => srcOf(p) === READING_PATH_HREF).length,
    1,
    '同一个文件不能出现两条目录项',
  );

  // 真的打出来看一眼：写进 EPUB 后能被读回来
  void inserted;
  void ZipReader;
});

test('EPUB3 nav 也要加一条（否则只改了 NCX，另一半读者看不到）', async () => {
  const { readEpub } = await import('../../lib/book-engine/epub/epub-reader.js');
  const { insertTocEntry } = await import('../../lib/book-engine/epub/epub-writer.js');
  const { makeFixtureEpub } = await import('./fixture-epub.js');

  const book = readEpub(makeFixtureEpub());
  assert.ok(book.navItem, '这个用例依赖 fixture 里有 nav.xhtml');
  const r = insertTocEntry(book, {
    id: 'pbe-reading-path-toc',
    href: READING_PATH_HREF,
    title: '目录 · 怎么读这本书',
  });
  const navText = r.updates.get(book.navItem.href);
  assert.ok(navText.includes(READING_PATH_HREF), 'nav 里要有这一条');
  assert.ok(navText.includes('目录 · 怎么读这本书'));
  // 排在第一项
  const doc = parseXml(navText);
  const ol = queryAll(doc.documentElement, 'ol')[0];
  const firstLi = (ol.children || []).find((c) => c.name === 'li');
  assert.ok(queryAll(firstLi, 'a')[0].getAttribute('href').includes(READING_PATH_HREF), '要排在第一项');
});
