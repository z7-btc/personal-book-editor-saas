/**
 * 目录通用性护栏。
 *
 * 真实成品里出现过两类错误，都不是某一本书的特例：
 *
 *   1. 42 字的卷首题词，目录里写成「正文第二章：市场分析预测价格与
 *      证券分析评估价值的本质区别」，还配了 5 条知识点 —— 原文里一个字都没提。
 *   2. 封面 / 分册扉页 / 扫码页，目录里写成「整页图片：无正文内容」——
 *      这是起名模型把卡片上的页面状态当成了标题。
 *
 * 修法不能只改这一本书的方案数据，必须在引擎里挡住，后面任何书上传来
 * 都不会再出现。这些测试锁的就是那几道闸。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_JUDGEABLE_CHARS,
  buildChapterCard,
  buildShortPageCard,
  sanitizeGeneratedName,
  displayTitleOf,
  applyNames,
  normalizePlan,
  normalizeCard,
} from '../../lib/book-engine/pipeline/book-plan.js';
import { isJudgeableChapter } from '../../lib/book-engine/pipeline/plan-service.js';
import { renderReadingPathPage } from '../../lib/book-engine/pipeline/reading-path.js';

const EPIGRAPH =
  '现在已然衰朽者，将来可能重放异彩；现在备受青睐者，将来却可能黯然失色。——贺拉斯《诗艺》';

test('★ 42 字题词不调用模型：卡片只复述原文，不编知识点', async () => {
  /**
   * provider 指向一个必然连不上的端口。函数要是偷偷发了请求，
   * 这里会直接抛错，测试变红 —— 比数调用次数更硬。
   */
  const provider = { baseUrl: 'http://127.0.0.1:9', apiKey: 'x', model: 'x' };
  const result = await buildChapterCard({
    chapter: {
      index: 2,
      title: '现在已然衰朽者，将来可能重放异彩',
      kind: 'tiny',
      textLength: 42,
      text: EPIGRAPH,
    },
    provider,
    projectRoot: process.cwd(),
  });

  assert.equal(result.skipped, true, '短页不该走模型');
  assert.equal(result.card.shortPage, true);
  assert.equal(result.card.summary, EPIGRAPH, '摘要只能是原文本身');
  assert.deepEqual(result.card.knowledgePoints, [], '不能编知识点');
  assert.equal(result.card.strategy, 'skip', '没有改写结果，只能原样保留');
  assert.equal(result.card.value, 'context');
});

test('整页图片 / 扫码页的卡片只写页面性质，不写内容', () => {
  const cover = buildShortPageCard({
    index: 9,
    title: '证券分析（上）',
    kind: 'image-only',
    textLength: 0,
    text: '',
  });
  assert.equal(cover.summary, '');
  assert.deepEqual(cover.knowledgePoints, []);
  assert.equal(cover.strategy, 'skip');
  assert.ok(cover.role.includes('整页图片'));

  const prompt = buildShortPageCard({
    index: 7,
    title: '扫码获取“湛庐阅读”App',
    kind: 'prompt',
    textLength: 38,
    text: '扫码获取“湛庐阅读”App',
  });
  assert.equal(prompt.summary, '');
  assert.equal(prompt.strategy, 'skip');
});

test('短页 / 图片页不进判断队列，正常章节照常进', () => {
  assert.equal(isJudgeableChapter({ index: 2, kind: 'tiny', text: EPIGRAPH, rewritable: true }), false);
  assert.equal(
    isJudgeableChapter({ index: 7, kind: 'prompt', text: '扫码获取 App', rewritable: false }),
    false,
  );
  assert.equal(
    isJudgeableChapter({ index: 9, kind: 'image-only', text: '', rewritable: false }),
    false,
  );
  assert.equal(
    isJudgeableChapter({ index: 3, kind: 'content', text: '字'.repeat(MIN_JUDGEABLE_CHARS), rewritable: true }),
    true,
  );
});

test('★ 模型起的假名字被拒绝：封面不再是「整页图片：无正文内容」，短页不再是「正文第二章」', () => {
  const epigraph = buildShortPageCard({
    index: 2,
    title: '现在已然衰朽者，将来可能重放异彩',
    kind: 'tiny',
    textLength: 42,
    text: EPIGRAPH,
  });
  const cover = buildShortPageCard({
    index: 9,
    title: '证券分析（上）',
    kind: 'image-only',
    textLength: 0,
    text: '',
  });
  const named = applyNames(
    {
      entries: [
        { index: 2, title: '现在已然衰朽者，将来可能重放异彩', chars: 42, value: 'context', strategy: 'skip', card: epigraph },
        { index: 9, title: '证券分析（上）', chars: 0, value: 'filler', strategy: 'skip', card: cover },
      ],
    },
    {
      2: '正文第二章：市场分析预测价格与证券分析评估价值的本质区别',
      9: '整页图片：无正文内容',
    },
  );

  assert.equal(named.names['2'], undefined, '假编号名字不能存进方案');
  assert.equal(named.names['9'], undefined, '页面状态不能当名字');
  assert.equal(named.entries[0].displayTitle, '现在已然衰朽者，将来可能重放异彩');
  assert.equal(named.entries[1].displayTitle, '证券分析（上）');
});

test('原书名里本来就有的编号，起名时保留', () => {
  const entry = {
    index: 15,
    title: '第二部分 固定价值投资',
    chars: 52_000,
    value: 'useful',
    strategy: 'keep',
    card: { summary: '债券与优先股的选择原则。', knowledgePoints: ['四条量化标准'] },
  };
  const named = applyNames({ entries: [entry] }, {
    15: '第二部分 固定价值投资：债券与优先股的选择原则',
  });
  assert.equal(named.entries[0].displayTitle, '第二部分 固定价值投资：债券与优先股的选择原则');
  assert.equal(
    sanitizeGeneratedName('第三部分 普通股：股息与安全边际', entry),
    '',
    '原书名是第二部分，名字不能写成第三部分',
  );
  assert.equal(
    sanitizeGeneratedName('第2部分 固定价值投资：债券与优先股的选择原则', entry),
    '第2部分 固定价值投资：债券与优先股的选择原则',
    '「第2部分」和「第二部分」是同一个位置，不能因为写法不同就误拒',
  );
  assert.equal(
    sanitizeGeneratedName('正文第2章 起点：安全边际的定义', {
      index: 1,
      title: '第一章 起点',
      chars: 3000,
      card: { summary: '讲安全边际。', knowledgePoints: ['定义'] },
    }),
    '',
    '原书名是第一章，写成「正文第2章」必须拒绝',
  );
  assert.equal(
    sanitizeGeneratedName('正文第一章 起点：安全边际的定义', {
      index: 1,
      title: '第一章 起点',
      chars: 3000,
      card: { summary: '讲安全边际。', knowledgePoints: ['定义'] },
    }),
    '正文第一章 起点：安全边际的定义',
    '「正文第一章」和原书名「第一章」是同一个位置，不该被误拒',
  );
});

test('★ 旧方案里已经存下的坏名字，读的时候也要洗掉', () => {
  const cover = {
    index: 9,
    title: '证券分析（上）',
    chars: 0,
    displayTitle: '整页图片：无正文内容',
    strategy: 'skip',
    value: 'filler',
    card: {},
  };
  assert.equal(displayTitleOf(cover), '证券分析（上）');

  const epigraph = {
    index: 2,
    title: '现在已然衰朽者，将来可能重放异彩',
    chars: 42,
    displayTitle: '正文第二章：市场分析预测价格与证券分析评估价值的本质区别',
    strategy: 'keep',
    value: 'core',
    card: { summary: '编出来的摘要', knowledgePoints: ['编出来的知识点'] },
  };
  assert.equal(displayTitleOf(epigraph), '现在已然衰朽者，将来可能重放异彩');
});

test('★ 阅读路径页不印假条目，也不印短页的假摘要', () => {
  const plan = {
    entries: [
      {
        index: 2,
        title: '现在已然衰朽者，将来可能重放异彩',
        chars: 42,
        value: 'core',
        strategy: 'keep',
        displayTitle: '正文第二章：市场分析预测价格与证券分析评估价值的本质区别',
        card: { summary: '本章系统区分了市场分析与证券分析的本质差异。', knowledgePoints: ['市场分析预测价格'] },
      },
      {
        index: 9,
        title: '证券分析（上）',
        chars: 0,
        value: 'filler',
        strategy: 'skip',
        displayTitle: '整页图片：无正文内容',
        card: { summary: '这一页概括了上册的全部精华。', knowledgePoints: ['价值投资'] },
      },
    ],
  };
  const html = renderReadingPathPage(plan, { bookTitle: '证券分析' });

  assert.ok(!html.includes('无正文内容'), '读者不该看到页面状态当标题');
  assert.ok(!html.includes('正文第二章'), '读者不该看到凭空安上的编号');
  assert.ok(!html.includes('本章系统区分了市场分析'), '短页不该印模型编的摘要');
  assert.ok(!html.includes('这一页概括了上册的全部精华'), '零字页面配的假摘要也不能印');
  assert.ok(!html.includes('价值投资'), '零字页面编的知识点不能印');
  assert.ok(html.includes('现在已然衰朽者，将来可能重放异彩'), '应显示真实原名');
  assert.ok(html.includes('证券分析（上）'), '封面应显示原书名');
  assert.equal((html.match(/短页/g) || []).length, 2, '两条短页都该标「短页」，不再是「核心」');
});

test('★ 汇总阶段不能把短页改成精读或提要', () => {
  const plan = normalizePlan(
    { entries: [{ index: 2, value: 'core', strategy: 'keep', reason: '当成正文第二章，必须精读' }] },
    [{ index: 2, title: '现在已然衰朽者，将来可能重放异彩', chars: 42, value: 'context', strategy: 'skip', shortPage: true }],
  );
  const entry = plan.entries.find((e) => e.index === 2);
  assert.equal(entry.strategy, 'skip', '短页没有改写结果，只能是 skip');
  assert.equal(entry.value, 'context');
  assert.ok(!entry.reason.includes('精读'), `理由也要跟着改口：${entry.reason}`);
});

test('知识点数量不超过原文能支撑的数量', () => {
  const card = normalizeCard(
    {
      value: 'useful',
      strategy: 'keep',
      knowledgePoints: ['一', '二', '三', '四', '五', '六'],
    },
    { index: 1, title: '短章', textLength: 300 },
  );
  assert.equal(card.knowledgePoints.length, 2, '300 字最多支撑 2 条');
  const long = normalizeCard(
    { value: 'useful', strategy: 'keep', knowledgePoints: ['一', '二', '三', '四', '五', '六', '七', '八'] },
    { index: 2, title: '长章', textLength: 20_000 },
  );
  assert.equal(long.knowledgePoints.length, 8, '长章不受这个上限影响');
});
