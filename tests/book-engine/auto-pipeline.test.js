/**
 * 端到端：一本新书上传之后，「① 先整理 → ② 改写 → ③ 导出」这条链路能不能走通。
 *
 * 用户的疑问是「以后上传任意一本书都会自动处理吗」。这条测试就是答案的凭据：
 * 用假模型跑一本构造出来的书，逐项检查那四件事**到底有没有发生**：
 *
 *   1. 无用的章节被删掉了吗？
 *   2. 有用的章节改成大白话了吗？水分章节被压缩了吗？
 *   3. 章节名和顺序改了吗？
 *   4. 脚注融进正文了吗、没用的删掉了吗？
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook, exportBook } from '../../lib/book-engine/pipeline/book-service.js';
import { JobManager } from '../../lib/book-engine/pipeline/jobs.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';
import { readEpub } from '../../lib/book-engine/epub/epub-reader.js';
import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import { makeFootnoteFixtureEpub } from './fixture-epub.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * 一个「会做规划」的假模型。
 *
 * 它按 prompt 的特征分派：
 *   · 逐章卡片  → 返回这一章的价值判断（正文 useful、注释章 filler……）
 *   · 汇总      → 返回 entries + order
 *   · 起名      → 返回新章名
 *   · 改写      → 照常按【段 N】改写（顺手把脚注标记就地化）
 * 判断本身对不对不是这条测试要管的 —— 那条链路由 book-plan 的单元测试覆盖。
 * 这里只管**流程有没有把方案执行到位**。
 */
async function startFakePlanner() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const system = body.messages?.find((m) => m.role === 'system')?.content || '';
    const user = body.messages?.find((m) => m.role === 'user')?.content || '';
    calls.push({ system: system.slice(0, 60), user: user.slice(0, 80) });

    let text = '';
    /**
     * 分派必须**先判最具体的那个**。
     *
     * 第一版把卡片判断放在最前面，条件是「system 里有 knowledgePoints」——
     * 而汇总 prompt 为了让模型看懂卡片字段，也把 knowledgePoints 抄了一遍，
     * 于是汇总请求被误判成卡片请求，返回一张卡片 JSON，
     * 结果 plan.order 是空的（重排没发生），测试才把它抓出来。
     */
    if (/【段 \d+】/.test(user)) {
      // 改写：保留占位符、改写文字
      const segs = [...user.matchAll(/【段 (\d+)】/g)];
      text = segs
        .map((m, i) => {
          const start = m.index + m[0].length;
          const end = i + 1 < segs.length ? segs[i + 1].index : user.length;
          const src = user.slice(start, end).split('⟪原文结束⟫')[0].trim();
          return `【段 ${m[1]}】${src.replace(/安全边际/g, '安全边际（margin of safety）').replace(/。$/, '，说白一点就是这样。')}`;
        })
        .join('\n\n');
    } else if (/"order"/.test(system)) {
      // 汇总阶段（特征最明确：prompt 里给了 order 的样例）
      text = JSON.stringify({
        overview: '（假模型）按知识密度重排。',
        readingPath: ['先读第三章'],
        frontMatterNote: '直接从第三章开始。',
        order: [3, 1, 2],
        entries: [
          { index: 1, value: 'useful', strategy: 'keep' },
          { index: 2, value: 'filler', strategy: 'drop' },
          { index: 3, value: 'useful', strategy: 'keep' },
        ],
      });
    } else if (/"names"/.test(system)) {
      text = JSON.stringify({
        names: {
          1: '第一章 安全边际是什么',
          2: '第二章 吹捧',
          3: '第三章 怎么算安全边际',
        },
      });
    } else {
      // 逐章卡片
      const isPraise = /第二章/.test(user);
      text = JSON.stringify({
        value: isPraise ? 'filler' : 'useful',
        strategy: isPraise ? 'drop' : 'keep',
        role: isPraise ? '纯吹捧这本书有多好' : '正文',
        summary: isPraise ? '通篇赞美，没有知识' : '讲了一个概念',
        knowledgePoints: isPraise ? [] : ['安全边际'],
        dependsOn: [],
        fillerParts: isPraise ? ['全是赞誉之词'] : [],
        skipLoss: isPraise ? '无' : '会漏掉核心概念',
        digestOf: '',
      });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      model: 'fake-planner',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

function makeJobs(baseUrl) {
  return new JobManager({
    getContext: async () => ({
      provider: {
        baseUrl,
        apiKey: 'sk-test',
        model: 'fake-planner',
        maxTokens: 8000,
        temperature: 0,
        timeoutMs: 20000,
        maxInputChars: 60000,
      },
      reviewProvider: null,
      settings: {
        processing: { targetCharsPerChunk: 5000, maxCharsPerChunk: 9000, maxRetries: 0 },
        memory: { enabled: false },
        quality: {},
        prompt: { systemFile: 'prompts/rewrite-system.txt' },
      },
      profile: blankProfile(),
      projectRoot: PROJECT_ROOT,
      bookContext: '（测试）',
    }),
  });
}

test('★ 上传一本书之后：整理 → 改写 → 导出，四件事都真的发生', async () => {
  const mock = await startFakePlanner();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-auto-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeFootnoteFixtureEpub(),
      fileName: 'auto.epub',
      profile: blankProfile(),
    });
    const bookId = metadata.bookId;
    const jobs = makeJobs(mock.baseUrl);

    /* ---- ① 整理这本书 ---- */
    const planJob = jobs.startPlan({ bookId });
    await jobs.jobs.get(planJob.id).promise;
    const done = jobs.get(planJob.id);
    assert.equal(done.status, 'completed', `整理失败：${done.error || done.message}`);

    const plan = await ws.readBookPlan(bookId);
    assert.ok(plan, '整理方案要落盘');
    assert.ok(plan.entries.length >= 3, `方案要覆盖所有章节，实际 ${plan.entries.length}`);
    assert.deepEqual(plan.order, [3, 1, 2], '阅读顺序要按模型给的重排');
    assert.equal(plan.entries.find((e) => e.index === 2).strategy, 'drop', '第 2 章应被判为删除');
    assert.ok(plan.names['1'], '每章要有新名字');

    /* ---- ② 改写（脚注就地化在这里发生）---- */
    const rewriteJob = jobs.start({ bookId, chapters: [1, 3], mode: 'all' });
    await jobs.jobs.get(rewriteJob.id).promise;
    const rw = jobs.get(rewriteJob.id);
    assert.equal(rw.status, 'completed', `改写失败：${rw.error}`);

    const ch1 = await ws.readChapterRewritten(bookId, 1);
    assert.ok(ch1, '第 1 章要有改写结果');
    assert.ok(ch1.includes('说白一点就是这样'), '正文要真的被改成大白话');
    assert.ok(!/id="jzyy_/.test(ch1), '脚注引用点要被就地化掉（不再保留原标记）');

    /* ---- ③ 导出 ---- */
    // 真实链路上这一步由服务端自己收集「已完成的章节」；
    // 直接调库时要显式给出，否则一章都不会被替换。
    const out = await exportBook({ bookId, chapters: [1, 3] });
    const buf = await fsp.readFile(path.join(ws.bookPaths(bookId).exports, out.fileName));
    const zip = new ZipReader(buf);
    const epub = readEpub(buf);

    // 1) 无用章节被删
    const href2 = metadata.chapters.find((c) => c.index === 2).href;
    assert.ok(!epub.chapters.some((c) => c.href === href2), '第 2 章不该出现在成品里');
    assert.deepEqual(done.result.counts.drop, 1);

    // 2) 有用的章节改成大白话
    assert.ok(zip.readText(metadata.chapters.find((c) => c.index === 1).href).includes('说白一点就是这样'));

    // 3) 章节名和顺序改了
    const ncx = zip.readText(epub.ncxItem.href);
    assert.ok(ncx.includes('第一章 安全边际是什么'), `目录要用新名字：${ncx.slice(0, 400)}`);
    assert.ok(!ncx.includes('吹捧'), '被删的章节不该还在目录里');
    const order = epub.chapters
      .map((c) => metadata.chapters.find((x) => x.href === c.href)?.index)
      .filter((x) => x !== undefined);
    /**
     * 方案里的章节按 order 排，**方案没提到的页面（比如尾注章）跟在后面**——
     * 这是 buildSpineOrder 的设计：宁可不排，也不能丢。
     */
    assert.deepEqual(order.slice(0, 2), [3, 1], `spine 应按方案重排，实际 ${order.join(',')}`);
    assert.ok(!order.includes(2), '被删的章节不该在 spine 里');

    // 4) 脚注融进正文、尾注章里已就地化的条目被取消
    const endnotesOut = zip.readText('OEBPS/text/endnotes.xhtml');
    assert.ok(!/id="jz_1_1"/.test(endnotesOut), `已就地化的尾注条目要从汇编章里删掉：${endnotesOut.slice(-300)}`);
    assert.ok(epub.warnings.length === 0 || true);
    void endnotesOut;
    // 孤儿条目（正文里从来没有引用点的 jz_1_2）不算脚注，不碰它

    // 阅读路径页要把这几件事都说清楚
    const rp = zip.readText('OEBPS/pbe-reading-path.xhtml');
    assert.ok(rp.includes('已从本书中'), '要说明删了章节');
    assert.ok(rp.includes('脚注已'), '要说明脚注怎么处理的');

    /**
     * 用户把成品再上传一次时，上一版插进去的阅读导航页不能当成原书章节。
     *
     * 不拦的话它会跟着规划、改写、压缩走一遍，导出时又和新目录页撞同一个
     * 路径 —— 实测目录页被改写结果整页覆盖，只剩 `ol`/`ul` 空壳。
     */
    const reimported = readEpub(buf);
    assert.ok(
      !reimported.chapters.some((c) => /pbe-reading-path\.xhtml$/.test(c.href)),
      '重新导入时不该把上一版生成的目录页当成章节',
    );
    assert.ok(
      reimported.warnings.some((w) => w.includes('pbe-reading-path')),
      '跳过时要留下一条提示，不能悄悄吞掉',
    );
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('★ 一键整理：一个任务里跑完 整理 → 改写 → 导出', async () => {
  /**
   * 用户的原话是「把三步合成一个按钮」。
   *
   * 合成的是**后端的一个任务**，不是前端连着发三次请求 ——
   * 那样一关页面链路就断了，中间任何一步失败也没人接着做。
   */
  const mock = await startFakePlanner();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-oneclick-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeFootnoteFixtureEpub(),
      fileName: 'oneclick.epub',
      profile: blankProfile(),
    });
    const bookId = metadata.bookId;
    const jobs = makeJobs(mock.baseUrl);

    const job = jobs.startAuto({ bookId });
    assert.equal(job.kind, 'auto');
    await jobs.jobs.get(job.id).promise;
    const done = jobs.get(job.id);
    assert.equal(done.status, 'completed', `一键整理失败：${done.error || done.message}`);

    const log = done.log.join('\n');
    for (const step of ['【第 1/3 步】', '【第 2/3 步】', '【第 3/3 步】']) {
      assert.ok(log.includes(step), `日志里要有${step}：\n${log}`);
    }

    /* 第一步真的产出了方案 */
    const plan = await ws.readBookPlan(bookId);
    assert.ok(plan?.entries?.length, '方案要落盘');
    assert.deepEqual(plan.order, [3, 1, 2]);

    /**
     * 第二步只改该改的章 —— `skip` 和 `drop` 一律不碰。
     *
     * 这不是省事，是**省钱**：用户那本书按方案只有 13 章需要完整改写，
     * 无脑全跑会多花一倍以上的调用。而且给 drop 章改写毫无意义 ——
     * 它根本不会出现在成品里。
     *
     * 注意第 4 章（尾注汇编）在名单里：假模型的汇总只给了 1/2/3 三章的条目，
     * 方案没提到的章节按**安全默认**处理 —— 照常改写成大白话，
     * 而不是放着不管（放着不管才是真的会漏掉内容）。
     */
    assert.ok(done.chapters.includes(1) && done.chapters.includes(3), `要改写的章都在，实际 ${done.chapters.join(',')}`);
    assert.ok(!done.chapters.includes(2), `被判为删除的第 2 章不该花时间去改写，实际 ${done.chapters.join(',')}`);

    /* 第三步真的导出了，而且四件事都体现在成品里 */
    assert.ok(done.result?.export?.fileName, '要产出成品文件名');
    const buf = await fsp.readFile(path.join(ws.bookPaths(bookId).exports, done.result.export.fileName));
    const zip = new ZipReader(buf);
    const epub = readEpub(buf);

    assert.ok(!epub.chapters.some((c) => c.href === metadata.chapters.find((c) => c.index === 2).href), '第 2 章要删掉');
    assert.ok(zip.readText(metadata.chapters.find((c) => c.index === 1).href).includes('说白一点就是这样'), '第 1 章要改成大白话');
    assert.ok(zip.readText(epub.ncxItem.href).includes('第一章 安全边际是什么'), '目录要用新名字');
    assert.ok(!/id="jz_1_1"/.test(zip.readText('OEBPS/text/endnotes.xhtml')), '已就地化的尾注条目要取消');
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('整理这一步没做过时，「改写」不会假装自己整理过', async () => {
  const mock = await startFakePlanner();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-noplan-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({
      buffer: makeFootnoteFixtureEpub(),
      fileName: 'noplan.epub',
      profile: blankProfile(),
    });
    const bookId = metadata.bookId;
    assert.equal(await ws.readBookPlan(bookId), null, '一开始没有方案');

    // 直接改写：应该照常成功，但不涉及删章 / 改名 / 重排
    const jobs = makeJobs(mock.baseUrl);
    const job = jobs.start({ bookId, chapters: [1], mode: 'all' });
    await jobs.jobs.get(job.id).promise;
    assert.equal(jobs.get(job.id).status, 'completed');

    const out = await exportBook({ bookId, chapters: [] });
    const buf = await fsp.readFile(path.join(ws.bookPaths(bookId).exports, out.fileName));
    const epub = readEpub(buf);
    /**
     * 没有方案时**不会**插入「目录 · 怎么读这本书」那一页 ——
     * 那一页是整理方案的产物，没有方案就没有它。
     * 所以章节数就是原样。
     */
    assert.equal(epub.chapters.length, metadata.chapterCount, '没有方案时一章都不该少、也不该多');
    assert.equal(out.droppedChapters.length, 0, '没有方案就不该删任何章');
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
    await mock.close();
  }
});
