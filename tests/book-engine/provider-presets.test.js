/**
 * 服务商预设的回归测试。
 *
 * 重点是「Base URL 只写到 /v1，由客户端补 /chat/completions」这个约定：
 * SuperGPT 的文档明确写了客户端自动补 /v1 时只填域名，而本项目会把
 * Base URL 拼成 `<base>/chat/completions`，所以预设里必须带 /v1。
 * 写错会得到 /v1/v1/chat/completions 或 404，用户点「测试」只会看到
 * 连接失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDER_PRESETS } from '../../lib/book-engine/config/providers.js';
import { buildChatUrl } from '../../lib/book-engine/llm/client.js';

test('SuperGPT 预设：OpenAI 兼容地址与默认模型', () => {
  const preset = PROVIDER_PRESETS.find((p) => p.id === 'supergpt');
  assert.ok(preset, 'SuperGPT 预设应存在');
  assert.equal(preset.name, 'SuperGPT');
  assert.equal(preset.baseUrl, 'https://api.supergpt.dev/v1');
  assert.equal(preset.model, 'gpt-5.6-terra');
});

test('SuperGPT 预设的 Base URL 拼出 /v1/chat/completions，不会重复 /v1', () => {
  const preset = PROVIDER_PRESETS.find((p) => p.id === 'supergpt');
  assert.equal(buildChatUrl(preset.baseUrl), 'https://api.supergpt.dev/v1/chat/completions');
});

test('预设 id 不重复', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});
