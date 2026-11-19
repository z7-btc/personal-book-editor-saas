/**
 * 回归测试：这些用例对应开发过程中真实踩到的坑。
 * 每一个都曾经造成「EPUB 损坏」或「AI 把原文改没了」这类严重问题，
 * 所以专门留一份显式测试，防止以后改回去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import {
  extractBlocks,
  blockToPlainText,
  rebuildBlockChildren,
  applyRebuild,
  validateDocument,
} from '../../lib/book-engine/epub/sanitize.js';
import { parseSegments, stripSourceEndMark } from '../../lib/book-engine/pipeline/rewrite.js';
import { extractNumberTokens } from '../../lib/book-engine/pipeline/quality.js';
import { buildRewriteSystemPrompt } from '../../lib/book-engine/pipeline/rewrite.js';

/* ---------------------------------------------------------------------- */
/* 坑 1：嵌套行内元素的 start 位置相同，按 start 排序会把父子关系搞反      */
/* ---------------------------------------------------------------------- */

test('回归：嵌套行内元素（sup > a）重建后仍保持正确嵌套', () => {
  const src = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x<sup class="ref"><a href="n.xhtml#n1" id="r1">1</a></sup>y</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const { text, marks } = blockToPlainText(blocks[0]);
  assert.equal(text, 'x⟦1⟧⟦2⟧1⟦/2⟧⟦/1⟧y');

  const result = rebuildBlockChildren(text, marks);
  assert.equal(result.missing.length, 0);

  // 树的形状必须是 p > sup > a，而不是反过来
  const p = result.nodes.find((n) => n.kind === 2);
  assert.equal(p.name, 'sup');
  assert.equal(p.children.length, 1);
  assert.equal(p.children[0].name, 'a');
  assert.equal(p.children[0].children[0].value, '1');
});

test('回归：多层嵌套（em > strong）顺序正确', () => {
  const src = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a<em>e<strong>s</strong></em>b</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const { text, marks } = blockToPlainText(blocks[0]);
  const result = rebuildBlockChildren(text, marks);
  // 找到 em，确认 strong 是它的子节点（而不是兄弟）
  const em = findElement(result.nodes, 'em');
  assert.ok(em, 'must produce <em>');
  const strong = findElement(em.children, 'strong');
  assert.ok(strong, '<strong> 必须是 <em> 的子节点');
  assert.equal(strong.children[0].value, 's');
});

function findElement(nodes, name) {
  for (const node of nodes) {
    if (node.kind === 2 && node.name === name) return node;
    if (node.kind === 2) {
      const found = findElement(node.children || [], name);
      if (found) return found;
    }
  }
  return null;
}

/* ---------------------------------------------------------------------- */
/* 坑 2：元素重建后 source 被清空，rawStartTag 从 [0, startTagEnd) 切片    */
/*       会把整篇文档开头当成开始标签吐出来（EPUB 直接损坏）              */
/* ---------------------------------------------------------------------- */

test('回归：重建后的元素不会吐出文档开头（XML 声明 / DOCTYPE）', () => {
  const src = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x<sup class="ref"><a href="n.xhtml#n1">1</a></sup>y</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const block = blocks[0];
  const { text, marks } = blockToPlainText(block);
  applyRebuild(block, rebuildBlockChildren(text, marks));

  const out = doc.serialize();
  assert.ok(!out.includes('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<body>\n<p>x'), '不得把文档开头当成标签输出');
  // 序列化结果必须仍然可以被解析
  assert.doesNotThrow(() => parseXml(out));
  // XML 声明只出现一次
  assert.equal(out.split('<?xml').length - 1, 1);
});

/* ---------------------------------------------------------------------- */
/* 坑 3：父元素「重建」后仍然回填源文本缝隙 => 原文被重复输出一遍         */
/* ---------------------------------------------------------------------- */

test('回归：重建后的段落不会把原文再输出一遍（内容不重复）', () => {
  const src = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>原始句子。带<em>强调</em>的部分。</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const block = blocks[0];
  const { marks } = blockToPlainText(block);
  // 模型返回一段完全不同的文字，且保留占位符
  applyRebuild(block, rebuildBlockChildren('这是全新写的一段话⟦1⟧重点⟦/1⟧，与原文不同。', marks));

  const out = doc.serialize();
  const text = parseXml(out).documentElement.textContent;
  assert.ok(!text.includes('原始句子'), `原文不应出现: ${text}`);
  assert.ok(!text.includes('的部分'), `原文尾段不应出现: ${text}`);
  assert.equal((text.match(/这是全新写的一段话/g) || []).length, 1, `内容被重复了: ${text}`);
});

test('回归：重复调用 serialize 结果稳定（幂等）', () => {
  const src = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a<em>b</em>c</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const block = blocks[0];
  const { text, marks } = blockToPlainText(block);
  applyRebuild(block, rebuildBlockChildren(`X${text}Y`, marks));
  const once = doc.serialize();
  const twice = doc.serialize();
  assert.equal(twice, once);
  assert.equal(parseXml(once).serialize(), once);
});

/* ---------------------------------------------------------------------- */
/* 坑 4：占位符统计塞在「补回分支」里，判定为破坏后就统计不到丢失数量      */
/* ---------------------------------------------------------------------- */

test('回归：全部占位符被丢掉时，missing 必须被统计出来', () => {
  const src = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a<sup><a href="#n1">1</a></sup>b<em>c</em>d<strong>e</strong>f</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const { marks } = blockToPlainText(blocks[0]);
  assert.ok(marks.length >= 3);

  const result = rebuildBlockChildren('完全重写的一句话。', marks);
  assert.equal(result.missing.length, marks.length, '所有标记都应计入 missing');
  assert.equal(result.corrupted, true, '应当判定为整块被破坏');
});

test('回归：轻微丢失（只丢 1 个）不算破坏，元素补回块尾', () => {
  const src = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a<sup><a href="#n1" id="keepme">1</a></sup>b</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const block = blocks[0];
  const { marks } = blockToPlainText(block);
  const result = rebuildBlockChildren('重写后的句子，故意不带占位符。', marks);
  assert.equal(result.missing.length, marks.length);
  assert.equal(result.corrupted, false, '只丢 1 个不应当判为破坏');
  applyRebuild(block, result);
  assert.ok(doc.serialize().includes('id="keepme"'), '锚点必须补回');
});

/* ---------------------------------------------------------------------- */
/* 坑 5：纯文字段落（没有任何标记）被摘要化时，旧的判定完全检测不到        */
/* ---------------------------------------------------------------------- */

test('回归：没有任何行内元素的段落被压成一句时判为破坏', () => {
  const long = '这是一段很长的正文。'.repeat(30); // 300 字
  const src = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${long}</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const { text, marks } = blockToPlainText(blocks[0]);
  assert.equal(marks.length, 0);

  // 必须显式传入原文长度：模型输出的长度不能作为判断基准
  const result = rebuildBlockChildren('这一段主要讲了一件事。', marks, { sourceLength: text.length });
  assert.equal(result.corrupted, true, '纯文字段落被摘要化也必须判为破坏');

  // 反过来：正常长度的改写不能被误判
  const ok = rebuildBlockChildren(text, marks, { sourceLength: text.length });
  assert.equal(ok.corrupted, false, '等长改写不应被判为破坏');
});

test('回归：没有传 sourceLength 时不会误判（保守行为）', () => {
  const long = '这是一段很长的正文。'.repeat(30);
  const src = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${long}</p></body></html>`;
  const doc = parseXml(src);
  const { blocks } = extractBlocks(doc);
  const { marks } = blockToPlainText(blocks[0]);
  const result = rebuildBlockChildren('很短的一句。', marks);
  assert.equal(result.corrupted, false, '缺少原文长度时应当保守，不误判为破坏');
});

/* ---------------------------------------------------------------------- */
/* 坑 6：模板里 {{SOURCE_TEXT}} 之后还有文字，模型会把尾部模板也当原文     */
/* ---------------------------------------------------------------------- */

test('回归：解析模型输出时会切掉「原文结束」标记之后的内容', () => {
  assert.equal(stripSourceEndMark('【段 1】改写后⟪原文结束⟫\n输出要求：只返回正文'), '【段 1】改写后');
  assert.equal(stripSourceEndMark('【段 1】改写后'), '【段 1】改写后');

  const parts = parseSegments('【段 1】改写⟪原文结束⟫\n\n输出要求：\n只返回处理后的正文。', 1);
  assert.equal(parts[0], '改写', '不得把模板尾部当成正文');
});

test('回归：真实 Prompt 模板带明确的原文结束标记', async () => {
  const { loadPromptTemplate } = await import('../../lib/book-engine/llm/prompts.js');
  const path = await import('node:path');
  const url = await import('node:url');
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
  const loaded = await loadPromptTemplate(root, 'prompts/rewrite-system.txt');
  const markerIndex = loaded.template.lastIndexOf('⟪原文结束⟫');
  assert.ok(markerIndex >= 0, 'Prompt 必须有明确的原文边界标记');
  // 真正的边界是最后一个标记，必须在 {{SOURCE_TEXT}} 之后
  assert.ok(
    markerIndex > loaded.template.indexOf('{{SOURCE_TEXT}}'),
    '边界标记必须紧跟在 SOURCE_TEXT 之后',
  );
});

/* ---------------------------------------------------------------------- */
/* 坑 7：数字 token 需要覆盖「紧跟中文」的写法（1973 年 / 40%1）           */
/* ---------------------------------------------------------------------- */

test('回归：中文语境里的数字也能被提取', () => {
  const tokens = [...extractNumberTokens('在 1973 年，通胀率高达 12.3%，折价 40%1。第 42 页。').keys()];
  for (const expected of ['1973', '12.3%', '40%', '42']) {
    assert.ok(tokens.includes(expected), `缺少 ${expected}，实际: ${tokens.join(',')}`);
  }
});

/* ---------------------------------------------------------------------- */
/* 坑 8：system prompt 里混进变量行                                        */
/* ---------------------------------------------------------------------- */

test('回归：system prompt 不含任何未替换的变量', () => {
  const template = [
    '角色与规则',
    '规则一',
    '',
    '读者画像：',
    '',
    '{{READER_PROFILE}}',
    '',
    '需要处理的原文：',
    '',
    '{{SOURCE_TEXT}}',
    '',
    '⟪原文结束⟫',
    '',
    '输出要求：只返回正文。',
  ].join('\n');
  const system = buildRewriteSystemPrompt(template);
  assert.ok(!system.includes('{{'), system);
  assert.ok(!system.includes('原文结束'), system);
  assert.ok(system.startsWith('角色与规则'));
});

/* ---------------------------------------------------------------------- */
/* 综合：一次完整的多块改写之后，文档依然结构有效                          */
/* ---------------------------------------------------------------------- */

test('回归：多块混合改写后整篇文档仍然合法，且每个块的锚点都在', () => {
  const src = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1 id="t">标题</h1>
<p>第一段，含 <em>强调</em> 与 <a href="x.xhtml#a" id="anchor-a">内部链接</a>。</p>
<p>第二段，含脚注<sup><a href="notes.xhtml#n1" id="anchor-n1">1</a></sup>。</p>
<p><img src="i.png" alt="图"/></p>
<table><tr><td>不该被碰的表格</td></tr></table>
</body></html>`;
  const doc = parseXml(src);
  const { blocks, skipped } = extractBlocks(doc);
  const outputs = {
    0: '【段 1】标题（改写）',
    1: '【段 1】第一段被改写，但链接必须还在⟦1⟧强调⟦/1⟧与⟦2⟧内部链接⟦/2⟧。',
    2: '【段 1】第二段被改写，脚注要保留⟦1⟧⟦2⟧1⟦/2⟧⟦/1⟧。',
    3: '',
  };

  blocks.forEach((block, index) => {
    const { marks } = blockToPlainText(block);
    const modelText = outputs[index];
    if (!modelText) return;
    const result = rebuildBlockChildren(modelText, marks);
    if (!result.corrupted) applyRebuild(block, result);
  });

  const out = doc.serialize();
  const check = validateDocument(doc, { parseXml });
  assert.equal(check.ok, true, check.errors.join('; '));
  assert.ok(out.includes('id="anchor-a"'), '内部链接锚点必须保留');
  assert.ok(out.includes('href="notes.xhtml#n1"'), '脚注链接必须保留');
  assert.ok(out.includes('id="anchor-n1"'), '脚注锚点必须保留');
  assert.ok(out.includes('<img src="i.png"'), '图片必须保留');
  assert.ok(out.includes('不该被碰的表格'), '表格必须保留');
  assert.ok(out.includes('标题（改写）'));
  assert.ok(!out.includes('第一段，含'), '被改写的段落不应保留原文');
  // 跳过的块（table）必须仍然完好
  assert.ok(skipped.some((s) => s.tag === 'table'));
});

/* ---------------------------------------------------------------------- */
/* 坑：导出文件名在落盘时被二次截断，AI 标记少了一个字母                  */
/* ---------------------------------------------------------------------- */

// 移到 SaaS 层重写：这里的 asciiFallbackName 现在住在 Next.js 下载路由里。
test.skip('★ [待 SaaS 层重测] 下载头的 ASCII 兜底名不能是乱码，也不能含非法字符', async () => {
  const { asciiFallbackName } = await import('../../lib/book-engine/server/http-util.js');

  // 老浏览器只看 filename=（不用 filename*），中文全被抹掉后的废名
  const junk = asciiFallbackName(
    '证券分析：原书第6版(经典畅销版全两册)(投资者的圣经！巴菲特灵魂导师、“华尔街教父”！' +
    '本杰明·格雷厄姆 不朽著作！巴曙松领衔专业人士全新... (z-library.sk, 1lib.sk, z-lib.sk).epub',
  );
  assert.ok(junk.endsWith('.epub'));
  /**
   * Windows 文件名非法字符：\ / : * ? " < > |
   * 原来的兜底实现只替换了非 ASCII，冒号是 ASCII 所以留了下来 ——
   * 一旦真的走了这条路，存盘会直接失败。
   */
  for (const bad of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    assert.ok(!junk.includes(bad), `兜底名里不能有非法字符 ${bad}：${junk}`);
  }
  assert.ok(!junk.includes('__'), `连续下划线要压缩掉：${junk}`);

  // 有 ASCII 主体的名字要保留可读内容
  assert.equal(asciiFallbackName('【AI重写】The Intelligent Investor.epub'), 'AI_The_Intelligent_Investor.epub');
  assert.equal(asciiFallbackName('Café Society.epub'), 'Cafe_Society.epub');
  // 纯中文名字剩不下东西时给一个干净的名字，而不是一长串下划线
  assert.equal(asciiFallbackName('【AI重写】活着.epub'), 'download.epub');
});

test('★ 回归：saveExport 必须原样保留文件名，不能悄悄截断', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-name-'));
  ws.setWorkspaceRoot(dir);
  try {
    const bookId = 'b_nametest_0001';

    /**
     * 事故现场：旧实现拼出来的名字是 121 个字符，
     * saveExport 里那句 sanitizeFileName(..., 'export') 用的是默认
     * 120 字上限，从尾巴上砍掉一个字符 —— 正好砍掉
     * `Personalized` 的最后一个 `d`。用户的成品文件名于是变成
     * `... - Personalize.epub`，看起来就像原名的一部分，
     * 他以为程序根本没加 AI 标记。
     *
     * 这里直接把一个 121 字符的名字交给存储层：
     * 存储层是「保存调用方给的名字」，不是「改名字」的地方。
     */
    const long = `【AI重写】${'很长的书名'.repeat(20)} - Personalized`; // 远超 120
    assert.ok(long.length > 120, `构造的用例必须真的超长，实际 ${long.length}`);

    const saved = await ws.saveExport(bookId, `${long}.epub`, Buffer.from('fake epub bytes'), {});
    /**
     * 2026-11-17 修正：原来的断言是「一个字都不能改」，这在 Linux 上不可能成立。
     * 单个文件名上限是 **255 字节**，一个汉字 3 个字节 —— 这个用例的名字
     * 是 600 多字节，写盘直接 ENAMETOOLONG（真实导出失败）。
     * 存储层要保证的是：字节安全、可读回、可删除，并且**头尾都还在**，
     * 用户一眼能看出这是成品（【AI重写】在前、Personalized 在后）。
     */
    assert.ok(
      Buffer.byteLength(saved.fileName, 'utf8') <= 255,
      `文件名必须落在 255 字节内，实际 ${Buffer.byteLength(saved.fileName, 'utf8')}`,
    );
    assert.ok(saved.fileName.startsWith('【AI重写】'), `AI 标记必须在：${saved.fileName}`);
    assert.ok(saved.fileName.endsWith(' - Personalized.epub'), `后缀必须保住：${saved.fileName}`);
    assert.ok(saved.fileName.includes('…'), '中间应该用省略号，而不是悄悄砍掉一截');

    // 写进去的名字必须能原样读回来、删掉（读写删三处的规则要一致）
    const read = await ws.readExport(bookId, saved.fileName);
    assert.equal(read.fileName, saved.fileName);
    assert.equal(read.buffer.toString(), 'fake epub bytes');

    const del = await ws.deleteExport(bookId, saved.fileName);
    assert.equal(del.deleted, saved.fileName);
    await assert.rejects(() => ws.readExport(bookId, saved.fileName), /不存在/);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('★ 端到端：长书名导出的成品文件名必须带着完整的 AI 标记', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');
  const { importBook, extractChapter, exportBook } = await import('../../lib/book-engine/pipeline/book-service.js');
  const { blankProfile } = await import('../../lib/book-engine/config/profile.js');
  const { AI_MARKER } = await import('../../lib/book-engine/epub/epub-writer.js');
  const { makeFixtureEpub } = await import('./fixture-epub.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-name-e2e-'));
  ws.setWorkspaceRoot(dir);
  try {
    // 用户实际的书名长这样：标题 + 版本 + 来源站点，111 个字符
    const longFileName =
      '证券分析：原书第6版(经典畅销版全两册)(投资者的圣经！巴菲特灵魂导师、“华尔街教父”！' +
      '本杰明·格雷厄姆 不朽著作！巴曙松领衔专业人士全新... (z-library.sk, 1lib.sk, z-lib.sk).epub';

    const metadata = await importBook({
      buffer: makeFixtureEpub(),
      fileName: longFileName,
      profile: blankProfile(),
    });
    await extractChapter(metadata.bookId, 1);

    // 造一份「已改写」的正文，让导出真的替换内容（否则不该叫 AI 重写）
    const { readEpub } = await import('../../lib/book-engine/epub/epub-reader.js');
    const book = readEpub(makeFixtureEpub());
    const href = book.chapters[0].href;
    await ws.saveChapterRewritten(
      metadata.bookId,
      1,
      book.zip.readXmlText(href).text.replace('第一章', '第一章（个人化）'),
    );
    const status = await ws.readChapterStatus(metadata.bookId, 1);
    await ws.writeChapterStatus(metadata.bookId, 1, { ...status, stage: 'completed' });

    const result = await exportBook({ bookId: metadata.bookId, chapters: [1] });

    assert.ok(
      result.fileName.startsWith(AI_MARKER),
      `文件名最前面必须是完整的 AI 标记，实际：${result.fileName}`,
    );
    assert.ok(result.fileName.endsWith('.epub'));
    assert.ok(result.fileName.length <= 120, `不能让系统再截一刀，实际 ${result.fileName.length}`);
    assert.ok(result.fileName.includes('证券分析'), '书名主体要留下来，用户得认得出是哪本书');

    // 真的落到了磁盘上，而且真的能按服务端返回的名字下载
    const onDisk = await fsp.readdir(ws.bookPaths(metadata.bookId).exports);
    assert.ok(onDisk.includes(result.fileName), `磁盘上找不到这个文件：${onDisk.join(' | ')}`);
    const download = await ws.readExport(metadata.bookId, result.fileName);
    assert.ok(download.buffer.length > 0);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('★ 回归：导出不能写两份，而且要自动清掉更早的成品', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = await import('../../lib/book-engine/pipeline/workspace.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pbe-exports-'));
  ws.setWorkspaceRoot(dir);
  try {
    await ws.ensureWorkspace();
    const bookId = 'b_exporttest_01';
    /**
     * 事故现场：saveExport 除了写 books/<id>/exports/，
     * 还往 workspace/exports/ 复制了一份 —— 但那一份从来没有代码读，
     * 只写不读，等于每本书磁盘占用翻倍。
     *
     * 用户的书 93MB，每点一次导出就 +93MB（浏览器下载的那份他已经删了，
     * 工作区这份他不知道还在）。堆了 18 份 = 1.7GB × 2 = 3.3GB，
     * 他直接来问「咋回事啊」。
     */
    for (let i = 0; i < 5; i += 1) {
      await ws.saveExport(bookId, `book (${i}).epub`, Buffer.alloc(16, i), {});
      // 文件 mtime 精度可能不够，隔开一点保证排序稳定
      await new Promise((r) => setTimeout(r, 12));
    }

    const top = await fsp.readdir(ws.exportsRoot());
    assert.deepEqual(top, [], `顶层 exports 不该再有副本，实际：${top.join(' | ')}`);
    const list = await ws.listExports(bookId);
    assert.equal(list.length, 3, `只该留最近 3 份，实际 ${list.length}：${list.map((e) => e.name).join(' | ')}`);
    const names = list.map((e) => e.name);
    assert.ok(names.includes('book (4).epub'), '最新的那份必须在');
    assert.ok(!names.includes('book (0).epub'), '最早的那份该被清掉');

    // 元数据 json 也要跟着清，否则列表里会出现指向空气的条目
    const files = await fsp.readdir(ws.bookPaths(bookId).exports);
    assert.equal(files.filter((f) => f.endsWith('.epub.json')).length, 3);

    // 被清掉的那份确实读不出来了，留下来的还能读
    await assert.rejects(() => ws.readExport(bookId, 'book (0).epub'), /不存在/);
    assert.ok((await ws.readExport(bookId, 'book (4).epub')).buffer.length === 16);
  } finally {
    ws.setWorkspaceRoot(null);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
