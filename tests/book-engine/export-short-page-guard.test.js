/**
 * 旧方案重新导出时，短页护栏必须在**真实导出路径**上生效。
 *
 * 这里锁的是一个只有集成测试才看得见的坑：
 * `readEpub()` 为了省内存不读每章正文，`chapter.textLength` 初始是 0；
 * 导出时判断「是不是短页」如果直接用这个数字，条件永远不成立。
 * 单元测试里手工传 `chars` 是测不出来的 —— 必须在 `exportBook` 里现量。
 *
 * 场景取自真实旧书：42 字的卷首题词在旧方案里是 `keep`、没有
 * `card.shortPage`，磁盘上却留着一份 141 字的改写稿。重新导出时
 * 必须用原文，不能被改写稿顶掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook, exportBook } from '../../lib/book-engine/pipeline/book-service.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';
import { readEpub } from '../../lib/book-engine/epub/epub-reader.js';
import { repackEpub } from '../../lib/book-engine/epub/epub-writer.js';
import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import { makeFixtureEpub } from './fixture-epub.js';

const EPIGRAPH =
  '现在已然衰朽者，将来可能重放异彩；现在备受青睐者，将来却可能黯然失色。——贺拉斯《诗艺》';

const SHORT_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>卷首题词</title></head>
<body><h1>卷首题词</h1><p>${EPIGRAPH}</p></body>
</html>
`;

async function withTempWorkspace(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-export-short-'));
  ws.setWorkspaceRoot(dir);
  try {
    return await fn();
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('★ 旧方案重新导出：42 字题词用原文，不被旧改写稿顶掉', async () => {
  await withTempWorkspace(async () => {
    const base = readEpub(makeFixtureEpub());
    const shortened = repackEpub(base, {
      replacements: new Map([['OEBPS/text/chapter1.xhtml', SHORT_CHAPTER]]),
    });
    const metadata = await importBook({
      buffer: shortened.buffer,
      fileName: 'old-plan.epub',
      profile: blankProfile(),
    });
    const bookId = metadata.bookId;

    /** 旧方案的样子：没有 card.shortPage，只有 planning 时记下的 chars。 */
    await ws.writeBookPlan(bookId, {
      entries: metadata.chapters.map((c) => ({
        index: c.index,
        title: c.title,
        chars: c.index === 1 ? 42 : c.textLength,
        value: c.index === 1 ? 'core' : 'useful',
        strategy: 'keep',
      })),
      names: {},
      order: metadata.chapters.map((c) => c.index),
    });

    /** 磁盘上确实有一份更早的改写稿 —— 旧方案里它会被当成最终正文。 */
    await ws.saveChapterRewritten(
      bookId,
      1,
      '<html><body><h1>卷首题词</h1><p>这是被改写过的内容，本来不该用在这里。</p></body></html>',
    );

    const out = await exportBook({ bookId, chapters: [1] });
    const buf = await fsp.readFile(path.join(ws.bookPaths(bookId).exports, out.fileName));
    const zip = new ZipReader(buf);
    const chapter1 = zip.readText(metadata.chapters.find((c) => c.index === 1).href);

    assert.ok(chapter1.includes('贺拉斯'), `应保留 42 字原文：${chapter1.slice(0, 300)}`);
    assert.ok(
      !chapter1.includes('这是被改写过的内容'),
      '短页的旧改写稿不该被用于导出',
    );
    assert.ok(out.keptOriginalChapters.includes(1), '第 1 章应记为「按原文保留」');
    assert.deepEqual(out.includedChapters, [], '短页不算改写章节');
  });
});
