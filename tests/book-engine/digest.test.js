/**
 * 「压缩成提要」的测试。
 *
 * 核心风险：压缩要删掉整章的段落，而**别的文件可能正指着这一章里的锚点**。
 * 实测用户这本书目录页指向每一章的开头锚点，脚注汇编章被 483 条链接指着。
 * 删错了不会报错，只会让读者点进去是空白。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { blocksWithInboundAnchors, applyDigest } from '../../lib/book-engine/pipeline/digest.js';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { queryAll } from '../../lib/book-engine/epub/selector.js';

const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>推荐序一</title></head><body>
<h1 id="pre4_4">推荐序一 改变一生的智慧之书</h1>
<p>这本书改变了无数人的投资方式，是有史以来最重要的一本书。</p>
<p>巴菲特回忆自己师从格雷厄姆的经历，说他 57 年来一直遵循这份路线图。</p>
<p id="jzyy_4_9"><a href="text00027.html#jz_4_9">(9)</a> 这里有一条脚注标记。</p>
<p>最后再次强调，这本书非常值得一读，强烈推荐给所有投资者。</p>
</body></html>`;

const paras = (xhtml) => queryAll(parseXml(xhtml).documentElement, 'p, h1').map((n) => n.textContent.replace(/\s+/g, ' ').trim());

test('★ 压缩时保留带入链锚点的块（否则目录点进去是空白）', () => {
  // 目录指向 h1 的 pre4_4
  const keep = blocksWithInboundAnchors(CHAPTER, new Set(['pre4_4']));
  assert.equal(keep.size, 1, `只应保留 1 个块，实际 ${keep.size}`);

  const result = applyDigest({
    xhtml: CHAPTER,
    digestText: '这是巴菲特为本书写的推荐序。他回忆了师从格雷厄姆的经历。\n\n实质内容：他 57 年来一直遵循格雷厄姆的路线图。其余部分是对本书的推崇，可以跳过。',
    inboundAnchors: new Set(['pre4_4']),
  });

  assert.equal(result.keptBlocks, 1, '标题块要保留');
  // 这一章共 5 个块（1 个 h1 + 4 个 p），保留标题后其余 4 个被提要取代
  assert.equal(result.replacedBlocks, 4, '其余 4 个块要被替换掉');
  assert.equal(result.digestParagraphs, 2, '提要应有 2 段');

  const out = result.xhtml;
  assert.ok(out.includes('id="pre4_4"'), '入链锚点必须还在');
  assert.ok(out.includes('推荐序一 改变一生的智慧之书'), '标题要在');
  assert.ok(out.includes('这是巴菲特为本书写的推荐序'), '提要在');
  assert.ok(!out.includes('这本书改变了无数人的投资方式'), '被压缩的段落应该没了');
  assert.ok(!out.includes('强烈推荐给所有投资者'), '被压缩的段落应该没了');

  // 顺序：标题在前，提要紧随其后
  const list = paras(out);
  assert.match(list[0], /推荐序一/);
  assert.match(list[1], /这是巴菲特为本书写的推荐序/);
});

test('★ 压缩会把指向正文内部的锚点一起删掉 —— 所以调用方必须先确认它没人指', () => {
  /**
   * `jzyy_4_9` 挂在正文段落上。调用方如果把它的入链锚点传进来，
   * 那个段落就会被保留；不传，就会被删 —— 指向它的链接随之失效。
   *
   * 这里把这个行为**明确固定下来**，免得以后有人以为「压缩天然安全」。
   */
  const withAnchor = applyDigest({
    xhtml: CHAPTER,
    digestText: '提要正文。',
    inboundAnchors: new Set(['pre4_4', 'jzyy_4_9']),
  });
  assert.equal(withAnchor.keptBlocks, 2, '两个带锚点的块都要保留');
  assert.ok(withAnchor.xhtml.includes('jzyy_4_9'), '正文里的锚点也在');

  const withoutAnchor = applyDigest({
    xhtml: CHAPTER,
    digestText: '提要正文。',
    inboundAnchors: new Set(['pre4_4']),
  });
  assert.ok(!withoutAnchor.xhtml.includes('jzyy_4_9'), '没被声明的锚点会随段落一起消失');
});

test('没有入链锚点时，提要插在标题之后、正文最前面', () => {
  const result = applyDigest({ xhtml: CHAPTER, digestText: '第一段提要。\n\n第二段提要。', inboundAnchors: new Set() });
  // 小标题永远保留（见 applyDigest 里的说明），所以这里保留 1 块
  assert.equal(result.keptBlocks, 1, '标题要保留，否则读者不知道自己在读什么');
  const list = paras(result.xhtml);
  assert.match(list[0], /推荐序一/, `标题应在最前面，实际：${list[0]}`);
  assert.match(list[1], /第一段提要/, `提要应紧接标题，实际：${list[1]}`);
  assert.match(list[2], /第二段提要/, `两段提要的顺序不能颠倒，实际：${list[2]}`);
});

test('提要里的尖括号会被转义，不会破坏 XHTML', () => {
  const result = applyDigest({ xhtml: CHAPTER, digestText: '这里提到了 <T> 这种写法。', inboundAnchors: new Set() });
  const doc = parseXml(result.xhtml);
  assert.ok(doc.documentElement);
  assert.ok(result.xhtml.includes('&lt;T&gt;'));
});

test('空提要不会把章节清空成白页', () => {
  const result = applyDigest({ xhtml: CHAPTER, digestText: '   ', inboundAnchors: new Set() });
  assert.equal(result.digestParagraphs, 0);
  // 一个段落都没插进去时，至少标题还在
  assert.ok(result.xhtml.includes('推荐序一'));
});

/**
 * ★ 回归：插阅读路径页**不能**把正文替换覆盖掉
 *
 * 真实事故：exportBook 里写的是
 *   `repackEpub(book, { replacements, ...insertReadingPath(...) })`
 * 而 insertReadingPath 自己也返回一个只含 OPF 的 `replacements`，
 * 展开时把 24 章改写内容**整个盖掉**了 —— 成品里插进了阅读路径页，
 * 正文却全部退回原文，而且不报任何错。
 *
 * 是校验脚本里「替换 1 个文件」那句话露的馅：一本改过 24 章的书
 * 只替换 1 个文件，本身就说不通。
 */
test('★ 插页与正文替换必须合并，不能互相覆盖', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');
  const { importBook, extractChapter, exportBook } = await import('../../lib/book-engine/pipeline/book-service.js');
  const { blankProfile } = await import('../../lib/book-engine/config/profile.js');
  const { makeFixtureEpub } = await import('./fixture-epub.js');
  const { readEpub } = await import('../../lib/book-engine/epub/epub-reader.js');
  const { ZipReader } = await import('../../lib/book-engine/epub/zip-reader.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-export-plan-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeFixtureEpub(),
      fileName: 'plan.epub',
      profile: blankProfile(),
    });
    await extractChapter(metadata.bookId, 1);

    // 造一份「已改写」的正文，让导出有东西可替换
    const book = readEpub(makeFixtureEpub());
    const href = book.chapters[0].href;
    const MARK = '这一段是改写后的新内容，用来验证它没有被覆盖掉。';
    await ws.saveChapterRewritten(metadata.bookId, 1, book.zip.readXmlText(href).text.replace('第一章', MARK));
    const status = await ws.readChapterStatus(metadata.bookId, 1);
    await ws.writeChapterStatus(metadata.bookId, 1, { ...status, stage: 'completed' });

    // 放一份规划，导出时就会插阅读路径页
    await ws.writeBookPlan(metadata.bookId, {
      entries: [{ index: 1, title: '第一章', chars: 600, value: 'useful', strategy: 'keep', reason: '正文' }],
      readingPath: ['第 1 步：第一章'],
      frontMatterNote: '直接从第一章开始。',
    });

    const result = await exportBook({ bookId: metadata.bookId, chapters: [1] });
    assert.equal(result.addedCount, 1, '应该新增了阅读路径页');
    /**
     * OPF + 1 个正文文件 + 目录。
     *
     * 目录这一项是后加的：阅读路径页只插进 spine、不进目录的话，
     * 读者点开目录面板找不到它 —— 用户的原话是「没看到目录这个分类」。
     * fixture 里 NCX 和 nav 同时存在，所以是 2 个。
     */
    const srcBook = readEpub(makeFixtureEpub());
    const tocFiles = (srcBook.ncxItem ? 1 : 0) + (srcBook.navItem ? 1 : 0);
    assert.equal(
      result.replacedCount,
      2 + tocFiles,
      `OPF + 1 个正文文件 + ${tocFiles} 个目录文件都要替换，实际 ${result.replacedCount}`,
    );

    const outBuf = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, result.fileName));
    const zipOut = new ZipReader(outBuf);
    assert.ok(zipOut.readText(href).includes(MARK), '正文改写内容必须还在（被覆盖就说明踩了这个坑）');

    // 目录里必须能找到这一页
    if (srcBook.ncxItem) {
      const ncx = zipOut.readText(srcBook.ncxItem.href);
      assert.ok(ncx.includes('pbe-reading-path.xhtml'), 'NCX 里要有一条指向阅读路径页');
      assert.ok(ncx.includes('目录 · 怎么读这本书'), 'NCX 里的名字要和页内标题一致');
    }
    if (srcBook.navItem) {
      const nav = zipOut.readText(srcBook.navItem.href);
      assert.ok(nav.includes('pbe-reading-path.xhtml'), 'nav 里也要有一条指向阅读路径页');
    }

    const out = readEpub(outBuf);
    /**
     * 阅读路径页在 spine 第一位，但**不进 chapters** —— readEpub 现在
     * 把它当作上一版导出的导航页跳过（否则重新导入成品时会被当章节改写、
     * 再和新目录页撞同一个路径）。所以要验位置只看 spine，看内容直接读 ZIP。
     */
    const first = out.spine[0]?.item?.href || '';
    assert.ok(first.includes('reading-path'), `阅读路径页应排在 spine 第一位，实际 ${first}`);
    assert.ok(zipOut.readText(first).includes('怎么读这本书'), '第一页应是目录页');
    assert.ok(out.warnings.some((w) => w.includes('reading-path')), '跳过导航页时要留一条提示，不能悄悄吞掉');
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------ 接进任务队列（jobs）-- */

/**
 * 造一个只服务这一章的 JobManager。
 *
 * 这段是补一个真实存在的坑：规划里标了 `digest` 的章节如果不接进
 * 任务队列，「Rewrite All」会把它们**整章重写一遍** —— 用户花两次钱，
 * 而且第二次把压缩结果整个盖掉，导出的书里那些提要又变回全文，
 * 目录名却还写着「已压缩为一页提要」。
 */
async function runJobFor(bookId, index, mockBaseUrl) {
  const { JobManager } = await import('../../lib/book-engine/pipeline/jobs.js');
  const jobs = new JobManager({
    getContext: async () => ({
      provider: {
        baseUrl: mockBaseUrl,
        apiKey: 'test-key',
        model: 'mock-model',
        maxTokens: 2000,
        timeoutMs: 20000,
      },
      reviewProvider: null,
      settings: { processing: {}, memory: { enabled: false }, quality: {} },
      profile: { reading_goal: '测试' },
      projectRoot: process.cwd(),
      bookContext: '（测试）',
    }),
  });
  const job = jobs.start({ bookId, chapters: [index] });
  // 直接等任务对象上的 promise —— 空提要会走 client 的重试退避，
  // 靠轮询很容易等不到（踩过一次：5 秒轮询窗口太短，测试假超时）
  await jobs.jobs.get(job.id).promise;
  return jobs.get(job.id);
}

test('★ plan 里标了 digest 的章节要走压缩，不能被整章重写', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');
  const { importBook } = await import('../../lib/book-engine/pipeline/book-service.js');
  const { blankProfile } = await import('../../lib/book-engine/config/profile.js');
  const { makeFixtureEpub } = await import('./fixture-epub.js');
  const { createMockLlmServer } = await import('./mock-llm.js');

  const mock = createMockLlmServer();
  const { baseUrl } = await mock.listen();

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-digest-job-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeFixtureEpub(),
      fileName: 'digest-job.epub',
      profile: blankProfile(),
    });

    await ws.writeBookPlan(metadata.bookId, {
      entries: [
        { index: 1, title: '第一章 起点', chars: 600, value: 'context', strategy: 'digest', reason: '前置内容' },
      ],
    });

    const job = await runJobFor(metadata.bookId, 1, baseUrl);
    assert.equal(job.status, 'completed', `任务应成功，实际 ${job.status}：${job.error || job.message}`);
    assert.deepEqual(job.completed, [1]);

    const status = await ws.readChapterStatus(metadata.bookId, 1);
    assert.equal(status.digest, true, '状态里要标记这是压缩出来的，不是逐段改写');
    assert.equal(status.stage, 'completed');
    assert.equal(status.stats.risk, 'low', '风险档位要记下来');

    const rewritten = await ws.readChapterRewritten(metadata.bookId, 1);
    assert.ok(rewritten.includes('mock 提要'), '正文应当是提要，而不是逐段改写的结果');
    assert.ok(!/【段\s*\d+】/.test(rewritten), '提要里不该混进改写用的段落标记');

    // 这一章只有一次调用：压缩只发一次请求
    assert.equal(mock.calls, 1, `压缩一章只该调一次模型，实际 ${mock.calls} 次`);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('★ 提要是空的必须中止，绝不能把整章清空', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');
  const { importBook } = await import('../../lib/book-engine/pipeline/book-service.js');
  const { blankProfile } = await import('../../lib/book-engine/config/profile.js');
  const { makeFixtureEpub } = await import('./fixture-epub.js');
  const { createMockLlmServer } = await import('./mock-llm.js');

  const mock = createMockLlmServer({ behavior: 'emptyDigest' });
  const { baseUrl } = await mock.listen();

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-digest-empty-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeFixtureEpub(),
      fileName: 'empty.epub',
      profile: blankProfile(),
    });
    await ws.writeBookPlan(metadata.bookId, {
      entries: [{ index: 1, title: '第一章', chars: 600, value: 'context', strategy: 'digest', reason: 'x' }],
    });

    const job = await runJobFor(metadata.bookId, 1, baseUrl);
    /**
     * 抛异常 → 整个任务标记失败（和逐段改写遇到 API 错误时的行为一致）。
     * 重点是**什么都没写坏**：不能出现一张白页，也不能留下半截状态。
     */
    assert.equal(job.status, 'failed', `空提要必须判失败，实际 ${job.status}`);
    assert.ok(/空|empty/i.test(job.error || ''), `错误信息要说清是空内容：${job.error}`);

    // 原文一个字都不能少：宁可没压成，也不能产出一张白页
    assert.equal(
      await ws.readChapterRewritten(metadata.bookId, 1),
      null,
      '失败时不能写入任何改写结果',
    );
    // 状态也不能被写成「已完成」
    const after = await ws.readChapterStatus(metadata.bookId, 1);
    assert.notEqual(after?.stage, 'completed', '失败却标成已完成，界面上就成了「做完了但书是空的」');
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('★ 锚点太密的章节（blocked）拒绝压缩，保留全文', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');
  const { importBook } = await import('../../lib/book-engine/pipeline/book-service.js');
  const { blankProfile } = await import('../../lib/book-engine/config/profile.js');
  const { makeWidelyLinkedFixtureEpub } = await import('./fixture-epub.js');
  const { createMockLlmServer } = await import('./mock-llm.js');

  const mock = createMockLlmServer();
  const { baseUrl } = await mock.listen();

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-digest-blocked-'));
  ws.setWorkspaceRoot(dir);
  try {
    /**
     * 第 1 章被 120 个各不相同的锚点指着 —— 真实场景是脚注汇编章
     * 被全书 483 条脚注指着。压它等于切断所有脚注跳转，
     * 而且阅读器**不会报错**，读者点一下什么都不会发生。
     */
    const metadata = await importBook({
      buffer: makeWidelyLinkedFixtureEpub(120),
      fileName: 'blocked.epub',
      profile: blankProfile(),
    });

    await ws.writeBookPlan(metadata.bookId, {
      entries: [{ index: 1, title: '第一章 注释汇编', chars: 900, value: 'context', strategy: 'digest', reason: 'x' }],
    });

    const job = await runJobFor(metadata.bookId, 1, baseUrl);
    assert.deepEqual(job.skipped, [1], `blocked 的章节应当跳过压缩，实际 ${JSON.stringify({ c: job.completed, f: job.failed, s: job.skipped })}`);
    assert.equal(mock.calls, 0, '判定不能压之后一次模型都不该调（省下的也是钱）');

    const status = await ws.readChapterStatus(metadata.bookId, 1);
    assert.ok(status.note.includes('锚点'), `要说明为什么不压：${status.note}`);
    assert.equal(status.digest, false);
    assert.equal(await ws.readChapterRewritten(metadata.bookId, 1), null, '不该写入压缩结果');
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});
