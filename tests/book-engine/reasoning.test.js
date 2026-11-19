/**
 * 推理模型（思考模式）相关的回归测试。
 *
 * 真实故障：用户配好 DeepSeek（deepseek-flash，密钥正确）后点「测试」，
 * 报错「模型在输出第一个字之前就撞上了 max_tokens 上限」。
 *
 * 根因：deepseek-flash 是推理模型，默认会先输出思维链，
 * 而思维链 token 也算在 max_tokens 里。连通性测试只给了 32，
 * 额度被思考吃光，正文一个字都没输出 -> finish_reason=length。
 * 密钥是对的，模型也是对的，纯粹是我给的额度不够。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockLlmServer } from './mock-llm.js';
import { chatCompletion, testProvider, buildRequestBody } from '../../lib/book-engine/llm/client.js';
import { normalizeProvider, normalizeReasoningEffort, REASONING_EFFORTS, maskProvider } from '../../lib/book-engine/config/providers.js';

async function withMock(fn, mockOptions = {}) {
  const mock = createMockLlmServer(mockOptions);
  const { baseUrl } = await mock.listen(0);
  const provider = normalizeProvider({
    name: 'Mock', baseUrl, model: 'mock-model', apiKey: 'sk-mock', timeoutMs: 20000,
  });
  try {
    return await fn({ mock, provider });
  } finally {
    await mock.close();
  }
}

/* ------------------------------------------------- 请求体构造 -- */

test('buildRequestBody 只在需要时带上 reasoning_effort 与 max_tokens', () => {
  const base = { model: 'm', temperature: 0.3 };

  const withAll = buildRequestBody([{ role: 'user', content: 'x' }], {
    ...base, maxTokens: 100, reasoningEffort: 'none',
  });
  assert.equal(withAll.max_tokens, 100);
  assert.equal(withAll.reasoning_effort, 'none');
  assert.equal(withAll.stream, false);

  // 空字符串 = 不干预，用服务端默认，不要往请求里塞空值
  const noEffort = buildRequestBody([{ role: 'user', content: 'x' }], { ...base, reasoningEffort: '' });
  assert.ok(!('reasoning_effort' in noEffort), '空档位不应出现在请求体里');

  const noMax = buildRequestBody([{ role: 'user', content: 'x' }], base);
  assert.ok(!('max_tokens' in noMax));

  // top_p = 1 是默认值，没必要发
  assert.ok(!('top_p' in buildRequestBody([{ role: 'user', content: 'x' }], { ...base, topP: 1 })));
  assert.equal(buildRequestBody([{ role: 'user', content: 'x' }], { ...base, topP: 0.5 }).top_p, 0.5);
});

/* --------------------------------------------- reasoningEffort 配置 -- */

test('reasoningEffort 默认关闭，非法值退回 none', () => {
  assert.equal(normalizeProvider({ name: 'a' }).reasoningEffort, 'none', '默认必须关闭思考');
  assert.equal(normalizeReasoningEffort(undefined), 'none');
  assert.equal(normalizeReasoningEffort(''), '');
  assert.equal(normalizeReasoningEffort('HIGH'), 'high');
  assert.equal(normalizeReasoningEffort('乱写的'), 'none');
  assert.equal(normalizeReasoningEffort(null), 'none');
  for (const v of REASONING_EFFORTS) {
    assert.equal(normalizeReasoningEffort(v), v);
  }
  // 必须能透出到前端
  assert.equal(maskProvider(normalizeProvider({ name: 'a', reasoningEffort: 'low' })).reasoningEffort, 'low');
});

/* --------------------------------------------------- 连通性测试 -- */

test('★ 回归：推理模型在旧实现下会"连接失败"，现在必须成功', async () => {
  await withMock(
    async ({ provider, mock }) => {
      // 现实中 max_tokens=32 时推理模型必然失败（mock 会模拟这个行为）
      const tinyBudget = await chatCompletion([{ role: 'user', content: '你好' }], {
        baseUrl: provider.baseUrl, apiKey: 'k', model: provider.model,
        maxTokens: 32, reasoningEffort: 'none', maxRetries: 0,
      }).catch((e) => e);
      assert.ok(tinyBudget instanceof Error, '额度不够时应当报错（这就是用户看到的现象）');

      // 走正式测试通道：必须成功
      const result = await testProvider(provider);
      assert.equal(result.ok, true);
      assert.ok(result.sample.length > 0, `应当拿到内容，实际 sample=${JSON.stringify(result.sample)}`);
      assert.ok(result.usage.totalTokens > 0);
      assert.ok(mock.calls >= 1);
    },
    { behavior: 'reasoningModel' },
  );
});

test('★ 回归：max_tokens 不足时自动加倍重试，而不是直接失败', async () => {
  await withMock(
    async ({ provider }) => {
      const retries = [];
      // 思考要烧 1200，初始额度 512 —— 必须靠自动加倍救回来
      const result = await chatCompletion([{ role: 'user', content: '你好' }], {
        baseUrl: provider.baseUrl, apiKey: 'k', model: provider.model,
        maxTokens: 512, reasoningEffort: 'none', maxRetries: 3,
        retryBaseDelayMs: 5,
        onRetry: (info) => retries.push(info),
      });
      assert.equal(result.text, '可用');
      assert.ok(retries.some((r) => /max_tokens/.test(r.reason || '')), `应当说明是额度问题: ${JSON.stringify(retries)}`);
    },
    { behavior: 'reasoningModel' },
  );
});

test('服务端不认识 reasoning_effort 时自动去掉该参数重试', async () => {
  await withMock(
    async ({ provider }) => {
      const retries = [];
      const result = await chatCompletion([{ role: 'user', content: '你好' }], {
        baseUrl: provider.baseUrl, apiKey: 'k', model: provider.model,
        maxTokens: 512, reasoningEffort: 'none', maxRetries: 2,
        retryBaseDelayMs: 5,
        onRetry: (info) => retries.push(info),
      });
      assert.ok(result.text.length > 0, '去掉参数后应当拿到内容');
      assert.ok(retries.some((r) => /reasoning_effort/.test(r.reason || '')), JSON.stringify(retries));
    },
    { behavior: 'rejectsReasoningEffort' },
  );
});

test('连通性测试会回报实际生效的思考档位', async () => {
  await withMock(
    async ({ provider }) => {
      const result = await testProvider(provider);
      assert.ok(typeof result.reasoningEffort === 'string');
      assert.ok(result.reasoningEffort.length > 0);
    },
    { behavior: 'reasoningModelCheap' },
  );
});

test('思考开销不大的模型：测试走正常路径，不被降级逻辑干扰', async () => {
  await withMock(
    async ({ provider, mock }) => {
      // reasoningModelCheap 只烧 64 tokens，2048 的额度完全够
      const result = await testProvider(provider);
      assert.equal(result.ok, true);
      assert.equal(result.sample, '可用');
      assert.equal(mock.calls, 1, '不应该发生第二次调用');
    },
    { behavior: 'reasoningModelCheap' },
  );
});
