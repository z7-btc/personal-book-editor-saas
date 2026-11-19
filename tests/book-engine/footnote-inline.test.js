/**
 * 脚注就地化的回归测试。
 *
 * 用户的原话：「脚注这种东西不是特别有意义……如果是重要的内容，就不需要用
 * 脚注，直接放在书里的括号里解释一下就行了；如果不重要的，直接删了也没有
 * 关系。所以，如果因为脚注而不去优化整本书的话，我觉得不太好。」
 *
 * 所以这一组测试守护两件事：
 *   1. 能正确认出「哪些是脚注」（成对互指才算，目录锚点不算）；
 *   2. 注释融进正文之后，尾注汇编章里变成纯重复的那些条目要能精确删掉，
 *      而**引用点还在正文里的那些必须留下** —— 否则内容就真丢了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import * as ws from '../../lib/book-engine/pipeline/workspace.js';
import { importBook, buildBookNoteRefs, stripNoteEntries } from '../../lib/book-engine/pipeline/book-service.js';
import { blankProfile } from '../../lib/book-engine/config/profile.js';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { queryAll } from '../../lib/book-engine/epub/selector.js';
import { makeFootnoteFixtureEpub } from './fixture-epub.js';

async function withTempWorkspace(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-notes-'));
  ws.setWorkspaceRoot(dir);
  try {
    return await fn(dir);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('★ 认得出成对互指的脚注，取的是注释正文而不是 "(1)" 这个标记', async () => {
  await withTempWorkspace(async () => {
    const metadata = await importBook({
      buffer: makeFootnoteFixtureEpub(),
      fileName: 'notes.epub',
      profile: blankProfile(),
    });
    const info = await buildBookNoteRefs(metadata.bookId);

    assert.equal(info.totalNotes, 1, `只应认出 1 条真脚注（成对互指），实际 ${info.totalNotes}`);
    assert.equal(info.refToNote.size, 1);

    const [refId, anchorId] = [...info.refToNote][0];
    assert.equal(refId, 'jzyy_1_1');
    assert.equal(anchorId, 'jz_1_1');

    /**
     * 注释正文在 `<a>` **外面**。取错了就只会拿到 "(1)" ——
     * 这是 buildNoteIndex 最容易写错的地方。
     */
    const note = info.noteRefs.get('jzyy_1_1');
    assert.ok(note, 'noteRefs 要能用「正文引用点 id」查到');
    assert.ok(note.text.includes('安全边际的概念最早由'), `取到的应是注释正文：${note.text}`);
    assert.ok(!note.text.startsWith('(1)'), `开头的序号标记要去掉：${note.text}`);

    // 尾注章自己能认出来（条目多、引用点少的那一章）
    const owner = metadata.chapters.find((c) => c.index === info.ownerIndex);
    assert.ok(owner.href.includes('endnotes'), `尾注章应是 endnotes.xhtml，实际 ${owner?.href}`);
  });
});

test('stripNoteEntries 按块删注释，别的内容一个不动', () => {
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>延伸阅读</h1>
<p>《共同基金常识》：指数基金教父约翰·博格先生的心血力作。</p>
<p id="n1"><a id="jz_1_1" href="chapter1.xhtml#jzyy_1_1">(1)</a> 安全边际的概念最早由格雷厄姆提出。</p>
<p id="n2"><a id="jz_1_2" href="chapter1.xhtml#jzyy_1_2">(2)</a> 会计口径差异会影响账面价值的可比性。</p>
</body></html>`;

  const r = stripNoteEntries(xhtml, new Set(['jz_1_1', 'jz_1_2']));
  const text = r.xhtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  assert.equal(r.removedBlocks, 2, `应删掉 2 条注释，实际 ${r.removedBlocks}`);
  assert.equal(r.keptBlocks, 2, `书单和标题要留下，实际留了 ${r.keptBlocks} 块`);
  assert.ok(text.includes('共同基金常识'), `非注释内容必须保留：${text}`);
  assert.ok(!text.includes('安全边际的概念最早由'), '被就地化的注释条目要删掉');
  assert.ok(!/id="jz_/.test(r.xhtml), '注释锚点不该残留');
});

test('★ 删掉块之后不能又被序列化回填（字节保真的坑）', () => {
  /**
   * 这套 DOM 是字节保真的：光 `detach()` 不够，父节点序列化时会按源区间
   * 把「缝隙」回填，删掉的段落原样又冒出来 —— 第一次跑脚本时
   * 146 处删除一处都没生效，就是这个原因。
   */
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>保留的段落。</p>
<p id="n1"><a id="jz_9_9" href="c.xhtml#jzyy_9_9">(9)</a> 这一条要被删掉，删掉之后一个字都不该出现在成品里。</p>
<p>后面还有一段。</p>
</body></html>`;

  const r = stripNoteEntries(xhtml, new Set(['jz_9_9']));
  assert.ok(!r.xhtml.includes('这一条要被删掉'), `删掉的段落又被回填了：${r.xhtml}`);
  assert.ok(r.xhtml.includes('保留的段落'));
  assert.ok(r.xhtml.includes('后面还有一段'));
});

test('stripNoteEntries 对没有注释的章节是空操作', () => {
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>普通段落一。</p><p>普通段落二。</p></body></html>`;
  const r = stripNoteEntries(xhtml, new Set(['jz_nope']));
  assert.equal(r.removedBlocks, 0);
  assert.equal(r.keptBlocks, 2);
  assert.ok(r.xhtml.includes('普通段落一') && r.xhtml.includes('普通段落二'));
});

test('尾部章节的注释引用点还在时，条目要能留下来（不能一刀切全删）', () => {
  /**
   * 用户这本书的第 13 章是**压缩成提要**的，走另一条链路、不做就地化，
   * 它引用的 23 条注释在正文里的引用点还在 —— 那些尾注条目必须保留，
   * 否则内容就真丢了。所以调用方传进来的是「可删集合」，不是「全部」。
   */
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p id="n1"><a id="jz_1_1" href="c.xhtml#jzyy_1_1">(1)</a> 已经融进正文的那一条。</p>
<p id="n2"><a id="jz_1_2" href="c.xhtml#jzyy_1_2">(2)</a> 引用点还在正文里的那一条，必须留下。</p>
</body></html>`;

  const r = stripNoteEntries(xhtml, new Set(['jz_1_1']));
  assert.equal(r.removedBlocks, 1);
  assert.equal(r.keptBlocks, 1);
  assert.ok(r.xhtml.includes('已经融进正文的那一条') === false, '被就地化的那条要删');
  assert.ok(r.xhtml.includes('引用点还在正文里的那一条'), '引用点还在的必须留');
  void parseXml;
  void queryAll;
});
