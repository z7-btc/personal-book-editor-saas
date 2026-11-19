/**
 * XML DOM 的关键性质测试：**未改动的部分必须字节级回写原文**。
 * 这是「EPUB 不容易损坏」的地基，所以测得细一点。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseXml, XmlText, XmlElement, escapeText, decodeEntities } from '../../lib/book-engine/epub/xml-dom.js';

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <title>标题 &amp; 副标题</title>
  <link rel="stylesheet" href="../styles/main.css"/>
</head>
<body>
  <!-- 一个注释 -->
  <p class="a b" id="p1">你好&nbsp;世界 &amp; 再见</p>
  <p>第二个段落</p>
  <br/>
  <p>第三段 <em>强调</em> 结束</p>
</body>
</html>
`;

test('未做任何修改时 serialize() 返回完全相同的字符串', () => {
  const doc = parseXml(DOC);
  assert.equal(doc.serialize(), DOC);
});

test('XML 声明 / DOCTYPE / 注释 / 自闭合标签被精确保留', () => {
  const doc = parseXml(DOC);
  const out = doc.serialize();
  assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(out.includes('<!DOCTYPE html>'));
  assert.ok(out.includes('<!-- 一个注释 -->'));
  assert.ok(out.includes('<link rel="stylesheet" href="../styles/main.css"/>'));
  assert.ok(out.includes('<br/>'));
});

test('实体引用原样保留，textContent 解码正确', () => {
  const doc = parseXml(DOC);
  const p = doc.documentElement.descendants().find((el) => el.getAttribute('id') === 'p1');
  assert.equal(p.textContent, '你好\u00a0世界 & 再见');
  assert.ok(doc.serialize().includes('你好&nbsp;世界 &amp; 再见'));
});

test('只改一个文本节点：其他行保持原样，只有该处变化', () => {
  const doc = parseXml(DOC);
  const paragraphs = doc.documentElement.descendants().filter((el) => el.name === 'p');
  const target = paragraphs[1];
  const textNode = target.children.find((c) => c.kind === 3);
  textNode.value = '修改后的第二段';
  textNode.markDirty();

  const out = doc.serialize();
  assert.notEqual(out, DOC);
  assert.ok(out.includes('<p>修改后的第二段</p>'));
  // 其他内容必须逐字不变
  assert.ok(out.includes('<p class="a b" id="p1">你好&nbsp;世界 &amp; 再见</p>'));
  assert.ok(out.includes('<p>第三段 <em>强调</em> 结束</p>'));
  assert.ok(out.includes('<link rel="stylesheet" href="../styles/main.css"/>'));
  // 空白与缩进也不应被重排
  assert.ok(out.includes('\n  <p class="a b" id="p1">'));
});

test('替换子节点后，父标签及其属性保持原样', () => {
  const doc = parseXml(DOC);
  const paragraphs = doc.documentElement.descendants().filter((el) => el.name === 'p');
  const target = paragraphs[2];
  const newNode = new XmlText('新的内容');
  target.replaceChild([newNode], target.children[0]);

  const out = doc.serialize();
  assert.ok(out.includes('<p>新的内容 <em>强调</em> 结束</p>'), out);
});

test('修改属性时只重建该标签，不触碰其他节点', () => {
  const doc = parseXml(DOC);
  const p1 = doc.documentElement.descendants().find((el) => el.getAttribute('id') === 'p1');
  p1.setAttribute('class', 'x');
  const out = doc.serialize();
  assert.ok(out.includes('<p class="x" id="p1">你好&nbsp;世界 &amp; 再见</p>'));
  assert.ok(out.includes('<title>标题 &amp; 副标题</title>'));
});

test('解析后再序列化的结果可以再次解析（结构稳定）', () => {
  const doc = parseXml(DOC);
  const paragraphs = doc.documentElement.descendants().filter((el) => el.name === 'p');
  paragraphs[0].children[0].value = 'X';
  paragraphs[0].children[0].markDirty();
  const once = doc.serialize();
  const twice = parseXml(once).serialize();
  assert.equal(twice, once);
});

test('未闭合标签默认报错，宽容模式下可以解析', () => {
  assert.throws(() => parseXml('<a><b></a>'), /标签不匹配|未闭合/);
  const doc = parseXml('<a><b>x</a>', { lenient: true });
  assert.equal(doc.documentElement.name, 'a');
});

test('CDATA 内容不被转义', () => {
  const src = '<pre><![CDATA[if (a < b && c > d) { }]]></pre>';
  const doc = parseXml(src);
  assert.equal(doc.serialize(), src);
});

test('escapeText 转义必要的字符', () => {
  assert.equal(escapeText('a<b>&c'), 'a&lt;b&gt;&amp;c');
  assert.equal(escapeText('x\u00a0y'), 'x&#160;y');
});

test('decodeEntities 支持命名与数字实体', () => {
  assert.equal(decodeEntities('&amp;&lt;&#65;&#x42;&nbsp;'), '&<AB\u00a0');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('深层嵌套的行内结构可以被精确重建', () => {
  const src = '<p>a <em>b <a href="x">c</a> d</em> e</p>';
  const doc = parseXml(src);
  assert.equal(doc.documentElement.textContent, 'a b c d e');
  assert.equal(doc.serialize(), src);
});
