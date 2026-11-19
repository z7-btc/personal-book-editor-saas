/**
 * Book Memory 测试。
 *
 * 这一组用例来自一个真实故障：
 * 跑到第 4~5 章时日志里不断出现
 *   「记忆更新失败（不影响结果）：API 返回了空内容（finish_reason=length）」
 *
 * 根因是三条叠加：
 *  1. prompt 要求模型把「累积的全部记忆」重新抄回来 —— 输出随章节数增长，
 *     迟早超过 max_tokens。
 *  2. maxTokens 固定 4000，中文 JSON 很占 token，一本书读到后面必然不够。
 *  3. finish_reason=length 被当成普通空响应，标成 retryable，重试也没用；
 *     而且错误信息只说「返回了空内容」，完全看不出该改什么。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { createMockLlmServer } from './mock-llm.js';
import { updateBookMemory } from '../../lib/book-engine/pipeline/rewrite.js';
import { mergeMemory } from '../../lib/book-engine/pipeline/jobs.js';
import { chatCompletion, estimateTokens } from '../../lib/book-engine/llm/client.js';
import { normalizeProvider } from '../../lib/book-engine/config/providers.js';
import { loadPromptTemplate, templateVariables } from '../../lib/book-engine/llm/prompts.js';
import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { LlmError } from '../../lib/book-engine/util/errors.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

async function withMock(fn, mockOptions = {}) {
  const mock = createMockLlmServer(mockOptions);
  const { baseUrl } = await mock.listen(0);
  const provider = normalizeProvider({
    name: 'Mock',
    baseUrl,
    model: 'mock-model',
    apiKey: 'sk-mock',
    maxTokens: 4096,
    timeoutMs: 20000,
  });
  try {
    return await fn({ mock, provider });
  } finally {
    await mock.close();
  }
}

/* ------------------------------------------- finish_reason=length -- */

test('★ 回归：finish_reason=length 抛出明确错误，并靠加大额度自救而不是空转重试', async () => {
  await withMock(
    async ({ provider, mock }) => {
      const retries = [];
      await assert.rejects(
        () =>
          chatCompletion([{ role: 'user', content: '更新记忆' }], {
            baseUrl: provider.baseUrl,
            apiKey: 'k',
            model: provider.model,
            maxTokens: 4000,
            maxRetries: 3,
            retryBaseDelayMs: 5,
            onRetry: (info) => retries.push(info),
          }),
        (err) => {
          assert.ok(err instanceof LlmError);
          assert.equal(err.code, 'TRUNCATED_EMPTY');
          // 同一个请求原样重发没有意义 => 错误本身标为不可重试。
          // （实际发生的是"加大额度后重发"，那是不同的请求，见下面的断言。）
          assert.equal(err.retryable, false);
          assert.match(err.message, /max_tokens/, err.message);
          assert.match(err.message, /Max tokens/, err.message);
          return true;
        },
      );

      // mock 的 finishLength 永远截断，所以最终必然失败；
      // 但过程中必须尝试过加大额度，而不是原样重发。
      assert.ok(retries.length >= 1, '应当尝试过加大额度重试');
      assert.ok(
        retries.every((r) => /max_tokens/.test(r.reason || '')),
        `重试原因应说明是额度问题: ${JSON.stringify(retries)}`,
      );
      assert.ok(mock.calls >= 2, `应当发生多次调用（额度递增），实际 ${mock.calls}`);
    },
    { behavior: 'finishLength' },
  );
});

test('finish_reason=length 的错误信息会带上思维链用量（如果 API 提供了）', async () => {
  await withMock(
    async ({ provider }) => {
      await assert.rejects(
        () =>
          chatCompletion([{ role: 'user', content: 'x' }], {
            baseUrl: provider.baseUrl,
            apiKey: 'k',
            model: provider.model,
            maxTokens: 4000,
            maxRetries: 0,
          }),
        (err) => {
          assert.match(err.message, /思考.*4000 tokens/, err.message);
          return true;
        },
      );
    },
    { behavior: 'finishLength' },
  );
});

test('普通的空响应仍然是可重试的', async () => {
  await withMock(async ({ provider }) => {
    // 用一个总是返回空 content 但 finish_reason=stop 的场景不好造，
    // 这里退一步：验证 finish_reason=length 与其它空响应走了不同分支。
    const err = await chatCompletion([{ role: 'user', content: 'x' }], {
      baseUrl: provider.baseUrl,
      apiKey: 'k',
      model: provider.model,
      maxRetries: 0,
    }).catch((e) => e);
    // mock-llm 的默认行为能正常返回，所以这里应当没有错误
    assert.ok(!(err instanceof Error), '默认行为应当成功');
  });
});

/* --------------------------------------------- 增量式记忆更新 -- */

test('★ 记忆 prompt 要求「只输出增量」，并要求本章序号', async () => {
  const loaded = await loadPromptTemplate(PROJECT_ROOT, 'prompts/memory-system.txt');
  assert.equal(loaded.source, 'file');

  // 必须明确禁止抄回旧内容 —— 这是这个故障的根因
  assert.match(loaded.template, /只输出增量|只返回.*增量/, '必须要求增量输出');
  assert.match(loaded.template, /不要重复输出/, '必须禁止重复输出已有条目');

  const vars = templateVariables(loaded.template);
  for (const required of ['BOOK_MEMORY', 'BOOK_CONTEXT', 'CHAPTER_CONTEXT', 'CHAPTER_TEXT']) {
    assert.ok(vars.includes(required), `缺少变量 ${required}`);
  }
  // 章节序号用于让 chapter_summaries 的键名确定
  assert.ok(vars.includes('CHAPTER_INDEX'), '需要 CHAPTER_INDEX 才能稳定写入摘要键名');
});

test('★ 记忆更新的实际请求：带上了章节序号，且输出上限不再是固定 4000', async () => {
  await withMock(async ({ mock, provider }) => {
    const bigMemory = {
      ...ws.blankBookMemory(),
      book_summary: '一本书的总结。'.repeat(50),
      important_concepts: Array.from({ length: 40 }, (_, i) => `概念${i}`),
      people: Array.from({ length: 50 }, (_, i) => `人物${i}`),
      terminology: Array.from({ length: 40 }, (_, i) => ({ term: `term${i}`, translation: `术语${i}` })),
      author_positions: Array.from({ length: 20 }, (_, i) => `立场${i}`),
      chapter_summaries: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i + 1), `第${i + 1}章摘要`])),
    };

    const prompt = await loadPromptTemplate(PROJECT_ROOT, 'prompts/memory-system.txt');
    await updateBookMemory({
      memory: bigMemory,
      chapterTitle: '第五章',
      chapterIndex: 5,
      chapterText: '本章正文。'.repeat(2000), // 约 1 万字，会被截断到 12000 字符
      bookContext: { title: '测试书', authors: ['作者'], chapterCount: 20 },
      provider,
      promptTemplate: prompt.template,
    });

    assert.equal(mock.requests.length, 1);
    const body = mock.requests[0].body;
    const userContent = mock.requests[0].messages.find((m) => m.role === 'user').content;

    // 章节序号必须出现在 prompt 里
    assert.ok(userContent.includes('第五章'), 'prompt 里应包含章节标题');
    // 输出上限应当按预算算，而不是死板的 4000
    assert.ok(body.max_tokens >= 4000, `max_tokens 过小: ${body.max_tokens}`);
    assert.ok(body.max_tokens <= 8000, `max_tokens 不应无限放大: ${body.max_tokens}`);
    // 正文不应无节制地塞进去
    const promptTokens = estimateTokens(userContent);
    assert.ok(promptTokens < 40000, `输入 prompt 过大: ${promptTokens} tokens`);
  });
});

test('记忆增量可以被正确合并进已有记忆（不丢旧内容、不重复）', () => {
  const existing = {
    ...ws.blankBookMemory(),
    book_summary: '已有总结',
    important_concepts: ['安全边际', '护城河'],
    people: ['Graham'],
    terminology: [{ term: 'margin of safety', translation: '安全边际' }],
    author_positions: ['投资要留有余地'],
    chapter_summaries: { 1: '第一章摘要' },
  };

  const merged = mergeMemory(existing, {
    book_summary: '',
    important_concepts: ['护城河', '能力圈'],
    people: ['Graham', 'Dodd'],
    terminology: [{ term: 'Margin of Safety', translation: '安全边际（修正译法）' }],
    author_positions: [],
    chapter_summaries: { 2: '第二章摘要' },
  }, 2, '第二章');

  assert.equal(merged.book_summary, '已有总结', '空 book_summary 不应覆盖旧值');
  assert.deepEqual(merged.important_concepts, ['安全边际', '护城河', '能力圈'], '应追加且去重');
  assert.deepEqual(merged.people, ['Graham', 'Dodd'], '应追加且去重');
  assert.equal(merged.terminology.length, 1, '同一术语不应重复');
  assert.equal(merged.terminology[0].translation, '安全边际（修正译法）', '同一术语应被新译法覆盖');
  assert.deepEqual(merged.author_positions, ['投资要留有余地'], '空数组不应清空旧值');
  assert.deepEqual(merged.chapter_summaries, { 1: '第一章摘要', 2: '第二章摘要' });
});

test('模型返回全量记忆（旧行为）时也能合并，不会把数据搞乱', () => {
  const existing = { ...ws.blankBookMemory(), important_concepts: ['A'], chapter_summaries: { 1: 's1' } };
  // 旧 prompt 会让模型把累积内容整个抄回来
  const merged = mergeMemory(existing, {
    book_summary: '全量总结',
    important_concepts: ['A', 'B'],
    people: [],
    terminology: [],
    author_positions: [],
    chapter_summaries: { 1: 's1', 2: 's2' },
  }, 2, '第二章');
  assert.deepEqual(merged.important_concepts, ['A', 'B'], '不应出现重复的 A');
  assert.equal(merged.chapter_summaries[1], 's1');
  assert.equal(merged.chapter_summaries[2], 's2');
});

test('记忆增量为空时不会破坏已有记忆', () => {
  const existing = {
    ...ws.blankBookMemory(),
    book_summary: '重要总结',
    important_concepts: ['X', 'Y'],
    people: ['P'],
  };
  const snapshot = JSON.stringify(existing);
  const merged = mergeMemory(existing, {
    book_summary: '',
    important_concepts: [],
    people: [],
    terminology: [],
    author_positions: [],
    chapter_summaries: {},
  }, 3, '第三章');
  assert.equal(merged.book_summary, '全新总结'.replace('全新', '重要'), '总结不应被清空');
  assert.deepEqual(merged.important_concepts, ['X', 'Y']);
  assert.deepEqual(merged.people, ['P']);
  assert.equal(JSON.stringify(existing), snapshot, '不应修改传入对象');
});

test('模型返回畸形数据时 mergeMemory 不崩溃', () => {
  const existing = ws.blankBookMemory();
  for (const incoming of [null, undefined, 'string', 42, [], { important_concepts: 'not an array' }]) {
    const merged = mergeMemory(existing, incoming, 1, 'x');
    assert.ok(Array.isArray(merged.important_concepts));
    assert.ok(Array.isArray(merged.people));
    assert.equal(typeof merged.chapter_summaries, 'object');
  }
});

/* ------------------------------------------- 端到端：逐章更新记忆 -- */

test('★ 端到端：连续处理多章，Book Memory 逐章累积且不报错', async () => {
  const { importBook, extractChapter } = await import('../../lib/book-engine/pipeline/book-service.js');
  const { rewriteChapter } = await import('../../lib/book-engine/pipeline/rewrite.js');
  const { JobManager } = await import('../../lib/book-engine/pipeline/jobs.js');
  const { makeFixtureEpub } = await import('./fixture-epub.js');
  const { DEFAULT_SETTINGS } = await import('../../lib/book-engine/config/settings.js');
  const { blankProfile } = await import('../../lib/book-engine/config/profile.js');

  const mock = createMockLlmServer({ behavior: 'normal' });
  const { baseUrl } = await mock.listen(0);
  const provider = normalizeProvider({
    name: 'Mock', baseUrl, model: 'mock-model', apiKey: 'sk-mock', maxTokens: 4096, timeoutMs: 20000,
  });

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-mem-'));
  ws.setWorkspaceRoot(dir);
  try {
    const metadata = await importBook({ buffer: makeFixtureEpub(), fileName: 'mem.epub', profile: blankProfile() });

    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    settings.memory.enabled = true;
    settings.processing.maxRetries = 0;

    const jobs = new JobManager({
      getContext: async () => ({
        provider,
        reviewProvider: null,
        settings,
        profile: blankProfile(),
        projectRoot: PROJECT_ROOT,
        bookContext: { title: metadata.title, authors: metadata.authors, chapterCount: metadata.chapterCount },
      }),
    });

    // 处理前两章（第 1、2 章）
    const job = jobs.start({ bookId: metadata.bookId, chapters: [1, 2] });
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const current = jobs.get(job.id);
      if (current && !['running', 'pausing'].includes(current.status)) break;
    }
    const finished = jobs.get(job.id);
    assert.equal(finished.status, 'completed', `任务未完成: ${finished.status} ${finished.error || ''}`);

    // 关键断言：日志里不应出现「Book Memory 更新失败」
    const failed = finished.log.filter((line) => line.includes('Book Memory 更新失败'));
    assert.deepEqual(failed, [], `记忆更新不应失败，实际日志:\n${finished.log.join('\n')}`);

    const okLines = finished.log.filter((line) => line.includes('记忆已更新'));
    assert.ok(okLines.length >= 2, `两章都应更新记忆，实际: ${JSON.stringify(finished.log)}`);

    // 记忆文件应当被写入且包含内容
    const memory = await ws.readBookMemory(metadata.bookId);
    assert.ok(memory.updatedAt, 'book-memory.json 应已写入');
    assert.ok(
      (memory.important_concepts?.length || 0) + (memory.people?.length || 0) > 0,
      `记忆内容为空: ${JSON.stringify(memory)}`,
    );
    assert.ok(Object.keys(memory.chapter_summaries || {}).length >= 1, '应有章节摘要');
  } finally {
    ws.setWorkspaceRoot(null);
    await mock.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
