/**
 * 核心安全层测试：正文提取 + 占位符还原。
 * 这一组测试直接守护「AI 不容易把原书内容改没」这条产品底线。
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
  PROTECTED_TAGS,
} from '../../lib/book-engine/epub/sanitize.js';

const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>t</title></head>
<body>
  <h1>第一章</h1>
  <p>普通段落一。</p>
  <p>带脚注的段落<sup class="ref"><a href="notes.xhtml#n1" id="r1">1</a></sup>继续。</p>
  <p>带 <em>强调 <strong>加粗</strong></em> 与 <a href="other.xhtml">链接</a> 的段落。</p>
  <p><img src="img/a.png" alt="图"/></p>
  <pre><code>const a = 1; // 不要动我</code></pre>
  <table><tbody><tr><td>单元格</td></tr></tbody></table>
  <div class="math"><math><mi>x</mi></math></div>
  <br/>
  <p>最后一段。</p>
</body>
</html>
`;

function prepare() {
  const doc = parseXml(CHAPTER);
  const { blocks, skipped } = extractBlocks(doc);
  return { doc, blocks, skipped };
}

test('提取语义块：段落 / 标题被识别', () => {
  const { blocks } = prepare();
  const tags = blocks.map((b) => b.tag);
  assert.ok(tags.includes('p'));
  assert.ok(tags.includes('h1'));
  assert.ok(blocks.length >= 6);
});

test('pre / table / math 整块跳过，不进入可改写块', () => {
  const { blocks, skipped } = prepare();
  const reasons = skipped.map((s) => s.tag);
  assert.ok(reasons.includes('pre'), 'pre 必须被保护');
  assert.ok(reasons.includes('table'), 'table 必须被保护');
  const blockTags = blocks.map((b) => b.tag);
  assert.ok(!blockTags.includes('pre'));
  assert.ok(!blockTags.includes('code'));
  assert.ok(!blockTags.includes('table'));
});

test('blockToPlainText 把行内元素替换成占位符', () => {
  const { blocks } = prepare();
  const withFootnote = blocks.find((b) => b.path?.includes('p') && b.element.textContent.includes('脚注'));
  const { text, marks } = blockToPlainText(withFootnote);
  assert.ok(text.includes('⟦1⟧'), text);
  assert.ok(text.includes('⟦/1⟧'), text);
  assert.ok(!text.includes('<a '), '不能把 HTML 交给模型');
  assert.ok(marks.length >= 2, 'a 与 sup 都应编号');
  assert.equal(marks[0].element.name, 'sup');
});

test('模型原样返回时，行内结构完全不变', () => {
  const { doc, blocks } = prepare();
  const block = blocks.find((b) => b.element.textContent.includes('脚注'));
  const { text, marks } = blockToPlainText(block);
  const result = rebuildBlockChildren(text, marks);
  applyRebuild(block, result);
  const out = doc.serialize();
  // 脚注标记的嵌套关系、class、id、href 必须一个不少
  assert.match(out, /<sup class="ref">\s*<a href="notes\.xhtml#n1" id="r1">1<\/a>\s*<\/sup>/, out);
  assert.ok(out.includes('带脚注的段落'));
  assert.ok(out.includes('继续。'));
});

test('模型改写文字但保留占位符：链接与脚注原样保留', () => {
  const { doc, blocks } = prepare();
  const block = blocks.find((b) => b.element.textContent.includes('脚注'));
  const { marks } = blockToPlainText(block);
  const modelText = '这是一个被重新编辑过的句子⟦1⟧⟦2⟧脚注标记⟦/2⟧⟦/1⟧，但结构必须还在。';
  const result = rebuildBlockChildren(modelText, marks);
  applyRebuild(block, result);
  const out = doc.serialize();
  assert.ok(out.includes('href="notes.xhtml#n1"'), out);
  assert.ok(out.includes('id="r1"'), out);
  assert.ok(out.includes('这是一个被重新编辑过的句子'));
});

test('模型完全丢掉占位符：元素被自动补回块尾，内容不丢', () => {
  const { doc, blocks } = prepare();
  const block = blocks.find((b) => b.element.textContent.includes('脚注'));
  const { marks } = blockToPlainText(block);
  const result = rebuildBlockChildren('模型忘记保留占位符了。', marks);
  applyRebuild(block, result);
  const out = doc.serialize();
  assert.ok(result.missing.length > 0, '应当检测到丢失');
  assert.ok(out.includes('href="notes.xhtml#n1"'), '锚点不能丢');
  assert.ok(doc.documentElement.textContent.includes('模型忘记保留占位符了。'));
});

test('模型编造占位符编号：被忽略并计入 unknown', () => {
  const { blocks } = prepare();
  const block = blocks.find((b) => b.element.textContent.includes('脚注'));
  const { marks } = blockToPlainText(block);
  const result = rebuildBlockChildren('文本⟦99⟧带有不存在的编号。', marks);
  assert.ok(result.unknown >= 1);
  const rendered = result.nodes.map((n) => n.textContent ?? n.value).join('');
  assert.ok(!rendered.includes('99'));
});

test('嵌套行内元素的配对结构被正确还原', () => {
  const { doc, blocks } = prepare();
  const block = blocks.find((b) => b.element.textContent.includes('强调'));
  const { text, marks } = blockToPlainText(block);
  // sup/em 的嵌套：⟦2⟧⟦3⟧…⟦/3⟧⟦/2⟧
  const result = rebuildBlockChildren(text, marks);
  applyRebuild(block, result);
  const out = doc.serialize();
  assert.ok(out.includes('<em>'), out);
  assert.ok(out.includes('<strong>'), out);
  assert.ok(/<em>[^<]*<strong>/.test(out) || out.includes('<strong>加粗</strong></em>'), out);
});

test('模型把开闭标记写反：被识别为 unbalanced 且不崩溃', () => {
  const { blocks } = prepare();
  const block = blocks.find((b) => b.element.textContent.includes('脚注'));
  const { marks } = blockToPlainText(block);
  const result = rebuildBlockChildren('⟦/1⟧倒过来的⟦1⟧标记。', marks);
  assert.ok(result.unbalanced >= 1);
  assert.ok(result.nodes.length > 0);
});

test('img / 自闭合元素在占位符体系里保持自闭合', () => {
  const { blocks } = prepare();
  const imgBlock = blocks.find((b) => b.element.descendants().some((el) => el.name === 'img'));
  const { marks } = blockToPlainText(imgBlock);
  const imgMark = marks.find((m) => m.name === 'img');
  assert.ok(imgMark, '应当找到 img 占位符');
  assert.equal(imgMark.selfClosing, true);
});

test('validateDocument 能识别被破坏的结构', () => {
  const doc = parseXml(CHAPTER);
  const ok = validateDocument(doc, { parseXml });
  assert.equal(ok.ok, true);

  const broken = parseXml('<html><body><p>x</p></body></html>');
  broken.documentElement.children = broken.documentElement.children.filter(
    (c) => !(c.name === 'body'),
  );
  const check = validateDocument(broken, { parseXml });
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('body')));
});

test('未经改写的章节序列化后与原文完全一致（最重要的回归测试）', () => {
  const doc = parseXml(CHAPTER);
  extractBlocks(doc);
  assert.equal(doc.serialize(), CHAPTER);
});

test('PROTECTED_TAGS 覆盖需求里点名要保护的结构', () => {
  for (const tag of ['pre', 'code', 'svg', 'math', 'table', 'script', 'style', 'iframe']) {
    assert.ok(PROTECTED_TAGS.has(tag), `${tag} 必须在保护名单里`);
  }
});

/* ------------------------------------------- 嵌套标记只丢一层（真实事故）-- */

/**
 * 这本书的脚注标记是**两层嵌套**：
 *
 *   <a id="jzyy_1_181" href="text00027.html#jz_1_181"><sup>(79)</sup></a>
 *
 * 模型只丢掉外层 `<a>` 的占位符、内层 `<sup>` 留在原地时，
 * 正文里已经有一个 `(79)`，块尾又被补上一个完整的 `<a>`，
 * 读者看到的是 `…债券投资的选择。(79)(79)` —— 第 16 章全书 43 处。
 */
const NESTED_MARK_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>t</title></head>
<body>
<p id="b1">白芝浩说过一句话：“如果难以决定，就应该放弃这只证券。”<a id="jzyy_1_181" href="notes.xhtml#jz_1_181"><sup>(79)</sup></a> 这句话同样适用。</p>
</body>
</html>
`;

/** 取出一个块的可改写文本与标记。 */
function nestedBlock() {
  const doc = parseXml(NESTED_MARK_CHAPTER);
  const { blocks } = extractBlocks(doc);
  const block = blocks.find((b) => b.element.getAttribute('id') === 'b1');
  const { text, marks } = blockToPlainText(block);
  return { block, text, marks };
}

const textOf = (nodes) =>
  nodes.map((n) => (n.kind === 3 ? n.value : n.textContent || '')).join('');

test('★ 嵌套标记只丢了外层时，要「套回原位」—— 既不重复也不能丢锚点', () => {
  const { text, marks } = nestedBlock();
  // 外层是 <a>、内层是 <sup>，编号按外层在前
  assert.equal(marks[0].element.name, 'a', `第一个标记应是外层 <a>，实际 ${marks[0].element.name}`);

  // 模型只保留内层：把 ⟦1⟧ / ⟦/1⟧ 删掉
  const innerOnly = text.replace(/⟦1⟧/g, '').replace(/⟦\/1⟧/g, '');
  const r = rebuildBlockChildren(innerOnly, marks);
  const out = textOf(r.nodes);

  /**
   * 两个条件缺一不可，都是踩出来的：
   *
   * 1. `(79)` 只能出现一次 —— 直接补回块尾会印成 `(79)(79)`（第 16 章 43 处）；
   * 2. `<a>` 上的 id / href 必须还在 —— 只做「内容已在就不补」会**丢掉锚点**
   *    （实测尾注跳不回正文，8 个锚点丢失）。
   *
   * 正解是外层套回内层身上。
   */
  assert.equal((out.match(/\(79\)/g) || []).length, 1, `(79) 只能出现一次：${out}`);
  assert.equal(r.wrappedBack.length, 1, '应当识别为「套回原位」');

  const findA = (nodes) => {
    for (const n of nodes) {
      if (n.name === 'a') return n;
      const deeper = n.children ? findA(n.children) : null;
      if (deeper) return deeper;
    }
    return null;
  };
  const a = findA(r.nodes);
  assert.ok(a, '外层 <a> 必须留在正文里，否则脚注锚点就没了');
  assert.equal(a.getAttribute('id'), 'jzyy_1_181');
  assert.equal(a.getAttribute('href'), 'notes.xhtml#jz_1_181');
  assert.equal(a.textContent.trim(), '(79)');
});

test('连标记带内容一起被模型删掉时，照旧补回块尾（脚注引用不能凭空消失）', () => {
  const { text, marks } = nestedBlock();
  // 模型「顺手清理」：连 ⟦1⟧⟦2⟧(79)⟦/2⟧⟦/1⟧ 整段（含文字）一起删了
  const wiped = text.replace(/⟦1⟧⟦2⟧\(79\)⟦\/2⟧⟦\/1⟧/g, '');
  assert.ok(!wiped.includes('(79)'), '前提：模型确实把内容也删了');
  const r = rebuildBlockChildren(wiped, marks);
  const out = textOf(r.nodes);
  assert.ok(out.includes('(79)'), `内容都没了就必须补回来，否则脚注引用凭空消失：${out}`);
  assert.equal(r.dedupedOrphans.length, 0, '这次是真的丢了，不该走去重分支');
});
