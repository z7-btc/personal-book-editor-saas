/**
 * 图片说明（image notes）：改写前「先看懂图」的那一步。
 *
 * 验收点：
 *  - 有视觉模型时，每张图拿到一段说明；
 *  - 同一张图第二次不再请求（按书缓存）；
 *  - 模型明确说不支持图片时，退回图注、不抛错、后面的图也不再挨个撞 400；
 *  - maxPerBook / maxBytes 真的能兜住成本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createMockLlmServer } from './mock-llm.js';
import { makeImageFixtureEpub } from './fixture-epub.js';
import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook, extractChapter } from '../../lib/book-engine/pipeline/book-service.js';
import { buildChapterImageNotes, resetVisionSupportCache, readImageNotes } from '../../lib/book-engine/pipeline/image-notes.js';
import { DEFAULT_SETTINGS } from '../../lib/book-engine/config/settings.js';
import { normalizeProvider } from '../../lib/book-engine/config/providers.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';

async function withMock(fn, mockOptions = {}) {
  resetVisionSupportCache();
  const mock = createMockLlmServer(mockOptions);
  const { baseUrl } = await mock.listen(0);
  const provider = normalizeProvider({
    name: 'Mock Vision',
    baseUrl,
    model: 'mock-vision',
    apiKey: 'sk-mock',
    maxTokens: 400,
    timeoutMs: 20000,
    presetId: 'custom',
  });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-image-notes-'));
  ws.setWorkspaceRoot(dir);
  try {
    return await fn({ mock, provider, dir });
  } finally {
    ws.setWorkspaceRoot(null);
    await mock.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function settingsWith(images = {}) {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    images: { ...DEFAULT_SETTINGS.images, ...images },
  };
}

async function setupBook() {
  const metadata = await importBook({ buffer: makeImageFixtureEpub(), fileName: 'images.epub', profile: blankProfile() });
  await extractChapter(metadata.bookId, 1);
  const chapter = metadata.chapters.find((c) => c.index === 1);
  const xhtml = await ws.readChapterOriginal(metadata.bookId, 1);
  return { bookId: metadata.bookId, chapterHref: chapter.href, xhtml };
}

test('每张图都有说明，第二次直接读缓存、不再请求', async () => {
  await withMock(async ({ mock, provider }) => {
    const { bookId, chapterHref, xhtml } = await setupBook();
    const first = await buildChapterImageNotes({
      bookId,
      chapterHref,
      xhtml,
      provider,
      settings: settingsWith(),
    });

    assert.equal(first.images.length, 4);
    assert.equal(first.stats.described, 4);
    assert.equal(first.stats.visionCalls, 4);
    assert.equal(first.stats.failed, 0);
    for (const image of first.images) {
      assert.match(image.description, /（mock 识图）/, `说明应由视觉模型生成: ${image.description}`);
      assert.equal(image.source, 'vision');
    }
    // 请求里必须真的带了图片，而不是只发文字
    const visionRequest = mock.requests.find((r) => Array.isArray(r.messages.find((m) => m.role === 'user')?.content));
    assert.ok(visionRequest, '应发出带图片内容的请求');
    const parts = visionRequest.messages.find((m) => m.role === 'user').content;
    const imagePart = parts.find((p) => p.type === 'image_url');
    assert.match(imagePart.image_url.url, /^data:image\/jpeg;base64,/, '图片应以 data URL 内联发送');

    const callsAfterFirst = mock.calls;
    const second = await buildChapterImageNotes({
      bookId,
      chapterHref,
      xhtml,
      provider,
      settings: settingsWith(),
    });
    assert.equal(second.stats.fromCache, 4, '四张图都应命中缓存');
    assert.equal(second.stats.described, 0);
    assert.equal(second.stats.visionCalls, 0);
    assert.equal(mock.calls, callsAfterFirst, '第二次不应再发任何请求');
    assert.deepEqual(
      second.images.map((i) => i.description),
      first.images.map((i) => i.description),
      '缓存里的说明必须和第一次一致',
    );
  });
});

test('模型不支持图片（400）时退回图注，不抛错，也不逐张重试', async () => {
  await withMock(
    async ({ mock, provider }) => {
      const { bookId, chapterHref, xhtml } = await setupBook();
      const result = await buildChapterImageNotes({
        bookId,
        chapterHref,
        xhtml,
        provider,
        settings: settingsWith(),
      });

      assert.equal(result.images.length, 4);
      assert.equal(result.stats.failed, 1, '只需要第一张确认「不支持」');
      assert.equal(result.stats.captionFallback, 3);
      assert.equal(result.stats.described, 0);
      assert.equal(mock.calls, 1, '确认不支持后，后面的图不应再撞 400');
      assert.match(result.images[0].description, /^图注：表6-1/, '应退回图注');
      assert.ok(result.images[0].error, '失败原因要记下来');

      const callsAfter = mock.calls;
      const again = await buildChapterImageNotes({
        bookId,
        chapterHref,
        xhtml,
        provider,
        settings: settingsWith(),
      });
      assert.equal(again.stats.failed, 0, '失败结果已缓存，第二次不再算失败');
      assert.equal(mock.calls, callsAfter, '第二次不应再发请求');
      assert.match(again.images[0].description, /^图注：表6-1/);
    },
    { behavior: 'rejectVision' },
  );
});

test('maxPerBook 限制真能兜住成本：超出的图只用图注', async () => {
  await withMock(async ({ mock, provider }) => {
    const { bookId, chapterHref, xhtml } = await setupBook();
    const result = await buildChapterImageNotes({
      bookId,
      chapterHref,
      xhtml,
      provider,
      settings: settingsWith({ maxPerBook: 1 }),
    });

    assert.equal(result.stats.described, 1);
    assert.equal(result.stats.captionFallback, 3);
    assert.equal(mock.calls, 1);
    assert.equal(result.images.filter((i) => i.source === 'vision').length, 1);
  });
});

test('maxBytes 超限的图不送模型，直接用图注', async () => {
  await withMock(async ({ mock, provider }) => {
    const { bookId, chapterHref, xhtml } = await setupBook();
    const result = await buildChapterImageNotes({
      bookId,
      chapterHref,
      xhtml,
      provider,
      settings: settingsWith({ maxBytes: 1024 }),
    });

    // 三个 2KB 的假 JPEG 被跳过；公式图（1x1 PNG）仍然识别
    assert.equal(result.stats.failed, 3);
    assert.equal(result.stats.described, 1);
    assert.equal(mock.calls, 1);
    assert.match(result.images[0].error, /超过/);
    assert.match(result.images[0].description, /^图注：表6-1/);
  });
});

test('describe=false 时完全不调用视觉模型', async () => {
  await withMock(async ({ mock, provider }) => {
    const { bookId, chapterHref, xhtml } = await setupBook();
    const result = await buildChapterImageNotes({
      bookId,
      chapterHref,
      xhtml,
      provider,
      settings: settingsWith({ describe: false }),
    });

    assert.equal(mock.calls, 0);
    assert.equal(result.stats.described, 0);
    assert.equal(result.stats.captionFallback, 4);
    assert.match(result.images[0].description, /^图注：表6-1/);
    assert.equal(result.images[2].description, '（没有图注，图片内容未识别）', '没有图注的公式图要明说没识别');
  });
});

test('★ 回归：暂停时已经成功的识图结果先落盘，恢复后不重复收费', async () => {
  await withMock(async ({ mock, provider }) => {
    const { bookId, chapterHref, xhtml } = await setupBook();
    const controller = new AbortController();

    await assert.rejects(
      () =>
        buildChapterImageNotes({
          bookId,
          chapterHref,
          xhtml,
          provider,
          settings: settingsWith(),
          signal: controller.signal,
          onProgress: (info) => {
            // 第一张已经识别成功；第二张开始前暂停
            if (info.image === 2) controller.abort();
          },
        }),
      (err) => err?.code === 'ABORTED' || err?.name === 'AbortedError',
      '暂停应当抛出 AbortedError',
    );

    assert.equal(mock.calls, 1, '确认暂停后不应再发第二张的请求');
    const cache = await readImageNotes(bookId);
    const visionEntries = Object.values(cache).filter((entry) => entry.source === 'vision');
    assert.equal(visionEntries.length, 1, '中断前已成功的说明必须落盘，否则恢复后重复收费');
    assert.ok(visionEntries[0].description.includes('mock 识图'));
  });
});

test('★ 回归：临时失败（空说明 / 超时 / 5xx）不写长期缓存，换 Provider 后会重新识别', async () => {
  await withMock(async ({ mock, provider }) => {
    const { bookId, chapterHref, xhtml } = await setupBook();

    // visionEmpty：请求成功但模型没给出说明 —— 典型的临时失败
    mock.setBehavior('visionEmpty');
    const first = await buildChapterImageNotes({
      bookId,
      chapterHref,
      xhtml,
      provider,
      settings: settingsWith(),
    });
    assert.equal(first.stats.failed, 4);
    assert.equal(first.stats.described, 0);
    assert.deepEqual(await readImageNotes(bookId), {}, '临时失败不许写进长期缓存');

    // 换好模型之后必须真的重新识图，而不是继续吃上一次的图注兜底
    mock.setBehavior('normal');
    const second = await buildChapterImageNotes({
      bookId,
      chapterHref,
      xhtml,
      provider,
      settings: settingsWith(),
    });
    assert.equal(second.stats.described, 4, '临时失败后必须能重试');
    const cache = await readImageNotes(bookId);
    assert.equal(Object.values(cache).filter((entry) => entry.source === 'vision').length, 4);
  });
});
