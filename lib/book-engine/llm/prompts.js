/**
 * Prompt 模板加载与渲染。
 *
 * 需求第六节：核心 Prompt 必须独立放在 prompts/*.txt，不硬编码在业务逻辑里。
 * 这里只做「读文件 + 变量替换」，缺文件时回落到内置文案并给出告警。
 */

import path from 'node:path';
import { readText, exists } from '../util/fsx.js';

/** 内置兜底文案（只在 prompts/ 文件缺失或为空时使用）。 */
export const FALLBACK_PROMPTS = {
  'rewrite-system.txt': [
    '你是一名专业的「个性化书籍编辑器」。',
    '你的任务不是创作新书，也不是总结原文，而是在忠实保留原作者知识、事实、观点、',
    '论证、案例和重要细节的前提下，按读者画像重新编辑表达方式。',
    '',
    '必须遵守：不得改变作者观点；不得捏造原文不存在的事实；不得删除重要论证过程；',
    '不得删除重要数字、人物、案例、时间、条件和限定语；不得为简洁牺牲重要知识；',
    '可以删除明显重复表达；可以拆分复杂句子；可以增加小标题；',
    '可以对复杂概念增加简短解释；可以减少读者已熟悉内容的基础解释；',
    '可以使用类比但不得改变事实含义；作者不确定时不得改成确定结论；',
    '作者有争议时保留争议性；引用他人观点不得误写成作者观点；',
    '不进行政治立场、美化、审查或价值观修正；不偷偷修改作者观点。',
    '',
    '原文中的占位符号 ⟦12⟧ 与 ⟦/12⟧ 代表链接、脚注、图片等结构，必须原样保留在原来的语义位置。',
    '不要输出任何 HTML 或 Markdown 标记。',
    '',
    '输出格式：原文用「【段 N】」标记段落，逐段处理，每段以 `【段 N】` 开头，',
    '不要合并或拆分段落，不要输出解释或代码块围栏。',
  ].join('\n'),
  'review-system.txt': [
    '你是一名严格的内容审校员。逐段对比原文与改写后文本，只判断 5 类问题：',
    'omission（遗漏知识）、viewpoint（改变观点）、fabrication（捏造事实）、',
    'oversummary（过度总结）、number（数字或专名变化）。',
    '只输出严格 JSON：{"score":0-100,"verdict":"pass|revise","issues":[...],"summary":"..."}',
  ].join('\n'),
  'memory-system.txt': [
    '你在维护一本书的长期记忆。根据已有记忆与本章原文，输出更新后的记忆 JSON。',
    '只记录原文明确出现的信息。输出严格 JSON，结构必须与输入一致。',
  ].join('\n'),
  /**
   * 补讲 Prompt 必须有独立兜底。
   *
   * fallbackPromptFor 对未知文件名会回落到「改写 Prompt」——那是能跑就行。
   * 但这一遍的输入是**已经改写好的正文**，用改写 Prompt 会把它再改一遍，
   * 等于一章改写两次，读者拿到的还是那个「换词版」。
   */
  'explain-system.txt': [
    '你是给一本书做最后一遍「读者补讲」的编辑。',
    '输入的每段文字已经通顺，不需要润色。只做两件事：',
    '一、读者会卡住的地方（术语、典故、旧时事物、跳过的推理、抽象说法）把解释化进句子讲开，',
    '不卡住的地方一个字都不要动；',
    '二、整段没有任何知识、事实、观点、情节或论证的，标出来删掉；不确定就不删。',
    '标题、首末段、含脚注标记的段落、对话一律不删。',
    '',
    '输出：只写插入点，不要重写原文。格式为 `【补 3】「逐字照抄的锚点」→ 只新增的一两句话`',
    '或 `【删 7】理由`。锚点必须在该段内只出现一次，且落在行内标记之外；',
    '都不需要时只输出「无需处理」。',
    '正文里的 ⟦1⟧…⟦/1⟧ 是行内标记，照抄锚点时不要带上它们。',
  ].join('\n'),
};

/**
 * 取内置兜底文案。
 * 未知文件名（例如用户把 systemFile 配成了别的名字）时回落到改写 Prompt，
 * 因为那是唯一"哪怕降级也必须能跑"的模板。
 */
export function fallbackPromptFor(fileName) {
  const base = path.basename(String(fileName || ''));
  if (FALLBACK_PROMPTS[base]) return FALLBACK_PROMPTS[base];
  if (/review/i.test(base)) return FALLBACK_PROMPTS['review-system.txt'];
  if (/memory/i.test(base)) return FALLBACK_PROMPTS['memory-system.txt'];
  if (/explain/i.test(base)) return FALLBACK_PROMPTS['explain-system.txt'];
  return FALLBACK_PROMPTS['rewrite-system.txt'];
}

/**
 * 读取模板文件。
 * @param {string} root 项目根目录
 * @param {string} relFile 形如 prompts/rewrite-system.txt
 * @returns {Promise<{template: string, source: 'file'|'fallback', file: string, warning?: string}>}
 */
export async function loadPromptTemplate(root, relFile) {
  const file = path.resolve(root, relFile);
  try {
    if (await exists(file)) {
      const text = await readText(file);
      if (text.trim()) return { template: text, source: 'file', file };
      return {
        template: fallbackPromptFor(relFile),
        source: 'fallback',
        file,
        warning: `${relFile} 为空，已使用内置兜底 Prompt`,
      };
    }
  } catch (err) {
    return {
      template: fallbackPromptFor(relFile),
      source: 'fallback',
      file,
      warning: `读取 ${relFile} 失败：${err.message}`,
    };
  }
  return {
    template: fallbackPromptFor(relFile),
    source: 'fallback',
    file,
    warning: `找不到 ${relFile}，已使用内置兜底 Prompt`,
  };
}

/**
 * 渲染 Prompt 模板：把 {{KEY}} 替换成对应值。
 * 未提供的变量会被替换成「（无）」而不是留空，避免模型看到裸占位符。
 * @param {string} template
 * @param {Record<string, string>} vars
 */
export function renderTemplate(template, vars) {
  return String(template).replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = vars[key];
      return value === null || value === undefined || value === '' ? '（无）' : String(value);
    }
    return match;
  });
}

/**
 * 把模板按「角色规则区」和「变量区」切开。
 *
 * 为什么需要这个：模板是一个整体，但如果把整份模板同时塞进
 * system message 和 user message，规则会被重复两遍——
 * 既浪费 token，又可能让模型对「以哪一份为准」产生歧义。
 *
 * 切法：找到第一个含 `{{VAR}}` 的行，再**往上吃掉紧邻的标签行**
 * （例如「读者画像：」）。否则那一行会留在 system prompt 末尾变成
 * 一个悬空的标题，模型会以为后面还应该有内容。
 *
 *  - system 部分：角色 + 规则 + 输出格式
 *  - user 部分：标签行 + 变量（读者画像 / 书籍 / 章节 / 原文 / 输出要求）
 *
 * @param {string} template
 * @returns {{system: string, user: string}}
 */
export function splitPromptTemplate(template) {
  const text = String(template || '');
  const lines = text.split('\n');
  const firstVar = lines.findIndex((line) => /\{\{\s*[A-Z0-9_]+\s*\}\}/.test(line));
  if (firstVar < 0) return { system: text.trim(), user: '' };

  // 往上跳过空行，看紧邻的那一行是不是「标签行」（以冒号结尾的短行）
  let cut = firstVar;
  let probe = firstVar - 1;
  while (probe >= 0 && lines[probe].trim() === '') probe -= 1;
  if (probe >= 0 && /^[^\n]{1,40}[：:]\s*$/.test(lines[probe].trim())) {
    cut = probe;
  }

  return {
    system: lines.slice(0, cut).join('\n').trim(),
    user: lines.slice(cut).join('\n').trim(),
  };
}

/** 列出模板里用到的变量名（供 UI 显示）。 */
export function templateVariables(template) {
  const out = new Set();
  for (const m of String(template).matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}
