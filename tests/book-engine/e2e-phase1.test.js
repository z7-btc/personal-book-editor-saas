/**
 * ★ Phase 1 端到端验收
 *
 *   input.epub -> 导入 -> 解析 -> 章节识别 -> 不经过 AI -> output.epub
 *
 * 验收标准（需求第十九节 Phase 1）：
 *   - output.epub 结构与原书一致：OPF / manifest / spine / nav / toc / CSS / 图片 / 封面
 *   - 打开时不会报错（用我们自己的解析器 + 结构校验双重确认）
 *   - 工作区目录结构符合需求第十三 / 十四节的约定
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { importBook, extractChapter, exportBook } from '../../lib/book-engine/pipeline/book-service.js';
import { repackEpub } from '../../lib/book-engine/epub/epub-writer.js';
import { readEpub } from '../../lib/book-engine/epub/epub-reader.js';
import { ZipReader } from '../../lib/book-engine/epub/zip-reader.js';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { queryAll } from '../../lib/book-engine/epub/selector.js';
import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';
import { makeFixtureEpub } from './fixture-epub.js';

async function withTempWorkspace(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-test-'));
  ws.setWorkspaceRoot(dir);
  try {
    return await fn(dir);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('★ Phase 1：导入 -> 不经过 AI -> 导出，结构与内容 100% 保留', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const source = makeFixtureEpub();
    const profile = { ...blankProfile(), reading_goal: '测试用' };

    // --- 1) 导入 ---
    const metadata = await importBook({
      buffer: source,
      fileName: '测试之书.epub',
      profile,
    });
    assert.equal(metadata.title, '测试之书：个人化编辑验证');
    assert.deepEqual(metadata.authors, ['测试作者']);
    assert.equal(metadata.chapterCount, 4);
    assert.equal(metadata.sourceFileName, '测试之书.epub');
    assert.ok(metadata.totalChars > 300);

    // 工作区目录结构（需求第十三节）
    const paths = ws.bookPaths(metadata.bookId);
    assert.ok(await exists(paths.original), 'original.epub 必须存在');
    assert.ok(await exists(paths.metadata), 'metadata.json 必须存在');
    assert.ok(await exists(paths.profileSnapshot), 'reader-profile-snapshot.json 必须存在');
    assert.ok(await exists(paths.memory), 'book-memory.json 必须存在');
    for (const chapter of metadata.chapters) {
      const cp = ws.chapterPaths(metadata.bookId, chapter.index);
      assert.ok(await exists(cp.dir), `章节目录必须预建: ${cp.dir}`);
    }

    // 原文必须与上传的字节完全一致
    const stored = await fsp.readFile(paths.original);
    assert.deepEqual(stored, source, 'original.epub 必须逐字节等于上传内容');

    // --- 2) 提取（不调用 AI） ---
    const extraction = await extractChapter(metadata.bookId, 1);
    assert.equal(extraction.cached, false);
    assert.ok(extraction.chunks.length >= 1);

    const cp1 = ws.chapterPaths(metadata.bookId, 1);
    assert.ok(await exists(cp1.originalHtml), 'original.xhtml 必须写出');
    assert.ok(await exists(cp1.originalHtmlCompat), 'original.html 兼容副本必须写出');
    assert.ok(await exists(cp1.chunks), 'chunks.json 必须写出');
    assert.ok(await exists(cp1.status), 'status.json 必须写出');

    const originalXhtml = await fsp.readFile(cp1.originalHtml, 'utf8');
    const book = readEpub(source);
    assert.equal(originalXhtml, book.zip.readXmlText(book.chapters[0].href).text, '提取的原文不得被改动');

    // 缓存生效
    const again = await extractChapter(metadata.bookId, 1);
    assert.equal(again.cached, true);

    // --- 3) 导出（无 AI） ---
    const result = await exportBook({ bookId: metadata.bookId, chapters: [] });
    assert.equal(result.replacedCount, 0, '没有 AI 改写时不应替换任何文件');
    assert.equal(result.includedChapters.length, 0);
    assert.equal(result.issues.length, 0);
    // 这一路没有经过 AI，一个字都没改：文件名必须如实说明，
    // 不能顶着【AI重写】的名号骗人
    assert.match(result.fileName, /^【未改写副本】/);
    assert.match(result.fileName, /\.epub$/);
    assert.ok(!result.fileName.includes('AI重写'), `没改写就不该叫 AI 重写：${result.fileName}`);

    const outPath = path.join(paths.exports, result.fileName);
    const outBuffer = await fsp.readFile(outPath);
    assert.ok(outBuffer.length > 0);

    // --- 4) 验收：输出 EPUB 必须仍然合法 ---
    const reread = readEpub(outBuffer); // 结构不合法会抛错
    assert.equal(reread.title, metadata.title);
    assert.equal(reread.chapters.length, 4);
    assert.deepEqual(reread.chapters.map((c) => c.title), metadata.chapters.map((c) => c.title));
    assert.equal(reread.warnings.length, 0, `不应有告警: ${reread.warnings.join('; ')}`);

    // 5) 每个 XHTML 文档仍然能被解析（没有损坏的 XML）
    for (const chapter of reread.chapters) {
      const text = reread.zip.readXmlText(chapter.href).text;
      assert.doesNotThrow(() => parseXml(text), `${chapter.href} 解析失败`);
    }

    // 6) OPF / manifest / spine / nav / toc / CSS / 图片 / 封面 全部一致
    const a = new ZipReader(source);
    const b = new ZipReader(outBuffer);
    for (const entry of a.list().filter((e) => !e.isDirectory)) {
      assert.deepEqual(b.read(entry.name), a.read(entry.name), `${entry.name} 内容被改动了`);
    }

    const opfAfter = parseXml(b.readText('OEBPS/content.opf'));
    const spine = queryAll(opfAfter.documentElement, 'itemref').map((el) => el.getAttribute('idref'));
    assert.deepEqual(spine, ['ch1', 'ch2', 'ch3', 'notes'], 'spine 顺序必须保持');
    const items = queryAll(opfAfter.documentElement, 'item').map((el) => el.getAttribute('id'));
    assert.deepEqual(items, ['nav', 'ncx', 'css', 'cover-image', 'fig1', 'ch1', 'ch2', 'ch3', 'notes']);

    // 7) mimetype 规范（EPUB 阅读器兼容性的硬要求）
    assert.equal(b.list()[0].name, 'mimetype');
    assert.equal(b.list()[0].method, 0);
    assert.equal(b.readText('mimetype'), 'application/epub+zip');
  });
});

test('导入后 listBooks 能看到进度汇总', async () => {
  await withTempWorkspace(async () => {
    const metadata = await importBook({
      buffer: makeFixtureEpub(),
      fileName: 'a.epub',
      profile: blankProfile(),
    });
    const books = await ws.listBooks();
    assert.equal(books.length, 1);
    assert.equal(books[0].bookId, metadata.bookId);
    assert.equal(books[0].progress.total, 4);
    assert.equal(books[0].progress.completed, 0);
    assert.equal(books[0].progress.pending, 4);
  });
});

test('导入非法文件时给出可读错误', async () => {
  await withTempWorkspace(async () => {
    await assert.rejects(
      () => importBook({ buffer: Buffer.from('this is not a zip file at all, but long enough'), fileName: 'x.epub', profile: blankProfile() }),
      /ZIP\/EPUB|EPUB/,
    );
    await assert.rejects(
      () => importBook({ buffer: makeFixtureEpub(), fileName: 'x.txt', profile: blankProfile() }),
      /只支持 \.epub/,
    );
    await assert.rejects(
      () => importBook({ buffer: Buffer.alloc(0), fileName: 'x.epub', profile: blankProfile() }),
      /为空/,
    );
  });
});

test('章节改写结果可以被单独导出（只替换那一章）', async () => {
  await withTempWorkspace(async () => {
    const source = makeFixtureEpub();
    const metadata = await importBook({ buffer: source, fileName: 'b.epub', profile: blankProfile() });
    const book = readEpub(source);
    const ch2 = book.chapters[1];

    // 真实流程：先提取（写 status.json），再写改写结果
    await extractChapter(metadata.bookId, 2);

    // 模拟改写：把标题换掉
    const rewritten = book.zip.readXmlText(ch2.href).text.replace('第二章 深入', '第二章 深入（个人化版本）');
    await ws.saveChapterRewritten(metadata.bookId, 2, rewritten);
    const status = await ws.readChapterStatus(metadata.bookId, 2);
    assert.ok(status, 'status.json 应当已由 extractChapter 写出');
    status.stage = 'completed';
    await ws.writeChapterStatus(metadata.bookId, 2, status);

    const result = await exportBook({ bookId: metadata.bookId, chapters: [2] });
    assert.equal(result.replacedCount, 1);
    assert.deepEqual(result.includedChapters, [2]);

    const out = await fsp.readFile(path.join(ws.bookPaths(metadata.bookId).exports, result.fileName));
    const reread = readEpub(out);
    assert.ok(reread.zip.readText(ch2.href).includes('个人化版本'));
    assert.ok(reread.zip.readText(ch2.href).includes('Personalized Edition'), '应带个人化标记注释');
    // 第一章不受影响
    assert.deepEqual(reread.zip.read(book.chapters[0].href), new ZipReader(source).read(book.chapters[0].href));
  });
});

test('导出时未改写的章节会被跳过并报告', async () => {
  await withTempWorkspace(async () => {
    const metadata = await importBook({ buffer: makeFixtureEpub(), fileName: 'c.epub', profile: blankProfile() });
    const result = await exportBook({ bookId: metadata.bookId, chapters: [1, 3] });
    assert.deepEqual(result.includedChapters, []);
    assert.equal(result.skippedChapters.length, 2);
    assert.ok(result.skippedChapters.every((s) => s.reason === '尚未改写'));
  });
});

test('删除书籍会清理工作区与导出目录', async () => {
  await withTempWorkspace(async () => {
    const metadata = await importBook({ buffer: makeFixtureEpub(), fileName: 'd.epub', profile: blankProfile() });
    await exportBook({ bookId: metadata.bookId, chapters: [] });
    assert.equal((await ws.listExports(metadata.bookId)).length, 1);

    await ws.deleteBook(metadata.bookId);
    assert.equal(await ws.bookExists(metadata.bookId), false);
    assert.equal((await ws.listBooks()).length, 0);
    const exported = await fsp.readdir(ws.exportsRoot());
    assert.equal(exported.length, 0, '顶层 exports 目录也要清干净');
  });
});

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
