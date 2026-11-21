/**
 * ★ 图片感知改写：模型看得到图，图与图注原地不动。
 *
 * 用「图片密集」的样书跑完整链路：
 *   extractChapter -> buildChapterImageNotes（视觉模型）-> rewriteChapter -> 检查成品
 *
 * 验收点（对应 DonMark 的反馈）：
 *  - 改写请求里真的有图片说明，模型知道「这里那张表说的是什么」；
 *  - 图注文本一个字都没变；
 *  - 图片顺序、数量、位置（所在的段落）都没变；
 *  - 正文里的「见表6-1」这类图号引用照原样保留。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createMockLlmServer } from './mock-llm.js';
import { makeImageFixtureEpub } from './fixture-epub.js';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook, extractChapter } from '../../lib/book-engine/pipeline/book-service.js';
import { rewriteChapter } from '../../lib/book-engine/pipeline/rewrite.js';
import { buildChapterImageNotes, resetVisionSupportCache } from '../../lib/book-engine/pipeline/image-notes.js';
import { DEFAULT_SETTINGS } from '../../lib/book-engine/config/settings.js';
import { normalizeProvider } from '../../lib/book-engine/config/providers.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

async function withMock(fn) {
  resetVisionSupportCache();
  const mock = createMockLlmServer();
  const { baseUrl } = await mock.listen(0);
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-image-rewrite-'));
  ws.setWorkspaceRoot(dir);
  try {
    return await fn({ mock, provider });
  } finally {
    ws.setWorkspaceRoot(null);
    await mock.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function settingsWith() {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    processing: {
      ...DEFAULT_SETTINGS.processing,
      targetCharsPerChunk: 5000,
      maxCharsPerChunk: 9000,
      explainPass: false,
      maxRetries: 0,
    },
    memory: { ...DEFAULT_SETTINGS.memory, enabled: false },
    review: { ...DEFAULT_SETTINGS.review, enabled: false },
  };
}

function imgSrcs(doc) {
  return doc.documentElement
    .descendants()
    .filter((el) => el.name === 'img')
    .map((el) => el.getAttribute('src'));
}

test('★ 改写时模型能看到图片说明，图注与图片顺序原样保留', async () => {
  await withMock(async ({ mock, provider }) => {
    const metadata = await importBook({
      buffer: makeImageFixtureEpub(),
      fileName: 'image-rewrite.epub',
      profile: blankProfile(),
    });
    const chapter = metadata.chapters.find((c) => c.index === 1);
    const extraction = await extractChapter(metadata.bookId, 1);

    assert.equal(extraction.status.imageCount, 4, '提取阶段就要数清 4 张图');
    assert.equal(extraction.status.preservedCaptionBlocks, 2, '表图注 + 插图图注');
    assert.equal(extraction.status.preservedImageBlocks, 1, '整页公式图');

    const originalXhtml = await ws.readChapterOriginal(metadata.bookId, 1);
    const originalImgs = imgSrcs(parseXml(originalXhtml));

    const notes = await buildChapterImageNotes({
      bookId: metadata.bookId,
      chapterHref: chapter.href,
      xhtml: originalXhtml,
      provider,
      settings: settingsWith(),
    });
    assert.equal(notes.stats.described, 4);

    const result = await rewriteChapter({
      xhtml: originalXhtml,
      provider,
      profile: blankProfile(),
      settings: settingsWith(),
      projectRoot: PROJECT_ROOT,
      chapterTitle: chapter.title,
      chapterHref: chapter.href,
      chapterImages: notes.images,
    });

    assert.equal(result.chunks.length, extraction.chunks.length, '提取与改写必须用同一套块过滤，chunk 数要一致');
    assert.deepEqual(result.images, {
      total: 4,
      described: 4,
      preservedCaptionBlocks: 2,
      preservedImageBlocks: 1,
    });

    // ---- 提示词：图片说明必须真的发给了改写模型 ----
    const rewriteReqs = mock.requests.filter((r) => {
      const content = r.messages.find((m) => m.role === 'user')?.content;
      return typeof content === 'string' && content.includes('【段 1】');
    });
    assert.ok(rewriteReqs.length >= 1, '应有改写请求');
    const userPrompt = rewriteReqs[0].messages.find((m) => m.role === 'user').content;
    assert.match(userPrompt, /本章相关图片/, '提示词里要有图片说明一节');
    assert.match(userPrompt, /（mock 识图）/, '图片说明要来自视觉模型');
    assert.match(userPrompt, /【段 \d+】⟦\d+⟧：/, '图片说明要绑定到段号与占位符');
    assert.match(userPrompt, /表6-1/, '正文提到的图号要在说明里对上');

    // ---- 成品：图注一个字不变 ----
    assert.ok(result.xhtml.includes('表6-1 各年收益率（1927—1932）'), '表图注必须原样保留');
    assert.ok(result.xhtml.includes('图0-1 1927—1932 年收益率走势'), '插图图注必须原样保留');

    // ---- 成品：图片数量、顺序、所在段落都不变 ----
    const outDoc = parseXml(result.xhtml);
    assert.deepEqual(imgSrcs(outDoc), originalImgs, '图片顺序与路径必须与原文一致');

    const p5 = outDoc.documentElement
      .descendants()
      .find((el) => el.name === 'p' && el.getAttribute('id') === 'p5');
    assert.ok(p5, '正文段落不能消失');
    const imgsInP5 = p5.descendants().filter((el) => el.name === 'img');
    assert.equal(imgsInP5.length, 1, '行内图片必须还在原来那一段里');
    assert.equal(imgsInP5[0].getAttribute('src'), '../images/inline02.jpg');
    assert.match(p5.textContent, /随后缓慢回升/, '那一段的正文也还在');
  });
});
