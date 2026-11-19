/**
 * 「整理结果」报告的测试。
 *
 * 用户点名要看四件事：删了几章、几章改成大白话、几条脚注融进正文、
 * 几条脚注被删掉。这些数字**必须能对上账**——总量守恒，
 * 而且「融进正文 / 删掉」的判定得经得起看。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook, exportBook } from '../../lib/book-engine/pipeline/book-service.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';
import { buildBookReport, shingles, noteOutcome, normalizeForMatch } from '../../lib/book-engine/pipeline/report-service.js';
import { makeFootnoteFixtureEpub } from './fixture-epub.js';

async function withTempWorkspace(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-report-'));
  ws.setWorkspaceRoot(dir);
  try {
    return await fn(dir);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ 判定 -- */

test('注释去向的判定：换个说法仍算融进正文，真删了才算删', () => {
  /**
   * 实测里最长的一段是：「1940年委员会修正了该指数，加入了新的成分股，
   * 并将1935—1939年的平均水平作为基础。」模型把它写成
   * 「1940年委员会修正了这个指数，加入了新的成分股，并把1935年到1939年
   * 的平均水平作为新的基础」—— 改了三处措辞。
   *
   * 这种必须判成「融进正文」。第一版用的片段长 6 个字、而且两侧
   * 归一化不一致，连这条都判成了删掉，整体方向完全反了。
   */
  const note = { text: '1940年委员会修正了该指数，加入了新的成分股，并将1935—1939年的平均水平作为基础。' };
  const hay = normalizeForMatch(
    '这个水平之前被联邦储备委员会定为指数100，1940年委员会修正了这个指数，' +
      '加入了新的成分股，并把1935年到1939年的平均水平作为新的基础，到现在仍然成立。',
  );
  assert.equal(noteOutcome(note, hay), 'inlined', '换了几处说法也要认出来是融进去了');

  // 正文里根本没提过 => 删掉了
  const other = normalizeForMatch('这一段在讲债券的偿还顺序，和指数成分股没有关系。');
  assert.equal(noteOutcome(note, other), 'dropped');
});

test('归一化必须对两侧一视同仁（否则永远匹配不上）', () => {
  /**
   * 第一版只归一化了注释（针），没归一化章节正文（海）——
   * 而正文里全是换行和缩进，于是任何片段都匹配不上，
   * 483 条注释被判成 355 删 / 128 融，方向反了。
   */
  const note = { text: '净营运资本是营运资本减去其他债务的余额。' };
  const html = '<p>所谓净营运\n资本，就是营运资本\n减去其他债务之后的余额。</p>';
  const hay = normalizeForMatch(html.replace(/<[^>]+>/g, ' '));
  assert.ok(hay.includes('净营运资本'), '正文里的换行必须被归一化掉');
  assert.equal(noteOutcome(note, hay), 'inlined');
});

test('shingles 逐字滑窗，一个字的改动不能毁掉后面全部片段', () => {
  const a = shingles('安全边际是投资的核心概念');
  assert.ok(a.length > 5, '应当是逐字滑窗而不是跳着取');
  for (const s of a) assert.equal(s.length, 4, '统一取 4 个字');
});

/* ------------------------------------------------------------ 账目 -- */

test('★ 整理结果的数字必须能对上账', async () => {
  await withTempWorkspace(async () => {
    const metadata = await importBook({
      buffer: makeFootnoteFixtureEpub(),
      fileName: 'report.epub',
      profile: blankProfile(),
    });
    const bookId = metadata.bookId;

    // 造一个「处理过」的状态：第 3 章删掉、第 2 章压缩、第 1 章改写（引用点被就地化）
    await ws.writeBookPlan(bookId, {
      entries: [
        { index: 1, value: 'useful', strategy: 'keep', chars: 100 },
        { index: 2, value: 'context', strategy: 'digest', chars: 100 },
        { index: 3, value: 'filler', strategy: 'drop', chars: 100 },
        { index: 4, value: 'filler', strategy: 'skip', chars: 100 },
      ],
      names: { 1: '第一章 新名字' },
      order: [1, 2],
    });

    const { extractChapter } = await import('../../lib/book-engine/pipeline/book-service.js');
    await extractChapter(bookId, 1); // original.xhtml 是提取阶段写下来的
    const orig1 = await ws.readChapterOriginal(bookId, 1);
    const rewritten1 = orig1.replace(/<a id="jzyy_1_1"[\s\S]*?<\/a>/, '').replace('安全边际', '安全边际（一层缓冲垫）');
    await ws.saveChapterRewritten(bookId, 1, rewritten1);
    await ws.writeChapterStatus(bookId, 1, {
      chapterIndex: 1, stage: 'completed', rewrittenChars: 200, noteRefsBefore: 1, noteRefsAfter: 0,
    });
    await ws.saveChapterRewritten(bookId, 2, '<html><body><p>提要。</p></body></html>');
    await ws.writeChapterStatus(bookId, 2, {
      chapterIndex: 2, stage: 'completed', digest: true, rewrittenChars: 3,
    });

    await exportBook({ bookId, chapters: [1, 2] });
    const report = await buildBookReport(bookId, { deep: true });

    // 1) 删了几章
    assert.equal(report.removed.count, 1, `删掉 1 章，实际 ${report.removed.count}`);
    assert.equal(report.removed.chapters[0].index, 3);
    assert.ok(report.removed.chars > 0, '要报出删掉多少字');

    // 2) 几章改成大白话 / 几章压缩 / 几章原样保留
    assert.equal(report.plainLanguage.count, 1, '第 1 章是改写');
    assert.equal(report.compressed.count, 1, '第 2 章是压缩');
    assert.equal(report.unchanged.count, 1, '第 4 章原样保留');
    assert.ok(report.plainLanguage.added !== 0 || report.plainLanguage.averageRatio > 0);

    // 3)+4) 脚注去向：这条注释的引用点被就地化掉了，而注释正文没进第 1 章
    assert.equal(report.notes.total, 1, `原书 1 条脚注，实际 ${report.notes.total}`);
    assert.equal(
      report.notes.inlined + report.notes.dropped + report.notes.kept,
      1,
      '三条去向相加必须等于总数',
    );

    // 总量守恒：两类相加必须等于原书 / 成品
    //
    // 成品那一侧比的是 `result.bodyChars`（正文字数），**不是** `result.chars` ——
    // 后者还含我们新加的页（「目录 · 怎么读这本书」），那不是任何一章的正文。
    // 两个数分开报，才不会出现「分类相加 ≠ 总数」这种自相矛盾的报告。
    const beforeSum =
      report.removed.chars +
      report.compressed.charsBefore +
      report.plainLanguage.charsBefore +
      report.unchanged.chars;
    const afterSum =
      report.compressed.charsAfter +
      report.plainLanguage.charsAfter +
      report.unchanged.charsAfter;
    assert.equal(beforeSum, report.original.chars, '各章原文字数相加必须等于原书总字数');
    assert.equal(afterSum, report.result.bodyChars, '各章成品字数相加必须等于成品正文字数');
    assert.equal(
      report.result.chars,
      report.result.bodyChars + report.result.addedChars,
      '成品总字数 = 正文 + 新增页',
    );
    assert.ok(report.added.chars > 0, '这本书加过「怎么读这本书」，新增页字数要报出来');

    /**
     * ★ 成品字数必须**量文件**，不能照抄 status 里那个数字。
     *
     * 上面给第 1 章写的 status.rewrittenChars 是 200，而磁盘上那份
     * rewritten.xhtml 根本不是 200 字 —— 状态只在改写完成那一刻写过一次，
     * 之后任何修补（剥离脚注署名、手工修复）都不会回头改它。
     * 实测那本真书因此差了 246 字，总账自己都不闭合。
     */
    assert.equal(report.result.measured, true, 'deep 报告必须逐章量过成品');
    assert.notEqual(
      report.plainLanguage.charsAfter,
      200,
      '第 1 章的 status 记着 200 字，报告却照抄了它 —— 应该去量成品文件',
    );

    // 成品体检
    assert.ok(report.export, '要带成品信息');
    assert.equal(report.export.chars, report.result.chars, 'export.chars 是成品 spine 的实测总和');
    assert.equal(report.export.deadLinks, 0, '不该有死链');
    assert.equal(report.export.anchorLost, 0, '不该丢锚点');
    assert.equal(report.export.droppedInSpine, 0, '被删的章不该出现在 spine 里');
  });
});

test('没有方案、没有成品时也给得出一份报告，不抛错', async () => {
  await withTempWorkspace(async () => {
    const metadata = await importBook({
      buffer: makeFootnoteFixtureEpub(),
      fileName: 'bare.epub',
      profile: blankProfile(),
    });
    const report = await buildBookReport(metadata.bookId);
    assert.equal(report.removed.count, 0);
    assert.equal(report.renamed, 0);
    assert.equal(report.export, null, '还没导出就没有成品信息');
    assert.ok(report.original.chars > 0);
  });
});

/* -------------------------------------------------- 是不是「正常功能」-- */

test('★ 整理结果是常规功能：换一本书照样算得出来', async () => {
  /**
   * 用户的原话是「我需要它成为一个正常的功能」。
   *
   * 所以这里不放任何针对某一本书的假设 —— 换一本构造出来的、
   * 从没被处理过的书，报告一样要出得来、数字一样要能对上账。
   */
  await withTempWorkspace(async () => {
    const metadata = await importBook({
      buffer: makeFootnoteFixtureEpub(),
      fileName: 'another.epub',
      profile: blankProfile(),
    });
    const report = await buildBookReport(metadata.bookId, { deep: true });

    // 结构齐全（界面按这些字段渲染，缺一个就是白屏）
    for (const key of ['original', 'result', 'removed', 'compressed', 'plainLanguage', 'unchanged', 'notes', 'export']) {
      assert.ok(key in report, `报告必须带 ${key} 字段`);
    }
    assert.equal(typeof report.original.chars, 'number');
    assert.equal(typeof report.notes.total, 'number');

    // 全新书的账也要对得上
    const beforeSum =
      report.removed.chars +
      report.compressed.charsBefore +
      report.plainLanguage.charsBefore +
      report.unchanged.chapters.reduce((a, c) => a + c.chars, 0);
    assert.equal(beforeSum, report.original.chars, '没整理过的书也要账目守恒');
  });
});

// 移到 SaaS 层重写：decorateBookForTest 现在住在 Next.js 书库路由里。
test.skip('★ [待 SaaS 层重测] 书库列表能看出哪本整理过（轻量摘要，不跑完整报告）', async () => {
  /**
   * 书库一屏十几本，每本都跑完整报告（读 93MB 原书、单本 1.6 秒）会卡死。
   * 所以列表用的是**另一个轻量摘要**：只读 book-plan.json。
   * 这条测试盯两件事：没整理时是 null；整理过之后数量对得上。
   */
  await withTempWorkspace(async () => {
    const metadata = await importBook({
      buffer: makeFootnoteFixtureEpub(),
      fileName: 'lib.epub',
      profile: blankProfile(),
    });
    const { decorateBookForTest } = await import('../../lib/book-engine/server/routes.js');

    const before = await decorateBookForTest(metadata.bookId);
    assert.equal(before.processed, null, '没整理过就该是 null，界面显示「尚未整理」');

    await ws.writeBookPlan(metadata.bookId, {
      entries: [
        { index: 1, value: 'useful', strategy: 'keep' },
        { index: 2, value: 'filler', strategy: 'drop' },
        { index: 3, value: 'context', strategy: 'digest' },
        { index: 4, value: 'filler', strategy: 'skip' },
      ],
      names: { 1: '新名字一', 3: '新名字三' },
      order: [3, 1],
      updatedAt: new Date().toISOString(),
    });

    const after = await decorateBookForTest(metadata.bookId);
    assert.ok(after.processed, '整理过之后要有摘要');
    assert.deepEqual(after.processed.counts, { keep: 1, digest: 1, skip: 1, drop: 1 });
    assert.equal(after.processed.renamed, 2);
    assert.equal(after.processed.reordered, true);
  });
});
