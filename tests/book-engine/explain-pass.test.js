/**
 * 第二遍「读者补讲 / 删段」的回归测试。
 *
 * 这一遍是「优化后的书终于讲得清」的来源，也是最容易把书改坏的地方：
 * 补讲插错位置、删段删掉了首末段或某条链接的目标。下面每一条都对应一个
 * 真实会发生的坏情况。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createMockLlmServer } from './mock-llm.js';
import { rewriteChapter } from '../../lib/book-engine/pipeline/rewrite.js';
import {
  parseExplainOutput,
  parseInsertionBody,
  insertIntoElement,
  dropRejectReason,
  applyExplainResults,
  isBareNounPhrase,
  stripMidSentenceNarration,
  repairDanglingReference,
  giveBareSentencesSubject,
  tidyInsertionText,
  isCommentaryInsertion,
} from '../../lib/book-engine/pipeline/explain.js';
import { normalizeProvider } from '../../lib/book-engine/config/providers.js';
import { DEFAULT_SETTINGS } from '../../lib/book-engine/config/settings.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

function makeXhtml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>测试</title></head><body>
<h1>第一章</h1>
<p>第一段正文，讲的是一个人从东京出发去仙台，路上经过一个叫日暮里的驿站，他一直记得这个名字。</p>
<p>第二段正文，带一个脚注<sup><a href="#n1" id="r1">1</a></sup>，其余部分讲的是学校里的先生怎样替他改讲义，一字一句都改。</p>
<p>第三段正文，是重复的客套话，翻来覆去说这本书多么重要、多么有用，读完没有多出任何事实。</p>
<p>最后一段正文，收束全章，说他把先生的照片挂在墙上，疲倦时看一眼便又有了力气继续写下去。</p>
</body></html>`;
}

async function runWithMock(behavior) {
  const mock = createMockLlmServer({ behavior });
  const { baseUrl } = await mock.listen(0);
  try {
    const provider = normalizeProvider({
      name: 'Mock',
      baseUrl,
      model: 'mock-model',
      apiKey: 'sk-mock',
      maxTokens: 4096,
      temperature: 0.2,
      timeoutMs: 20000,
    });
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    settings.memory.enabled = false;
    const result = await rewriteChapter({
      xhtml: makeXhtml(),
      provider,
      profile: blankProfile(),
      settings,
      projectRoot: PROJECT_ROOT,
    });
    return result;
  } finally {
    await mock.close();
  }
}

test('补讲：改写完成后会再跑一遍，讲解插进成品正文', async () => {
  const result = await runWithMock('explain');
  assert.ok(result.explain.enabled, '默认应当开启补讲');
  assert.ok(result.explain.paragraphs >= 1, `应当至少补讲 1 段，实际 ${JSON.stringify(result.explain)}`);
  assert.ok(result.rewrittenBodyText.includes('mock 补讲'), '补讲内容必须进入正文');
  assert.equal(result.stats.explained, result.explain.paragraphs);
});

test('补讲：锚点里带 ⟦n⟧ 标记的插不进去，原文与脚注锚点都保留', async () => {
  const result = await runWithMock('explainBadMarks');
  assert.equal(result.explain.paragraphs, 0, '锚点带标记的补讲必须被拒绝');
  assert.ok(result.explain.rejected >= 1, '拒绝要计数，不能悄悄吞掉');
  assert.ok(result.xhtml.includes('id="r1"'), '脚注锚点必须还在');
  assert.ok(result.xhtml.includes('href="#n1"'), '脚注链接必须还在');
});

test('删段：没有信息量的段落会被删掉，首末段和标题不受影响', async () => {
  const result = await runWithMock('explainDrop');
  assert.equal(result.stats.dropped, 1, '应当删掉 1 段');
  assert.ok(!result.rewrittenBodyText.includes('重复的客套话'), '被删的段落不能留在成品里');
  assert.ok(result.rewrittenBodyText.includes('第一章'), '标题必须保留');
  assert.ok(result.rewrittenBodyText.includes('从东京出发'), '第一段必须保留');
  assert.ok(result.rewrittenBodyText.includes('照片挂在墙上'), '最后一段必须保留');
});

test('解析：段号越界的不认；同一段可以有多条插讲', () => {
  const parsed = parseExplainOutput(
    '【补 2】「乙段原文」→ 插一句解释。\n\n【补 2】「后面几个字」→ 再插一句。\n\n【补 9】「甲」→ 不存在\n\n【删 3】没有信息量',
    4,
  );
  assert.deepEqual(parsed.inserts.get(1), [
    { anchor: '乙段原文', text: '插一句解释。' },
    { anchor: '后面几个字', text: '再插一句。' },
  ]);
  assert.deepEqual(parsed.unknown, [9]);
  assert.equal(parsed.drops.get(2), '没有信息量');
});

test('解析：两行写法「锚点：… / 插入：…」也认', () => {
  assert.deepEqual(parseInsertionBody('锚点：日暮里\n插入：日暮里是东京北边的一个地名。'), {
    anchor: '日暮里',
    text: '日暮里是东京北边的一个地名。',
  });
  assert.equal(parseInsertionBody('这句话没有锚点'), null);
});

/** 造一个最小 DOM：element.children 里放文本节点和行内元素。 */
function textNode(value) {
  return {
    kind: 3,
    value,
    setValue(next) {
      this.value = String(next);
    },
  };
}
function el(children) {
  return { kind: 2, children, markDirty() {} };
}

test('插入：讲解落在整句说完之后，行内元素原样保留', () => {
  const before = textNode('前面一句话，讲到驿站，');
  const emphasis = { kind: 2, children: [textNode("着重")] };
  const after = textNode('，后面还有一句。');
  const element = el([before, emphasis, after]);

  const result = insertIntoElement(element, {
    anchor: '讲到驿站',
    text: '（旧时驿站在这里指中途歇脚的站点。）',
  });
  assert.equal(result.ok, true);
  assert.equal(before.value, '前面一句话，讲到驿站，', '锚点后面的逗号不能被讲解顶掉');
  assert.equal(emphasis.children[0].value, '着重', '行内元素一个字都不能动');
  assert.equal(after.value, '，后面还有一句。（旧时驿站在这里指中途歇脚的站点。）');
});

test('插入：锚点后面是逗号时，讲解不会把一句话劈成两半', () => {
  // 实测坏样本（《藤野先生》）：锚点「北京的白菜运到浙江」后面紧跟逗号，
  // 讲解插在逗号后 →「就用红头绳系住菜根」没了主语，读者以为书印错了。
  const element = el([
    textNode('北京的白菜运到浙江，就用红头绳系住菜根，倒挂在水果店门口，被尊称为“胶菜”。下一句。'),
  ]);
  const result = insertIntoElement(element, {
    anchor: '北京的白菜运到浙江',
    text: '这是用来说明物以稀为贵的道理',
  });
  assert.equal(result.ok, true);
  assert.equal(
    element.children[0].value,
    '北京的白菜运到浙江，就用红头绳系住菜根，倒挂在水果店门口，被尊称为“胶菜”。这是用来说明物以稀为贵的道理。下一句。',
  );
});

test('插入：没有句末标点的讲解会自动补句号', () => {
  const element = el([textNode('前一句，讲到驿站，后一句。')]);
  const result = insertIntoElement(element, { anchor: '讲到驿站', text: '驿站是中途歇脚的地方' });
  assert.equal(result.ok, true);
  assert.equal(element.children[0].value, '前一句，讲到驿站，后一句。驿站是中途歇脚的地方。');
});

test('插入：补讲只剩「指……」，插进去以后要能单独读通', () => {
  /**
   * 实测坏样本（《藤野先生》v11）：
   *   「……总少不了一群一群的“清国留学生”速成班的学生。指当时日本专为中国学生
   *     开设的短期速成教育班，学制比正式课程短……」
   * 补讲落在整句之后，读者看不见锚点，「指」的是谁全靠猜。
   */
  const element = el([textNode('花树底下总少不了一群一群的“清国留学生”速成班的学生。他们头顶上盘着大辫子。')]);
  const result = insertIntoElement(element, {
    anchor: '速成班的学生',
    text: '指当时日本专为中国学生开设的短期速成教育班。',
  });
  assert.equal(result.ok, true);
  assert.equal(
    element.children[0].value,
    '花树底下总少不了一群一群的“清国留学生”速成班的学生。“速成班的学生”指当时日本专为中国学生开设的短期速成教育班。他们头顶上盘着大辫子。',
  );
});

test('插入：「这里说……」「意思是……」这类开场也要补主语或去掉旁白', () => {
  // 「意思是……」→ 用锚点当主语
  const a = el([textNode('这大概就是物以稀为贵吧。')]);
  insertIntoElement(a, { anchor: '物以稀为贵', text: '意思是东西因为稀少而显得贵重。' });
  assert.equal(a.children[0].value, '这大概就是物以稀为贵吧。“物以稀为贵”意思是东西因为稀少而显得贵重。');

  // 「这里说……」→ 旁白没有信息，去掉就是完整句子
  const b = el([textNode('看上去就像头上顶了一座富士山。')]);
  insertIntoElement(b, { anchor: '富士山', text: '这里说学生帽被辫子顶得高高耸起。' });
  assert.equal(b.children[0].value, '看上去就像头上顶了一座富士山。学生帽被辫子顶得高高耸起。');

  // 「这里也是反话，指……」→ 旁白换成锚点，后面原样
  const c = el([textNode('问起来，得到的回答是学跳舞。')]);
  insertIntoElement(c, { anchor: '学跳舞', text: '这里也是反话，指那些整天关心跳舞的留学生。' });
  assert.equal(c.children[0].value, '问起来，得到的回答是学跳舞。“学跳舞”是反话，指那些整天关心跳舞的留学生。');

  // 「这里指……」→ 去掉旁白，剩下的如果是名词短语就请锚点当主语
  const d = el([textNode('不久就到了一个驿站，站名写着两个字：日暮里。')]);
  insertIntoElement(d, { anchor: '一个驿站', text: '这里指中途歇脚的地方。' });
  assert.equal(
    d.children[0].value,
    '不久就到了一个驿站，站名写着两个字：日暮里。“一个驿站”指中途歇脚的地方。',
  );
});

test('插入：开场本来就是完整句子时，一个字都不改', () => {
  const element = el([textNode('朱舜水客死他乡的地方。')]);
  insertIntoElement(element, { anchor: '朱舜水', text: '朱舜水是明末清初的学者，不肯降清。' });
  assert.equal(element.children[0].value, '朱舜水客死他乡的地方。朱舜水是明末清初的学者，不肯降清。');
});

test('补讲：模型第一次没按格式给条目，会再要一次，而不是静默少讲', async () => {
  /**
   * 实测（v12）：一章 6 块里 5 块补讲零产出，页面上没有任何痕迹。
   * 补讲是这一版的核心增值，解析不出条目时必须重问一次。
   */
  const result = await runWithMock('explainGarbageOnce');
  assert.ok(result.explain.paragraphs >= 1, `重问一次以后应当有讲解，实际 ${JSON.stringify(result.explain)}`);
  assert.ok(result.rewrittenBodyText.includes('mock 补讲'), '补讲要进正文');
});

test('补讲：两次都解析不出条目，要记一条告警，不能当成「成功但零条」', async () => {
  const result = await runWithMock('explainGarbageAlways');
  assert.equal(result.explain.paragraphs, 0);
  assert.equal(result.explain.empty, 1, `应当记下 1 块空产出，实际 ${JSON.stringify(result.explain)}`);
  assert.ok(
    result.warnings.some((w) => w.includes('补讲没有产出')),
    `要留告警，实际告警：${result.warnings.join(' | ')}`,
  );
});

test('解析：锚点里自带引号（「“生于太荒”」）也要能认出来', () => {
  // 实测（v11《五猖會》）：9 条里 2 条因为锚点带引号被当成格式错误丢掉
  assert.deepEqual(parseInsertionBody('「“生于太荒”」→ 「“生于太荒”」是和前面「粤自盘古」相连的一句。'), {
    anchor: '“生于太荒”',
    text: '「“生于太荒”」是和前面「粤自盘古」相连的一句。',
  });
  assert.deepEqual(parseInsertionBody('「《陶庵梦忆》」→ 《陶庵梦忆》是明末清初张岱的散文集。'), {
    anchor: '《陶庵梦忆》',
    text: '《陶庵梦忆》是明末清初张岱的散文集。',
  });
});

test('解析：模型漏了箭头、把锚点写进句子里，也要认（否则整章补讲全空）', () => {
  /**
   * 实测（v13《藤野先生》）：整块 14 条都是这个形状，两次重问都一样，
   * 解析一条都认不出 —— 一章补讲全空，页面上毫无痕迹。
   */
  assert.deepEqual(parseInsertionBody('“清国留学生”指当时在日本的清朝中国留学生，速成班是短期培训课程。'), {
    anchor: '清国留学生',
    text: '“清国留学生”指当时在日本的清朝中国留学生，速成班是短期培训课程。',
  });
  assert.deepEqual(parseInsertionBody('「标致」在这里是反话，其实是笑话他们那副打扮。'), {
    anchor: '标致',
    text: '「标致」在这里是反话，其实是笑话他们那副打扮。',
  });
  // 引号后面不是解释（而是一句别的话），不要瞎认
  assert.equal(parseInsertionBody('「原文」后面还有别的内容要说明'), null);
});

test('插入：锚点自带引号时，补主语要用锚点本身，不要叠出一堆引号', () => {
  const element = el([textNode('开头就是“生于太荒”这一句。')]);
  insertIntoElement(element, { anchor: '“生于太荒”', text: '指的是《鉴略》开头那一句。' });
  assert.equal(element.children[0].value, '开头就是“生于太荒”这一句。“生于太荒”指的是《鉴略》开头那一句。');
});

test('插入：锚点找不到 / 不唯一 / 太短 / 整段没有句末标点，一律拒绝', () => {
  const element = el([textNode('甲乙丙丁，甲乙丙丁，没有句号的一段字')]);
  assert.equal(insertIntoElement(element, { anchor: '戊己庚', text: '解释' }).reason, 'anchor-not-found');
  assert.equal(insertIntoElement(element, { anchor: '甲乙丙丁', text: '解释' }).reason, 'anchor-ambiguous');
  assert.equal(insertIntoElement(element, { anchor: '甲', text: '解释' }).reason, 'anchor-too-short');
  assert.equal(insertIntoElement(element, { anchor: '没有句号', text: '解释' }).reason, 'no-sentence-end');
  assert.equal(element.children[0].value, '甲乙丙丁，甲乙丙丁，没有句号的一段字', '被拒绝时原文不能变');
});

test('插入：锚点跨了行内元素也能用（它只负责定位那一句，不负责插在那里）', () => {
  const head = textNode('前半句到锚');
  const emphasis = { kind: 2, children: [textNode('点中间')] };
  const tail = textNode('后半句。');
  const element = el([head, emphasis, tail]);
  const result = insertIntoElement(element, { anchor: '锚点中间', text: '这是解释' });
  assert.equal(result.ok, true);
  assert.equal(head.value, '前半句到锚');
  assert.equal(emphasis.children[0].value, '点中间', '行内元素一个字都不能动');
  assert.equal(tail.value, '后半句。这是解释。');
});

test('插入：超过段落长度上限的（模型在讲自己的话）不插', () => {
  const element = el([textNode('短短一句话，讲到驿站。')]);
  const result = insertIntoElement(element, { anchor: '讲到驿站', text: '很长'.repeat(30) }, 20);
  assert.equal(result.reason, 'too-long');
});

test('插入：引文（引号里）不插话，免得读者以为后半句也是引文', () => {
  const element = el([textNode('他记扮《水浒传》人物云：“……于是，尋黑矮漢，尋梢長大漢，尋頭陀。”')]);
  const result = insertIntoElement(element, { anchor: '尋黑矮漢', text: '张岱写当时为扮人物满城寻找好汉。' });
  assert.equal(result.reason, 'inside-quote');
});

test('插入：补讲只有一个名词短语时，拿锚点当主语（否则读者读到半句话）', () => {
  /**
   * 实测坏样本（v14《藤野先生》《范愛農》《二十四孝圖》）：
   *   「这大概是《新约》上的句子吧……。基督教《圣经》的后半部分。」
   *   「……对学校里的掌故相当熟悉。上一学年考试不及格、不能升级的学生。」
   * 补讲落在整句之后，只是一个名词短语，读起来像书印错了。
   */
  const a = el([textNode('这大概是《新约》上的句子吧。')]);
  insertIntoElement(a, { anchor: '《新约》', text: '基督教《圣经》的后半部分。' });
  assert.equal(a.children[0].value, '这大概是《新约》上的句子吧。“《新约》”是基督教《圣经》的后半部分。');

  const b = el([textNode('那些坐在后面发笑的是上一学年不及格的留级学生，在学校已经待了一年。')]);
  insertIntoElement(b, { anchor: '留级学生', text: '上一学年考试不及格、不能升级的学生。' });
  assert.equal(
    b.children[0].value,
    '那些坐在后面发笑的是上一学年不及格的留级学生，在学校已经待了一年。“留级学生”是上一学年考试不及格、不能升级的学生。',
  );

  // 本来就是完整句子（有谓语、有逗号）的一个字都不改
  assert.equal(isBareNounPhrase('朱舜水是明末清初的学者，不肯降清，流亡日本。'), false);
  assert.equal(isBareNounPhrase('鲁迅说他们把帽子顶得高高耸起像富士山，是嘲笑辫子把帽子撑了起来。'), false);
  assert.equal(isBareNounPhrase('基督教《圣经》的后半部分。'), true);
});

test('补讲：同一段里重复/被包住的条目不再插入，每段最多两条', () => {
  const source =
    '第一句话讲日暮里，那是他从东京北上仙台时坐火车经过的一个小站，站名他却一直记得。' +
    '第二句话讲水户，说那是明朝遗民朱舜水客死的地方，他也就记住了这座城市。';
  const entry = {
    text: source,
    block: { isHeading: false, markDirty() {}, element: el([textNode(source)]) },
  };
  const inserts = new Map([
    [
      0,
      [
        { anchor: '日暮里', text: '日暮里是东京北边的一个车站名。' },
        { anchor: '日暮里', text: '日暮里是东京北边的一个车站名！' }, // 去标点后与上一条相同
        { anchor: '朱舜水客死', text: '朱舜水是明末清初的学者，流亡日本，最后死在水户。' },
        { anchor: '朱舜水客死', text: '流亡日本，最后死在水户。' }, // 被上一条完全包住
        { anchor: '第一句话', text: '日暮里在东京北边，是他坐火车经过的地方。' },
        { anchor: '一直记得这个名字', text: '再到水户就没了印象，那是朱舜水客死的地方。' },
      ],
    ],
  ]);
  const { stats, notes } = applyExplainResults({ entries: [entry], inserts, drops: new Map() });
  assert.equal(stats.explained, 1);
  assert.ok(
    notes.some((n) => n.includes('duplicate') || n.includes('too-many')),
    `被丢弃的条目要留痕，实际：${notes.join(' | ')}`,
  );
  const value = entry.block.element.children[0].value;
  assert.equal(value.split('东京北边的一个车站名').length - 1, 1, '同一条只插一次');
  assert.equal(value.split('死在水户').length - 1, 1, '被包住的短版本不能再插');
  /**
   * 每段最多两条（和提示词里的「每段最多两条」对齐）：
   * 前两条已经占满名额，后面两条都不该插进去。
   */
  assert.equal(value.split('日暮里在东京北边').length - 1, 0, '超过两条的要丢弃');
  assert.equal(value.split('再到水户就没了印象').length - 1, 0, '超过两条的要丢弃');
  assert.ok(notes.length >= 1);
});

test('插入：一条补讲中间又冒出「这里指……」时，把旁白收掉', () => {
  /**
   * 实测坏样本（v15《范愛農》）：
   *   「……常受雇参与各种秘密活动。这里指革命党人花钱雇他们去接应徐锡麟家属。」
   * 整条补讲落在句号后面，读到第二句时「这里」指谁已经不清楚了。
   */
  assert.equal(
    stripMidSentenceNarration('常受雇参与各种秘密活动。这里指革命党人花钱雇他们去接应徐锡麟家属。'),
    '常受雇参与各种秘密活动。革命党人花钱雇他们去接应徐锡麟家属。',
  );
  assert.equal(
    repairDanglingReference('清末电报是长途通讯的主要手段。这里指发电报给清政府，公开抗议其残暴。', '电报'),
    '清末电报是长途通讯的主要手段。发电报给清政府，公开抗议其残暴。',
  );
  // 收掉旁白以后成了「是……」这种没主语的开头，就不要动
  assert.equal(
    stripMidSentenceNarration('前一句。这里是说清政府的残暴。'),
    '前一句。这里是说清政府的残暴。',
  );
  // 正常句子原样不动
  assert.equal(stripMidSentenceNarration('朱舜水流亡日本，最后死在水户。'), '朱舜水流亡日本，最后死在水户。');
});

test('插入：补讲后面一句以「是……」开头时，要补上「这」', () => {
  // 实测坏样本（v17《藤野先生》）：「……开头就引用了《新约》里这句「你改悔罢」。是基督教《圣经》的后半部分……」
  const element = el([textNode('这是《新约》上的句子罢，但经托尔斯泰新近引用过的。')]);
  insertIntoElement(element, {
    anchor: '托尔斯泰',
    text: '“托尔斯泰”指俄国作家列夫·托尔斯泰，他写信给日俄两国皇帝，开头就引用了《新约》里这句「你改悔罢」。是基督教《圣经》的后半部分，记载耶稣及其门徒的事迹。',
  });
  assert.equal(
    element.children[0].value,
    '这是《新约》上的句子罢，但经托尔斯泰新近引用过的。“托尔斯泰”指俄国作家列夫·托尔斯泰，他写信给日俄两国皇帝，开头就引用了《新约》里这句「你改悔罢」。这是基督教《圣经》的后半部分，记载耶稣及其门徒的事迹。',
  );
  // 「即使」「是否」这类不是半截谓语，不能加「这」
  assert.equal(giveBareSentencesSubject('前一句。即使下雨也要去。'), '前一句。即使下雨也要去。');
  assert.equal(giveBareSentencesSubject('前一句。是否如此。'), '前一句。是否如此。');
});

test('补讲：第一小句不是句子时，用锚点当主语；是状语时不动', () => {
  /**
   * 实测坏样本（v18《五猖會》）：
   *   「……可以活下去。倘若在那里什么也不见，他们其实倒不如死。”俄国作家，鲁迅曾翻译过他的作品。」
   * 第一小句只是个名词，插在句号后面读起来像半句话。
   */
  assert.equal(
    repairDanglingReference('俄国作家，鲁迅曾翻译过他的作品。', '阿尔志跋绥夫'),
    '“阿尔志跋绥夫”是俄国作家，鲁迅曾翻译过他的作品。',
  );
  // 第一小句本来就是锚点：不能叠成「“朱自清”是朱自清，……」
  assert.equal(
    repairDanglingReference('朱自清，现代散文家，写过《背影》。', '朱自清'),
    '“朱自清”是现代散文家，写过《背影》。',
  );
  // 状语开头 / 状语结尾的，一个字都不能动（加了「是」就成病句）
  assert.equal(
    repairDanglingReference('日俄战争期间，他写信给两国皇帝。', '托尔斯泰'),
    '日俄战争期间，他写信给两国皇帝。',
  );
  assert.equal(
    repairDanglingReference('在仙台，他第一次见到藤野先生。', '仙台'),
    '在仙台，他第一次见到藤野先生。',
  );
  assert.equal(
    repairDanglingReference('这之后，他就离开了东京。', '东京'),
    '这之后，他就离开了东京。',
  );
});

test('补讲：重复标点、以及拿锚点当主语后又接「是这句」的，插进去前就要收干净', () => {
  // 实测（v18《五猖會》）：句尾两个句号
  assert.equal(tidyInsertionText('只要我想达到仁，仁就会到来。。'), '只要我想达到仁，仁就会到来。');
  // 实测（v18《五猖會》）：「……的」是这句出自《论语·述而》——两个「是」叠在一起
  assert.equal(
    tidyInsertionText('“有念“仁远乎哉我欲仁斯仁至矣”的”是这句出自《论语·述而》，意思是仁德离我并不远。'),
    '这句出自《论语·述而》，意思是仁德离我并不远。',
  );
  // 正常的句子一个字不动
  assert.equal(
    tidyInsertionText('朱舜水是明末清初的学者，不肯降清，流亡日本。'),
    '朱舜水是明末清初的学者，不肯降清，流亡日本。',
  );
});

test('补讲：站在书外面点评的旁白，一律不插', () => {
  /**
   * 实测（v19《藤野先生》）：
   *   「这是鲁迅在转述当时日本社会流行的偏见：国家弱，中国人就被当成低能儿……」
   *   「这句在写他离开东京时的记忆。」
   * 这类句子只是阅读理解的批注，原文一个字都没多说。
   */
  const element = el([textNode('中国是弱国，所以中国人当然是低能儿。但我接着便有参观枪毙中国人的命运了。')]);
  const result = insertIntoElement(element, {
    anchor: '中国人当然是低能儿',
    text: '这是鲁迅在转述当时日本社会流行的偏见，国家弱中国人就被当成低能儿。',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'commentary');
  assert.equal(element.children[0].value, '中国是弱国，所以中国人当然是低能儿。但我接着便有参观枪毙中国人的命运了。');

  assert.equal(isCommentaryInsertion('这句在写他离开东京时的记忆。'), true);
  assert.equal(isCommentaryInsertion('这说明作者的讽刺笔法。'), true);
  // 正常补讲不受影响
  assert.equal(isCommentaryInsertion('《新约》是基督教《圣经》的后半部分。'), false);
  assert.equal(isCommentaryInsertion('这是基督教《圣经》的后半部分。'), false);
  assert.equal(isCommentaryInsertion('朱舜水是明末清初的学者，流亡日本。'), false);
});

test('补讲：第一人称的书里，讲解不该改口用第三人称提作者', () => {
  /**
   * 实测（v20《藤野先生》）：
   *   「芋梗是芋头的茎，煮成汤味道很涩，鲁迅觉得难以下咽，说明仙台的饮食他很不习惯。」
   * 正文通篇是「我」，插进来一句叫作者名字的话，读者立刻出戏。
   */
  const body = '我每天总要喝那难以下咽的芋梗汤，我喝得实在辛苦，后来我一直记得那个味道。';
  const node = textNode(body);
  const entry = { text: body, block: { isHeading: false, markDirty() {}, element: el([node]) } };
  const inserts = new Map([
    [0, [{ anchor: '芋梗汤', text: '芋梗是芋头的茎，煮成汤味道很涩，鲁迅觉得难以下咽。' }]],
  ]);
  const { notes } = applyExplainResults({
    entries: [entry],
    inserts,
    drops: new Map(),
    authorNames: ['鲁迅'],
  });
  assert.ok(notes.some((n) => n.includes('third-person')), `要留痕，实际：${notes.join(' | ')}`);
  assert.equal(node.value, body, '被拒绝时原文一个字都不能变');

  // 第三人称的书（全篇没有「我」）不受这条限制，别把正常的补讲一起砍掉
  const thirdBody = '他只说这芋梗汤难喝极了，只好天天忍着喝完。';
  const thirdNode = textNode(thirdBody);
  const thirdEntry = { text: thirdBody, block: { isHeading: false, markDirty() {}, element: el([thirdNode]) } };
  applyExplainResults({
    entries: [thirdEntry],
    inserts: new Map([[0, [{ anchor: '芋梗汤', text: '芋梗是芋头的茎，煮成汤味道很涩。' }]]]),
    drops: new Map(),
    authorNames: ['鲁迅'],
  });
  assert.ok(thirdNode.value.includes('芋梗是芋头的茎'), '第三人称的书照常补讲');
});

test('补讲：书里作者名是繁体、模型写简体，也要认出是同一个人', () => {
  // 维基文库导航表写「魯迅」，正文和补讲写「鲁迅」：按原字比对永远对不上。
  const body = '我心里想，我是多么想念那位先生，我后来一直记着他。';
  const node = textNode(body);
  const entry = { text: body, block: { isHeading: false, markDirty() {}, element: el([node]) } };
  const { notes } = applyExplainResults({
    entries: [entry],
    inserts: new Map([[0, [{ anchor: '那位先生', text: '鲁迅在仙台时受他照顾，一直记着他的样子。' }]]]),
    drops: new Map(),
    authorNames: ['魯迅'],
  });
  assert.ok(notes.some((n) => n.includes('third-person')), `要留痕，实际：${notes.join(' | ')}`);
  assert.equal(node.value, body, '被拒绝时原文一个字都不能变');
});

test('补讲：第一人称的书里，绕开名字直接说「作者」也算第三人称', () => {
  /**
   * 实测（v25《藤野先生》）：正文「……煮成汤味道很涩」，补讲写成
   * 「……所以作者说难以下咽。」读者正在听「我」说话，突然冒出「作者」，
   * 等于把人推到书外面去 —— 和直呼「鲁迅」是同一类旁白。
   */
  const body = '我在这里吃的第一顿饭，是把芋梗煮成汤，我皱着眉头，我记得自己硬咽了下去。';
  const node = textNode(body);
  const entry = { text: body, block: { isHeading: false, markDirty() {}, element: el([node]) } };
  const { notes } = applyExplainResults({
    entries: [entry],
    inserts: new Map([[0, [{ anchor: '芋梗煮成汤', text: '芋梗是芋头的叶柄，煮出来的汤味道很涩，所以作者说难以下咽。' }]]]),
    drops: new Map(),
    authorNames: [],
  });
  assert.ok(notes.some((n) => n.includes('third-person')), `要留痕，实际：${notes.join(' | ')}`);
  assert.equal(node.value, body, '被拒绝时原文一个字都不能变');
});

test('补讲：中间夹着「这里鲁迅用来自嘲」这类旁白时，收掉旁白留正文', () => {
  assert.equal(
    stripMidSentenceNarration(
      '“物以稀为贵”意思是东西因为稀少才显得贵重。这里鲁迅用来自嘲：仙台还没有中国学生，所以他这个中国人才被学校格外优待。',
    ),
    '“物以稀为贵”意思是东西因为稀少才显得贵重。仙台还没有中国学生，所以他这个中国人才被学校格外优待。',
  );
});

test('补讲：句尾「这里引的是……」、整句「是……的一种说法」的旁白要收掉', () => {
  // 实测（v21《二十四孝圖》《從百草園到三味書屋》）
  assert.equal(
    tidyInsertionText('阿尔志跋绥夫是俄国作家，鲁迅早年翻译过他的作品，这里引的是他小说里的话。'),
    '阿尔志跋绥夫是俄国作家，鲁迅早年翻译过他的作品。',
  );
  assert.equal(
    tidyInsertionText('朱文公是南宋理学家朱熹，“文”是他的谥号。卖给朱文公的后人，是鲁迅对买主的一种带点调侃的说法。'),
    '朱文公是南宋理学家朱熹，“文”是他的谥号。',
  );
  // 正常的补讲一个字不动
  assert.equal(
    tidyInsertionText('《新约》是基督教《圣经》的后半部分，记载耶稣及其门徒的事迹。'),
    '《新约》是基督教《圣经》的后半部分，记载耶稣及其门徒的事迹。',
  );
});

test('补讲：整条以「是……」开头（漏了主语）时，用锚点当主语', () => {
  /**
   * 实测（v23《二十四孝圖》）：
   *   「……即使半语不合，一念偶差，也都得受相当的报应。是旧时民间流传的劝善书，专讲地狱里各种刑罚和因果报应。」
   * 模型把书名省了，只给半句话。锚点就是那本书的名字，直接接上去。
   */
  assert.equal(
    repairDanglingReference('是旧时民间流传的劝善书，专讲地狱里各种刑罚和因果报应。', '《玉历钞传》'),
    '“《玉历钞传》”是旧时民间流传的劝善书，专讲地狱里各种刑罚和因果报应。',
  );
  // 「是非」「是否」不是半截谓语，不能硬加主语
  assert.equal(repairDanglingReference('是非曲直自有公论。', '这段公案'), '是非曲直自有公论。');
});

test('补讲：句子中间「这里引用的……」也是旁白，收掉', () => {
  // 实测（v23《藤野先生》）
  assert.equal(
    stripMidSentenceNarration(
      '《新约》是基督教《圣经》的后半部分。这里引用的“你改悔罢”出自《新约·马太福音》，是劝人悔改的话。',
    ),
    '《新约》是基督教《圣经》的后半部分。“你改悔罢”出自《新约·马太福音》，是劝人悔改的话。',
  );
});

test('插入：句末紧跟括号出处时，讲解插在出处后面，不把引文和出处拆开', () => {
  /**
   * 实测（v23《二十四孝圖》）：
   *   师觉授《孝子传》云，“……僵仆为婴儿啼。”（《太平御览》四百十三引）较之今说……
   * 讲解插在引号和出处括号中间，读者会以为「（《太平御览》四百十三引）」
   * 是讲解里的，引文的出处反而看不出来。
   */
  const element = el([
    textNode('师觉授《孝子传》云，“老莱子常著斑斓之衣，僵仆为婴儿啼。”（《太平御览》四百十三引）较之今说，似稍近于人情。'),
  ]);
  const result = insertIntoElement(element, {
    anchor: '师觉授',
    text: '是南朝宋人，编过《孝子传》。',
  });
  assert.equal(result.ok, true);
  const value = element.children[0].value;
  assert.ok(
    value.indexOf('四百十三引）') < value.indexOf('“师觉授”是南朝宋人'),
    `讲解要落在出处括号后面，实际：${value}`,
  );
});

test('补讲：两条都挂在同一句句末时，按模型给的顺序落下，不会反过来', () => {
  /**
   * 实测（v23《二十四孝圖》）：原文先说《文昌帝君阴骘文图说》、后说《玉历钞传》，
   * 两条讲解都插在同一句句末，先处理的那条会被后处理的顶到后面去。
   */
  const source = '我能在大众面前阅看的，是《文昌帝君阴骘文图说》和《玉历钞传》，都画着赏善罚恶的故事。';
  const node = textNode(source);
  const entry = { text: source, block: { isHeading: false, markDirty() {}, element: el([node]) } };
  applyExplainResults({
    entries: [entry],
    inserts: new Map([
      [
        0,
        [
          { anchor: '《文昌帝君阴骘文图说》', text: '《文昌帝君阴骘文图说》是清代的劝善书，配图讲因果报应。' },
          { anchor: '《玉历钞传》', text: '《玉历钞传》是旧时流传的劝善书，专讲地狱刑罚。' },
        ],
      ],
    ]),
    drops: new Map(),
  });
  const value = node.value;
  assert.ok(
    value.indexOf('文昌帝君阴骘文图说》是清代') < value.indexOf('玉历钞传》是旧时'),
    `书里先提到的书，讲解也要先出现，实际：${value}`,
  );
});

test('补讲：正文是简体、讲解写成繁体时，先摊成简体再收旁白', () => {
  /**
   * 实测（v24《藤野先生》）：正文全简体，模型给的「这里說日本的翻译……」用了「說」，
   * 收旁白的规则一条都没对上，最后导出折成简体，正文里留下一句「这里说……」。
   */
  const element = el([textNode('他们的翻译和研究新的医学，并不比中国早。')]);
  const result = insertIntoElement(element, {
    anchor: '翻译和研究新的医学',
    text: '這裡說日本的翻譯與研究新的醫學，並不比中國早。',
  });
  assert.equal(result.ok, true);
  const value = element.children[0].value;
  assert.ok(!value.includes('这里说') && !value.includes('這裡說'), `旁白要收掉，实际：${value}`);
  assert.ok(value.includes('日本的翻译与研究新的医学'), `正文要摊成简体，实际：${value}`);

  // 正文本身就是繁体时，不能把讲解改成简体
  const trad = el([textNode('他們的翻譯與研究新的醫學，並不比中國早。')]);
  insertIntoElement(trad, { anchor: '翻譯與研究新的醫學', text: '朱舜水是明末的學者。' });
  assert.ok(trad.children[0].value.includes('朱舜水是明末的學者。'), '繁体书的讲解保持繁体');
});

test('删段底线：标题、首末段、带标记、带锚点的段落一律不删', () => {
  const body = '这是一段足够长的正文，用来测试删段的各种拒绝条件：它必须长过四十个字，否则会因为太短被拒绝，测不到后面那几条规则。';
  assert.equal(dropRejectReason({ text: body, block: { isHeading: true, element: {} } }, 1, 5), 'heading');
  assert.equal(dropRejectReason({ text: body, block: { isHeading: false, element: {} } }, 0, 5), 'edge-paragraph');
  assert.equal(dropRejectReason({ text: body, block: { isHeading: false, element: {} } }, 4, 5), 'edge-paragraph');
  assert.equal(
    dropRejectReason({ text: `${body}⟦1⟧脚注⟦/1⟧`, block: { isHeading: false, element: {} } }, 2, 5),
    'has-markers',
  );
  const anchored = { getAttribute: (n) => (n === 'id' ? 'a1' : null), childElements: [] };
  assert.equal(
    dropRejectReason({ text: body, block: { isHeading: false, element: anchored } }, 2, 5),
    'has-anchor',
  );
  assert.equal(dropRejectReason({ text: body, block: { isHeading: false, element: { childElements: [] } } }, 2, 5), null);
});
