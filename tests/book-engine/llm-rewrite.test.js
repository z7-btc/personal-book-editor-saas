/**
 * ★ Phase 2 验收：Provider 设置 -> 单章节 AI Rewrite -> 重新生成 EPUB
 *
 * 用本地 mock 的 OpenAI-compatible 服务端，把「改写链路」的每个环节都跑一遍：
 *   提取 -> 分块 -> Prompt -> 调用 -> 解析 -> 写回 DOM -> 质量检查 -> 导出
 *
 * 同时验证「AI 不容易把原书内容改没」这条底线的几个关键场景：
 *   - 模型丢掉脚注占位符  => 脚注必须被自动补回
 *   - 模型把内容摘要化    => 质量检查必须判 fail
 *   - 模型删掉数字        => 数字检查必须抓到
 *   - 429 / 500           => 自动退避重试后成功
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createMockLlmServer } from './mock-llm.js';
import { makeFixtureEpub, makeLongFixtureEpub } from './fixture-epub.js';
import { readEpub } from '../../lib/book-engine/epub/epub-reader.js';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook, extractChapter, exportBook } from '../../lib/book-engine/pipeline/book-service.js';
import { rewriteChapter } from '../../lib/book-engine/pipeline/rewrite.js';
import { chatCompletion, testProvider, extractJson, buildChatUrl, describeNetworkError } from '../../lib/book-engine/llm/client.js';
import { DEFAULT_SETTINGS } from '../../lib/book-engine/config/settings.js';
import { normalizeProvider, effectiveApiKey } from '../../lib/book-engine/config/providers.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';
import { LlmError, AbortedError } from '../../lib/book-engine/util/errors.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

async function withMock(fn, mockOptions = {}) {
  const mock = createMockLlmServer(mockOptions);
  const { baseUrl, port } = await mock.listen(0);
  const provider = normalizeProvider({
    name: 'Mock',
    baseUrl,
    model: 'mock-model',
    apiKey: 'sk-mock',
    maxTokens: 4096,
    temperature: 0.2,
    timeoutMs: 20000,
    presetId: 'custom',
  });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-llm-'));
  ws.setWorkspaceRoot(dir);
  try {
    return await fn({ mock, provider, baseUrl, port, dir });
  } finally {
    ws.setWorkspaceRoot(null);
    await mock.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function settingsWith(overrides = {}) {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    processing: {
      ...DEFAULT_SETTINGS.processing,
      maxRetries: 3,
      retryBaseDelayMs: 10,
      targetCharsPerChunk: 5000,
      maxCharsPerChunk: 9000,
      ...(overrides.processing || {}),
    },
    review: { ...DEFAULT_SETTINGS.review, ...(overrides.review || {}) },
    memory: { ...DEFAULT_SETTINGS.memory, enabled: false, ...(overrides.memory || {}) },
    quality: { ...DEFAULT_SETTINGS.quality, ...(overrides.quality || {}) },
  };
}

/* ------------------------------------------------------------ 客户端 -- */

test('chatCompletion 解析标准 OpenAI 响应', async () => {
  await withMock(async ({ provider }) => {
    const result = await chatCompletion([{ role: 'user', content: '【段 1】你好' }], {
      baseUrl: provider.baseUrl,
      apiKey: effectiveApiKey(provider),
      model: provider.model,
      maxRetries: 0,
    });
    assert.ok(result.text.includes('【段 1】'));
    assert.equal(result.usage.totalTokens, 150);
    assert.equal(result.model, 'mock-model');
  });
});

test('429 会自动指数退避重试并最终成功', async () => {
  await withMock(
    async ({ provider, mock }) => {
      const retries = [];
      const result = await chatCompletion([{ role: 'user', content: '【段 1】x' }], {
        baseUrl: provider.baseUrl,
        apiKey: 'k',
        model: provider.model,
        maxRetries: 3,
        retryBaseDelayMs: 10,
        onRetry: (info) => retries.push(info),
      });
      assert.ok(result.text.length > 0);
      assert.equal(retries.length, 2, '应重试两次');
      assert.ok(retries[0].waitMs > 0);
      assert.equal(mock.calls, 3, '一共调用 3 次（2 次 429 + 1 次成功）');
    },
    { rateLimitTimes: 2 },
  );
});

test('5xx 重试耗尽后抛出 retryable 的 LlmError', async () => {
  await withMock(
    async ({ provider }) => {
      await assert.rejects(
        () =>
          chatCompletion([{ role: 'user', content: 'x' }], {
            baseUrl: provider.baseUrl,
            apiKey: 'k',
            model: provider.model,
            maxRetries: 2,
            retryBaseDelayMs: 5,
          }),
        (err) => {
          assert.ok(err instanceof LlmError);
          assert.equal(err.retryable, true);
          assert.match(err.message, /500/);
          return true;
        },
      );
    },
    { behavior: 'http500' },
  );
});

test('AbortSignal 能立刻打断请求（Pause 的实现基础）', async () => {
  await withMock(
    async ({ provider }) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 60);
      await assert.rejects(
        () =>
          chatCompletion([{ role: 'user', content: 'x' }], {
            baseUrl: provider.baseUrl,
            apiKey: 'k',
            model: provider.model,
            maxRetries: 0,
            signal: controller.signal,
          }),
        (err) => err instanceof AbortedError,
      );
    },
    { latencyMs: 3000 },
  );
});

test('buildChatUrl 兼容各种 Base URL 写法', () => {
  assert.equal(buildChatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(buildChatUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(buildChatUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(
    buildChatUrl('https://x/v1/chat/completions'),
    'https://x/v1/chat/completions',
    '已经带路径时不应重复拼接',
  );
});

test('testProvider 返回延迟与样例输出', async () => {
  await withMock(async ({ provider }) => {
    const result = await testProvider(provider);
    assert.equal(result.ok, true);
    assert.ok(result.latencyMs >= 0);
    assert.ok(typeof result.sample === 'string');
  });
});

test('extractJson 容忍代码块围栏与前后废话', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('好的，结果如下：{"a":3} 希望有帮助'), { a: 3 });
  assert.throws(() => extractJson('完全不是 JSON'), /不是合法 JSON/);
});

/* ------------------------------------------- 网络错误提示（可操作性）-- */

test('回归：网络错误被翻译成用户能照着修的中文提示', () => {
  const url = 'https://api.example.com/v1/chat/completions';
  const cases = [
    ['ECONNREFUSED', /连接被拒绝.*api\.example\.com.*请确认服务已启动/],
    ['ENOTFOUND', /无法解析域名.*请检查 Base URL/],
    ['ETIMEDOUT', /连接超时.*Timeout/],
    ['ECONNRESET', /连接被重置/],
    ['UND_ERR_CONNECT_TIMEOUT', /连接超时/],
  ];
  for (const [code, expected] of cases) {
    const message = describeNetworkError({ message: 'fetch failed', cause: { code } }, url);
    assert.match(message, expected, `${code} 的提示不够可操作: ${message}`);
    // 关键：不能把裸的 "fetch failed" 直接丢给用户
    assert.ok(!/^无法连接到 API：fetch failed$/.test(message), `${code} 没有翻译: ${message}`);
  }
});

test('未知网络错误也会带上主机名，便于排查', () => {
  const message = describeNetworkError({ message: 'something odd', cause: { code: 'EWEIRD' } }, 'https://x.test/v1/chat/completions');
  assert.ok(message.includes('x.test'), message);
  assert.ok(message.includes('EWEIRD'), message);
});

test('Base URL 非法时不会因为解析主机名而崩溃', () => {
  const message = describeNetworkError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }, 'not a url');
  assert.ok(message.includes('not a url'));
});

/* ------------------------------------------------------- 体积预算 -- */

test('★ 回归：中断后继续会复用已完成的 chunk，不整章重跑', async () => {
  await withMock(async ({ provider, mock }) => {
    const buffer = makeLongFixtureEpub(30);
    const metadata = await importBook({ buffer, fileName: 'resume.epub', profile: blankProfile() });
    await extractChapter(metadata.bookId, 1);
    const xhtml = await ws.readChapterOriginal(metadata.bookId, 1);

    const settings = settingsWith({
      /**
       * 这条只验「中断恢复不要整章重跑」，所以关掉第二遍补讲：
       * 补讲对每个 chunk 也会各发一次请求，混进来会让「调用次数」这个
       * 断言测不到它本来要测的东西（补讲有自己的 explain-pass.test.js）。
       */
      processing: { targetCharsPerChunk: 1500, maxCharsPerChunk: 3000, explainPass: false },
    });

    // ---- 第一次：跑到第 3 个 chunk 就中止 ----
    const controller = new AbortController();
    let saved = null;
    let savedSignature = null;
    const aborted = await rewriteChapter({
      xhtml,
      provider,
      profile: blankProfile(),
      settings,
      projectRoot: PROJECT_ROOT,
      signal: controller.signal,
      onChunkDone: async (info) => {
        saved = JSON.parse(JSON.stringify(info.chunkResults));
        savedSignature = info.planSignature;
        if (info.chunkIndex === 2) controller.abort(new Error('模拟用户暂停'));
      },
    }).catch((err) => err);

    assert.ok(aborted instanceof AbortedError, `应当抛出 AbortedError，实际 ${aborted?.name}`);
    assert.ok(saved && Object.keys(saved).length >= 3, '已完成的 chunk 内容必须被保留下来');
    assert.ok(savedSignature, '进度里必须带分块计划指纹，否则续跑无法判断边界');

    // ---- 第二次：带 resume 继续 ----
    const before = mock.calls;
    const resumed = await rewriteChapter({
      xhtml,
      provider,
      profile: blankProfile(),
      settings,
      projectRoot: PROJECT_ROOT,
      resumeChunkResults: saved,
      resumePlanSignature: savedSignature,
    });
    const newCalls = mock.calls - before;

    assert.ok(resumed.resumedChunks >= 3, `应复用至少 3 个 chunk，实际 ${resumed.resumedChunks}`);
    assert.equal(
      newCalls,
      resumed.chunks.length - resumed.resumedChunks,
      '只应对剩下的 chunk 调用模型',
    );
    assert.ok(newCalls < resumed.chunks.length, '总调用次数必须少于整章重跑');
    assert.equal(resumed.quality.verdict, 'ok', JSON.stringify(resumed.quality.issues));
    assert.ok(resumed.stats.applied > 0, '恢复后正文要被写回');
  });
});

/**
 * ★ P1 回归：旧版 chunkResults 遇到新分块计划（图片感知改写）不能按序号硬套。
 *
 * QA 的复现场景：base 版本跑完第 1 章，存下 9 块 1 个 chunk 的结果；
 * 切到图片感知改写后，图注块被摘出可改写块，新计划只有 7 块。
 * 旧代码只按 `chunk.index` 复用，图注文字被写进正文块 —— 4 处串段。
 *
 * 这里用「图注当普通段落」的旧版 XHTML 生成真实旧结果，
 * 再用带 <figure> 的新版 XHTML 续跑，断言旧结果被丢弃、正文不串段。
 */
test('★ P1 回归：分块计划变了就丢弃旧 chunkResults，图注不会被写进正文', async () => {
  await withMock(async ({ provider, mock }) => {
    const settings = settingsWith({ processing: { explainPass: false } });
    const para = (n) =>
      `<p>第${n}段正文：${`这是第${n}段的内容，用来验证续跑时旧分块结果不会被错套到新分块上。`.repeat(4)}` +
      `第${n}段的关键数字是 ${n}000。</p>`;
    const caption = (n) => `图 ${n}：这是第${n}张图的图注，不能被写进正文`;
    const fig = (n) =>
      `<figure><img src="../images/f${n}.png" alt="图 ${n}"/><figcaption>${caption(n)}</figcaption></figure>`;

    // 新版：图注块 / 整图块不参与改写（annotateBlocks 会把它们标成 preserve）
    const newXhtml =
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>串段测试</title></head><body>' +
      `<h1>串段测试</h1>${para(1)}${para(2)}${fig(1)}${para(3)}${para(4)}${fig(2)}${para(5)}${para(6)}` +
      '</body></html>';

    // 旧版：没有图片识别，图注就是普通段落，会一起进 chunk（9 块 1 个 chunk）
    const legacyXhtml =
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>串段测试</title></head><body>' +
      `<h1>串段测试</h1>${para(1)}${para(2)}<p>${caption(1)}</p>${para(3)}${para(4)}<p>${caption(2)}</p>${para(5)}${para(6)}` +
      '</body></html>';

    const legacy = await rewriteChapter({
      xhtml: legacyXhtml,
      provider,
      profile: blankProfile(),
      settings,
      projectRoot: PROJECT_ROOT,
    });
    assert.equal(legacy.chunks.length, 1, '旧计划应当是 1 个 chunk');
    assert.ok(legacy.planSignature, '改写结果必须带分块计划指纹');
    assert.equal(legacy.resumeDiscarded, null, '首次改写没有旧结果可丢弃');

    /* ---- 1) 指纹不一致：丢弃并整章重跑 ---- */
    const before = mock.calls;
    const chunkTotals = [];
    const resumed = await rewriteChapter({
      xhtml: newXhtml,
      provider,
      profile: blankProfile(),
      settings,
      projectRoot: PROJECT_ROOT,
      chapterHref: 'OEBPS/text/ch1.xhtml',
      resumeChunkResults: legacy.chunkResults,
      resumePlanSignature: legacy.planSignature,
      onChunkDone: (info) => chunkTotals.push(info.chunkTotal),
    });

    assert.notEqual(legacy.planSignature, resumed.planSignature, '图片过滤后分块计划指纹必须变化');
    assert.equal(resumed.resumeDiscarded, 'plan-changed', '计划不一致时必须丢弃旧结果');
    assert.equal(resumed.resumedChunks, 0, '一个旧 chunk 都不许复用');
    assert.equal(mock.calls - before, resumed.chunks.length, '所有 chunk 都应重新调用模型');
    assert.ok(chunkTotals.length > 0 && chunkTotals.every((n) => n === resumed.chunks.length));
    assert.equal(resumed.quality.verdict, 'ok', JSON.stringify(resumed.quality.issues));

    // 正文不串段：每个 <p> 都还是它自己那一段，图注只出现在 figcaption 里
    const doc = parseXml(resumed.xhtml);
    const paragraphs = doc.documentElement.descendants().filter((el) => el.name === 'p');
    assert.ok(paragraphs.length >= 6, `正文段落数不对：${paragraphs.length}`);
    for (const p of paragraphs) {
      assert.match(p.textContent.trim(), /^第\d+段正文/, `正文段落被串成了：${p.textContent.slice(0, 40)}`);
    }
    const captions = doc.documentElement.descendants().filter((el) => el.name === 'figcaption').map((el) => el.textContent.trim());
    assert.deepEqual(captions, [caption(1), caption(2)], '图注必须原样保留在 figcaption 里');

    /* ---- 2) 旧版本状态没有指纹：同样不能复用 ---- */
    const beforeLegacy = mock.calls;
    const legacyResume = await rewriteChapter({
      xhtml: newXhtml,
      provider,
      profile: blankProfile(),
      settings,
      projectRoot: PROJECT_ROOT,
      chapterHref: 'OEBPS/text/ch1.xhtml',
      resumeChunkResults: legacy.chunkResults,
    });
    assert.equal(legacyResume.resumeDiscarded, 'missing-signature', '没有指纹的旧状态必须丢弃');
    assert.equal(legacyResume.resumedChunks, 0);
    assert.equal(mock.calls - beforeLegacy, legacyResume.chunks.length);
  });
});

test('不传 resumeChunkResults 时整章重跑（用户点「重新改写」的场景）', async () => {
  await withMock(async ({ provider, mock }) => {
    const buffer = makeLongFixtureEpub(30);
    const metadata = await importBook({ buffer, fileName: 'redo.epub', profile: blankProfile() });
    await extractChapter(metadata.bookId, 1);
    const xhtml = await ws.readChapterOriginal(metadata.bookId, 1);
    const settings = settingsWith({
      processing: { targetCharsPerChunk: 1500, maxCharsPerChunk: 3000 },
    });

    const before = mock.calls;
    const result = await rewriteChapter({ xhtml, provider, profile: blankProfile(), settings, projectRoot: PROJECT_ROOT });
    const calls = mock.calls - before;
    assert.equal(result.resumedChunks, 0, '不该复用');
    assert.ok(calls >= result.chunks.length, `每个 chunk 都应重新调用（${calls} vs ${result.chunks.length}）`);
  });
});

test('回归：超长 Prompt 在发请求之前就被拦下并给出可操作提示', async () => {
  // 体积检查发生在 rewriteChunk 里（chatCompletion 是通用客户端，不该管业务预算），
  // 所以这里直接测 rewriteChunk 的行为。
  await withMock(async ({ provider, mock }) => {
    const source = makeLongFixtureEpub(6);
    const metadata = await importBook({ buffer: source, fileName: 'budget.epub', profile: blankProfile() });
    await extractChapter(metadata.bookId, 1);
    const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);

    const tinyBudget = normalizeProvider({
      name: 'Mock',
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: 'k',
      timeoutMs: 20000,
      maxInputChars: 500, // 故意设得极小，必然超限
    });

    await assert.rejects(
      () =>
        rewriteChapter({
          xhtml: originalXhtml,
          provider: tinyBudget,
          profile: blankProfile(),
          settings: settingsWith(),
          projectRoot: PROJECT_ROOT,
        }),
      (err) => {
        assert.ok(err instanceof LlmError, `期望 LlmError，实际 ${err?.name}: ${err?.message}`);
        assert.equal(err.code, 'PROMPT_TOO_LARGE');
        assert.match(err.message, /每 chunk 最大字符数/);
        return true;
      },
    );
    assert.equal(mock.calls, 0, '超限的请求不应该真的发出去');
  });
});

/* ------------------------------------------------------- 单章改写 -- */

test('★ Phase 2：单章改写成功，脚注 / 链接 / 图片全部保留', async () => {
  await withMock(async ({ provider }) => {
    const source = makeFixtureEpub();
    const metadata = await importBook({ buffer: source, fileName: 'phase2.epub', profile: blankProfile() });
    await extractChapter(metadata.bookId, 1);

    const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);
    const result = await rewriteChapter({
      xhtml: originalXhtml,
      provider,
      profile: { ...blankProfile(), preferred_style: ['直接'] },
      settings: settingsWith(),
      projectRoot: PROJECT_ROOT,
      chapterTitle: '第一章 起点',
      bookContext: { title: '测试之书', authors: ['测试作者'] },
    });

    assert.ok(result.blockCount >= 6);
    assert.equal(result.quality.verdict, 'ok', JSON.stringify(result.quality.issues));
    assert.equal(result.stats.missing, 0, '不应有占位符丢失');

    const doc = parseXml(result.xhtml);
    const html = doc.documentElement;
    const anchors = html.descendants().filter((el) => el.name === 'a');
    const hrefs = anchors.map((a) => a.getAttribute('href'));
    assert.ok(hrefs.includes('endnotes.xhtml#n1'), `脚注链接必须保留: ${hrefs.join(',')}`);
    assert.ok(hrefs.includes('chapter2.xhtml'), '章节间链接必须保留');
    assert.ok(
      html.descendants().some((el) => el.name === 'sup'),
      '脚注上标必须保留',
    );
    assert.ok(html.descendants().some((el) => el.name === 'img'), '图片必须保留');
    assert.equal(
      html.descendants().find((el) => el.name === 'img')?.getAttribute('src'),
      '../images/figure1.png',
      '图片路径必须保持相对原样',
    );
    // 结构性属性必须保留
    const ids = html.descendants().map((el) => el.getAttribute('id')).filter(Boolean);
    assert.ok(ids.includes('ref1'), '脚注锚点 id 必须保留');
    assert.ok(ids.includes('h-1'), '标题 id 必须保留');
    assert.ok(result.rewrittenChars > 0);
  });
});

test('模型丢掉占位符时，脚注与链接被自动补回（内容不丢）', async () => {
  await withMock(
    async ({ provider }) => {
      const source = makeFixtureEpub();
      const metadata = await importBook({ buffer: source, fileName: 'drop.epub', profile: blankProfile() });
      await extractChapter(metadata.bookId, 1);
      const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);

      const result = await rewriteChapter({
        xhtml: originalXhtml,
        provider,
        profile: blankProfile(),
        settings: settingsWith(),
        projectRoot: PROJECT_ROOT,
        chapterTitle: '第一章 起点',
      });

      assert.ok(result.stats.missing > 0, '应当检测到占位符丢失');
      const html = parseXml(result.xhtml).documentElement;
      const hrefs = html.descendants().filter((el) => el.name === 'a').map((a) => a.getAttribute('href'));
      assert.ok(hrefs.includes('endnotes.xhtml#n1'), `脚注链接必须被补回: ${hrefs.join(',')}`);
      assert.ok(
        result.quality.issues.some((i) => i.type === 'placeholders'),
        '占位符异常必须出现在质量报告里',
      );
    },
    { behavior: 'dropTags' },
  );
});

test('模型把内容摘要化时，质量检查判定 fail', async () => {
  await withMock(
    async ({ provider }) => {
      // 用一个足够长的章节，否则「摘要化」在短章节上不构成显著的长度异常
      const buffer = makeLongFixtureEpub(8);
      const metadata = await importBook({ buffer, fileName: 'sum.epub', profile: blankProfile() });
      await extractChapter(metadata.bookId, 1);
      const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);

      const result = await rewriteChapter({
        xhtml: originalXhtml,
        provider,
        profile: blankProfile(),
        settings: settingsWith(),
        projectRoot: PROJECT_ROOT,
      });

      // 引擎的正确行为是：逐段判定「被摘要化」=> 该段保留原文（内容零损失），
      // 同时把这一章标为 fail，提示「模型没按规矩干活，应当重试或换模型」。
      assert.equal(result.quality.verdict, 'fail', JSON.stringify(result.quality.issues));
      assert.ok(result.stats.corrupted > 0, '应当有段落被判为不可信');
      assert.ok(
        result.quality.issues.some((i) => i.type === 'rewrite_failed' && i.severity === 'fail'),
        JSON.stringify(result.quality.issues),
      );
      // 关键：内容不能丢——被破坏的段落保留了原文
      assert.ok(result.rewrittenChars >= result.originalChars * 0.8, '被破坏的段落应保留原文，字数不应骤降');
      assert.ok(result.rewrittenBodyText.includes('安全边际'), '原文内容必须还在');
    },
    { behavior: 'summary' },
  );
});

test('模型删掉数字时，数字检查抓到', async () => {
  await withMock(
    async ({ provider }) => {
      const source = makeFixtureEpub();
      const metadata = await importBook({ buffer: source, fileName: 'num.epub', profile: blankProfile() });
      await extractChapter(metadata.bookId, 1);
      const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);

      const result = await rewriteChapter({
        xhtml: originalXhtml,
        provider,
        profile: blankProfile(),
        settings: settingsWith(),
        projectRoot: PROJECT_ROOT,
      });
      assert.ok(
        result.quality.issues.some((i) => i.type === 'numbers'),
        JSON.stringify(result.quality.issues),
      );
      assert.ok(result.quality.metrics.numberMissing > 0);
    },
    { behavior: 'numberLoss' },
  );
});

test('模型换掉专有名词时，专名检查抓到', async () => {
  await withMock(
    async ({ provider }) => {
      const source = makeFixtureEpub();
      const metadata = await importBook({ buffer: source, fileName: 'ent.epub', profile: blankProfile() });
      await extractChapter(metadata.bookId, 2);
      const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 2);

      const result = await rewriteChapter({
        xhtml: originalXhtml,
        provider,
        profile: blankProfile(),
        settings: settingsWith(),
        projectRoot: PROJECT_ROOT,
      });
      const issue = result.quality.issues.find((i) => i.type === 'entities');
      assert.ok(issue, JSON.stringify(result.quality.issues));
    },
    { behavior: 'renameEntity' },
  );
});

test('空输出不会导致原文消失（回退到原文）', async () => {
  await withMock(
    async ({ provider }) => {
      const source = makeFixtureEpub();
      const metadata = await importBook({ buffer: source, fileName: 'empty.epub', profile: blankProfile() });
      await extractChapter(metadata.bookId, 1);
      const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);

      const result = await rewriteChapter({
        xhtml: originalXhtml,
        provider,
        profile: blankProfile(),
        settings: settingsWith({ processing: { maxRetries: 0 } }),
        projectRoot: PROJECT_ROOT,
      });
      const html = parseXml(result.xhtml).documentElement;
      // 原文的关键句子必须仍然存在（因为回退用了原文）
      assert.ok(html.textContent.includes('安全边际'), '原文内容不能消失');
      assert.ok(result.stats.fallback > 0, '应当记录回退次数');
    },
    { behavior: 'empty' },
  );
});

test('onChunkDone 回调让每个 chunk 立即落盘（崩溃可恢复）', async () => {
  await withMock(async ({ provider }) => {
    const source = makeFixtureEpub();
    const metadata = await importBook({ buffer: source, fileName: 'chunk.epub', profile: blankProfile() });
    await extractChapter(metadata.bookId, 1);
    const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);

    const saved = [];
    await rewriteChapter({
      xhtml: originalXhtml,
      provider,
      profile: blankProfile(),
      settings: settingsWith({ processing: { targetCharsPerChunk: 200, maxCharsPerChunk: 400 } }),
      projectRoot: PROJECT_ROOT,
      onChunkDone: async (info) => {
        saved.push({ index: info.chunkIndex, total: info.chunkTotal });
        await ws.saveChapterRewritten(metadata.bookId, 1, info.doc.serialize());
      },
    });

    assert.ok(saved.length >= 1, '至少回调一次');
    const onDisk = await ws.readChapterRewritten(metadata.bookId, 1);
    assert.ok(onDisk && onDisk.length > 0, 'rewritten.xhtml 必须已落盘');
  });
});

/* --------------------------------------------- 端到端：改写后导出 -- */

test('★ Phase 2 端到端：改写 -> 保存 -> 导出 EPUB，结构不变内容已改', async () => {
  await withMock(async ({ provider }) => {
    const source = makeFixtureEpub();
    const metadata = await importBook({ buffer: source, fileName: 'The Test Book.epub', profile: blankProfile() });
    await extractChapter(metadata.bookId, 1);
    const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);

    const result = await rewriteChapter({
      xhtml: originalXhtml,
      provider,
      profile: blankProfile(),
      settings: settingsWith(),
      projectRoot: PROJECT_ROOT,
      chapterTitle: '第一章 起点',
    });
    await ws.saveChapterRewritten(metadata.bookId, 1, result.xhtml);
    const status = await ws.readChapterStatus(metadata.bookId, 1);
    status.stage = 'completed';
    status.quality = result.quality;
    status.usage = result.usage;
    status.rewrittenChars = result.rewrittenChars;
    await ws.writeChapterStatus(metadata.bookId, 1, status);

    const exported = await exportBook({ bookId: metadata.bookId, chapters: [1] });
    assert.equal(exported.replacedCount, 1);
    // 真的替换了正文，文件名最前面必须挂着 AI 标记
    assert.equal(exported.fileName, '【AI重写】The Test Book.epub');

    const buffer = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, exported.fileName));

    // 1) 输出的 EPUB 必须仍然合法
    const book = readEpub(buffer);
    assert.equal(book.chapters.length, 4);
    assert.equal(book.warnings.length, 0);

    // 2) OPF / nav / NCX / CSS / 图片 必须与原文逐字节一致
    const a = new ZipReader(source);
    const b = new ZipReader(buffer);
    for (const name of ['OEBPS/content.opf', 'OEBPS/toc.ncx', 'OEBPS/nav.xhtml', 'OEBPS/styles/main.css', 'OEBPS/images/figure1.png', 'OEBPS/images/cover.png']) {
      assert.deepEqual(b.read(name), a.read(name), `${name} 不应被改动`);
    }

    // 3) 被改写的章节：文字变了，但脚注与链接还在
    const rewritten = b.readText('OEBPS/text/chapter1.xhtml');
    const html = parseXml(rewritten).documentElement;
    assert.ok(rewritten.includes('Personalized Edition'), '应带个人化标记注释');
    assert.ok(html.textContent.includes('安全边际'));
    const hrefs = html.descendants().filter((el) => el.name === 'a').map((el) => el.getAttribute('href'));
    assert.ok(hrefs.includes('endnotes.xhtml#n1'));

    // 4) 未改写的章节完全没变
    assert.deepEqual(b.read('OEBPS/text/chapter2.xhtml'), a.read('OEBPS/text/chapter2.xhtml'));
    assert.deepEqual(b.read('OEBPS/text/endnotes.xhtml'), a.read('OEBPS/text/endnotes.xhtml'));
  });
});

test('开启 Review：评分与问题会写进结果，但不会篡改正文', async () => {
  await withMock(
    async ({ provider, mock }) => {
      const source = makeFixtureEpub();
      const metadata = await importBook({ buffer: source, fileName: 'review.epub', profile: blankProfile() });
      await extractChapter(metadata.bookId, 1);
      const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);

      const result = await rewriteChapter({
        xhtml: originalXhtml,
        provider,
        providerForReview: provider,
        profile: blankProfile(),
        settings: settingsWith({ review: { enabled: true } }),
        projectRoot: PROJECT_ROOT,
      });

      assert.ok(result.review, '应当产生 review 结果');
      assert.equal(result.review.verdict, 'revise');
      assert.ok(result.review.issues.length > 0);
      assert.ok(result.quality.issues.some((i) => i.type === 'review'));
      assert.ok(mock.calls >= 2, '改写 + 审校至少两次调用');
      // 正文仍然完整
      assert.ok(parseXml(result.xhtml).documentElement.textContent.includes('安全边际'));
    },
    { behavior: 'strictReview' },
  );
});
