/**
 * 成品排版样式（viewport + PBE 样式）的测试。
 *
 * 起因：v27 成品的布局核验发现两件事 ——
 *   1. 阅读路径页一个样式都没有（`cssHref` 没人传，`.rp-*` 规则也不存在），
 *      标签文字直接贴在标题后面连排；
 *   2. 所有页面都没有 viewport，手机浏览器按 980px 排版再缩放，字小到看不清。
 *
 * 这里守住三件事：插得进去、只插一次、拆坏的页面不许二次伤害。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { injectPbeStyle, pbeHeadSnippet, PBE_STYLE_CSS, PBE_VIEWPORT } from '../../lib/book-engine/epub/pbe-style.js';
import { renderReadingPathPage } from '../../lib/book-engine/pipeline/reading-path.js';

const PAGE = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>一章</title>
<link rel="stylesheet" type="text/css" href="styles/main.css"/></head>
<body><p>正文</p></body></html>`;

test('★ 样式与 viewport 插在 </head> 之前，位于原样式表之后', () => {
  const out = injectPbeStyle(PAGE);
  assert.ok(out.includes(PBE_VIEWPORT), '缺 viewport');
  assert.ok(out.includes('data-pbe-style="1"'), '缺样式标记');
  assert.ok(out.includes('.rp-toc'), '缺阅读路径页的样式规则');
  // 顺序：原样式表 -> 我们的样式 -> </head>
  const linkAt = out.indexOf('styles/main.css');
  const styleAt = out.indexOf('data-pbe-style="1"');
  const headEndAt = out.indexOf('</head>');
  assert.ok(linkAt >= 0 && styleAt > linkAt, '样式必须在原样式表之后才覆盖得住');
  assert.ok(headEndAt > styleAt, '样式必须还在 head 里');
});

test('★ 幂等：重复注入只留一份', () => {
  const once = injectPbeStyle(PAGE);
  const twice = injectPbeStyle(once);
  assert.equal(twice, once);
  assert.equal((twice.match(/data-pbe-style="1"/g) || []).length, 1);
});

test('没有 </head> 的页面原样返回，不做二次伤害', () => {
  const broken = '<html><body><p>没有 head</p></body></html>';
  assert.equal(injectPbeStyle(broken), broken);
});

test('空输入不炸', () => {
  assert.equal(injectPbeStyle(''), '');
  assert.equal(injectPbeStyle(null), '');
  assert.equal(injectPbeStyle(undefined), '');
});

test('★ 阅读路径页自带样式和 viewport，不再依赖没人传的 cssHref', () => {
  const page = renderReadingPathPage(
    {
      entries: [
        { index: 0, title: '第一章', strategy: 'keep', value: 'core', chars: 1200, card: { summary: '讲了什么' } },
      ],
      order: [0],
    },
    { bookTitle: '测试书' },
  );
  assert.ok(page.includes(PBE_VIEWPORT), '阅读路径页缺 viewport');
  assert.ok(page.includes('data-pbe-style="1"'), '阅读路径页缺样式');
  assert.ok(page.includes('<ol class="rp-toc">'), '阅读路径页结构变了，检查测试前提');
});

test('★ 阅读路径页输出的每个 rp-* 类，样式表里都得有规则', () => {
  // 这一条是防「页面输出了一个新类、忘了写样式」这种漏 —— 上一版
  // .rp-foot / .rp-reasons 就是这么裸奔的。
  // 输出必须覆盖全部分支（提要/移除/知识点/掠读/理由/脚注），否则扫不到
  // 那几个只在特定分支出现的类，等于白守。
  const page = renderReadingPathPage(
    {
      entries: [
        { index: 0, title: '引言', strategy: 'keep', value: 'core', chars: 1200, reason: '整本的前提', card: { summary: '讲了前提', knowledgePoints: ['要点一'], fillerParts: ['寒暄', '客套。'] } },
        { index: 1, title: '提要章', strategy: 'digest', value: 'useful', chars: 5000, card: { summary: '压成半页' } },
        { index: 2, title: '速读章', strategy: 'skip', value: 'low', chars: 800, card: { summary: '翻翻就行' } },
        { index: 3, title: '附录', strategy: 'skip', value: 'low', chars: 300, reason: '纯索引' },
      ],
      order: [0, 1, 2],
      frontMatterNote: '前面的小引压成一页提要。',
      overview: '先立前提，再看方法。',
      readingPath: ['先读引言定框架'],
    },
    {
      bookTitle: '测试书',
      digestedIndexes: new Set([1]),
      droppedIndexes: new Set([3]),
      droppedParagraphs: new Map([[0, 2]]),
      noteInline: { total: 12, stripped: 10 },
      generatedAt: '2026-11-17T00:00:00Z',
    },
  );
  const classes = new Set([...page.matchAll(/class="(rp-[a-z-]+)/g)].map((m) => m[1]));
  // 真实成品页有 14 个；扫到的少说明测试输入没覆盖全部分支
  assert.ok(classes.size >= 13, `只扫到 ${classes.size} 个 rp-* 类，测试输入没覆盖全分支`);
  // 用法名当词边界：`.rp-t` 不能靠 `.rp-toc` 混过去
  const unstyled = [...classes].filter((c) => !new RegExp(`\\.${c}(?![\\w-])`).test(PBE_STYLE_CSS));
  assert.deepEqual(unstyled, [], `这些类没有样式规则：${unstyled.join(', ')}`);
});

test('★ </head> 出现在注释里时，样式插进真正的 head 末尾', () => {
  const page = `<?xml version="1.0" encoding="utf-8"?>
<html><head><title>T</title>
<!-- 模板说明：每页都要有 </head> 收尾 -->
<link rel="stylesheet" href="styles/main.css"/></head>
<body><p>正文</p></body></html>`;
  const out = injectPbeStyle(page);
  const styleAt = out.indexOf('data-pbe-style="1"');
  const commentEnd = out.indexOf('-->');
  assert.ok(styleAt > commentEnd, '样式不能插进注释里');
  // 插完之后 head 里要有样式，且原来那句注释一个字没动
  assert.ok(out.lastIndexOf('</head>') > styleAt, '样式必须还在真正的 head 里');
  assert.ok(out.includes('每页都要有 </head> 收尾'), '注释被改动了');
});

test('★ </head> 出现在 CDATA / script 里时，样式也插进真正的 head 末尾', () => {
  const page = `<html><head><title>T</title>
<style typeof="mw:Extension/templatestyles"><![CDATA[.a::after{content:"</head>"}]]></style>
<script>var t = "</head>";</script></head><body><p>正文</p></body></html>`;
  const out = injectPbeStyle(page);
  const styleAt = out.indexOf('data-pbe-style="1"');
  // 不能落进 CDATA 或 script 里：那里面的原文必须一个字符不动
  assert.ok(out.includes('content:"</head>"'), 'CDATA 里的 CSS 被改动了');
  assert.ok(out.includes('var t = "</head>";'), 'script 正文被改动了');
  assert.ok(out.lastIndexOf('</head>') > styleAt, '样式必须插在真正的 head 末尾');
  assert.ok(out.indexOf('<body>') > styleAt, '样式必须在 body 之前');
});

test('注释里出现标记属性，不该让这页跳过注入', () => {
  const page = `<html><head><title>T</title>
<!-- 上一版插入的写法：<style data-pbe-style="1">…</style> --></head><body></body></html>`;
  const out = injectPbeStyle(page);
  assert.notEqual(out, page, '被注释里的标记骗过去了，这页永远没样式');
  assert.equal((out.match(/data-pbe-style="1"/g) || []).length, 2, '注释里的那句不算，真实样式要插一份');
  assert.equal(injectPbeStyle(out), out, '插过之后必须幂等');
});

test('样式里不许出现会破坏 XHTML 的字符', () => {
  const snippet = pbeHeadSnippet();
  assert.equal((snippet.match(/<style\b/g) || []).length, 1, '只能有一个 style 开标签');
  assert.equal((snippet.match(/<\/style>/g) || []).length, 1, '只能有一个 style 闭标签');
  // 裸 & 会让 XML 解析直接报错；< 出现在 CSS 里也危险
  assert.ok(!/&(?!(amp|lt|gt|quot|#\d+);)/.test(snippet), '裸 & 会破坏 XML 解析');
  assert.ok(!PBE_STYLE_CSS.includes('<'), 'CSS 里出现 < 会破坏 XML 解析');
});
