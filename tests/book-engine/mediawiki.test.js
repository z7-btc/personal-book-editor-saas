/**
 * 维基文库（MediaWiki）导出书的两个「内容会悄悄坏掉」的问题。
 *
 * 用户的抱怨是「成品不太对，又说不出哪里不对」。对着《朝花夕拾》
 * 的成品逐章读下来，这两条是看得见的具体毛病：
 *
 *   1. 每章开头都顶着「←上一篇 本篇 作者：鲁迅 下一篇→ 姊妹计划: 数据项」，
 *      结尾顶着两百字版权法条 —— 这些是网页导航，不是书；
 *   2. 有些句子**缺字**：「正确地写起来，须是“____”。」——
 *      繁简转换的字写在标签属性里，解析时被当成空标签跳过了。
 *
 * 两件事都是**来源的通病**，不是某一本书的特例，所以测试也按
 * 「任意一本维基文库导出书」来写：喂一段典型标记，检查成品该留的留、该去的去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expandLanguageVariants,
  pickVariantText,
  cleanChapterXhtml,
  stripReaderChrome,
} from '../../lib/book-engine/epub/mediawiki.js';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { extractBlocks, blockToPlainText } from '../../lib/book-engine/epub/sanitize.js';
import { applyDigest } from '../../lib/book-engine/pipeline/digest.js';
import { ensureChapterTitle } from '../../lib/book-engine/pipeline/book-service.js';
import { findRedundantChapters } from '../../lib/book-engine/pipeline/plan-service.js';

/* ------------------------------------------------ 繁简转换的字 -- */

/** 造一个和 Parsoid 一模一样的变体空标签（属性里的引号是 &quot;）。 */
const variantSpan = (obj) =>
  `<span typeof="mw:LanguageVariant" data-mw-variant="${JSON.stringify(obj).replace(/"/g, '&quot;')}"/>`;

test('★ 繁简转换的字写在属性里：空标签要摊平成正文，不能让句子缺字', () => {
  const src = `<p>正确地写起来，须是${variantSpan({
    twoway: [
      { l: 'zh-hans', t: '麻胡子' },
      { l: 'zh-hant', t: '麻鬍子' },
    ],
  })}。</p>`;
  const { xhtml, expanded } = expandLanguageVariants(src, 'zh-hans');
  assert.equal(expanded, 1, '要认出这一个变体标签');
  assert.ok(xhtml.includes('麻胡子'), `字要摊回来，实际：${xhtml}`);
  assert.ok(!xhtml.includes('mw:LanguageVariant'), '空标签不能再留在正文里');
});

test('不转换的写法（disabled）也要摊平', () => {
  const src = `<p>著名${variantSpan({ disabled: { t: '著' } })}作</p>`;
  assert.ok(expandLanguageVariants(src, 'zh').xhtml.includes('著名著作'));
});

test('按文档语言挑变体：繁体文档选繁体的那一路', () => {
  const twoway = {
    twoway: [
      { l: 'zh-hans', t: '收录于' },
      { l: 'zh-hant', t: '收錄於' },
    ],
  };
  assert.equal(pickVariantText(twoway, 'zh-Hant'), '收錄於');
  assert.equal(pickVariantText(twoway, 'zh-Hans'), '收录于');
  // 只写了 zh 的文档：优先原文那一路（zh 条目），没有就退繁体
  assert.equal(pickVariantText({ twoway: [{ l: 'zh', t: '原文' }, { l: 'zh-hans', t: '简体' }] }, 'zh'), '原文');
  assert.equal(pickVariantText(twoway, 'zh'), '收錄於');
});

test('变体里的尖括号要转义，不能把标记塞进正文', () => {
  // Parsoid 写进属性的尖括号是转义过的：`&amp;lt;` 解出来才是 `<`
  const src = `<p>${variantSpan({ disabled: { t: '&lt;b&gt;' } })}</p>`;
  assert.ok(expandLanguageVariants(src, 'zh').xhtml.includes('&lt;b&gt;'));
});

/* -------------------------------------------------- 网页外壳 -- */

const WIKISOURCE_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>阿长与山海经</title><style>.mw-parser-output .licensetpl{display:none}</style></head>
<body>
<section><div id="headerContainer-n10" typeof="mw:Transclusion">
<table><tbody><tr><td>←<a href="a.xhtml">狗·猫·鼠</a></td>
<td><b>阿長與《山海經》</b><br/><span>作者：</span><a href="author.xhtml">魯迅</a></td>
<td><a href="c.xhtml">二十四孝圖</a>→</td></tr></tbody></table></div>
<ul id="plainSister-n11"><li>姊妹计划: <a href="https://zh.wikipedia.org">百科</a>·<a href="https://www.wikidata.org">数据项</a></li></ul>
<h3></h3>
<p>长妈妈，已经说过，是一个一向带领着我的女工。</p>
<p>　　</p>
<p>她教给我的道理还很多。</p>
<div class="licenseContainer licenseBanner"><p><span class="licensetpl_short">Public domain</span><span class="licensetpl_long">Public domain</span>falsefalse</p></div>
<h6>以2026年11月17日从维基文库导出</h6>
</section>
</body></html>`;

test('★ 网页导航、姊妹计划、许可声明、导出水印：一个都不能留进成品正文', () => {
  const { xhtml, removed, title, author } = cleanChapterXhtml(WIKISOURCE_CHAPTER, { lang: 'zh' });
  assert.equal(title, '阿長與《山海經》', '导航表里那格 <b> 就是本章标题，要能取出来');
  assert.equal(author, '魯迅', '导航表里「作者：」后面那位要能取出来，补进元数据');
  assert.ok(removed.nav >= 1, '章首导航表要删');
  assert.ok(removed.sister >= 1, '姊妹计划要删');
  assert.ok(removed.license >= 1, '许可声明要删');
  assert.ok(removed.stamps >= 1, '导出水印要删');
  assert.ok(removed.emptyBlocks >= 2, '空标题和空段落要删');

  for (const junk of ['姊妹计划', 'headerContainer', 'plainSister', 'Public domain', '从维基文库导出']) {
    assert.ok(!xhtml.includes(junk), `「${junk}」不该留在正文里：${xhtml}`);
  }
  assert.ok(xhtml.includes('长妈妈，已经说过'), '正文一个字都不能少');
  assert.ok(xhtml.includes('她教给我的道理还很多'), '正文一个字都不能少');
  assert.ok(xhtml.includes('mw-parser-output'), '<head> 里的排版 CSS 不能删（删了掉字体）');
});

test('没有网页外壳的书原样返回（不能顺手重排一本干净的书）', () => {
  const plain = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head>
<body><h1>第一章</h1><p>正文。</p></body></html>`;
  const out = cleanChapterXhtml(plain, { lang: 'zh' });
  assert.equal(out.xhtml, plain, '没改动就必须字节不变');
  assert.equal(out.removed.nav + out.removed.sister + out.removed.license, 0);
});

test('stripReaderChrome 对已解析的 DOM 同样有效（导出侧可以用）', () => {
  const doc = parseXml(WIKISOURCE_CHAPTER);
  const { removed } = stripReaderChrome(doc);
  assert.ok(removed.nav >= 1);
  assert.ok(!doc.serialize().includes('姊妹计划'));
});

test('章首导航表换一种写法（table.ws-header）时，标题和作者照样取得出来', () => {
  const src = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
<table class="ws-header"><tbody><tr><td>上一章</td>
<td><b>藤野先生</b><br/><span>作者：周树人</span></td><td>下一章</td></tr></tbody></table>
<p>东京也无非是这样。</p>
</body></html>`;
  const { title, author, xhtml } = cleanChapterXhtml(src, { lang: 'zh' });
  assert.equal(title, '藤野先生');
  assert.equal(author, '周树人');
  assert.ok(!xhtml.includes('上一章'), '导航表要删干净');
  assert.ok(xhtml.includes('东京也无非是这样'), '正文一个字都不能少');
});

/* -------------------------------------- 看不见的行内元素不该占编号 -- */

test('★ 排版用的空格占位不该变成占位符（它会让整段被误判成「占位符丢失」）', () => {
  /**
   * 维基文库用 `<span typeof="mw:Entity">　</span>` 当缩进。
   * 这类空壳以前每个都编一个 `⟦n⟧`，模型只留文字、当然不会保留编号，
   * 于是「丢了占位符 ⇒ 这段坏了 ⇒ 退回原文」—— 成品一半简体一半繁体。
   */
  const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>` +
    '<span typeof="mw:Entity">　</span><span typeof="mw:Entity">　</span>' +
    '长妈妈，已经说过，是一个一向带领着我的女工。' +
    '<span typeof="mw:Entity">　</span></p></body></html>';
  const doc = parseXml(xhtml);
  const { blocks } = extractBlocks(doc);
  const plain = blockToPlainText(blocks[0]);
  assert.equal(plain.marks.length, 0, `这些空壳不该编号，实际编了 ${plain.marks.length} 个`);
  assert.ok(plain.text.includes('长妈妈'), '真正的文字要留下');
});

test('有链接 / 有图片的空元素仍然要编号（它们有实际功能）', () => {
  const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>前文` +
    '<a id="anchor1"></a><img src="x.png" alt="图"/>后文</p></body></html>';
  const doc = parseXml(xhtml);
  const { blocks } = extractBlocks(doc);
  const plain = blockToPlainText(blocks[0]);
  assert.equal(plain.marks.length, 2, '锚点和图片都要编号，不能当成空壳删掉');
});

/* -------------------------------------------- 压缩后不留悬空小标题 -- */

test('★ 压缩成提要后，没有正文的小标题要一起走（否则成品里挂着空的「後記」）', () => {
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>朝花夕拾</title></head><body>
<h1>朝花夕拾</h1>
<p>鲁迅一九二六年所作的回忆散文结集，共十篇。</p>
<h2>小引</h2>
<p>我常想在纷扰中寻出一点闲静来。</p>
<h2>後記</h2>
<p>我在第三篇讲《二十四孝》的开头说错了一件事。</p>
</body></html>`;
  const out = applyDigest({ xhtml, digestText: '这本书是鲁迅的回忆散文集。', inboundAnchors: new Set() });
  assert.ok(out.xhtml.includes('朝花夕拾'), '章节标题要留着');
  assert.ok(!out.xhtml.includes('後記'), `悬空的小标题不能留：${out.xhtml.slice(-300)}`);
  assert.ok(!out.xhtml.includes('小引') || out.xhtml.includes('我常想'), '留标题就必须留它下面的正文');
});

/* ---------------------------------------------- 正文里的章节标题 -- */

test('★ 清洗掉导航表之后，导出时要给正文补一个章节标题', () => {
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head>
<body><p>长妈妈，已经说过。</p></body></html>`;
  const out = ensureChapterTitle(xhtml, '阿长与《山海经》');
  assert.ok(out.includes('<h1 class="pbe-chapter-title">阿长与《山海经》</h1>'), `要补标题：${out}`);
  assert.ok(out.indexOf('<h1') > out.indexOf('<body'), '标题要在 body 里、正文前面');
});

test('正文开头已经有标题，就不要补第二个', () => {
  const withH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>小引</h1><p>正文。</p></body></html>`;
  assert.equal(ensureChapterTitle(withH1, '小引：鲁迅的自序'), withH1, '已经有标题就原样返回');
});

test('标题里的 & 和 < 要转义', () => {
  const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文。</p></body></html>`;
  const out = ensureChapterTitle(xhtml, 'A & B <读本>');
  assert.ok(out.includes('A &amp; B &lt;读本&gt;'));
});

test('★ 章节 <title> 是繁体时换成章名（阅读器顶栏读的是它）', () => {
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>阿長與《山海經》</title></head>
<body><h1>阿长与《山海经》：阿长买来绘图《山海经》</h1><p>长妈妈，已经说过。</p></body></html>`;
  const out = ensureChapterTitle(xhtml, '阿长与《山海经》：阿长买来绘图《山海经》');
  assert.ok(out.includes('<title>阿长与《山海经》：阿长买来绘图《山海经》</title>'), `顶栏标题要跟着换：${out.slice(0, 200)}`);
});

test('★ 章节 <title> 是同一章的简体短名时，也要换成带副题的章名', () => {
  // 实测（v16《藤野先生》）：目录写长名，阅读器顶栏只写「藤野先生」
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>藤野先生</title></head>
<body><h1>藤野先生：讲义批改、匿名信与幻灯片事件、弃医从文</h1><p>东京也无非是这样。</p></body></html>`;
  const out = ensureChapterTitle(xhtml, '藤野先生：讲义批改、匿名信与幻灯片事件、弃医从文');
  assert.ok(
    out.includes('<title>藤野先生：讲义批改、匿名信与幻灯片事件、弃医从文</title>'),
    `顶栏标题要跟着换：${out.slice(0, 220)}`,
  );
  // 原标题和章名没有前缀关系时一个字都不动
  const other = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>朝花夕拾小引</title></head>
<body><h1>小引</h1><p>正文。</p></body></html>`;
  assert.equal(ensureChapterTitle(other, '小引：从《旧事重提》到《朝花夕拾》的成书经过'), other);
});

test('★ 章节 <title> 是 MediaWiki 系统消息键时换成真正的章名', () => {
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>MediaWiki:Wsexport_about</title></head>
<body><h1>About this digital edition</h1><p>This e-book comes from Wikisource.</p></body></html>`;
  const out = ensureChapterTitle(xhtml, '关于：数字版本说明与版权页');
  assert.ok(out.includes('<title>关于：数字版本说明与版权页</title>'), `不能把系统键印在顶栏：${out.slice(0, 220)}`);
});

test('简体 <title> 是章名的前缀时，要补成完整的章名', () => {
  /**
   * 早先这里要求「已经是章名的一部分就一个字都不动」，实测效果不好：
   * 目录里是「藤野先生：添改讲义」，阅读器顶栏还是「藤野先生」，
   * 同一章两套名字。原标题是章名的前缀，说明方案只是在后面加了副题，
   * 换成完整章名才不会前后不一。
   */
  const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>藤野先生</title></head>
<body><h1>藤野先生：添改讲义</h1><p>正文。</p></body></html>`;
  const out = ensureChapterTitle(xhtml, '藤野先生：添改讲义');
  assert.ok(out.includes('<title>藤野先生：添改讲义</title>'), `顶栏标题要跟着换：${out.slice(0, 200)}`);
});

/* -------------------------------------------------- 合集页去重 -- */

test('★ 合集页（内容都在别的章节里）要标成重复，被包含的章节不算', () => {
  /**
   * 维基文库的「整部作品页」：一篇 6000 字的页面把各篇全文都抄了一份，
   * 下面又各自单独成章。模型会认真给这一页写提要，于是成品里
   * 同一段内容出现两遍。这条判断必须由代码做 —— 模型看到的是截断的正文。
   */
  const essay = '我常想在纷扰中寻出一点闲静来，然而委实不容易。'.repeat(30);
  const afterword = '我在第三篇讲二十四孝的开头说错了一件事，现在更正。'.repeat(30);
  const container = `目錄${essay}${afterword}`;
  const chapters = [
    { index: 1, title: '合集页', text: container },
    { index: 2, title: '小引', text: essay },
    { index: 3, title: '後記', text: afterword },
  ];
  const redundant = findRedundantChapters(chapters);
  assert.ok(redundant.has(1), `合集页应被判重复，实际：${[...redundant.keys()]}`);
  assert.ok(!redundant.has(2), '被包含的那一篇不能删（它就是正文）');
  assert.ok(!redundant.has(3), '被包含的那一篇不能删');
  assert.ok(redundant.get(1).coverage > 0.9);
  assert.deepEqual(redundant.get(1).coveredBy.sort(), [2, 3]);
});

test('两篇各自独立的章节不会被误判重复', () => {
  const a = '甲'.repeat(400) + '甲的内容'.repeat(50);
  const b = '乙'.repeat(400) + '乙的内容'.repeat(50);
  const redundant = findRedundantChapters([
    { index: 1, title: 'A', text: a },
    { index: 2, title: 'B', text: b },
  ]);
  assert.equal(redundant.size, 0);
});
