/**
 * 文风守卫的测试。
 *
 * 这份测试的重点**不是**「能不能删掉模板腔」，而是
 * **「会不会误删作者的话」**。
 * 删不干净只是观感差一点；误删正文就是内容事故 ——
 * 这个项目的第一原则是「绝不能把原书内容改没」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectTemplateLeadIn,
  stripTemplateLeadIn,
  stripTemplateLeadIns,
  MIN_REMAINDER_CHARS_HEADING,
} from '../../lib/book-engine/pipeline/style-guard.js';

/* ------------------------------------------------ 该删的（用户实际遇到的）-- */

test('删掉用户实际遇到的「这一节的核心结论是：」', () => {
  const original = '尽管《证券分析》写于75年前，书中案例已经年代久远，但它阐述的投资方法至今依然管用。';
  const rewritten =
    '这一节的核心结论是：尽管《证券分析》写于75年前、书中的案例已经年代久远，但它所阐述的投资方法至今依然管用，仍然是投资者在动荡市场中可以依靠的路线图。';

  const result = stripTemplateLeadIn(rewritten, original);
  assert.equal(result.stripped, 1);
  assert.ok(result.text.startsWith('尽管《证券分析》写于75年前'));
  assert.ok(!result.text.includes('这一节的核心结论是'));
});

test('各种变体的标签句都能认出来', () => {
  const variants = [
    '这一节的核心结论是：',
    '本节的结论是：',
    '本节核心结论：',
    '核心结论是：',
    '这一段的结论是——',
    '小结：',
    '一句话总结：',
    '换句话说，',
    '简而言之，',
    '值得注意的是，',
    '综上所述，',
    '这一节我们要回答的问题是：',
  ];
  for (const v of variants) {
    const text = `${v}后面是真正的正文内容，这里要够长才不会被当成空段。`;
    const n = detectTemplateLeadIn(text);
    assert.ok(n > 0, `认不出这种标签：${v}`);
    const stripped = stripTemplateLeadIn(text, '原文里没有这种说法，讲的是别的事情。');
    assert.equal(stripped.stripped, 1, `没删掉：${v}`);
    assert.ok(stripped.text.startsWith('后面是真正的正文'), `删多了或删少了：${stripped.text.slice(0, 20)}`);
  }
});

test('连着两层模板腔（结论 + 简而言之）都能剥掉', () => {
  const text = '这一节的核心结论是：简而言之，市场短期是投票机，长期是称重机，这句话值得记住。';
  const result = stripTemplateLeadIn(text, '原文：市场短期是投票机。');
  assert.equal(result.stripped, 2);
  assert.ok(result.text.startsWith('市场短期是投票机'));
});

test('多段输出逐段清理（标签是逐段贴的）', () => {
  const rewritten = [
    '这一节的核心结论是：第一段真正的内容在这里，讲的是安全边际。',
    '',
    '这一节的核心结论是：第二段真正的内容在这里，讲的是分散投资。',
    '',
    '这一节的核心结论是：第三段真正的内容在这里，讲的是市场先生。',
  ].join('\n');
  const result = stripTemplateLeadIns(rewritten, '原文内容。');
  assert.equal(result.stripped, 3);
  assert.ok(!result.text.includes('这一节的核心结论是'));
  assert.ok(result.text.includes('安全边际'));
  assert.ok(result.text.includes('分散投资'));
  assert.ok(result.text.includes('市场先生'));
  assert.equal(result.text.split('\n\n').length >= 3, true, '段落结构要保住');
});

/* ------------------------------------------------------ 绝不能删的 -- */

test('★ 原文自己就带这个说法时，一个字都不能动', () => {
  // 作者本来就在写「这一节的核心结论是」——那是作者的话
  const original = '这一节的核心结论是：市场并不总是有效的。';
  const rewritten = '这一节的核心结论是：市场并不总是有效的，这一点在格雷厄姆的时代就已经被反复验证过了。';
  const result = stripTemplateLeadIn(rewritten, original);
  assert.equal(result.stripped, 0, '原文自带的说法的不能删');
  assert.ok(result.text.startsWith('这一节的核心结论是'));
});

test('★ 带实词的句子不算模板，不能删', () => {
  const cases = [
    '本节的核心结论是格雷厄姆在1934年提出的安全边际概念，它要求买入价格显著低于内在价值。',
    '这一节我们要回答的问题是为什么市场会周期性地失效，以及投资者该如何应对它。',
  ];
  for (const text of cases) {
    const result = stripTemplateLeadIn(text, '原文。');
    assert.equal(result.stripped, 0, `把实词删掉了：${result.text.slice(0, 30)}`);
    assert.equal(result.text, text);
  }
  // 「小结一下三个要点：」这种是标签 + 正文，允许剥标签但要点必须留着
  const withList = stripTemplateLeadIn('小结一下三个要点：第一，安全边际；第二，分散；第三，耐心。', '原文。');
  assert.ok(withList.text.includes('安全边际') && withList.text.includes('耐心'), '要点不能被删');
});

test('★ 长句只剥开头的标签，后面的正文一个字都不能丢', () => {
  const long =
    '这一节的核心结论是：作者认为投资者应当把注意力放在企业的长期盈利能力上，' +
    '而不是短期股价波动，同时必须为自己留出足够的容错空间。';
  const result = stripTemplateLeadIn(long, '原文没有这个说法。');
  assert.equal(result.stripped, 1);
  assert.ok(result.text.startsWith('作者认为投资者应当把注意力'), `正文被改动了：${result.text.slice(0, 30)}`);
  // 标签之后的每一个字都必须在
  assert.ok(result.text.endsWith('同时必须为自己留出足够的容错空间。'));
  assert.equal(result.text.length, long.length - '这一节的核心结论是：'.length);
});

test('★ 标签词后面直接接实词时，整句都不动（实词不能被当标签吃掉）', () => {
  const cases = [
    '本节的核心结论是安全边际要求买入价格显著低于内在价值，这是格雷厄姆的核心思想。',
    '小结三个要点分别是安全边际、分散投资与耐心持有，缺一不可。',
    '换句话说市场先生每天报价，但投资者不必每天交易。',
  ];
  for (const text of cases) {
    const result = stripTemplateLeadIn(text, '原文里没有这种说法。');
    assert.equal(result.stripped, 0, `不该删：${text.slice(0, 20)}`);
    assert.equal(result.text, text);
  }
});

test('★ 删完就什么都不剩的，不删（不能让段落消失）', () => {
  const result = stripTemplateLeadIn('这一节的核心结论是：好。', '原文。');
  assert.equal(result.stripped, 0);
  assert.equal(result.text, '这一节的核心结论是：好。');
});

test('★ 标题用更低的下限，否则脏标签会永远印在小标题上', () => {
  // <h1>第一章 起点</h1> 剥完只剩 6 个字，按正文的下限（8）永远清不掉
  const heading = '这一节的核心结论是：第一章 起点';
  assert.equal(stripTemplateLeadIn(heading, '原文。').stripped, 0, '按正文下限确实不该动');

  const asHeading = stripTemplateLeadIn(heading, '原文。', {
    minRemainder: MIN_REMAINDER_CHARS_HEADING,
  });
  assert.equal(asHeading.stripped, 1, '标题下限下应该能剥掉');
  assert.equal(asHeading.text, '第一章 起点');

  // 但「不能删作者的话」这条保险不受影响
  const authorHeading = stripTemplateLeadIn(heading, '这一节的核心结论是：第一章 起点', {
    minRemainder: MIN_REMAINDER_CHARS_HEADING,
  });
  assert.equal(authorHeading.stripped, 0, '原文自带的标题一个字都不能动');
});

test('正常段落一字不改', () => {
  const text = '格雷厄姆在1934年提出，投资者应当关注企业的内在价值，并在价格显著低于价值时买入。';
  const result = stripTemplateLeadIn(text, '原文。');
  assert.equal(result.stripped, 0);
  assert.equal(result.text, text);
});

test('空输入不炸', () => {
  assert.deepEqual(stripTemplateLeadIn('', ''), { text: '', stripped: 0, removed: [] });
  assert.deepEqual(stripTemplateLeadIn(null, null), { text: '', stripped: 0, removed: [] });
  assert.equal(detectTemplateLeadIn('   '), 0);
});

test('★ 章节开头也不留例外：剥掉标签不会丢结论', () => {
  // 用户的画像要「先给结论」，但那不等于允许贴「核心结论」四个字的标签。
  // 剥完「市场并不总是有效的」照样在最前面 —— 少的是模板腔，不是内容。
  const text = '这一节的核心结论是：市场并不总是有效的，价格会围绕价值上下波动。';
  const result = stripTemplateLeadIns(text, '原文讲的是市场有效性。');
  assert.equal(result.stripped, 1);
  assert.ok(result.text.startsWith('市场并不总是有效的'), '结论仍然在最前面');
  assert.ok(!result.text.includes('核心结论'));
});
