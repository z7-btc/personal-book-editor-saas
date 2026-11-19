/**
 * 章节分类测试。
 *
 * 来自真实用户反馈：他导入《证券分析》后看到
 *   - 「证券分析（上）」「证券分析（下）」显示 0 字
 *   - 「text00001」「text00026」「text00027」这种文件名当标题
 *   - 不知道这些要不要处理、会怎么处理
 *
 * 查了原书才发现：spine 里 28 个文件并不都是「章节」——
 * 有 3 个是整页插图（正文只有 <div><img></div>，一个字都没有），
 * 有 1 个是「扫码获取 App」的图片提示页，
 * 另有 4 个文件在 NCX 目录里根本没有条目，所以标题只能回退成文件名。
 *
 * 这个文件锁定三件事：
 *   1. 纯图片页 / 提示页被正确识别，不进 AI 队列（省调用，也避免模型往
 *      只有图片的页面里塞文字）
 *   2. 没有 TOC 标题的章节能从正文推断出人能看懂的标题
 *   3. 老书（没有这些字段）会被自动升级，不需要用户重新导入
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import {
  analyzeChapterDocument,
  inferChapterTitle,
  isRewritable,
  noTextReason,
} from '../../lib/book-engine/epub/chapter-info.js';
import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook } from '../../lib/book-engine/pipeline/book-service.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';
import { makeFixtureEpub } from './fixture-epub.js';

function analyze(xhtml) {
  return analyzeChapterDocument(parseXml(xhtml));
}

/* ------------------------------------------------------ 分类判定 -- */

test('正常正文页被识别为 content', () => {
  const info = analyze(
    '<html><body><h1>第一章</h1><p>' + '这是一段足够长的正文内容。'.repeat(20) + '</p></body></html>',
  );
  assert.equal(info.kind, 'content');
  assert.equal(isRewritable(info.kind), true);
  assert.equal(noTextReason(info.kind), null);
});

test('★ 整页插图页被识别为 image-only（正文里一个字都没有）', () => {
  // 这就是《证券分析》里「证券分析（上）」的真实结构
  const info = analyze(
    '<html><body><div id="x" class="chatu_img"><img src="Image00002.jpg" style="height:800px;" alt=""/></div></body></html>',
  );
  assert.equal(info.kind, 'image-only');
  assert.equal(info.textLength, 0);
  assert.equal(info.imageCount, 1);
  assert.equal(isRewritable(info.kind), false, '整页图片不该进 AI 队列');
  assert.match(noTextReason(info.kind), /整页图片/);
});

test('★ 扫码／关注之类的图片提示页被识别为 prompt', () => {
  const info = analyze(
    '<html><body><div class="chatu_img"><img src="q.jpg"/>' +
      '<p class="tuti">扫码获取“湛庐阅读”App，搜索“证券分析”</p></div></body></html>',
  );
  assert.equal(info.kind, 'prompt');
  assert.equal(isRewritable(info.kind), false, '扫码页不是书的内容，不该改写');
  assert.match(noTextReason(info.kind), /扫码/);
});

test('空白页被识别为 empty，且不算可改写', () => {
  const info = analyze('<html><body><div>\r\n</div></body></html>');
  assert.ok(['empty', 'image-only'].includes(info.kind), `实际 ${info.kind}`);
  assert.equal(isRewritable(info.kind), false);
});

test('短引文页被识别为 tiny，仍然可改写', () => {
  // 「现在已然衰朽者，将来可能重放异彩。」这类献词页
  const info = analyze(
    '<html><body><p class="poem"><b>现在已然衰朽者，将来可能重放异彩。</b></p>' +
      '<p class="bodyContent"><b>贺拉斯《诗艺》</b></p></body></html>',
  );
  assert.equal(info.kind, 'tiny');
  assert.equal(isRewritable(info.kind), true, '短页也是正文，应该处理');
});

test('只有空白 div、没有图片的页面不会被误判为可改写', () => {
  const info = analyze('<html><body><div>   </div><div>\n\n</div></body></html>');
  assert.equal(isRewritable(info.kind), false);
});

/* ------------------------------------------------------ 标题推断 -- */

test('★ 没有 TOC 条目的章节会用正文推断标题，而不是显示文件名', () => {
  // text00001.html 的真实内容是一句引文
  const title = inferChapterTitle({
    title: 'text00001', navTitle: null, kind: 'tiny',
    heading: '', firstText: '现在已然衰朽者，将来可能重放异彩。', index: 2, href: 'OEBPS/text00001.html',
  });
  assert.equal(title, '现在已然衰朽者，将来可能重放异彩', '应去掉句末标点，不显示 text00001');
  assert.ok(!/text\d+/i.test(title), '不该出现文件名');
});

test('推断标题时优先用正文里的标题元素', () => {
  const title = inferChapterTitle({
    title: 'text00009', navTitle: null, kind: 'content',
    heading: '第6版前言 格雷厄姆和多德的永恒智慧',
    firstText: '别的东西', index: 10, href: 'OEBPS/text00009.html',
  });
  assert.equal(title, '第6版前言 格雷厄姆和多德的永恒智慧');
});

test('TOC 标题存在时永远优先，不会被推断覆盖', () => {
  for (const tocTitle of ['版权页', '献词', '第一部分 证券分析综览及方法']) {
    const title = inferChapterTitle({
      title: tocTitle, navTitle: tocTitle, kind: 'content',
      heading: '别的标题', firstText: '别的正文', index: 1, href: 'x.html',
    });
    assert.equal(title, tocTitle);
  }
});

test('文件名样式的标题会被当成"没有标题"处理', () => {
  for (const bad of ['text00001', 'TEXT00027', 'chapter3', 'x.xhtml', 'a1']) {
    const title = inferChapterTitle({
      title: bad, navTitle: bad, kind: 'content',
      heading: '', firstText: '正文首句在这里', index: 5, href: 'x.html',
    });
    assert.equal(title, '正文首句在这里', `${bad} 应被识别为文件名而非标题`);
  }
});

test('完全没文字也没标题时给出兜底名称', () => {
  assert.equal(
    inferChapterTitle({ title: 'text00027', navTitle: null, kind: 'image-only', heading: '', firstText: '', index: 27, href: 'x.html' }),
    '整页图片',
  );
  assert.equal(
    inferChapterTitle({ title: 'text00007', navTitle: null, kind: 'prompt', heading: '', firstText: '', index: 7, href: 'x.html' }),
    '图片提示页',
  );
  assert.equal(
    inferChapterTitle({ title: 'text00008', navTitle: null, kind: 'empty', heading: '', firstText: '', index: 9, href: 'x.html' }),
    '空白页',
  );
});

test('超长标题会被截断，不会撑破表格', () => {
  const title = inferChapterTitle({
    title: 'x.html', navTitle: null, kind: 'content',
    heading: '', firstText: '很长的句子'.repeat(30), index: 1, href: 'x.html',
  });
  assert.ok(title.length <= 31, `实际长度 ${title.length}`);
  assert.ok(title.endsWith('…'));
});

/* ------------------------------------------- 导入后元数据正确 -- */

async function withTempWorkspace(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-chinfo-'));
  ws.setWorkspaceRoot(dir);
  try {
    return await fn(dir);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('★ 导入后每章都带 kind / rewritable / 可用标题', async () => {
  await withTempWorkspace(async () => {
    const metadata = await importBook({
      buffer: makeFixtureEpub(),
      fileName: 'cls.epub',
      profile: blankProfile(),
    });
    assert.equal(metadata.schemaVersion, ws.CURRENT_METADATA_VERSION, '导入时应写入当前元数据版本');
    for (const c of metadata.chapters) {
      assert.ok(c.kind, `第 ${c.index} 章缺少 kind`);
      assert.equal(typeof c.rewritable, 'boolean', `第 ${c.index} 章缺少 rewritable`);
      assert.ok(c.title && !/^text\d+$/i.test(c.title), `第 ${c.index} 章标题不合理: ${c.title}`);
    }
    // 测试用书都是正常正文页
    assert.ok(metadata.chapters.every((c) => c.rewritable), '样例书应全部可改写');
  });
});

/* --------------------------------------------- 老书自动升级 -- */

test('★ 老书（没有 kind 字段）会被自动升级，不需要重新导入', async () => {
  const metadata = {
    bookId: 'b_old_0001',
    schemaVersion: 1,
    chapters: [
      { index: 1, href: 'a.xhtml', title: 'text00001' },
      { index: 2, href: 'b.xhtml', title: '正常章节' },
    ],
  };
  const called = [];
  const { metadata: upgraded, changed, from } = await ws.upgradeBookMetadata(metadata, {
    reanalyze: async (chapter) => {
      called.push(chapter.index);
      return chapter.index === 1
        ? { title: '推断出来的标题', kind: 'image-only', rewritable: false, textLength: 0 }
        : { title: '正常章节', kind: 'content', rewritable: true, textLength: 500 };
    },
  });

  assert.equal(from, 1);
  assert.equal(changed, true);
  assert.deepEqual(called, [1, 2]);
  assert.equal(upgraded.schemaVersion, ws.CURRENT_METADATA_VERSION);
  assert.equal(upgraded.chapters[0].kind, 'image-only');
  assert.equal(upgraded.chapters[0].rewritable, false);
  assert.equal(upgraded.chapters[0].title, '推断出来的标题');
  assert.equal(upgraded.chapters[1].rewritable, true);
});

test('已经是最新版本的书不会被重复升级', async () => {
  const metadata = { schemaVersion: ws.CURRENT_METADATA_VERSION, chapters: [{ index: 1, kind: 'content' }] };
  let called = 0;
  const { changed } = await ws.upgradeBookMetadata(metadata, {
    reanalyze: async () => {
      called += 1;
      return {};
    },
  });
  assert.equal(changed, false);
  assert.equal(called, 0, '不该重复分析');
});

test('升级过程中单章分析失败不会中断，退化为按正常章节处理', async () => {
  const metadata = {
    schemaVersion: 1,
    chapters: [{ index: 1, href: 'bad.xhtml', title: 'x' }, { index: 2, href: 'ok.xhtml', title: 'y' }],
  };
  const { metadata: upgraded, changed } = await ws.upgradeBookMetadata(metadata, {
    reanalyze: async (chapter) => {
      if (chapter.index === 1) throw new Error('解析失败');
      return { kind: 'content', rewritable: true };
    },
  });
  assert.equal(changed, true);
  assert.equal(upgraded.chapters[0].rewritable, undefined, '失败的章节保持原样');
  assert.equal(upgraded.chapters[1].rewritable, true);
});

test('没有提供 reanalyze 时只升级版本号', async () => {
  const metadata = { schemaVersion: 1, chapters: [{ index: 1 }] };
  const { metadata: upgraded, changed } = await ws.upgradeBookMetadata(metadata, {});
  assert.equal(changed, true);
  assert.equal(upgraded.schemaVersion, ws.CURRENT_METADATA_VERSION);
  assert.equal(upgraded.chapters[0].kind, undefined, '没有分析回调就不猜内容性质');
});
