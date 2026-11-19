/**
 * 章名和正文必须是同一种字。
 *
 * 真实成品里的样子（《朝花夕拾》导出后第 2 章）：
 *
 *     阿長與《山海經》：阿长买来绘图《山海经》、除夕福橘与长毛禁忌
 *     ────── 繁体 ──────  ──────────── 简体 ────────────
 *
 * 前半截是模型抄的原书目录（繁体来源），后半截是它自己写的说明。
 * 标题是读者最先看到的一行，一半繁体一半简体，整本书看起来就像排版坏了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { hanScriptOf, alignTitleToBody } from '../../lib/book-engine/pipeline/han-variants.js';
import { applyNames, stripStrategySuffix } from '../../lib/book-engine/pipeline/book-plan.js';

const SIMPLE = '长妈妈，前面已经说过，她是一个一向带着我的女工。她喜欢切切察察，向人们低声絮说些什么事。';
const TRAD = '長媽媽，前面已經說過，她是一個一向帶著我的女工。她喜歡切切察察，向人們低聲絮說些什麼事。';

test('能看出正文是简体还是繁体', () => {
  assert.equal(hanScriptOf(SIMPLE), 'simplified');
  assert.equal(hanScriptOf(TRAD), 'traditional');
});

test('太短或不是中文的正文不下判断（不能拿一句话去猜全书的字）', () => {
  assert.equal(hanScriptOf('好的'), 'none');
  assert.equal(hanScriptOf('Chapter One. A Short History of Everything.'), 'none');
});

test('简体正文配繁体标题：标题跟着正文转简体', () => {
  assert.equal(
    alignTitleToBody('阿長與《山海經》：阿长买来绘图《山海经》', SIMPLE),
    '阿长与《山海经》：阿长买来绘图《山海经》',
  );
});

test('★ 简体为主、只夹了几个繁体字的正文（mixed）也按简体对齐', () => {
  const mixed = `${SIMPLE}此后我就更其搜集绘图的書。`;
  assert.equal(hanScriptOf(mixed), 'mixed');
  assert.equal(alignTitleToBody('阿長與《山海經》', mixed), '阿长与《山海经》');
});

test('繁体正文配繁体标题：一个字都不动（没改写的章节保持原样）', () => {
  assert.equal(alignTitleToBody('阿長與《山海經》', TRAD), '阿長與《山海經》');
});

test('日文 / 西文正文不动标题（宁可不改，也不能把外文书名转坏）', () => {
  const ja = 'これは日本語の文章です。漢字も含まれています。';
  assert.equal(alignTitleToBody('吾輩は猫である', ja), '吾輩は猫である');
  assert.equal(alignTitleToBody('A Tale of Two Cities', 'It was the best of times.'), 'A Tale of Two Cities');
});

test('★ 名字里「· 已压缩为一页提要」这类按当时方案写的后缀要去掉', () => {
  assert.equal(stripStrategySuffix('小引：写作缘起 · 已压缩为一页提要'), '小引：写作缘起');
  assert.equal(stripStrategySuffix('后记·已压缩为提要'), '后记');
  assert.equal(stripStrategySuffix('藤野先生：弃医从文'), '藤野先生：弃医从文', '没有后缀就原样返回');

  const plan = applyNames(
    { entries: [{ index: 3, title: '小引' }] },
    { 3: '小引：写作缘起 · 已压缩为一页提要' },
  );
  assert.equal(plan.entries[0].displayTitle, '小引：写作缘起');
});

/**
 * 维基文库的导出说明页：目录里叫「关于」，正文顶着一个英文大标题
 * 「About this digital edition」。这一章是「原样保留」的，正文不能改写，
 * 但标题是**版面的一部分** —— 翻进去看到英文大标题，会以为排版漏了一页。
 */
test('★ 保留章节的英文大标题，换成方案里的中文名（英文书不受影响）', async () => {
  const { alignForeignHeading } = await import('../../lib/book-engine/pipeline/book-service.js');
  const about = `<html><head><title>About this digital edition</title></head><body class="mw"><h1 id="About">About this digital edition</h1><p>This e-book comes from Wikisource.</p></body></html>`;
  const out = alignForeignHeading(about, '关于：维基文库来源、CC BY-SA 3.0 授权与贡献者名单');
  assert.ok(out.includes('<h1 id="About">关于：维基文库来源、CC BY-SA 3.0 授权与贡献者名单</h1>'), out);
  assert.ok(out.includes('This e-book comes from Wikisource.'), '正文一个字段都不能动');

  // 英文书：方案标题也是英文 → 不动
  const en = `<html><body><h1>About this digital edition</h1><p>Text</p></body></html>`;
  assert.equal(alignForeignHeading(en, 'About This Edition'), en);

  // 正文标题本来就是中文 → 不动
  const zh = `<html><body><h1>藤野先生</h1><p>正文</p></body></html>`;
  assert.equal(alignForeignHeading(zh, '藤野先生：弃医从文'), zh);
});

test('★ 命名模型把「· 已压缩为一页提要」放在冒号前，也要去掉', () => {
  assert.equal(
    stripStrategySuffix('小引·已压缩为一页提要：鲁迅自述《旧事重提》改名《朝花夕拾》'),
    '小引：鲁迅自述《旧事重提》改名《朝花夕拾》',
  );
  assert.equal(
    stripStrategySuffix('后记·已压缩为一页提要：考订麻胡子应作麻祜'),
    '后记：考订麻胡子应作麻祜',
  );
  // 不是后缀、只是正文里提到「提要」的，不能误删
  assert.equal(stripStrategySuffix('前言里的提要说明'), '前言里的提要说明');
});
