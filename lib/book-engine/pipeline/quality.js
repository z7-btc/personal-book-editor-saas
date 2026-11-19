/**
 * 质量检查：AI 改写结束后不要直接接受。
 *
 * 检查项（对应需求文档第十五节）：
 *  1. 长度异常      —— 改写后长度相对原文的比例越界
 *  2. 数字检查      —— 年份 / 百分比 / 金额 / 数字是否大量消失或变化
 *  3. 专有名词检查  —— 人物 / 公司 / 地点 / 技术名词是否无故消失
 *  4. HTML 检查     —— 结构是否仍然有效
 *
 * 纯函数、无外部依赖、无 LLM，结果可以缓存到 status.json。
 */

import { toSimplified } from './han-variants.js';

/** 报告里的严重级别。 */
export const SEVERITY = {
  OK: 'ok',
  WARN: 'warn',
  FAIL: 'fail',
};

/**
 * @typedef {Object} QualityIssue
 * @property {string} type      length | numbers | entities | html
 * @property {string} severity  ok | warn | fail
 * @property {string} message
 * @property {object} [details]
 */

/**
 * @typedef {Object} QualityReport
 * @property {string} verdict   ok | warn | fail
 * @property {number} score     0..100
 * @property {QualityIssue[]} issues
 * @property {object} metrics
 */

const DEFAULT_OPTIONS = {
  minRatio: 0.45,
  maxRatio: 2.2,
  minFailedRatio: 0.25,
  numberKeepRatio: 0.85,
  entityKeepRatio: 0.8,
};

/* ------------------------------------------------------------ 文本归一 -- */

/**
 * 统计「正文字符数」，用于长度比较。
 *
 * 必须先把占位符（⟦12⟧ / ⟦/12⟧）去掉：
 * 否则模型丢掉占位符时字数会虚高，反而看不出内容缩水。
 */
export function countContentChars(text) {
  return String(text)
    .replace(/⟦\/?\d+⟧/g, '')
    .replace(/\s+/g, '')
    .length;
}

/** 统一全半角数字、去掉千分位，方便比对。 */
function normalizeDigits(text) {
  return String(text)
    .replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/(\d)[,\u3001](?=\d{3}\b)/g, '$1');
}

/**
 * 提取需要保真的数字类 token：
 * 年份、百分比、金额、度量、普通数字。
 */
export function extractNumberTokens(text) {
  const src = normalizeDigits(text).replace(/\s+/g, ' ');
  const out = new Map();
  const patterns = [
    /[$\u00a3\u20ac\u00a5]\s?\d[\d,]*(?:\.\d+)?/g,
    /\d+(?:\.\d+)?\s?%/g,
    /\b(1[0-9]{3}|20[0-9]{2}|19[0-9]{2})\b(?:\s?(?:年|s|'s))?/g,
    /\d+(?:\.\d+)?\s?(?:万|亿|千|百|million|billion|trillion|thousand|k|bn)\b/gi,
    /\b\d+(?:\.\d+)?\b/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const raw = m[0].trim().replace(/\s+/g, '');
      const key = raw.toLowerCase();
      out.set(key, (out.get(key) || 0) + 1);
    }
  }
  return out;
}

/**
 * 提取专有名词候选：拉丁大写开头词、大写缩写、中日韩书名号内容、
 * 中文人名地名常见模式（连续 2-6 个汉字且出现在「专名标记」里由调用方补充）。
 */
export function extractEntityTokens(text) {
  const out = new Map();
  const src = String(text);
  const add = (token, weight = 1) => {
    const key = token.trim();
    if (key.length < 2) return;
    if (STOPWORDS.has(key.toLowerCase())) return;
    out.set(key, (out.get(key) || 0) + weight);
  };

  // 拉丁词：首字母大写（排除句首常见词由 STOPWORDS 处理）
  for (const m of src.matchAll(/\b[A-Z][A-Za-z0-9'’\-]*(?:\s+(?:of|the|and|de|van|von|der|la|le)\s+)?[A-Z][A-Za-z0-9'’\-]*\b/g)) {
    add(m[0]);
  }
  // 全大写缩写
  for (const m of src.matchAll(/\b[A-Z]{2,6}\b/g)) add(m[0]);
  // 单个首字母大写词（技术名词 / 地名）
  for (const m of src.matchAll(/\b[A-Z][a-z]{2,}\b/g)) add(m[0]);
  // 中文书名 / 引号内内容
  for (const m of src.matchAll(/[《〈]([^》〉]{2,40})[》〉]/g)) add(m[1], 3);
  // 中文里的专有名词标记（书名号外的「」通常不是专名，不采）
  // 数字+单位的技术名词
  for (const m of src.matchAll(/\b[A-Z]{2,}[0-9]{1,4}\b/g)) add(m[0], 2);
  return out;
}

/**
 * 专名还在不在——允许「同一个词的另一种写法」。
 *
 * 真实误判（2026-11-17，《朝花夕拾》维基文库版）：原文是繁体，改写按读者
 * 要求出简体，于是《山海經》变成《山海经》、范愛農变成范爱农。逐字相等
 * 的检查把它们统统算成「专名丢失」，每章保留率只有 0.29–0.33，
 * 六章被判 fail、整章丢弃——读者看到的还是繁体原文。
 *
 * 现在两边都先过一遍繁→简单字表再比。这是在**比对**，不是在改正文：
 * 读者拿到的文字一个字节都没被这里动过。
 */
export function looseEntityPresent(token, text) {
  const needle = String(token || '');
  const hay = String(text || '');
  if (!needle) return true;
  if (hay.includes(needle)) return true;
  // 拉丁字母不适用：大小写之外，一个字母不同就是另一个名字
  if (!/[㐀-鿿]/.test(needle)) return hay.toLowerCase().includes(needle.toLowerCase());
  return toSimplified(hay).includes(toSimplified(needle));
}

const STOPWORDS = new Set([  'the', 'and', 'but', 'for', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our',
  'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old', 'see', 'two',
  'way', 'who', 'boy', 'did', 'use', 'that', 'this', 'with', 'from', 'they', 'have', 'were',
  'will', 'your', 'when', 'what', 'into', 'than', 'then', 'them', 'some', 'such', 'only',
  'also', 'been', 'more', 'most', 'very', 'much', 'many', 'each', 'other', 'about', 'would',
  'there', 'their', 'which', 'these', 'those', 'after', 'before', 'because', 'however',
  'chapter', 'part', 'book', 'page', 'figure', 'table',
]);

/* ------------------------------------------------------------- 检查 -- */

/**
 * 主入口。
 * @param {Object} input
 * @param {string} input.originalText   原文纯文本
 * @param {string} input.rewrittenText  改写后纯文本
 * @param {object} [input.htmlCheck]    {ok, errors, warnings} 结构自检结果
 * @param {object} [input.pipelineStats] {missing, unbalanced, unknown} 占位符统计
 * @param {object} [options]
 * @returns {QualityReport}
 */
export function checkQuality(input, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const originalText = String(input.originalText || '');
  const rewrittenText = String(input.rewrittenText || '');
  /** @type {QualityIssue[]} */
  const issues = [];

  const origLen = countContentChars(originalText);
  const newLen = countContentChars(rewrittenText);
  const ratio = origLen === 0 ? 1 : newLen / origLen;

  /**
   * 原文里没有任何内容时，所有「丢了多少」的判断都没有意义。
   *
   * 这种情况真实出现过：整页插图（正文只有 `<div><img></div>`）被送进
   * 改写流程，模型面对空内容只能返回空，于是被判「长度严重异常」、
   * 整章标成失败 —— 而它本来就没有文字可改。
   * 现在上游已经会跳过这类页面，这里再做一层兜底：
   * 原文为空 => 不做内容层面的判定，直接返回 pass 并说明原因。
   */
  if (origLen === 0) {
    const htmlOk = !input.htmlCheck || input.htmlCheck.ok;
    return {
      verdict: htmlOk ? SEVERITY.OK : SEVERITY.FAIL,
      score: htmlOk ? 100 : 0,
      issues: htmlOk
        ? [{
            type: 'empty_source',
            severity: SEVERITY.OK,
            message: '这一页原文没有正文内容（通常是整页图片），无需进行内容层面的质量检查',
            details: { origLen, newLen },
          }]
        : [{
            type: 'html',
            severity: SEVERITY.FAIL,
            message: `HTML 结构检查未通过：${(input.htmlCheck.errors || []).join('；')}`,
            details: input.htmlCheck,
          }],
      metrics: {
        origLen,
        newLen,
        lengthRatio: 1,
        numberTokens: 0,
        numberMissing: 0,
        numberKeepRatio: 1,
        entityTokens: 0,
        entityMissing: 0,
        entityKeepRatio: 1,
        emptySource: true,
      },
    };
  }

  /* ---- 1. 长度 ---- */
  if (origLen > 0) {
    // 先判「严重丢失」：比例低于 minFailedRatio，或内容量骤降（≥65% 没了）。
    // 后者是专门防「把一章压成一段话」的：哪怕比例阈值被调松也不会漏判。
    const collapsed = origLen >= 300 && newLen / origLen < 0.35;
    if (ratio < opts.minFailedRatio || collapsed) {
      issues.push({
        type: 'length',
        severity: SEVERITY.FAIL,
        message: `长度严重异常：原文 ${origLen} 字，改写后仅 ${newLen} 字（${(ratio * 100).toFixed(1)}%），疑似被摘要化或内容丢失`,
        details: { origLen, newLen, ratio },
      });
    } else if (ratio < opts.minRatio) {
      issues.push({
        type: 'length',
        severity: SEVERITY.WARN,
        message: `长度偏短：原文 ${origLen} 字，改写后 ${newLen} 字（${(ratio * 100).toFixed(1)}%）`,
        details: { origLen, newLen, ratio },
      });
    } else if (ratio > opts.maxRatio) {
      issues.push({
        type: 'length',
        severity: SEVERITY.WARN,
        message: `长度偏长：原文 ${origLen} 字，改写后 ${newLen} 字（${(ratio * 100).toFixed(1)}%）`,
        details: { origLen, newLen, ratio },
      });
    }
  }

  /* ---- 2. 数字 ---- */
  const origNumbers = extractNumberTokens(originalText);
  const newNumbers = extractNumberTokens(rewrittenText);
  const missingNumbers = [];
  for (const [token, count] of origNumbers) {
    if (!newNumbers.has(token)) missingNumbers.push({ token, count });
  }
  missingNumbers.sort((a, b) => b.count - a.count);
  const numberKeep = origNumbers.size === 0 ? 1 : (origNumbers.size - missingNumbers.length) / origNumbers.size;
  if (origNumbers.size >= 2 && numberKeep < opts.numberKeepRatio) {
    // 原文里的数字被清空（一个都没留下）是最明确的信号，直接判 fail
    const wipedOut = newNumbers.size === 0 && origNumbers.size >= 2;
    issues.push({
      type: 'numbers',
      severity: wipedOut || numberKeep < 0.6 ? SEVERITY.FAIL : SEVERITY.WARN,
      message: `数字丢失：原文 ${origNumbers.size} 个数字 token，改写后缺少 ${missingNumbers.length} 个（保留率 ${(numberKeep * 100).toFixed(0)}%）`,
      details: { keepRatio: numberKeep, missing: missingNumbers.slice(0, 30) },
    });
  }

  /* ---- 3. 专有名词 ---- */
  const origEntities = extractEntityTokens(originalText);
  const newEntities = extractEntityTokens(rewrittenText);
  const missingEntities = [];
  for (const [token, count] of origEntities) {
    if (newEntities.has(token)) continue;
    if (looseEntityPresent(token, rewrittenText)) continue; // 繁简/异体写法差异不算丢失
    missingEntities.push({ token, count });
  }
  missingEntities.sort((a, b) => b.count - a.count);
  const entityKeep =
    origEntities.size === 0 ? 1 : (origEntities.size - missingEntities.length) / origEntities.size;
  if (origEntities.size >= 1 && entityKeep < opts.entityKeepRatio) {
    const wipedOut = newEntities.size === 0;
    issues.push({
      type: 'entities',
      severity: wipedOut || entityKeep < 0.5 ? SEVERITY.FAIL : SEVERITY.WARN,
      message: `专有名词丢失：原文 ${origEntities.size} 个，改写后缺少 ${missingEntities.length} 个（保留率 ${(entityKeep * 100).toFixed(0)}%）`,
      details: { keepRatio: entityKeep, missing: missingEntities.slice(0, 30) },
    });
  }

  /* ---- 4. HTML 结构 ---- */
  const htmlCheck = input.htmlCheck || null;
  if (htmlCheck && !htmlCheck.ok) {
    issues.push({
      type: 'html',
      severity: SEVERITY.FAIL,
      message: `HTML 结构检查未通过：${(htmlCheck.errors || []).join('；')}`,
      details: htmlCheck,
    });
  } else if (htmlCheck && (htmlCheck.warnings || []).length) {
    issues.push({
      type: 'html',
      severity: SEVERITY.WARN,
      message: `HTML 结构告警：${htmlCheck.warnings.slice(0, 3).join('；')}`,
      details: htmlCheck,
    });
  }

  /* ---- 5. 占位符（脚注 / 链接）完整性 ---- */
  const stats = input.pipelineStats || null;
  if (stats) {
    const lost = (stats.missing || 0) + (stats.unbalanced || 0) + (stats.unknown || 0);
    if (lost > 0) {
      issues.push({
        type: 'placeholders',
        severity: SEVERITY.WARN,
        message: `行内元素占位符异常：丢失 ${stats.missing || 0}、错配 ${stats.unbalanced || 0}、编造 ${stats.unknown || 0}（丢失的元素已自动补回块尾；整段严重丢失的已保留原文）`,
        details: stats,
      });
    }

    // 破坏率过高 => 这一章的改写实际上没有成功。
    // 注意：这时**正文是安全的**（被破坏的段落保留了原文），
    // 但用户需要知道「模型没按规矩干活，应该换个模型或重试」，
    // 所以判定为 fail，从而触发自动重试 / 在 UI 上标红。
    const totalBlocks = Number(stats.totalBlocks || 0);
    const corrupted = Number(stats.corrupted || 0);
    if (totalBlocks > 0 && corrupted > 0) {
      const rate = corrupted / totalBlocks;
      if (rate >= 0.3) {
        issues.push({
          type: 'rewrite_failed',
          severity: SEVERITY.FAIL,
          message: `改写质量不合格：${totalBlocks} 段中有 ${corrupted} 段因行内元素（脚注 / 链接 / 强调）大量丢失而被判定为不可信，已保留这些段落的原文。建议更换模型或降低 temperature 后重试。`,
          details: { corrupted, totalBlocks, rate },
        });
      } else {
        issues.push({
          type: 'rewrite_partial',
          severity: SEVERITY.WARN,
          message: `有 ${corrupted}/${totalBlocks} 段改写不可信，已保留原文`,
          details: { corrupted, totalBlocks, rate },
        });
      }
    }

    // 一段都没改成功 => 结果等于原文。
    // 阈值是 1 而不是 3：真实电子书里「一页只有一两段」很常见，
    // 门槛设成 3 会让这种短页的失败悄悄溜过去。
    const blocksTotal = Number(stats.blocks || 0);
    const applied = Number(stats.applied || 0);
    if (blocksTotal >= 1 && applied === 0) {
      issues.push({
        type: 'no_change',
        severity: SEVERITY.FAIL,
        message: `没有任何段落被成功改写（共 ${blocksTotal} 段）。结果与原文相同，请检查模型是否按【段 N】格式输出。`,
        details: { blocksTotal, applied },
      });
    }
  }

  const hasFail = issues.some((i) => i.severity === SEVERITY.FAIL);
  const hasWarn = issues.some((i) => i.severity === SEVERITY.WARN);
  const verdict = hasFail ? SEVERITY.FAIL : hasWarn ? SEVERITY.WARN : SEVERITY.OK;

  // 简单打分：从 100 分开始扣，便于 UI 一眼看出好坏
  let score = 100;
  for (const issue of issues) score -= issue.severity === SEVERITY.FAIL ? 30 : 8;
  score = Math.max(0, Math.min(100, score));

  return {
    verdict,
    score,
    issues,
    metrics: {
      origLen,
      newLen,
      lengthRatio: Number(ratio.toFixed(3)),
      numberTokens: origNumbers.size,
      numberMissing: missingNumbers.length,
      numberKeepRatio: Number(numberKeep.toFixed(3)),
      entityTokens: origEntities.size,
      entityMissing: missingEntities.length,
      entityKeepRatio: Number(entityKeep.toFixed(3)),
    },
  };
}

/**
 * 简单 diff：按段落做 LCS，输出 -1/0/+1 序列，供 UI 的三视图使用。
 * @param {string} original
 * @param {string} rewritten
 * @param {{maxLines?: number}} [opts]
 * @returns {Array<{type: 'same'|'add'|'del', text: string}>}
 */
export function diffParagraphs(original, rewritten, opts = {}) {
  const maxLines = opts.maxLines ?? 4000;
  const a = splitParagraphs(original).slice(0, maxLines);
  const b = splitParagraphs(rewritten).slice(0, maxLines);

  // 先用 set 去掉两边都有的段落，剩下的做 LCS（够用且快）
  const setB = new Map();
  b.forEach((line, i) => {
    if (!setB.has(line)) setB.set(line, []);
    setB.get(line).push(i);
  });

  const n = a.length;
  const m = b.length;
  // 大文本时退化为逐行比较，避免 O(n*m) 爆内存
  if (n * m > 4_000_000) {
    const out = [];
    const len = Math.max(n, m);
    for (let i = 0; i < len; i += 1) {
      if (i < n && i < m && a[i] === b[i]) out.push({ type: 'same', text: a[i] });
      else {
        if (i < n) out.push({ type: 'del', text: a[i] });
        if (i < m) out.push({ type: 'add', text: b[i] });
      }
    }
    return out;
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

export function splitParagraphs(text) {
  return String(text)
    .split(/\n{1,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}
