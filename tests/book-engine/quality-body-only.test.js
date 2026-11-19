/**
 * 回归：质量检查的「原文」必须是正文，不能把 <head> 里的 <style> 也算进去。
 *
 * 真实案例（2026-11-17，《朝花夕拾》维基文库版）：
 * 每个 XHTML 的 <head> 里都有一大段内联 CSS（`.mw-parser-output{...}`、
 * `width:100%`、`#8888aa`、`5px`…）。`collectText(doc)` 取的是
 * `documentElement.textContent`，CSS 里的数字被当成「原文数字」，
 * 而改写后的文本只从 <body> 抽 —— 于是每一章都判「数字丢失 11 个」，
 * 6 章全部 fail、自动重试一轮后放弃，成品里这些章还是原文。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createMockLlmServer } from './mock-llm.js';
import { rewriteChapter } from '../../lib/book-engine/pipeline/rewrite.js';
import { normalizeProvider } from '../../lib/book-engine/config/providers.js';
import { DEFAULT_SETTINGS } from '../../lib/book-engine/config/settings.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

test('回归：<head> 里的 CSS 不算正文，数字检查只比 body', async () => {
  const mock = createMockLlmServer({ behavior: 'normal' });
  const { baseUrl } = await mock.listen(0);
  try {
    const provider = normalizeProvider({
      name: 'Mock',
      baseUrl,
      model: 'mock-model',
      apiKey: 'sk-mock',
      maxTokens: 4096,
      temperature: 0.2,
      timeoutMs: 20000,
    });
    const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>测试</title>
<style type="text/css">.x{width:100%;border:2px solid #8888aa;margin:5px;padding:1em}</style>
</head><body>
<h1>第一章</h1>
<p>1949 年，他在第 42 页写下这句话，共 3 个例子。</p>
<p>这是第二段，提到 1998 年的数据。</p>
</body></html>`;

    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    settings.memory.enabled = false;

    const result = await rewriteChapter({
      xhtml,
      provider,
      profile: blankProfile(),
      settings,
      projectRoot: PROJECT_ROOT,
    });

    const m = result.quality.metrics;
    /**
     * 正文里只有 1949 / 42 / 3 / 1998 四个数字，但年份会同时命中
     * 「年份」和「普通数字」两条规则，所以 token 计数是 6（1949年 + 1949、
     * 1998年 + 1998）—— 这是 extractNumberTokens 既有的口径，不是本次要改的东西。
     * 关键是：CSS 里的 100、2、5、1 一个都不能进来。
     */
    assert.equal(m.numberTokens, 6, `数字 token 只该来自正文，实际 ${m.numberTokens}`);
    assert.equal(m.numberKeepRatio, 1, '正文数字一个都没丢，保留率必须是 1');
    assert.notEqual(result.quality.verdict, 'fail', `不该判 fail：${JSON.stringify(result.quality.issues)}`);
  } finally {
    await mock.close();
  }
});
