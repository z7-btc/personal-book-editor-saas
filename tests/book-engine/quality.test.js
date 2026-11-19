/**
 * 质量检查测试（需求第十五节）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkQuality,
  extractNumberTokens,
  extractEntityTokens,
  diffParagraphs,
  splitParagraphs,
  SEVERITY,
} from '../../lib/book-engine/pipeline/quality.js';

const ORIGINAL = `在 1973 年，这本书第一次出版，当时的通胀率高达 12.3%。
Benjamin Graham 与 David Dodd 在 1934 年提出了安全边际的概念。
如果一家公司每股净资产为 50 美元，而你只用 30 美元买入，安全边际就是 40%。
到了 2008 年，Acme Corp. 的市值下跌了 55%。
作者强调，这个结论在极端情况下可能不成立。`;

test('长度严重缩短被判定为 fail', () => {
  const report = checkQuality({
    originalText: ORIGINAL,
    rewrittenText: '这本书讲了安全边际。',
  });
  assert.equal(report.verdict, SEVERITY.FAIL);
  assert.ok(report.issues.some((i) => i.type === 'length' && i.severity === 'fail'));
});

test('长度略短只告警', () => {
  const report = checkQuality({
    originalText: ORIGINAL,
    rewrittenText: ORIGINAL.replace(/作者强调[^。]*。/, '作者强调该结论有前提。'),
  });
  assert.notEqual(report.verdict, SEVERITY.FAIL);
});

test('长度基本保持时判定通过', () => {
  const report = checkQuality({
    originalText: ORIGINAL,
    // 逐句改写，长度几乎不变，数字与专名全部保留
    rewrittenText: ORIGINAL.replace(/，/g, '，').replace('第一次出版', '首次出版'),
  });
  assert.equal(report.verdict, SEVERITY.OK, JSON.stringify(report.issues));
  assert.ok(report.metrics.lengthRatio > 0.9);
});

test('数字大量丢失被检出', () => {
  const report = checkQuality({
    originalText: ORIGINAL,
    rewrittenText: ORIGINAL.replace(/\d+(\.\d+)?/g, '若干'),
  });
  assert.ok(report.issues.some((i) => i.type === 'numbers'), JSON.stringify(report.issues));
  assert.equal(report.metrics.numberMissing > 0, true);
});

test('专有名词消失被检出', () => {
  const report = checkQuality({
    originalText: ORIGINAL,
    rewrittenText: ORIGINAL.replace(/Benjamin Graham/g, '某位学者')
      .replace(/David Dodd/g, '他的同事')
      .replace(/Acme Corp\./g, '一家公司'),
  });
  const issue = report.issues.find((i) => i.type === 'entities');
  assert.ok(issue, JSON.stringify(report.issues));
  assert.ok(issue.details.missing.some((m) => m.token.includes('Graham')));
});

test('HTML 结构失败会直接导致 fail', () => {
  const report = checkQuality({
    originalText: ORIGINAL,
    rewrittenText: ORIGINAL,
    htmlCheck: { ok: false, errors: ['缺少 <body> 元素'], warnings: [] },
  });
  assert.equal(report.verdict, SEVERITY.FAIL);
  assert.ok(report.issues.some((i) => i.type === 'html'));
});

test('占位符异常计入 issues（但不丢内容）', () => {
  const report = checkQuality({
    originalText: ORIGINAL,
    rewrittenText: ORIGINAL,
    pipelineStats: { missing: 2, unbalanced: 1, unknown: 0 },
  });
  const issue = report.issues.find((i) => i.type === 'placeholders');
  assert.ok(issue);
  assert.match(issue.message, /丢失 2/);
});

test('extractNumberTokens 覆盖年份 / 百分比 / 金额 / 普通数字', () => {
  const tokens = extractNumberTokens('1973 年，通胀 12.3%，价格 $1,200 与 40 美元，占 55%。');
  const keys = [...tokens.keys()];
  assert.ok(keys.includes('1973'), keys.join(','));
  assert.ok(keys.includes('12.3%'), keys.join(','));
  assert.ok(keys.some((k) => k.includes('1200')), keys.join(','));
  assert.ok(keys.includes('55%'), keys.join(','));
});

test('全角数字会被归一化后再比较', () => {
  const a = extractNumberTokens('1973 年');
  const b = extractNumberTokens('１９７３ 年');
  assert.deepEqual([...b.keys()], [...a.keys()]);
});

test('extractEntityTokens 抓拉丁专名与缩写', () => {
  const entities = extractEntityTokens('Benjamin Graham 与 DCF 模型，见《证券分析》。');
  const keys = [...entities.keys()];
  assert.ok(keys.some((k) => k.includes('Benjamin')), keys.join(','));
  assert.ok(keys.includes('DCF'), keys.join(','));
  assert.ok(keys.includes('证券分析'), keys.join(','));
});

test('常见虚词不会被当成专有名词', () => {
  const entities = extractEntityTokens('The quick brown fox. However, This is fine.');
  for (const stop of ['The', 'This', 'However']) {
    assert.ok(!entities.has(stop), `${stop} 不应被算作专名`);
  }
});

test('diffParagraphs 输出 same / add / del', () => {
  const a = '第一段\n第二段\n第三段';
  const b = '第一段\n第二段（改过）\n第三段\n第四段';
  const diff = diffParagraphs(a, b);
  const types = diff.map((d) => d.type);
  assert.ok(types.includes('same'));
  assert.ok(types.includes('add'));
  assert.ok(types.includes('del'));
  assert.equal(diff.filter((d) => d.type === 'same').length, 2);
});

test('diffParagraphs 在完全相同时全部是 same', () => {
  const text = 'a\nb\nc';
  const diff = diffParagraphs(text, text);
  assert.ok(diff.every((d) => d.type === 'same'));
});

test('splitParagraphs 去掉空行', () => {
  assert.deepEqual(splitParagraphs('a\n\n\n b \n\nc\n'), ['a', 'b', 'c']);
});

/* ---------------------------------------------------------------------- */
/* 专名检查不能把「繁体→简体」当成「专名丢失」                            */
/* ---------------------------------------------------------------------- */

test('回归：繁简写法不同不算专名丢失（《山海經》→《山海经》）', () => {
  const original =
    '阿長買來了《山海經》，這是她給我的第一本書。范愛農後來也來了，我們在東京見過。' +
    '藤野先生替他改講義，一句一句都改。'.repeat(1);
  const rewritten =
    '阿长买来了《山海经》，这是她给我的第一本书。范爱农后来也来了，我们在东京见过。' +
    '藤野先生替他改讲义，一句一句都改。';
  const report = checkQuality({ originalText: original, rewrittenText: rewritten });
  const entityIssue = report.issues.find((i) => i.type === 'entities');
  assert.ok(!entityIssue, `繁简转换不该报专名丢失：${JSON.stringify(entityIssue)}`);
  assert.equal(report.metrics.entityKeepRatio, 1);
});

test('looseEntityPresent：换了个真名字仍然算丢失', async () => {
  const { looseEntityPresent } = await import('../../lib/book-engine/pipeline/quality.js');
  assert.equal(looseEntityPresent('范愛農', '范爱农后来也来了'), true);
  assert.equal(looseEntityPresent('Benjamin Graham', '本杰明·格雷厄姆'), false);
  assert.equal(looseEntityPresent('Acme Corp.', 'Beta Industries'), false);
});
