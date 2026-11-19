/**
 * 方案里「理由」和「动作」必须是同一件事。
 *
 * 真实成品里出现过这样一段（《朝花夕拾》导出的「怎么读这本书」）：
 *
 *     后记：考证「麻祜」来源……   5,957 字 · 有用 · 照常精读改写
 *     理由：后记考据偏版本校勘，与目录页重复，**压成提要即可**。
 *
 * 读者读到「压成提要」，翻过去却是全文；同一页导读还说「读第 10 章后记提要」。
 * 原因不是模型乱写，而是它先建议压缩、代码的硬闸又把 core/useful 保成 keep，
 * 那句理由却原样留下来了。
 *
 * 处理办法：核心 / 有用的章节不许压缩是有意的，所以只能让理由闭嘴 ——
 * 把和最终动作打架的那半句删掉，其余解释保留。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlan, stripContradictoryAction, applyNames } from '../../lib/book-engine/pipeline/book-plan.js';

test('★ 判成 keep 的章节，理由里「压成提要即可」要删掉，其余解释保留', () => {
  assert.equal(
    stripContradictoryAction('后记考据偏版本校勘，与目录页重复，压成提要即可。', 'keep'),
    '后记考据偏版本校勘，与目录页重复。',
  );
});

test('动作和理由一致时不改一个字', () => {
  assert.equal(
    stripContradictoryAction('自序背景可保留书名与写作时间，压成提要即可。', 'digest'),
    '自序背景可保留书名与写作时间，压成提要即可。',
  );
  assert.equal(
    stripContradictoryAction('核心写人散文，阿长买《山海经》是关键启蒙。', 'keep'),
    '核心写人散文，阿长买《山海经》是关键启蒙。',
  );
});

test('否定式不算「说了别的动作」（不必压缩、不能删）', () => {
  assert.equal(
    stripContradictoryAction('全书核心，不必压缩成提要，必须精读。', 'keep'),
    '全书核心，不必压缩成提要，必须精读。',
  );
});

test('整句都在说别的动作时整句删掉，不留空标点', () => {
  assert.equal(stripContradictoryAction('压成提要即可。这一章是凑数的。', 'keep'), '这一章是凑数的。');
  assert.equal(stripContradictoryAction('压成提要即可。', 'keep'), '');
});

test('★ normalizePlan：硬闸把 useful 保成 keep，理由也跟着改口', () => {
  const plan = normalizePlan(
    {
      entries: [
        { index: 10, value: 'useful', strategy: 'digest', reason: '后记考据偏版本校勘，与目录页重复，压成提要即可。' },
        { index: 3, value: 'context', strategy: 'digest', reason: '自序，压成提要即可。' },
      ],
    },
    [
      { index: 10, title: '後記', value: 'useful', strategy: 'keep' },
      { index: 3, title: '小引', value: 'context', strategy: 'keep' },
    ],
  );
  const byIndex = new Map(plan.entries.map((e) => [e.index, e]));
  assert.equal(byIndex.get(10).strategy, 'keep', 'useful 不许压缩');
  assert.ok(
    !byIndex.get(10).reason.includes('压成提要'),
    `理由不能和动作打架：${byIndex.get(10).reason}`,
  );
  assert.equal(byIndex.get(3).strategy, 'digest');
  assert.ok(byIndex.get(3).reason.includes('压成提要'), '真的压缩了，理由就该说压缩');
});

test('★ 封面 / 版权页这类「家具页」不起新名字，保留原名', () => {
  const plan = {
    entries: [
      { index: 1, title: '封面', chars: 4, strategy: 'skip', value: 'filler', reason: '整页图片' },
      { index: 3, title: '小引', chars: 1200, strategy: 'keep', value: 'core', reason: '交代成书背景' },
    ],
  };
  const named = applyNames(plan, {
    '1': '封面：无正文，整页图片或空白页',
    '3': '小引：鲁迅自述成书背景与书名由来',
  });
  assert.equal(named.names['1'], undefined, '家具页不该带一个句子当名字');
  assert.equal(named.entries[0].displayTitle, '封面');
  assert.equal(named.entries[1].displayTitle, '小引：鲁迅自述成书背景与书名由来');
});
