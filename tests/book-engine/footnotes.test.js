/**
 * 脚注就地化的测试。
 *
 * 背景：用户嫌脚注要来回翻页，提出「重要的内容直接放括号里，不重要的删掉」。
 * 实测这本书 484 条脚注里只有 6% 是纯出处，53% 是编者注和实质说明（4.5 万字），
 * 所以做法是「融进正文 + 删标记」，而不是一刀切删除。
 *
 * 这份测试盯三件事：
 *   1. 认得出真正的脚注（不能把目录锚点当成脚注）；
 *   2. 标记要被展开成注释正文，且**不进入数字占位符**（否则会被还原回去）；
 *   3. 模型输出里的标记要被清干净，同时**内容不能丢**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { extractBlocks, blockToPlainText, stripNoteMarkers, rebuildBlockChildren, applyRebuild } from '../../lib/book-engine/epub/sanitize.js';
import {
  buildNoteIndex,
  classifyNote,
  noteCoverage,
  checkNoteCoverage,
  isMustKeep,
  collectNoteAttributions,
  extractNoteAttribution,
  findNoteAttributions,
  stripNoteAttributions,
  stripTrailingNoteAttribution,
} from '../../lib/book-engine/epub/footnotes.js';

/* ------------------------------------------------------------ 分类 -- */

test('脚注分类：编者注 / 实质说明 / 纯出处 分得开', () => {
  assert.equal(
    classifyNote('(1) 亏钱常常会让人不安，这种焦虑会影响我们把握投资机会的能力。——卡拉曼注'),
    'editor',
  );
  assert.equal(
    classifyNote(
      '(2) 1933—1939年，凯斯公司普通股的盈利状况在每股亏损14.66美元和盈利19.20美元之间变化，平均为3.18美元。股价介于30.5美元到191.75美元之间，公司1939年的收市价为73.75美元。',
    ),
    'substantive',
  );
  assert.equal(classifyNote('《伦巴底街》（ Lombard Street ），第245页，纽约，1892年。'), 'citation');
  assert.equal(classifyNote('关于这三家公司的数据将在附录注释1中给出。'), 'brief');
});

test('只有编者注和实质说明算「必须保住」', () => {
  assert.equal(isMustKeep('editor'), true);
  assert.equal(isMustKeep('substantive'), true);
  assert.equal(isMustKeep('brief'), false);
  assert.equal(isMustKeep('citation'), false);
});

/* -------------------------------------------------------- 认出脚注 -- */

const REF_XHTML = `<html><body>
<p class="body">痛苦<a id="jzyy_1_28" href="text00027.html#jz_1_28"> <sup>(1)</sup> </a>。假如要用抛硬币。</p>
</body></html>`;
const NOTE_XHTML = `<html><body>
<p class="fnContent-1"><a id="jz_1_28" href="text00009.html#jzyy_1_28">(1)</a> 正如格雷厄姆所言，亏钱常常会让人不安。最近的亏损经历会显著影响我们把握投资机会的能力。——卡拉曼注</p>
<h2 id="pre2_2">各方赞誉</h2>
</body></html>`;
const TOC_XHTML = `<html><body>
<p><a href="text00009.html#pre2_2">各方赞誉</a></p>
</body></html>`;

test('★ 认得出真正成对的脚注，且不会把目录锚点当成脚注', () => {
  const idx = buildNoteIndex([
    { index: 10, href: 'OEBPS/text00009.html', xhtml: REF_XHTML },
    { index: 28, href: 'OEBPS/text00027.html', xhtml: NOTE_XHTML },
    { index: 8, href: 'OEBPS/text00007.html', xhtml: TOC_XHTML },
  ]);
  /**
   * 目录指向 `#pre2_2`，而那个 id 挂在标题上。第一版实现把这类
   * 「有 id 且被引用」的元素全当注释，在这本书上捞出 1038 条（真实只有 483 条）。
   * 真正的脚注是**成对互指**的：正文 → 注释，注释 → 正文。
   */
  assert.equal(idx.totalNotes, 1, `只应认出 1 条脚注，实际 ${idx.totalNotes}`);
  const note = idx.notes.get('jz_1_28');
  assert.ok(note, '应认出 jz_1_28');
  assert.match(note.text, /亏钱常常会让人不安/);
  assert.doesNotMatch(note.text, /^\(1\)/, '注释正文不该把标记本身也算进去');
  assert.equal(idx.refToNote.get('jzyy_1_28'), 'jz_1_28');
  assert.equal(idx.notes.has('pre2_2'), false, '目录锚点不是脚注');
});

/* ---------------------------------------------------- 展开与清理 -- */

test('★ 脚注在提取时展开成注释正文，而且不占数字占位符', () => {
  const doc = parseXml(REF_XHTML.replace('</body>', '</body>'));
  const { blocks } = extractBlocks(doc);
  const noteRefs = new Map([['jzyy_1_28', { anchor: 'jz_1_28', text: '亏钱常常会让人不安。', kind: 'editor' }]]);

  const withNotes = blockToPlainText(blocks[0], { noteRefs });
  assert.match(withNotes.text, /⟦注1⟧亏钱常常会让人不安。⟦\/注1⟧/, `没展开：${withNotes.text}`);
  assert.equal(withNotes.noteChars, '亏钱常常会让人不安。'.length);

  /**
   * 关键：脚注**不能**进入 marks。
   * 进了 marks 就会被 rebuildBlockChildren 配对还原成原 <a> 元素 ——
   * 那样链接还在，等于「没删掉标记」，就地化就白做了。
   */
  const numeric = withNotes.marks.filter((m) => m.name === 'a');
  assert.equal(numeric.length, 0, `脚注不该占用数字占位符，实际 ${JSON.stringify(numeric.map((m) => m.name))}`);

  // 不传 noteRefs 时行为不变（脚注当普通行内元素保护起来）
  const without = blockToPlainText(blocks[0]);
  assert.equal(without.marks.some((m) => m.name === 'a'), true, '不传 noteRefs 时应保持旧行为');
});

test('★ 模型把标记留下时，剥掉包装、保住内容（最安全的兜底）', () => {
  const kept = stripNoteMarkers('痛苦⟦注1⟧亏钱常常会让人不安。⟦/注1⟧。假如要用抛硬币。');
  assert.equal(kept.keptInPlace, 1);
  assert.match(kept.text, /亏钱常常会让人不安。/);
  assert.ok(!kept.text.includes('⟦注'), '包装必须去掉');

  const onlyMarker = stripNoteMarkers('痛苦⟦注1⟧⟦/注1⟧。假如要用抛硬币。');
  assert.equal(onlyMarker.droppedMarkers, 1);
  assert.ok(!onlyMarker.text.includes('⟦注'));

  const stray = stripNoteMarkers('痛苦⟦/注3⟧。假如');
  assert.ok(!stray.text.includes('⟦/注3⟧'), '孤儿标记也要清掉');
});

test('★ 重建时脚注元素会被丢掉，其余行内元素照常保留', () => {
  const html = `<html><body><p>前<em>强调</em>中<a id="jzyy_1_28" href="t.html#jz_1_28"> <sup>(1)</sup> </a>后</p></body></html>`;
  const doc = parseXml(html);
  const { blocks } = extractBlocks(doc);
  const noteRefs = new Map([['jzyy_1_28', { anchor: 'jz_1_28', text: '这是注释正文，足够长以通过检查。', kind: 'editor' }]]);
  const { text, marks } = blockToPlainText(blocks[0], { noteRefs });

  // 模型把注释融进句子，只留 em 的占位符
  const emMark = marks.find((m) => m.name === 'em');
  const modelText = text
    .replace(/⟦注\d+⟧[\s\S]*?⟦\/注\d+⟧/g, '')
    .replace(new RegExp(`⟦${emMark.n}⟧[\\s\\S]*?⟦/${emMark.n}⟧`), `⟦${emMark.n}⟧强调⟦/${emMark.n}⟧`)
    .replace(/这是注释正文，足够长以通过检查。/, '这是融进正文的注释。');
  const result = rebuildBlockChildren(modelText, marks, { sourceLength: 40 });
  applyRebuild(blocks[0], result);

  const out = blocks[0].element.serialize(doc.source || html);
  assert.ok(out.includes('<em>'), '普通行内元素要保住');
  assert.ok(!out.includes('jzyy_1_28'), '脚注标记必须被删掉');
  assert.ok(!out.includes('<sup>'), '脚注的角标也要一起删掉');
});

/* ------------------------------------------------------ 覆盖率校验 -- */

test('★ 覆盖率用模糊匹配：改写过的注释算「还在」，真丢了才算丢', () => {
  const note = { text: '正如格雷厄姆所言，亏钱常常会让人不安。最近的亏损经历会显著影响我们把握投资机会的能力。', kind: 'editor' };

  // 措辞被改写，但意思和用词大体保留 —— 应该判为「还在」
  const rewritten = '……正如格雷厄姆所言，亏钱常常会让人感到不安。最近的亏损经历，会显著影响我们把握投资机会的能力。';
  const ok = noteCoverage(note.text, rewritten.split('。'));
  assert.equal(ok.covered, true, `改写后应判为还在，实际相似度 ${ok.best}`);

  // 完全无关的内容 —— 应该判为丢失
  const dropped = noteCoverage(note.text, ['这一段讲的是债券的利息保障倍数怎么算。']);
  assert.equal(dropped.covered, false, `丢了就该报出来，实际相似度 ${dropped.best}`);
});

test('覆盖率只检查「必须保住」的注释，短说明和纯出处允许被删', () => {
  const noteRefs = new Map([
    ['a', { text: '亏钱常常会让人不安，这种焦虑会影响投资机会。——卡拉曼注', kind: 'editor' }],
    ['b', { text: '见附录注释1。', kind: 'brief' }],
    ['c', { text: '《伦巴底街》，第245页，纽约，1892年。', kind: 'citation' }],
  ]);
  const report = checkNoteCoverage('这段完全没提注释内容。', noteRefs);
  assert.equal(report.checked, 1, `只该检查 1 条，实际 ${report.checked}`);
  /**
   * 注意措辞：字段叫 `dropped`（模型判定不保留），不是 `missing`（丢失）。
   * 一条注释没进成品，是模型在做编辑判断 —— 实测里被删的那条
   * 是「2007年次贷危机是最新最富戏剧性的案例」，挂在「但每隔一段时间……」
   * 后面，原文那句话本来就完整，删掉读起来更干净。
   * 所以这个报告只做诊断，**不接进用户界面、也不触发任何自动补回**。
   */
  assert.equal(report.dropped.length, 1);
  assert.equal(report.dropped[0].ref, 'a');
  assert.equal(report.kept, 0);
});

/* -------------------------------------------- 脚注署名（「——某某注」） -- */

/**
 * 用户的抱怨（原话）：「你把脚注融到了文字之中，但是你还会标注这个：xxxxx注。
 * 这个我觉得非常影响阅读体验，你不用标注什么什么注。我让你融进文字之中，
 * 就是把脚注当中有用的信息给融进文字之中，你就不用标注它是脚注了。」
 *
 * 查下来根因不在模型：原书 483 条尾注里有 69 条**末尾本来就签着**署名
 * （格兰特注 23 / 译者注 14 / 卡拉曼注 11 / 梅尔金注 / 唐朝注 /
 * 罗杰·洛温斯坦注 / 编者注 / 作者注）。模型把整条注释搬进正文，
 * 署名就跟着进来了。所以要在**送进模型之前**剥掉，而不是指望它记得别写。
 */

const BOOK_SIGNATURES = new Set([
  '卡拉曼注',
  '格兰特注',
  '作者注',
  '罗杰·洛温斯坦注',
  '译者注',
  '梅尔金注',
  '唐朝注',
  '编者注',
]);

test('署名只认缀在末尾的那种（正文中间出现的不算）', () => {
  assert.equal(extractNoteAttribution('……平均水平作为新的基准。——作者注'), '作者注');
  assert.equal(extractNoteAttribution('……第35页。——罗杰·洛温斯坦注 '), '罗杰·洛温斯坦注');
  // 中间有署名、但末尾不是 —— 尾注里不存在这种写法，不认才是对的
  assert.equal(extractNoteAttribution('——译者注 后面还有正文。'), null);
  assert.equal(extractNoteAttribution('这是一条没有署名的普通注释。'), null);
});

test('能从一本书的注释里收出署名闭集', () => {
  const set = collectNoteAttributions([
    '……作为新的基准。——作者注',
    '……第35页。——罗杰·洛温斯坦注',
    '这是一条没有署名的注释。',
    '……被严格审查。——梅尔金注',
  ]);
  assert.deepEqual(
    [...set].sort(),
    ['作者注', '梅尔金注', '罗杰·洛温斯坦注'].sort(),
  );
});

test('输入端：注释正文末尾的署名要剥掉，内容一字不动', () => {
  const r = stripTrailingNoteAttribution('1935年到1939年的平均水平作为新的基准。——作者注');
  assert.equal(r.stripped, 1);
  assert.equal(r.text, '1935年到1939年的平均水平作为新的基准。');

  // 没有署名的注释是空操作
  const plain = '亏钱常常会让人不安，这种焦虑会影响投资机会。';
  assert.deepEqual(stripTrailingNoteAttribution(plain), { text: plain, stripped: 0 });
});

test('输出端：模型搬注释时带出来的署名要剥掉，标点碎屑一起收拾', () => {
  // 这几条都是从成品里逐字抄出来的
  const cases = [
    ['市盈率。——编者注 ，这个系数反映的是：', '市盈率，这个系数反映的是：'],
    ['第35页。——罗杰·洛温斯坦注 。几年之后', '第35页。几年之后'],
    ['总部设在纽约州的哈奇森。——译者注 ：一个准破产案例', '总部设在纽约州的哈奇森：一个准破产案例'],
    ['《哈姆雷特》，第三幕，第二景。——梅尔金注。这种精神', '《哈姆雷特》，第三幕，第二景。这种精神'],
  ];
  for (const [input, want] of cases) {
    const r = stripNoteAttributions(input, { signatures: BOOK_SIGNATURES });
    assert.equal(r.stripped, 1, `${input} 应剥掉 1 处`);
    assert.equal(r.text, want);
  }
});

test('★ 不能把「赌注」「关注」「脚注」这类正常用词当成署名', () => {
  /**
   * 第一版判据只要求「破折号 + 短词 + 注」，实测在成品上挑出 84 处，
   * 其中一半以上是这种句子。这些字符串是逐条抄下来的误报样本。
   */
  const untouched = [
    '——准确说是一连串这样的注。',
    '这不是投资，而是一个赌注——每个赌注都押在公司的前景上。',
    '——没人关注这种小公司。',
    '——也就是关注资产负债表。',
    '公司以脚注的方式披露了这笔钱。',
    '——而盈利恰恰是华尔街最关注的。',
    '见附录注释16。',
    '——作者本杰明·格雷厄姆',
  ];
  for (const s of untouched) {
    const r = stripNoteAttributions(s, { signatures: BOOK_SIGNATURES });
    assert.equal(r.stripped, 0, `「${s}」被误判成署名了`);
    assert.equal(r.text, s);
  }
});

test('「（某某的注：……）」这种招牌也要摘掉 —— 换个写法标注脚注同样不行', () => {
  const r = stripNoteAttributions(
    '已经很少能成为漏网之鱼了（卡拉曼的注：技术革新让投资者能搜集到越来越多的信息）。',
    { signatures: BOOK_SIGNATURES },
  );
  assert.equal(r.stripped, 1);
  // 开括号留着（内容本来就括在里面），只摘掉「卡拉曼的注：」
  assert.equal(r.text, '已经很少能成为漏网之鱼了（技术革新让投资者能搜集到越来越多的信息）。');

  const r2 = stripNoteAttributions(
    '以及评级较低的债务工具（卡拉曼在这里加了一条注：另一种限制叫“谨慎人原则”）。',
    { signatures: BOOK_SIGNATURES },
  );
  assert.equal(r2.text, '以及评级较低的债务工具（另一种限制叫“谨慎人原则”）。');
});

test('招牌不靠闭集也能认出人称（「（编者注：」），但绝不泛化到任意名字', () => {
  // 没有闭集时，只有「译者/编者/作者…」这类确定的人称才认
  assert.equal(
    stripNoteAttributions('（编者注：这一句是编者加的）').text,
    '（这一句是编者加的）',
  );
  // 「某某人」不在闭集里、也不是人称 —— 一个字都不能动
  const unknown = '（某某人在这里加了一条注：内容）';
  assert.deepEqual(stripNoteAttributions(unknown, { signatures: BOOK_SIGNATURES }), {
    text: unknown,
    stripped: 0,
  });
  // 括号里是正常句子，即使结尾撞上「注：」也不动
  const normal = '（这句话是在解释什么叫做注：把注释的内容说出来）';
  assert.equal(stripNoteAttributions(normal, { signatures: BOOK_SIGNATURES }).stripped, 0);
});

test('findNoteAttributions 报出的位置能对上原文（修复脚本要靠它做预览）', () => {
  const src = '基准。——作者注 后面';
  const hits = findNoteAttributions(src, { signatures: BOOK_SIGNATURES });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, '作者注');
  assert.equal(src.slice(hits[0].start, hits[0].end).trim(), '——作者注');
});

test('★ 送进模型的注释正文里就不能再有署名（输入端真的接上了，不是只写了函数）', () => {
  /**
   * 这是根因所在的一层。模型把整条注释搬进正文，署名跟着进去 ——
   * 指望提示词叫它「别写」是概率性的；在**它看到注释的那一刻**就没有署名，
   * 才是确定性的。所以必须验证 blockToPlainText 这条真实链路上确实剥掉了。
   */
  const html = `<html><body><p>前<a id="jzyy_1_28" href="t.html#jz_1_28"> (1) </a>后</p></body></html>`;
  const doc = parseXml(html);
  const { blocks } = extractBlocks(doc);
  const noteRefs = new Map([[
    'jzyy_1_28',
    { anchor: 'jz_1_28', text: '1935年到1939年的平均水平作为新的基准。——作者注', kind: 'editor' },
  ]]);

  const { text, noteChars } = blockToPlainText(blocks[0], { noteRefs });
  assert.ok(!text.includes('作者注'), `送进模型的文本里还有署名：${text}`);
  assert.ok(text.includes('1935年到1939年的平均水平作为新的基准。'), '注释内容不能一起丢掉');
  assert.equal(noteChars, '1935年到1939年的平均水平作为新的基准。'.length, 'noteChars 要按剥掉署名之后的长度算');

  // 整条注释只有署名时，等于没有这条注释 —— 连 ⟦注N⟧ 包装都不该给模型看
  const empty = blockToPlainText(blocks[0], {
    noteRefs: new Map([['jzyy_1_28', { anchor: 'jz_1_28', text: '——译者注', kind: 'editor' }]]),
  });
  assert.ok(!empty.text.includes('⟦注'), `空注释不该留下包装：${empty.text}`);
  assert.equal(empty.noteChars, 0);
});

/* --------------------------------------------- 判据统一（回归修复） -- */

test('★ 输入端不能因为「末尾 + 破折号」就把一整句话当署名吃掉', () => {
  /**
   * 这是一个**真实回归**，而且是输入端独有的：`stripTrailingNoteAttribution`
   * 原先只看「末尾 + 破折号」，不看前面是什么；`findNoteAttributions` 却还要看
   * 「前面是不是句末标点」。同一件事两套判据，于是
   *
   *     ——准确说是一连串这样的注。
   *
   * 被整段剥成了空字符串（注释内容直接没了）。现在两边共用
   * `isRealAttribution` 一个判据，输入端不会再有这条捷径。
   */
  for (const s of ['——准确说是一连串这样的注。', '——每个赌注', '……——每个赌注']) {
    const r = stripTrailingNoteAttribution(s);
    assert.equal(r.stripped, 0, `「${s}」被整段吃掉了`);
    assert.equal(r.text, s, `「${s}」被动过`);
  }
  // 反过来，真署名照剥不误
  assert.equal(stripTrailingNoteAttribution('……见前引书。——格兰特注。').text, '……见前引书。');
});

test('★ 输入端和输出端对同一句话必须给同一个答案', () => {
  /**
   * 「同一件事两套判据」是这个模块唯一出过真事故的地方（见上一条）。
   * 这条测试把两个入口钉在一起：只要有人再给输入端开一条捷径，就会红。
   */
  const samples = [
    ['……第35页。——罗杰·洛温斯坦注。', true],
    ['……原文如此。——译者注。', true],
    ['——准确说是一连串这样的注。', false],
    ['……——每个赌注', false],
    ['……去翻资产负债表的脚注。', false],
  ];
  for (const [s, expected] of samples) {
    const inTail = stripTrailingNoteAttribution(s, { signatures: BOOK_SIGNATURES }).stripped > 0;
    const outAll = findNoteAttributions(s, { signatures: BOOK_SIGNATURES }).length > 0;
    assert.equal(inTail, expected, `输入端对「${s}」的判断变了`);
    assert.equal(outAll, expected, `输出端对「${s}」的判断变了`);
  }
});

test('★ 闭集被污染会让输出端到处错删 —— 收集时就不能收句子碎片', () => {
  /**
   * 闭集是「这本书真的在用的署名」，它一旦收进一句正文的尾巴，
   * 那句话就会在**全书**范围内被当成署名删掉。所以收集用的判据
   * （`isCollectableAttribution`）位置这一条不能放宽。
   */
  const sigs = collectNoteAttributions([
    '……见前引书。——格兰特注。',
    '——准确说是一连串这样的注。',
    '……——每个赌注',
  ]);
  assert.deepEqual([...sigs], ['格兰特注'], `闭集被污染了：${[...sigs].join(' / ')}`);
});

/* -------------------------------------------------- 覆盖到的署名形态 -- */

test('★ 括号署名（「（译者注）」「【编者注】」）也要摘掉', () => {
  // 末尾圆括号：连括号一起摘
  assert.equal(
    stripNoteAttributions('这有点像《西卜林书》里记载的传说（译者注）。', {
      signatures: BOOK_SIGNATURES,
    }).text,
    '这有点像《西卜林书》里记载的传说。',
  );
  // 句首方括号：只摘招牌，内容留着
  assert.equal(
    stripNoteAttributions('【译者注】此处原文为拉丁文。', { signatures: BOOK_SIGNATURES }).text,
    '此处原文为拉丁文。',
  );
  // 「（原注）」——单字形态靠人称认
  assert.equal(stripNoteAttributions('此处原文为拉丁文（原注）。').text, '此处原文为拉丁文。');
  // 但括号里只是一句带「注」字的正文，一个字都不能动
  const keep = '公司以脚注的方式披露（见资产负债表的脚注）。';
  assert.equal(stripNoteAttributions(keep, { signatures: BOOK_SIGNATURES }).text, keep);
});

test('★ 括号署名在输入端也要剥掉（模型不该看见「（译者注）」）', () => {
  /**
   * 输出端能兜住，但让模型**从一开始就没见过**才是确定性的 ——
   * 它看见了就可能在别处换个说法提一句「译者注」。
   */
  assert.equal(stripTrailingNoteAttribution('此处原文为拉丁文（译者注）。').text, '此处原文为拉丁文。');
  assert.equal(stripTrailingNoteAttribution('此处原文为拉丁文（原注）。').text, '此处原文为拉丁文。');
  // 括号夹在句子中间，后面那个句号是句子的结尾，不能跟着摘掉
  assert.equal(stripTrailingNoteAttribution('此处原文为拉丁文（译者注）').text, '此处原文为拉丁文');
  // 句首招牌：只摘招牌，内容留着
  assert.equal(stripTrailingNoteAttribution('【译者注】此处原文为拉丁文。').text, '此处原文为拉丁文。');
  // 整条注释只有招牌 —— 等于没有这条注释
  assert.equal(stripTrailingNoteAttribution('【译者注】').text, '');
  // 括号里是正文时一个字都不能动
  for (const s of ['公司以脚注的方式披露（见资产负债表的脚注）。', '作者注明了这一点（作者注明的）。']) {
    assert.equal(stripTrailingNoteAttribution(s).text, s, `「${s}」被动过`);
  }
});

test('★ 破折号尾词：注/按 靠位置判据，「译/校」只认闭集', () => {
  // 注 / 按：形状够特征，前面是句末标点就认
  assert.equal(stripNoteAttributions('此处有删节。——编者按。').text, '此处有删节。');
  assert.equal(stripNoteAttributions('见前引书。——责任编辑注。').text, '见前引书。');

  /**
   * 「译」这个字太常见（「——翻译，就是把一种语言换成另一种语言」），
   * 形状上不设防会吃掉正文，所以只在「名字是确定人称」或
   * 「这本书真的在用这个署名」时才认。
   */
  const named = '见前引书。——张三译。';
  assert.equal(stripNoteAttributions(named).stripped, 0, '没有闭集时不该动「——张三译」');
  assert.equal(
    stripNoteAttributions(named, { signatures: new Set(['张三译']) }).text,
    '见前引书。',
  );
  // 即使闭集里有别的署名，「——翻译，就是把……」也不能动
  const trans = '——翻译，就是把一种语言换成另一种语言。';
  assert.equal(stripNoteAttributions(trans, { signatures: new Set(['张三译']) }).text, trans);
});

test('★ 英文写法：ASCII 双连字符 + 英文句点也要认', () => {
  assert.equal(
    stripNoteAttributions('See the note above.-- Grant注.', { signatures: new Set(['Grant注']) })
      .text,
    'See the note above.',
  );
});


