/**
 * 分块 / Prompt 渲染 / 模型输出解析测试（需求第六 / 七节）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { extractBlocks } from '../../lib/book-engine/epub/sanitize.js';
import { chunkChapter, buildChunkContext } from '../../lib/book-engine/pipeline/chunker.js';
import {
  prepareChapter,
  serializeChunkSource,
  parseSegments,
  materializeChunk,
  buildRewriteSystemPrompt,
  buildRewriteUserTemplate,
  applyChunkResults,
  planChunkSizes,
} from '../../lib/book-engine/pipeline/rewrite.js';
import { checkPromptBudget, estimateTokens } from '../../lib/book-engine/llm/client.js';
import { loadPromptTemplate, renderTemplate, templateVariables, splitPromptTemplate } from '../../lib/book-engine/llm/prompts.js';
import { normalizeProfile, renderProfileForPrompt, suggestProfileFromFeedback } from '../../lib/book-engine/config/profile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const LONG_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>长章节</title></head><body>
<h1>长章节</h1>
${Array.from({ length: 40 }, (_, i) => `<p>这是第 ${i + 1} 段。${'内容'.repeat(60)}这一段用于测试分块是否会切断语义。</p>`).join('\n')}
</body></html>`;

/** 带多个小标题的章节：用来验证「章节骨架」被正确收集 */
const LONG_CHAPTER_WITH_HEADINGS = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>长章节</title></head><body>
<h1>长章节</h1>
<h2>第一节 起点</h2>
${Array.from({ length: 8 }, (_, i) => `<p>第一节的第 ${i + 1} 段。${'内容'.repeat(50)}</p>`).join('\n')}
<h2>第二节 深入</h2>
${Array.from({ length: 8 }, (_, i) => `<p>第二节的第 ${i + 1} 段。${'内容'.repeat(50)}</p>`).join('\n')}
<h2>第三节 收尾</h2>
${Array.from({ length: 8 }, (_, i) => `<p>第三节的第 ${i + 1} 段。${'内容'.repeat(50)}</p>`).join('\n')}
</body></html>`;

test('分块按目标长度切分且不切断段落', () => {
  const doc = parseXml(LONG_CHAPTER);
  const { blocks } = extractBlocks(doc);
  const chunks = chunkChapter(blocks, { targetChars: 1500, maxChars: 3000 });

  assert.ok(chunks.length > 1, '长章节必须被切成多块');
  // 所有块拼起来应当覆盖全部块，且没有重复
  const covered = chunks.flatMap((c) => c.blockIndexes);
  assert.deepEqual(covered, blocks.map((b) => b.index), '块必须被完整且不重复地覆盖');
  // 除最后一块外，每块长度不应超过上限太多
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.charCount <= 3000 + 500, `chunk ${chunk.index} 过长: ${chunk.charCount}`);
  }
});

test('每个 chunk 都带上一块摘要与下一节标题等上下文', () => {
  const doc = parseXml(LONG_CHAPTER);
  const { blocks } = extractBlocks(doc);
  const chunks = chunkChapter(blocks, { targetChars: 1200, maxChars: 2400 });
  const context = buildChunkContext({
    chunk: chunks[0],
    bookTitle: '测试书',
    chapterTitle: '长章节',
    previousSummary: '前文讲了 ABC',
    bookMemory: {
      important_concepts: ['安全边际'],
      people: ['Graham'],
      terminology: [{ term: 'margin of safety', translation: '安全边际' }],
      author_positions: ['估值需要留有余地'],
    },
  });
  assert.match(context, /书名：测试书/);
  assert.match(context, /当前章节：长章节/);
  assert.match(context, /前文摘要：前文讲了 ABC/);
  assert.match(context, /安全边际/);
  assert.match(context, /Graham/);
});

test('★ 告诉模型「你在写第几块、这不是完整章节」（防止它给每段贴结论）', () => {
  const doc = parseXml(LONG_CHAPTER);
  const { blocks } = extractBlocks(doc);
  const chunks = chunkChapter(blocks, { targetChars: 1200, maxChars: 2400 });
  assert.ok(chunks.length >= 3, '这个用例需要至少 3 块');

  // 第一块：允许点题，但只允许一次
  const first = buildChunkContext({ chunk: chunks[0], chunkTotal: chunks.length, chapterTitle: '长章节' });
  assert.match(first, /第 1 块/);
  assert.match(first, /不是完整的一节|不是完整的章节/);
  assert.match(first, /只允许一次/);

  // 中间块：必须明确「不要重新起头」「不要重复前文」
  const middle = buildChunkContext({ chunk: chunks[1], chunkTotal: chunks.length, chapterTitle: '长章节' });
  assert.match(middle, /第 2 块/);
  assert.match(middle, /不要重新起头/);
  assert.match(middle, /不要重复前文/);
  assert.ok(!/只允许一次/.test(middle), '中间块不该出现「允许点题」的说法');

  // 最后一块：也要说清楚后面没有了
  const last = buildChunkContext({ chunk: chunks[chunks.length - 1], chunkTotal: chunks.length });
  assert.match(last, new RegExp(`第 ${chunks.length} 块`));
});

test('★ 单块章节不加「第几块」的说明（那本来就是一节，点题是对的）', () => {
  const context = buildChunkContext({
    chunk: { index: 0, headingPath: '', nextHeading: '', blockIndexes: [] },
    chapterTitle: '短章节',
    chunkTotal: 1,
  });
  assert.ok(!context.includes('不要重新起头'), '单块不需要防重复的说明');
  assert.match(context, /本段序号：1/);
});

test('★ 切块尺寸必须落在模型的输出上限之内（否则会静默截断）', () => {
  /**
   * 这里的比例来自实测（scripts/probe-model-limits.mjs）：
   * 中文输出约 1.66 字/token，代码里按 1.5 留余量。
   *
   * 一开始我按「1 字 = 1 token」算，把用户的 9000 字上限压到了 5913 ——
   * 纯属自己吓自己：实测 9000 字的中文，输出只有约 5400 token。
   */
  const userConfig = planChunkSizes({
    targetCharsPerChunk: 5000,
    maxCharsPerChunk: 9000,
    maxOutputTokens: 8000,
  });
  assert.ok(userConfig.max > 8000, `8000 token 的输出额度足够放 8000 字以上，实际压到 ${userConfig.max}`);
  assert.ok(userConfig.max <= 9000, `但也不能超过用户设的上限，实际 ${userConfig.max}`);
  assert.equal(userConfig.target, 5000, 'target 本来就安全，不该被动');
  assert.equal(userConfig.targetChanged, false, 'target 没变就不该打扰用户');

  // 省钱档 6000 同样安全，不该被压
  const frugal = planChunkSizes({ targetCharsPerChunk: 6000, maxCharsPerChunk: 9000, maxOutputTokens: 8000 });
  assert.equal(frugal.target, 6000, '6000 字的块输出约 3600 token，完全放得下');
  assert.equal(frugal.targetChanged, false);

  // 输出上限很大的模型：用户设置原样保留，不做任何偷偷的改动
  const big = planChunkSizes({ targetCharsPerChunk: 5000, maxCharsPerChunk: 9000, maxOutputTokens: 64000 });
  assert.deepEqual({ t: big.target, m: big.max }, { t: 5000, m: 9000 });
  assert.equal(big.reason, null);

  // 小输出模型：必须压，否则几乎每块都截断（4096 token ≈ 6100 字）
  const small = planChunkSizes({ targetCharsPerChunk: 5000, maxCharsPerChunk: 9000, maxOutputTokens: 4096 });
  assert.ok(small.target <= 4600, `应压到 4600 字以内，实际 ${small.target}`);
  assert.equal(small.targetChanged, true);
  assert.match(small.reason, /压到|max tokens/);

  // 任何情况下 target 都不能大于 max，否则切分逻辑没有腾挪空间
  for (const args of [
    { targetCharsPerChunk: 5000, maxCharsPerChunk: 9000, maxOutputTokens: 2048 },
    { targetCharsPerChunk: 5000, maxCharsPerChunk: 200, maxOutputTokens: 8000 },
    { targetCharsPerChunk: 0, maxCharsPerChunk: 0 },
  ]) {
    const r = planChunkSizes(args);
    assert.ok(r.target <= r.max, `target(${r.target}) 不能大于 max(${r.max})`);
    assert.ok(r.target >= 800 && r.max >= 1200, '不能压到 0 或负数');
  }
});

test('★ 把上一块改写后的原话给模型，让它接着自己的话头写', () => {
  const context = buildChunkContext({
    chunk: { index: 1, headingPath: '', nextHeading: '', blockIndexes: [] },
    chunkTotal: 3,
    previousTail: '所以安全边际不是一句口号，而是一个可以计算的价格差。',
    previousSummary: '（这条不该出现，有原话时以原话为准）',
  });
  assert.match(context, /你上一块写出来的最后几句/);
  assert.match(context, /安全边际不是一句口号/);
  assert.match(context, /接着这里往下写/);
  assert.ok(!context.includes('（这条不该出现'), '有改写原话时不该再塞摘要');
});

test('★ 每一块都要知道整章有哪几节、自己在哪一节', () => {
  const context = buildChunkContext({
    chunk: {
      index: 1,
      headingPath: '第6版前言 / 今天的价值投资',
      nextHeading: '未解的投资难题',
      blockIndexes: [],
      chapterHeadings: ['第6版前言', '历久弥新', '今天的价值投资', '机构投资', '结语'],
    },
    chapterTitle: '第6版前言',
    chunkTotal: 3,
  });
  assert.match(context, /本章结构/);
  assert.match(context, /★ 今天的价值投资/, '当前小节要标出来');
  assert.match(context, /4\. 机构投资/, '后面的小节也要列出来，模型才知道别提前讲掉');
  assert.match(context, /5\. 结语/);
  // 只有一节时不用画结构图，省 token
  const single = buildChunkContext({
    chunk: { index: 0, headingPath: '前言', nextHeading: '', blockIndexes: [], chapterHeadings: ['前言'] },
    chunkTotal: 1,
  });
  assert.ok(!single.includes('本章结构'));
});

test('★ 人物是对象不是字符串，绝不能把 [object Object] 发给模型', () => {
  /**
   * 真实 bug：book-memory.json 里 people 是 [{name, note}]，
   * 而上下文里直接 .join('、') —— 于是「已出现的人物：[object Object]、…」
   * 被发给了模型整整一本书、每一次调用。不报错，只是安静地烂在提示词里。
   */
  const context = buildChunkContext({
    chunk: { index: 0, headingPath: '', nextHeading: '', blockIndexes: [] },
    chunkTotal: 1,
    bookMemory: {
      people: [
        { name: '沃伦·巴菲特', note: '伯克希尔董事长，格雷厄姆的学生' },
        { name: '塞思·卡拉曼', note: 'Baupost 对冲基金总裁' },
      ],
      important_concepts: ['安全边际'],
      terminology: [{ term: 'margin of safety', translation: '安全边际' }],
      author_positions: ['估值需要留有余地'],
    },
  });
  assert.ok(!context.includes('[object Object]'), `又把对象当字符串用了：\n${context}`);
  assert.match(context, /已出现的人物：沃伦·巴菲特、塞思·卡拉曼/);
  assert.match(context, /margin of safety=安全边际/);

  // 兼容老格式（字符串数组）和老数据里的脏值
  const legacy = buildChunkContext({
    chunk: { index: 0, headingPath: '', nextHeading: '', blockIndexes: [] },
    chunkTotal: 1,
    bookMemory: { people: ['格雷厄姆', null, { note: '没有名字' }, { name: '多德' }] },
  });
  assert.ok(!legacy.includes('[object Object]'));
  assert.match(legacy, /已出现的人物：格雷厄姆、多德/);
});

test('★ chunkChapter 会把章节骨架挂在每一块上', () => {
  const doc = parseXml(LONG_CHAPTER_WITH_HEADINGS);
  const { blocks } = extractBlocks(doc);
  const chunks = chunkChapter(blocks, { targetChars: 800, maxChars: 1600, chapterTitle: '长章节' });
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(Array.isArray(c.chapterHeadings), '每块都要带章节骨架');
    assert.deepEqual(c.chapterHeadings, chunks[0].chapterHeadings, '各块的骨架必须一致');
  }
  assert.ok(chunks[0].chapterHeadings.length >= 3, `应收集到多个小标题，实际 ${JSON.stringify(chunks[0].chapterHeadings)}`);
});

test('serializeChunkSource 用【段 N】标记段落', () => {
  const prepared = prepareChapter(LONG_CHAPTER, { targetCharsPerChunk: 100000 });
  const chunk = materializeChunk(prepared.chunks[0]);
  const source = serializeChunkSource(chunk);
  assert.match(source, /^【段 1】/);
  assert.match(source, /【段 2】/);
  // 每段一行标记，数量与块数一致
  assert.equal((source.match(/【段 \d+】/g) || []).length, chunk.blocks.length);
});

test('parseSegments 正确切分模型输出', () => {
  const text = `【段 1】第一段改写。
【段 2】第二段改写，
跨了两行。
【段 3】第三段。`;
  const parts = parseSegments(text, 3);
  assert.equal(parts[0], '第一段改写。');
  assert.equal(parts[1], '第二段改写，\n跨了两行。');
  assert.equal(parts[2], '第三段。');
});

test('parseSegments 对缺失段返回 null（触发逐段回退）', () => {
  const parts = parseSegments('【段 1】只有第一段。', 3);
  assert.equal(parts[0], '只有第一段。');
  assert.equal(parts[1], null);
  assert.equal(parts[2], null);
});

test('parseSegments 对重复段号合并而不是丢弃', () => {
  const parts = parseSegments('【段 1】A【段 1】B', 1);
  assert.equal(parts[0], 'A\nB');
});

test('parseSegments 忽略越界段号', () => {
  const parts = parseSegments('【段 5】越界内容', 2);
  assert.deepEqual(parts, [null, null]);
});

test('prepareChapter 返回块、被跳过的块与 chunk', () => {
  const prepared = prepareChapter(LONG_CHAPTER, { targetCharsPerChunk: 5000 });
  assert.ok(prepared.blocks.length >= 41);
  assert.equal(prepared.skipped.length, 0);
  assert.ok(prepared.chunks.length >= 1);
});

test('渲染 Prompt 模板：变量被替换，缺失变量变成（无）', () => {
  const template = 'A={{READER_PROFILE}}\nB={{SOURCE_TEXT}}\nC={{UNKNOWN_VAR}}';
  const out = renderTemplate(template, { READER_PROFILE: '画像', SOURCE_TEXT: '原文' });
  assert.equal(out, 'A=画像\nB=原文\nC={{UNKNOWN_VAR}}');
  const empty = renderTemplate('X={{SOURCE_TEXT}}', { SOURCE_TEXT: '' });
  assert.equal(empty, 'X=（无）');
});

test('templateVariables 列出所有变量', () => {
  const vars = templateVariables('{{A}} {{B}} {{A}}');
  assert.deepEqual(vars.sort(), ['A', 'B']);
});

test('真实的 rewrite-system.txt 可加载且包含全部必需变量', async () => {
  const loaded = await loadPromptTemplate(ROOT, 'prompts/rewrite-system.txt');
  assert.equal(loaded.source, 'file');
  const vars = templateVariables(loaded.template);
  for (const required of ['READER_PROFILE', 'BOOK_CONTEXT', 'CHAPTER_CONTEXT', 'PREVIOUS_CONTEXT', 'SOURCE_TEXT']) {
    assert.ok(vars.includes(required), `缺少变量 ${required}`);
  }
  /**
   * 需求第六节那 17 条禁令必须仍然在 —— 措辞可以换，**约束本身一条都不能丢**。
   * 这里改成按「约束的语义」断言，而不是逐字匹配某一句：
   * 提示词大改过一轮（见 prompts/rewrite-system-classic.txt），
   * 逐字断言会让「改写措辞」和「删掉规则」变得无法区分。
   */
  const mustKeep = [
    /不得改变作者观点|作者的观点、立场、褒贬/,
    /不得捏造|不许加|不能凭空|原文没有的数据、人物、事件、案例/,
    /政治立场|美化、审查/,
    /不确定|限定语|不确定的程度/,
    /不能写成作者自己的观点|引用别人/,
    /已经定论|有争议/,
  ];
  for (const re of mustKeep) {
    assert.ok(re.test(loaded.template), `Prompt 缺少这条约束：${re}`);
  }
  // 占位符约定必须写清楚
  assert.ok(loaded.template.includes('⟦12⟧'));
});

test('review / memory prompt 也能加载', async () => {
  const review = await loadPromptTemplate(ROOT, 'prompts/review-system.txt');
  const memory = await loadPromptTemplate(ROOT, 'prompts/memory-system.txt');
  assert.equal(review.source, 'file');
  assert.equal(memory.source, 'file');
  assert.ok(review.template.includes('omission'));
  assert.ok(memory.template.includes('book_summary'));
});

test('缺少 Prompt 文件时回落到内置文案并给出告警', async () => {
  const loaded = await loadPromptTemplate(ROOT, 'prompts/does-not-exist.txt');
  assert.equal(loaded.source, 'fallback');
  assert.ok(loaded.warning);
  assert.ok(loaded.template.length > 0);
});

test('system prompt 只含角色与规则，不含任何变量占位', () => {
  const template = '角色说明\n\n规则一\n\n读者画像：\n\n{{READER_PROFILE}}\n\n原文：\n\n{{SOURCE_TEXT}}\n';
  const system = buildRewriteSystemPrompt(template);
  assert.ok(!system.includes('{{'), system);
  assert.ok(system.includes('规则一'));
  assert.ok(!system.includes('{{SOURCE_TEXT}}'));
  // 变量块本身的行也不能混进 system prompt
  assert.ok(!system.includes('原文：'), system);
});

test('模板切分：标签行跟随变量进入 user，system 不留悬空标题', () => {
  const template = '角色\n\n规则\n\n读者画像：\n\n{{READER_PROFILE}}\n\n原文：\n\n{{SOURCE_TEXT}}\n';
  const split = splitPromptTemplate(template);
  assert.equal(split.system, '角色\n\n规则');
  assert.ok(split.user.startsWith('读者画像：'), split.user);
  assert.ok(split.user.includes('{{READER_PROFILE}}'));
  // system 末尾不能是「…：」这种悬空标签
  assert.ok(!/[：:]\s*$/.test(split.system), `system 以悬空标题结尾: ${JSON.stringify(split.system)}`);
});

test('规则不会在 system 与 user 里重复出现（省 token、避免歧义）', () => {
  const template = '规则A\n规则B\n\n画像：\n{{READER_PROFILE}}\n\n原文：\n{{SOURCE_TEXT}}\n';
  const system = buildRewriteSystemPrompt(template);
  const userTemplate = buildRewriteUserTemplate(template);
  assert.ok(system.includes('规则A') && system.includes('规则B'));
  assert.ok(!userTemplate.includes('规则A'), 'user 里不应重复规则');
  assert.ok(!userTemplate.includes('规则B'), 'user 里不应重复规则');
  assert.ok(userTemplate.includes('{{SOURCE_TEXT}}'));
});

test('模板切分对没有变量的模板安全降级', () => {
  const split = splitPromptTemplate('只有说明，没有变量。');
  assert.equal(split.system, '只有说明，没有变量。');
  assert.equal(split.user, '');
  // user 模板必须至少包含 SOURCE_TEXT，否则模型看不到原文
  assert.ok(buildRewriteUserTemplate('只有说明，没有变量。').includes('{{SOURCE_TEXT}}'));
});

test('模板切分对空输入不抛错', () => {
  assert.deepEqual(splitPromptTemplate(''), { system: '', user: '' });
  assert.deepEqual(splitPromptTemplate(null), { system: '', user: '' });
});

test('真实 Prompt 切分后：system 有规则、user 有画像与原文，且无重复', async () => {
  const loaded = await loadPromptTemplate(ROOT, 'prompts/rewrite-system.txt');
  const split = splitPromptTemplate(loaded.template);

  assert.ok(/作者的观点、立场、褒贬|不得改变作者观点/.test(split.system), 'system 必须含核心规则');
  assert.ok(split.system.includes('⟦12⟧'), 'system 必须含占位符规则');
  assert.ok(!split.system.includes('{{'), 'system 不能有未替换变量');
  assert.ok(!/[：:]\s*$/.test(split.system), 'system 不能以悬空标题结尾');

  assert.ok(split.user.includes('{{READER_PROFILE}}'));
  assert.ok(split.user.includes('{{SOURCE_TEXT}}'));
  assert.ok(!/作者的观点、立场、褒贬/.test(split.user), 'user 不应重复规则');

  // 切分后总长度不应显著短于原文（不能丢内容）
  const combined = split.system.length + split.user.length;
  assert.ok(combined >= loaded.template.trim().length - 10, '切分不应丢失模板内容');
});

/* ------------------------------------------------------- 体积预算 -- */

test('estimateTokens 对中英文给出保守估计', () => {
  assert.ok(estimateTokens('中文十个字') >= 5, '中文按接近 1 字 1 token 估算');
  assert.ok(estimateTokens('a'.repeat(350)) <= 120, '英文按约 3.5 字符 1 token 估算');
  assert.equal(estimateTokens(''), 0);
});

test('checkPromptBudget 在超限时给出可操作的提示', () => {
  const small = checkPromptBudget([{ role: 'user', content: '短' }], { maxInputChars: 100 });
  assert.equal(small.ok, true);

  const big = checkPromptBudget([{ role: 'user', content: 'x'.repeat(5000) }], { maxInputChars: 1000 });
  assert.equal(big.ok, false);
  assert.ok(big.message.includes('每 chunk 最大字符数'), '提示要能指导用户怎么改');
  assert.ok(big.message.includes('Reader Profile'), '提示要指出画像也是体积来源');
});

test('真实画像 + 真实 Prompt 的输入体积在默认安全线内', async () => {
  const { loadProfile, renderProfileForPrompt } = await import('../../lib/book-engine/config/profile.js');
  const { estimateTokens: est } = await import('../../lib/book-engine/llm/client.js');
  const profile = await loadProfile(ROOT);
  const block = renderProfileForPrompt(profile);
  const loaded = await loadPromptTemplate(ROOT, 'prompts/rewrite-system.txt');

  const system = buildRewriteSystemPrompt(loaded.template);
  const budget = checkPromptBudget([
    { role: 'system', content: system },
    { role: 'user', content: block },
  ]);
  assert.equal(budget.ok, true, `画像 + system 已经超限: ${budget.chars} 字符`);
  // 记录实际开销，方便判断是否需要精简画像
  assert.ok(
    budget.tokens < 20000,
    `画像固定开销过大（≈${budget.tokens} tokens），应精简或调大 chunk`,
  );
  assert.ok(est(block) > 0);
});

test('真实 Prompt 的 system 部分保留了占位符规则（否则脚注会被改坏）', async () => {
  const loaded = await loadPromptTemplate(ROOT, 'prompts/rewrite-system.txt');
  const system = buildRewriteSystemPrompt(loaded.template);
  assert.ok(system.includes('⟦12⟧'), 'system prompt 必须说明占位符约定');
  assert.ok(/作者的观点、立场、褒贬|不得改变作者观点/.test(system));
  assert.ok(!system.includes('{{READER_PROFILE}}'));
  assert.ok(system.length > 800, 'system prompt 不应该被截得过短');
});

test('★ 真实 Prompt 里点名禁止了模板腔引导语', async () => {
  const loaded = await loadPromptTemplate(ROOT, 'prompts/rewrite-system.txt');
  const system = buildRewriteSystemPrompt(loaded.template);
  /**
   * 只写「不要啰嗦」是不够的 —— 模型照加不误。必须把用户实际看到的
   * 那句话原样点名，它才知道你在说哪一件具体的事。
   */
  assert.ok(system.includes('这一节的核心结论是'), '要点名具体的模板句');
  assert.ok(system.includes('不要给段落贴引导语'));
  assert.ok(system.includes('原文那句话里没有这层意思，你就一个字都不要加'));
  assert.ok(system.includes('不是在替读者做笔记'));
});

test('★ 光有「不要」会把模型吓成照抄，必须有正向的改写幅度要求', () => {
  /**
   * 实测两次，都是真实事故：
   *
   * 1. 用户第 10 章 16k 字，成品里 92.4% 的句子和原文逐字相同，
   *    模型只是给每段贴了一句「这一节的核心结论是：」就交差了。
   * 2. 只用「不得……」把模型框住时，整章一次调用的改写率是 **0.9%**
   *    —— 它把原文一字不改地还了回来（三次里三次）。
   *
   * 结论：光禁止不产出，必须同时给出**正向的、可判断的**改写幅度要求，
   * 而且要明说「不许多加事实 ≠ 不许把话说长」，否则模型会拿怕编造当借口。
   */
  return loadPromptTemplate(ROOT, 'prompts/rewrite-system.txt').then((loaded) => {
    const system = buildRewriteSystemPrompt(loaded.template);
    assert.ok(/不许照抄|不是「润色」/.test(system), '要点明这是重写、不是润色');
    assert.ok(/如果你写出来的句子和原文一模一样/.test(system), '要给出可自查的失败判据');
    assert.ok(/1\.4～1\.8 倍|1\.4~1\.8 倍/.test(system), '要给可执行的篇幅目标');
    assert.ok(system.includes('改的是说法，不是内容'), '要划清改与不改的界线');
    assert.ok(
      /不许多加事实」不等于「不许把话说长/.test(system),
      '要说清「怕编造」不能变成「整段原样还回去」的借口',
    );
    for (const must of ['把术语翻译成人话', '把抽象的说法落到具体场景', '把数字变成一个能感觉到的量']) {
      assert.ok(system.includes(must), `缺少正向改写手法：${must}`);
    }
    // 【段 N】的语义必须说清楚，否则模型会把自然段当小节，逐段贴结论
    assert.ok(system.includes('是自然段，不是小节'));
  });
});

test('★ applyChunkResults 会在真实链路上剥掉模板腔（不是只写了函数没人用）', () => {
  const html = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>
<h1>标题</h1>
<p>尽管《证券分析》写于75年前，书中案例已经年代久远，但它阐述的投资方法至今依然管用。</p>
<p>价值投资不是一套机械地寻找便宜股票的工具，而是一种完整的投资哲学。</p>
<p>大多数冲进股市的人其实是在投机而非投资，他们赌的是价格快速上涨。</p>
</body></html>`;
  const doc = parseXml(html);
  const { blocks } = extractBlocks(doc);
  const chunks = chunkChapter(blocks, { targetChars: 100000, maxChars: 100000 });
  const chunk = materializeChunk(chunks[0]);

  // 模型输出：每段都被贴上了「这一节的核心结论是：」
  const segmentTexts = {};
  chunk.blockTexts.forEach((text, i) => {
    if (i === 0) {
      segmentTexts[i] = text; // 标题原样
      return;
    }
    segmentTexts[i] = `这一节的核心结论是：${text}`;
  });

  const { stats } = applyChunkResults({
    doc,
    chunk,
    segmentTexts,
  });

  assert.equal(stats.leadInStripped, 3, `应剥掉 3 处，实际 ${stats.leadInStripped}`);
  const out = doc.serialize();
  const occurrences = (out.match(/这一节的核心结论是/g) || []).length;
  assert.equal(occurrences, 0, `成稿里不该再出现模板腔，实际还有 ${occurrences} 处`);
  assert.ok(out.includes('尽管《证券分析》写于75年前'), '正文内容不能丢');
  assert.ok(out.includes('大多数冲进股市的人其实是在投机'), '正文内容不能丢');
});

test('★ applyChunkResults 会剥掉模型搬进来的脚注署名（用户的抱怨：融进正文还标「——某某注」）', () => {
  const html = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>
<h1>标题</h1>
<p>1935年到1939年的平均水平作为新的基准。</p>
<p>账面价值等于总资产减去总负债。</p>
<p>总部设在纽约州的哈奇森，这个案子值得细看。</p>
</body></html>`;
  const doc = parseXml(html);
  const { blocks } = extractBlocks(doc);
  const chunks = chunkChapter(blocks, { targetChars: 100000, maxChars: 100000 });
  const chunk = materializeChunk(chunks[0]);

  /**
   * 模型输出：把注释原样搬了进来，连末尾的署名一起。
   *
   * 第 3 段的署名故意接在**逗号**后面 —— 位置判据（前面必须是句末标点）抓不到它，
   * 只有「闭集里有这个名字」这条能抓。这样才能证明 `signatures` 真的被用上了，
   * 而不是躺在参数列表里没人读。
   */
  const segmentTexts = {};
  chunk.blockTexts.forEach((text, i) => {
    if (i === 0) {
      segmentTexts[i] = text; // 标题原样
      return;
    }
    if (i === 3) {
      segmentTexts[i] = text.replace('，这个案子值得细看。', '，——译者注 这个案子值得细看。');
      return;
    }
    segmentTexts[i] = `${text}——译者注 `;
  });

  const { stats } = applyChunkResults({
    doc,
    chunk,
    segmentTexts,
    signatures: new Set(['译者注', '作者注']),
  });

  assert.equal(stats.noteAttrStripped, 3, `应剥掉 3 处署名，实际 ${stats.noteAttrStripped}`);
  const out = doc.serialize();
  const left = (out.match(/译者注/g) || []).length;
  assert.equal(left, 0, `成稿里不该再出现署名，实际还有 ${left} 处：${out}`);
  assert.ok(out.includes('平均水平作为新的基准。'), '正文内容不能丢');
  assert.ok(out.includes('总资产减去总负债'), '正文内容不能丢');
  assert.ok(out.includes('这个案子值得细看'), '正文内容不能丢');
});

test('Reader Profile 渲染成可读文本，空画像有兜底说明', () => {
  const profile = normalizeProfile({
    about_me: '我有自动化背景。',
    preferred_style: ['直接', '逻辑清晰', '直接'],
    weak_topics: '货币银行学\n期权定价',
  });
  assert.deepEqual(profile.preferred_style, ['直接', '逻辑清晰'], '应当去重');
  assert.deepEqual(profile.weak_topics, ['货币银行学', '期权定价'], '字符串应按行拆分');

  const rendered = renderProfileForPrompt(profile);
  assert.match(rendered, /关于我：我有自动化背景。/);
  assert.match(rendered, /- 逻辑清晰/);

  const empty = renderProfileForPrompt({});
  assert.match(empty, /尚未填写画像/);
});

test('Feedback 只生成建议，不直接改画像', () => {
  const profile = normalizeProfile({ preferred_style: ['直接'] });
  const before = JSON.stringify(profile);
  const { profile: suggested, notes, changed } = suggestProfileFromFeedback(
    profile,
    '我觉得改得太短了，而且解释太多，小标题不要那么多',
    ['太短', '解释太多', '小标题'],
  );
  assert.equal(JSON.stringify(profile), before, '原画像对象不能被改动');
  assert.equal(changed, true);
  assert.ok(suggested.preferred_style.length > profile.preferred_style.length);
  assert.ok(suggested.disliked_style.length > 0);
  assert.ok(suggested.custom_instructions.includes('改得太短'));
  assert.ok(notes.length >= 3);
});
