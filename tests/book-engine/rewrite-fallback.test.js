/**
 * 「缺段补写」的成本测试。
 *
 * 背景是一次真实的开销事故：用新提示词跑一个 16k 字的整章时，
 * 整块调用没有按 `【段 N】` 格式输出，于是走了**逐段回退** ——
 * 一个 91 段的块变成 30 多次请求，每次都要带上完整的 system prompt
 * 和读者画像。那一章最终烧掉 **433,651 输入 token**、耗时 225 秒，
 * 而界面上只显示「已完成」，从外面完全看不出来。
 *
 * 修法：缺段时先用**一次小而聚焦的整批请求**补齐，补不齐才逐段。
 * 这里用「数请求次数」把这个成本钉死 —— 不看次数的话，
 * 这种退化会一直悄悄烧钱。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { rewriteChunk } from '../../lib/book-engine/pipeline/rewrite.js';

/** 一个只服务本用例的假模型：按脚本回应，并记录每次收到的段数。 */
async function startScriptedServer(script) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const user = body.messages?.find((m) => m.role === 'user')?.content || '';
    const segCount = (user.match(/【段 \d+】/g) || []).length;
    calls.push(segCount);
    const text = script(segCount, calls.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'x',
        object: 'chat.completion',
        model: 'scripted',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

const CHUNK = {
  index: 0,
  blockTexts: ['甲段原文', '乙段原文', '丙段原文', '丁段原文'],
  blocks: [],
  marksByBlock: [],
};

function chunkArgs(baseUrl) {
  return {
    chunk: CHUNK,
    chunkSource: '【段 1】甲段原文\n\n【段 2】乙段原文\n\n【段 3】丙段原文\n\n【段 4】丁段原文',
    systemPrompt: '你是改写器。',
    userTemplate: '{{CHAPTER_CONTEXT}}\n\n{{SOURCE_TEXT}}',
    provider: {
      baseUrl,
      apiKey: 'sk-test',
      model: 'scripted',
      maxTokens: 4096,
      temperature: 0,
      timeoutMs: 10000,
    },
    readerProfileBlock: '（测试画像）',
    bookContext: '（测试）',
    chapterContext: '（测试章节）',
    previousContext: '（无）',
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
}

test('★ 缺段时先用一次整批补写，不是一上来就逐段（成本差 30 倍）', async () => {
  const server = await startScriptedServer((segCount, callNo) => {
    if (callNo === 1) return '【段 1】甲段改写。'; // 只给 1 段，缺 3 段
    // 第二次请求只带缺的那 3 段（编号被重排成 1..3）
    assert.equal(segCount, 3, `第二次请求应该只带缺的 3 段，实际 ${segCount}`);
    return '【段 1】乙段改写。\n\n【段 2】丙段改写。\n\n【段 3】丁段改写。';
  });
  try {
    const r = await rewriteChunk(chunkArgs(server.baseUrl));
    assert.equal(server.calls.length, 2, `应当只发 2 次请求，实际 ${server.calls.length} 次`);
    assert.equal(r.attempts, 2);
    assert.deepEqual(r.segmentTexts, {
      0: '甲段改写。',
      1: '乙段改写。',
      2: '丙段改写。',
      3: '丁段改写。',
    });
  } finally {
    await server.close();
  }
});

test('整批也补不齐时才逐段补，剩下的几段就发几次', async () => {
  const server = await startScriptedServer((segCount, callNo) => {
    if (callNo === 1) return '【段 1】甲段改写。';
    if (callNo === 2) return '【段 1】乙段改写。'; // 整批只补回 1 段
    return `【段 1】第 ${callNo} 次补写的段落。`; // 剩下 2 段逐段补
  });
  try {
    const r = await rewriteChunk(chunkArgs(server.baseUrl));
    // 1 次整块 + 1 次整批 + 2 次逐段 = 4
    assert.equal(server.calls.length, 4, `实际发了 ${server.calls.length} 次：${server.calls.join(',')}`);
    assert.ok(r.segmentTexts[0] && r.segmentTexts[1] && r.segmentTexts[2] && r.segmentTexts[3], '四段都要补齐');
  } finally {
    await server.close();
  }
});

test('整块一次就返回全部段落时，只发一次请求（不触发任何回退）', async () => {
  const server = await startScriptedServer(
    () => '【段 1】甲。\n\n【段 2】乙。\n\n【段 3】丙。\n\n【段 4】丁。',
  );
  try {
    const r = await rewriteChunk(chunkArgs(server.baseUrl));
    assert.equal(server.calls.length, 1, '正常路径就该只有一次调用');
    assert.equal(r.attempts, 1);
  } finally {
    await server.close();
  }
});
