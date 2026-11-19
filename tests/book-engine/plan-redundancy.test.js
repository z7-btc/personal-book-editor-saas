/**
 * 合集页 / 目录页（重复章）的护栏测试。
 *
 * 这一刀是全流程里**唯一不可逆**的删除，而且早先的版本里有一条很常见的
 * 漏法：卡片阶段判出「这一页是重复的」，汇总照抄成 `drop`，兜底阶段
 * 看见已经是 `drop` 就直接跳过复查 —— 于是「覆盖它的章节还在不在方案里」
 * 这道安全线在最长走的那条路上根本没生效。
 *
 * 这里把那个漏洞钉死：删之前必须用**最终方案里真的保留下来的章节**
 * 重算覆盖率，覆盖率掉下来就得退回卡片原本的判断。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findRedundantChapters,
  coverageByChapterIndexes,
  applyRedundantDrops,
} from '../../lib/book-engine/pipeline/plan-service.js';

/** 造一段只属于自己、和别的章没有重叠的正文。 */
function filler(seed, sentences) {
  const out = [];
  for (let i = 0; i < sentences; i += 1) {
    out.push(`${seed}的第${i + 1}句话，讲的是只有这一篇里才有的内容，换一篇就对不上了。`);
  }
  return out.join('');
}

const A = filler('小引', 16); // 约 600 字
const B = filler('后记', 16);
const C = filler('无关短章', 8);
const X = A + B; // 合集页：把 A 和 B 全文又放了一遍

function book(list) {
  return list.map((text, index) => ({ index, title: `第${index}章`, text, rewritable: true }));
}

test('合集页的 coveredBy 只列真正出力的章节，不把无关短章算进来', () => {
  const chapters = book([A, B, X, C]);
  const redundant = findRedundantChapters(chapters);

  assert.ok(redundant.has(2), `合集页要被识别出来，实际：${[...redundant.keys()]}`);
  const info = redundant.get(2);
  assert.ok(info.coverage >= 0.9, `覆盖率应接近 1，实际 ${info.coverage}`);
  assert.deepEqual(
    [...info.coveredBy].sort((x, y) => x - y),
    [0, 1],
    `coveredBy 只能是真正出力的小引和后记，不能出现无关的第 4 章：${info.coveredBy}`,
  );
  assert.ok(!redundant.has(3), '无关短章不该被判重复');
  assert.ok(!redundant.has(0) && !redundant.has(1), '被覆盖的一方（更短的章节）不该判重复');
});

test('覆盖率可以按「指定的这几章」重算', () => {
  const chapters = book([A, B, X, C]);
  const all = coverageByChapterIndexes(chapters, 2, [0, 1]);
  const onlyA = coverageByChapterIndexes(chapters, 2, [0]);
  const unrelated = coverageByChapterIndexes(chapters, 2, [3]);

  assert.ok(all >= 0.9, `两章都在时应接近 1，实际 ${all}`);
  assert.ok(onlyA < 0.9, `只剩小引时应明显不足，实际 ${onlyA}`);
  assert.ok(onlyA > 0, `小引那一半还是要算进去，实际 ${onlyA}`);
  assert.equal(unrelated, 0, '毫无重叠的章节覆盖率必须是 0');
});

test('★ 覆盖它的章节被删掉时，合集页不许删', () => {
  const chapters = book([A, B, X, C]);
  const redundant = findRedundantChapters(chapters);

  const plan = {
    entries: [
      { index: 0, title: '小引', strategy: 'drop', value: 'filler', card: {} },
      { index: 1, title: '后记', strategy: 'drop', value: 'filler', card: {} },
      {
        index: 2,
        title: '合集页',
        strategy: 'drop',
        value: 'filler',
        // 卡片阶段改判之前存下的模型原判断
        card: { redundantOriginal: { strategy: 'digest', value: 'useful' } },
      },
      { index: 3, title: '无关短章', strategy: 'keep', value: 'useful', card: {} },
    ],
  };

  const out = applyRedundantDrops({ plan, chapters, redundant });
  const x = out.entries.find((e) => e.index === 2);

  assert.equal(
    x?.strategy,
    'digest',
    `小引和后记都被删了，合集页就是唯一副本，必须退回原判断，实际 ${x?.strategy}`,
  );
  assert.match(String(x?.reason || ''), /没有第二份|唯一副本/, `要说清为什么不删：${x?.reason}`);
  assert.equal(x?.value, 'useful', '价值也要退回原判断');
});

test('★ 只要有一个无关短章被保留，也不许因此删掉合集页', () => {
  /**
   * 这是老实现真正漏掉的那条路：`coveredBy` 里混着无关短章，
   * 用 `.some(keep)` 一问，答「还在」，于是合集页被删。
   */
  const chapters = book([A, B, X, C]);
  const redundant = findRedundantChapters(chapters);

  const plan = {
    entries: [
      { index: 0, title: '小引', strategy: 'drop', value: 'filler', card: {} },
      { index: 1, title: '后记', strategy: 'drop', value: 'filler', card: {} },
      { index: 2, title: '合集页', strategy: 'drop', value: 'filler', card: {} },
      // 和第 3 章毫无关系的短章被保留 —— 老实现会把它当成「覆盖者还在」
      { index: 3, title: '无关短章', strategy: 'keep', value: 'core', card: {} },
    ],
  };

  const out = applyRedundantDrops({ plan, chapters, redundant });
  const x = out.entries.find((e) => e.index === 2);
  assert.notEqual(x?.strategy, 'drop', '无关短章还在，不代表合集页的内容还在');
});

test('覆盖它的章节都留着时，合集页照删，并记下依赖了哪几章', () => {
  const chapters = book([A, B, X, C]);
  const redundant = findRedundantChapters(chapters);

  const plan = {
    entries: [
      { index: 0, title: '小引', strategy: 'keep', value: 'useful', card: {} },
      { index: 1, title: '后记', strategy: 'keep', value: 'useful', card: {} },
      // 汇总把它改回了「精读」—— 兜底应该再压成删除
      { index: 2, title: '合集页', strategy: 'keep', value: 'useful', card: {} },
      { index: 3, title: '无关短章', strategy: 'keep', value: 'useful', card: {} },
    ],
  };

  const out = applyRedundantDrops({ plan, chapters, redundant });
  const x = out.entries.find((e) => e.index === 2);
  assert.equal(x?.strategy, 'drop', '内容确实在别处完整留着，这一页就该删');
  assert.deepEqual([...x.redundantOf].sort((a, b) => a - b), [0, 1], '要记下真正依赖的两章');
  assert.match(String(x.reason || ''), /合集页|目录页/);
});

test('原样保留（skip）的章节一律不动', () => {
  const chapters = book([A, B, X, C]);
  const redundant = findRedundantChapters(chapters);
  const plan = {
    entries: [
      { index: 0, title: '小引', strategy: 'keep', value: 'useful', card: {} },
      { index: 1, title: '后记', strategy: 'keep', value: 'useful', card: {} },
      { index: 2, title: '合集页', strategy: 'skip', value: 'filler', card: {} },
    ],
  };
  const out = applyRedundantDrops({ plan, chapters, redundant });
  assert.equal(out.entries.find((e) => e.index === 2)?.strategy, 'skip');
});
