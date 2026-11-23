/**
 * 质量自动修正：把质量报告翻译成提示词里的修正要求（2026-11-23）。
 *
 * 背景：自动重试原来是拿同一个提示词空跑一遍，模型没有任何新信息，
 * 输出自然一样。现在每一轮都告诉模型「上一版缺了什么」，这两个函数
 * 就是那座桥：jobs.js 生成 repair，rewrite.js 把它写进提示词。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildQualityRepair } from '../../lib/book-engine/pipeline/jobs.js';
import { buildRepairNotes } from '../../lib/book-engine/pipeline/rewrite.js';

test('buildQualityRepair 汇总缺失的数字 / 专有名词与问题描述', () => {
  const repair = buildQualityRepair({
    verdict: 'fail',
    issues: [
      {
        type: 'numbers',
        severity: 'fail',
        message: '数字丢失：原文 2 个数字 token，改写后缺少 1 个',
        details: { keepRatio: 0.5, missing: [{ token: '62', count: 2 }] },
      },
      {
        type: 'entities',
        severity: 'fail',
        message: '专有名词丢失',
        details: { keepRatio: 0.5, missing: [{ token: '勒庞', count: 5 }] },
      },
    ],
  });
  assert.deepEqual(repair.tokens, [
    { token: '62', kind: 'number' },
    { token: '勒庞', kind: 'entity' },
  ]);
  assert.ok(repair.messages.some((m) => m.includes('数字丢失')));
  assert.ok(repair.messages.some((m) => m.includes('专有名词')));
});

test('buildQualityRepair 对通过的报告不产出修正要求', () => {
  assert.equal(buildQualityRepair({ verdict: 'ok', issues: [] }), null);
  assert.equal(buildQualityRepair(null), null);
});

test('buildRepairNotes 只写进这一块原文里真的存在的 token', () => {
  const notes = buildRepairNotes(
    {
      messages: ['数字丢失'],
      hints: [],
      tokens: [
        { token: '62', kind: 'number' },
        { token: '勒庞', kind: 'entity' },
      ],
    },
    ['……见注 62，这是本页的编号。'],
  );
  assert.ok(notes.startsWith('【质量修正要求】'), notes);
  assert.ok(notes.includes('62'), notes);
  assert.ok(!notes.includes('勒庞'), notes);
});

test('buildRepairNotes 连着上下文给出 token 的位置', () => {
  const notes = buildRepairNotes(
    { messages: [], hints: [], tokens: [{ token: '62', kind: 'number' }] },
    ['正文一段，见注62，后面还有内容。'],
  );
  assert.ok(notes.includes('原文附近'), notes);
  assert.ok(notes.includes('注62'), notes);
});

test('buildRepairNotes 没有任何可写内容时返回空串', () => {
  assert.equal(
    buildRepairNotes(
      { messages: [], hints: [], tokens: [{ token: '99', kind: 'number' }] },
      ['这一块没有那个数字'],
    ),
    '',
  );
});
