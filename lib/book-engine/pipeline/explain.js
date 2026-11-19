/**
 * 第二遍：读者补讲 / 删段。
 *
 * 为什么必须单独做一遍，而不是把要求写进改写 Prompt：
 * docs/PHASES.md 记录了实测结论 —— 在改写调用里要求「写到 1.4–1.8 倍」，
 * 模型的选择永远是「照抄原文」或者「换几个同义词」，两种都不是读者要的。
 * 同一章用同一模型做的对照实验（2026-11-17）：
 *
 *   · 原 Prompt                     平均 1.21 倍，纯换词
 *   · 段首标上字数目标               平均 2.37 倍，但先把原文抄一遍再补白话
 *   · 再加「禁止抄原文」             平均 0.98 倍，扩写被彻底压没
 *   · 单独一遍「只补讲卡住的地方」   44 段里挑出 10 段，1.3–2.1 倍，
 *                                   补的是「清国/速成班」「驿站」「朱舜水」
 *                                   「芋梗汤」「线装」「裹脚」「日俄战争」
 *                                   「双关的漏字」这类真障碍
 *
 * ## 为什么是「插入」而不是「重写这一段」
 *
 * 第一版让模型整段重写（【补 3】完整段落）。实测两章直接废掉：
 *   · 《五猖會》——整章 6 段带脚注链接，模型每次重写都丢 ⟦n⟧ 标记，
 *     安全线只能全部拒绝，一章零补讲；
 *   · 《范愛農》——模型干脆把原段照抄回来，等于没做。
 *
 * 改成「只输出插入点」以后，原文一个字节都不会被模型碰到：
 * 【补 3】「每日傍晚」→ 这句说的是……
 * 代码只在这句话后面插一段讲解，⟦n⟧ 标记原样还在，
 * 而且讲解就落在读者卡住的那个词后面，比整段重写更准。
 *
 * 两条安全线（回归测试覆盖）：
 *   · 锚点必须在段内唯一出现，找不到/不唯一就丢弃这条插入；
 *   · 删段有硬上限，标题、首末段、带标记/带 id 的段落永远不删。
 */

import { chatCompletion, checkPromptBudget } from '../llm/client.js';
import { renderTemplate } from '../llm/prompts.js';
import { effectiveApiKey } from '../config/providers.js';
import { AbortedError } from '../util/errors.js';
import { NODE } from '../epub/xml-dom.js';
import { toSimplified } from './han-variants.js';

/** `【补 3】「原文锚点」→ 插入的话` / `【删 7】理由` */
export const EXPLAIN_MARKER_RE = /【\s*(补|删)\s*(\d+)\s*】/g;

const MARK_TOKEN_RE = /⟦\d+⟧/g;
const CLOSE_TOKEN_RE = /⟦\/\d+⟧/g;

/** 补讲长到原来的几倍就不要再插了。超过说明模型在讲自己的东西。 */
export const MAX_EXPLAIN_RATIO = 2.6;
/** 一个 chunk 里最多删掉多少比例的段落。 */
export const MAX_DROP_RATIO = 0.2;
/** 单块最多删几段（比例之外再加一层绝对上限）。 */
export const MAX_DROP_COUNT = 8;
/** 锚点太短会在段里重复，太长模型抄不准。 */
export const MIN_ANCHOR_CHARS = 3;
export const MAX_ANCHOR_CHARS = 40;
/** 一块补讲最多问几遍（解析不出任何条目时重问）。 */
export const MAX_EXPLAIN_ATTEMPTS = 2;
/**
 * 同一段最多插几条补讲。再多就不是「讲解」，是把原文淹掉了。
 *
 * 这个数和 `prompts/explain-system.txt` 里「每段最多两条」是同一件事，
 * 改一边必须改另一边：提示词说两条、代码放三条，成品就会比设计更密。
 */
export const MAX_INSERTS_PER_PARAGRAPH = 2;

/** 锚点在段落原文里的位置；找不到的排到最后，其余按原顺序。 */
function anchorRank(text, anchor) {
  const at = String(text || '').indexOf(String(anchor || ''));
  return at < 0 ? Number.MAX_SAFE_INTEGER : at;
}

/** 判断两条补讲是不是在说同一件事：去掉标点空白以后比字符。 */
export function normalizeForDuplicateCheck(text) {
  return String(text || '')
    .replace(/[\s，。！？；：、“”「」『』（）()《》〈〉…—－\-.,!?;:'"]/g, '')
    .trim();
}

/**
 * 解析模型输出。
 *
 * 补讲只有一种合法写法：`【补 3】「锚点」→ 要插入的话`
 * 也容忍「锚点：… / 插入：…」这种两行写法（模型偶尔会自作主张分行）。
 *
 * @param {string} text
 * @param {number} expectedCount
 * @returns {{inserts: Map<number, Array<{anchor:string,text:string}>>, drops: Map<number,string>, unknown:number[], badFormat:number}}
 */
export function parseExplainOutput(text, expectedCount) {
  const inserts = new Map();
  const drops = new Map();
  const unknown = [];
  let badFormat = 0;
  const src = String(text || '').trim();
  if (!src) return { inserts, drops, unknown, badFormat };

  EXPLAIN_MARKER_RE.lastIndex = 0;
  const marks = [];
  let m;
  while ((m = EXPLAIN_MARKER_RE.exec(src)) !== null) {
    marks.push({ kind: m[1], n: Number(m[2]), start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    const cur = marks[i];
    const idx = cur.n - 1;
    const body = src.slice(cur.contentStart, end).trim();
    if (!Number.isInteger(idx) || idx < 0 || idx >= expectedCount) {
      unknown.push(cur.n);
      continue;
    }
    if (cur.kind === '删') {
      if (body) drops.set(idx, body.split('\n')[0].trim());
      continue;
    }
    const parsed = parseInsertionBody(body);
    if (!parsed) {
      badFormat += 1;
      continue;
    }
    const list = inserts.get(idx) || [];
    list.push(parsed);
    inserts.set(idx, list);
  }
  return { inserts, drops, unknown, badFormat };
}

/** 从【补 N】后面的正文里拆出「锚点 + 插入内容」。 */
export function parseInsertionBody(body) {
  const text = String(body || '').trim();
  if (!text) return null;
  /**
   * 写法一：「锚点」→ 插入的话（允许 -> / => / 插入：）
   *
   * 锚点里本身可能带引号 —— 模型爱写成「“生于太荒”」「“莫谈国事”」。
   * 早先这里用 `[^」”]+` 排除引号，结果《五猖會》两条全是这种写法，
   * 整个被当成格式错误丢掉（实测 9 条里丢 2 条）。改成非贪婪匹配到
   * 「后面紧跟箭头」的那个收尾引号，锚点里的引号就都留着了。
   */
  const inline = text.match(/^[「“]([\s\S]+?)[」”]\s*(?:→|->|=>|插入[:：])\s*([\s\S]+)$/);
  if (inline) {
    const anchor = inline[1].trim();
    const inserted = inline[2].trim();
    if (anchor && inserted) return { anchor, text: inserted };
  }
  // 写法二：锚点：xxx\n插入：yyy
  const lines = text.match(/锚点[:：]\s*[「“]?([^」”\n]+?)[」”]?\s*\n+\s*插入[:：]\s*([\s\S]+)/);
  if (lines) return { anchor: lines[1].trim(), text: lines[2].trim() };
  /**
   * 写法三：模型把锚点直接写进了讲解里，箭头忘了。
   *
   * 实测（v13《藤野先生》）：整块 14 条全是这个形状 ——
   *   【补 1】“清国留学生”指当时在日本的清朝中国留学生，速成班是短期培训课程…
   * 没有箭头，旧解析一条都认不出，一整章补讲全空（两次重问都一样，
   * 因为模型每次都这么写）。形状本身是能用的：引号里就是锚点，
   * 后面整句就是讲解，插到句末正好读得通。
   */
  const bare = text.match(/^[「“]([\s\S]{2,40}?)[」”]([\s\S]+)$/);
  if (bare && /^(是|指|即|就是|也就是|意思|在这里|本是|原指|出自|引申)/.test(bare[2].trim())) {
    return { anchor: bare[1].trim(), text };
  }
  return null;
}

/** 段落（含所有后代）里是否带 id —— 带 id 就可能是全书某条链接的目标。 */
function hasAnchorId(element) {
  if (!element) return false;
  if (element.getAttribute?.('id') || element.getAttribute?.('name')) return true;
  const stack = [...(element.childElements || [])];
  while (stack.length) {
    const node = stack.pop();
    if (node.getAttribute?.('id') || node.getAttribute?.('name')) return true;
    stack.push(...(node.childElements || []));
  }
  return false;
}

/**
 * 判断一条删段能不能执行。返回 null 表示可删，否则返回拒绝原因。
 * @param {{text: string, block: any}} entry
 * @param {number} index 段号（0 基）
 * @param {number} total 本块段数
 */
export function dropRejectReason(entry, index, total, opts = {}) {
  const { block, text } = entry || {};
  if (!block) return 'not-found';
  if (block.isHeading) return 'heading';
  if (index === 0 || index === total - 1) return 'edge-paragraph';
  const plain = String(text || '').replace(MARK_TOKEN_RE, '').replace(CLOSE_TOKEN_RE, '');
  if (MARK_TOKEN_RE.test(text) || CLOSE_TOKEN_RE.test(text)) return 'has-markers';
  if (plain.length < (opts.minChars ?? 40)) return 'too-short';
  if (hasAnchorId(block.element)) return 'has-anchor';
  return null;
}

/**
 * 把解析结果落到文档上。
 *
 * 补讲：只改 `block` 的**一个文本节点**里的字符串（插入讲解），
 *       行内元素与锚点不可能被触碰 —— 这是它比「整段重写」安全的地方。
 * 删段：直接从 DOM 里摘掉；被拒绝的记下原因，最后写进报告。
 *
 * @returns {{stats: {explained:number,dropped:number,rejected:number}, notes: string[]}}
 */
export function applyExplainResults({
  entries,
  inserts,
  drops,
  maxRatio = MAX_EXPLAIN_RATIO,
  authorNames = [],
  firstPerson: firstPersonHint,
}) {

  const stats = { explained: 0, dropped: 0, rejected: 0 };
  const notes = [];
  /**
   * 第一人称的书里，补讲不该用第三个人称讲作者。
   * 实测（v20《藤野先生》）：「……煮成汤味道很涩，鲁迅觉得难以下咽，说明仙台的饮食他很不习惯。」
   * 正文是「我」在回忆，插进来的讲解突然改口叫名字，读者会以为换了本书。
   *
   * 判定要用**整章**，不能只用这一块：一块往往只有一两千字，一段对话体
   * 或引文多的块里「我」不到三次，照样是第一人称的书，判定按块算就会漏。
   * 调用方有整章文本时通过 `firstPerson` 传进来；没有才退回按块数。
   */
  const chapterText = entries.map((e) => String(e.text || '')).join('');
  const firstPerson =
    typeof firstPersonHint === 'boolean'
      ? firstPersonHint
      : (chapterText.match(/我/g) || []).length >= 3;
  const total = entries.length;

  // 先补讲：删段会改变段号与首末段的位置，顺序反了会判错
  for (const [index, list] of [...inserts.entries()].sort((a, b) => a[0] - b[0])) {
    const entry = entries[index];
    if (!entry) {
      stats.rejected += 1;
      continue;
    }
    if (entry.block?.isHeading) {
      stats.rejected += 1;
      continue;
    }
    const sourceLength = [...String(entry.text || '')].length;
    const maxLength = Math.floor(sourceLength * maxRatio);
    let applied = 0;
    const reasons = [];
    const seen = [];
    /**
     * 先按模型给的顺序挑出要用的几条（去重、每段至多三条），再按锚点在原文里
     * 的位置**从后往前**插。
     *
     * 倒着插有两个原因：
     *  · 两条讲解落在同一句句末时，后插的那条会跑到前一条前面；倒着插，
     *    读起来才和模型给的顺序一致（同一位置的两条再按原序倒过来）。
     *  · 先插的前文讲解里可能又提到后面的锚点，倒着插就不会干扰后面找锚点。
     * 实测（v23《二十四孝圖》）原文先说《文昌帝君阴骘文图说》、后说《玉历钞传》，
     * 两条讲解都在同一句句末，原来的顺序插进去正好反过来。
     */
    const chosen = [];
    for (const insertion of list) {
      /**
       * 同一段里模型常把一句讲解拆成两三条，或者换个说法再说一遍。
       * 实测（v14《藤野先生》）同一句原文后面连着插了三条讲《新约》的，
       * 读起来像在凑字数。一样的不再插，被另一条完全包住的那条也不插。
       */
      const normalized = normalizeForDuplicateCheck(insertion?.text);
      if (normalized && seen.some((prev) => prev.includes(normalized) || normalized.includes(prev))) {
        reasons.push('duplicate');
        continue;
      }
      if (chosen.length >= MAX_INSERTS_PER_PARAGRAPH) {
        reasons.push('too-many');
        continue;
      }
      if (normalized) seen.push(normalized);
      chosen.push(insertion);
    }
    const ordered = chosen
      .map((insertion, i) => ({ insertion, i, rank: anchorRank(entry.text, insertion?.anchor) }))
      .sort((x, y) => y.rank - x.rank || y.i - x.i)
      .map((x) => x.insertion);
    const spans = [];
    for (const insertion of ordered) {
      const result = insertIntoElement(entry.block.element, insertion, maxLength, {
        authorNames,
        firstPerson,
        spans,
      });
      if (!result.ok) {
        reasons.push(result.reason);
        continue;
      }
      applied += 1;
    }
    if (!applied) {
      stats.rejected += 1;
      if (reasons.length) notes.push(`第 ${index + 1} 段补讲未采用（${reasons[0]}）`);
      continue;
    }
    entry.block.element.markDirty?.();
    stats.explained += 1;
    if (reasons.length) notes.push(`第 ${index + 1} 段有 ${reasons.length} 条补讲未采用（${reasons[0]}）`);
  }

  const dropLimit = Math.min(MAX_DROP_COUNT, Math.max(0, Math.floor(total * MAX_DROP_RATIO)));
  const accepted = [];
  for (const [index, reason] of [...drops.entries()].sort((a, b) => a[0] - b[0])) {
    const entry = entries[index];
    if (accepted.length >= dropLimit) {
      stats.rejected += 1;
      continue;
    }
    const reject = dropRejectReason(entry, index, total);
    if (reject) {
      stats.rejected += 1;
      notes.push(`第 ${index + 1} 段未删除（${reject}）`);
      continue;
    }
    accepted.push({ index, entry, reason });
  }
  for (const { entry } of accepted) {
    // detach() 只摘节点、不标脏；而「脏父节点」的序列化是按子节点源区间
    // 回填缝隙的——被摘掉的段落会作为「缝隙原文」重新吐出来。
    // 必须把父节点标成 rebuilt：只按当前 DOM 输出，不再回填源缝隙。
    const parent = entry.block.element.parentNode;
    entry.block.element.detach();
    if (parent) {
      parent.rebuilt = true;
      parent.markDirty?.();
    }
    stats.dropped += 1;
  }
  return { stats, notes };
}

/**
 * 补讲以「指……」这类半截话开场时，给它补上主语。
 *
 * 补讲落在**整句之后**，读者看到的是独立的一句，看不见模型选的那个锚点。
 * 于是「清国留学生」的讲解如果写成「指当时日本专为中国学生开设的短期速成教育班」，
 * 插进去就成了：
 *   「……总少不了一群一群的“清国留学生”速成班的学生。指当时日本专为中国学生
 *     开设的短期速成教育班，学制比正式课程短……」
 * 读者得回头找“指”的是谁。Prompt 已经明令不许这样写，但《藤野先生》《范愛農》
 * 实测里模型照样写了九条（指…、意思是…、这里说…）。所以代码兜一层：
 *
 *   · 「指 X」        → 「“锚点”指 X」
 *   · 「意思是 X」    → 「“锚点”意思是 X」
 *   · 「这里说 X」    → 去掉旁白，留「X」（X 本身是完整句子）
 *   · 「这里也是反话，指 X」 → 「“锚点”是反话，X」
 *
 * 只改开场那几个字，后面的话一个字不动。
 */
export function repairDanglingReference(text, anchor) {
  const s = tidyInsertionText(String(text || '').trim());
  const a = String(anchor || '').trim().replace(/^[「“『](.*)[」”』]$/, '$1');
  if (!s || !a) return s;
  return giveBareSentencesSubject(repairLeading(s, a));
}

/**
 * 补讲本身的小毛病：重复标点、拿锚点当主语后又接「是这句」。
 *
 * 实测（v18《五猖會》）：
 *   「……仁就会到来。。先生自己也念书。」（多一个句号）
 *   「“有念“仁远乎哉我欲仁斯仁至矣”的”是这句出自《论语·述而》……」
 *   「……的」是这句出自」两个「是」叠在一起，读来像书印错了。
 * 改法不动意思：「这句出自《论语·述而》」本身就是完整一句。
 */
export function tidyInsertionText(text) {
  let s = String(text || '');
  s = s.replace(/([。！？；])[。！？；]+/g, '$1'); // 「到来。。」→「到来。」
  s = s.replace(/(^|[。！？])\s*[“"「][\s\S]{1,60}?[”"」]是这句(?=出自|引自|来自|见于)/g, '$1这句');

  /**
   * 句子里带「，这里引的是……」「，这里指的是……」这种指着书说话的尾巴。
   *
   * 实测（v21《二十四孝圖》）：「阿尔志跋绥夫是俄国作家，鲁迅早年翻译过他的作品，
   * 这里引的是他小说里的话。」前半句有实料，尾巴是旁白，收掉尾巴就干净了。
   */
  const sentences = s.match(/[^。！？]*[。！？]|[^。！？]+$/g) || [];
  const kept = [];
  for (const raw of sentences) {
    let sentence = raw;
    sentence = sentence.replace(
      /[，,]\s*这里(?:也)?(?:引的是|引的|指的是|说的是|说的就是|是说|说|指|是|就是)[^。！？]*([。！？]?)$/,
      '$1',
    );
    /**
     * 整句都是站在书外面点评的（「……是鲁迅对买主的一种带点调侃的说法。」），
     * 这句不要 —— 但同一段补讲里别的句子照留。
     */
    if (/(?:是|这是)[^。！？]{0,24}(?:的一种|的一句)[^。！？]{0,8}?(?:调侃|讽刺|反话|说法|笔法|口吻)/.test(sentence)) continue;
    if (/^(?:这句话|这一句|这句|此句)(?:是|在|说的|写的|讲的)/.test(sentence.trim())) continue;
    kept.push(sentence);
  }
  s = kept.join('');
  return s.replace(/[，,]\s*$/, '。').trim();
}

/**
 * 补讲后面几句以「是……」开头时，补一个「这」。
 *
 * 实测（v17《藤野先生》）：
 *   「“托尔斯泰”指俄国作家列夫·托尔斯泰……。是基督教《圣经》的后半部分，
 *     记载耶稣及其门徒的事迹和书信。」
 * 第二句没有主语 —— 上一句的末尾正好提到了《新约》，加「这」就接上了：
 *   「这是基督教《圣经》的后半部分……」。
 * 只动**句号/叹号/问号后面**的半截谓语，第一个字和引号里的内容不碰。
 */
export function giveBareSentencesSubject(text) {
  return String(text || '').replace(
    /([。！？])(\s*)(指的是|指的就是|意思是|也就是|就是|是指|是(?!否|不)|指(?!出|向|导)|即(?![使将便刻日为以]))/g,
    (whole, prev, space, verb) => `${prev}${space}这${verb}`,
  );
}

/** 开场那一句的修补（补讲落在整句之后，看不见锚点）。 */
function repairLeading(s, a) {
  // 「这里也是反话，指……」——旁白换成锚点，后面「指……」原样留着
  const irony = s.match(/^这里(?:也)?(?:是|说的是)(?:反话|反语)[，,：:]?\s*/);
  if (irony) {
    const rest = s.slice(irony[0].length);
    return rest ? `“${a}”是反话，${rest}` : s;
  }
  // 「这里说……」「这里指……」「这里是说……」——旁白本身不带信息
  const hereSays = s.match(/^这里(?:也)?(?:说的就是|说的是|说的|是说|说明|讲的是|指的是|说|指|即|就是|是)[，,：:]?\s*/);
  if (hereSays) {
    const rest = s.slice(hereSays[0].length).replace(/^[，,：:]\s*/, '');
    if (!rest) return s;
    // 去掉旁白后是个没主语的「是……」句子，就把主语换回锚点
    if (/^(是|指|即|就是|也就是)/.test(rest)) return `“${a}”${rest}`;
    // 剩下的本身是完整句子（「学生帽被辫子顶得高高耸起」），原样留着
    if (hasPredicate(rest)) return rest;
    // 剩下的还是个名词短语（「这里指中途歇脚的地方」），用锚点当主语
    return `“${a}”指${rest}`;
  }
  // 「指……」「即……」「意思是……」——直接补主语
  const ref = s.match(/^(?:指的是|说的是|意思是|也就是|就是|指|即|是(?![非否的]))[，,：:]?\s*/);
  if (ref) {
    const rest = s.slice(ref[0].length);
    if (!rest) return s;
    const lead = ref[0].replace(/[，,：:\s]+$/, '');
    return `“${a}”${lead}${rest}`;
  }
  // 「基督教《圣经》的后半部分。」——整个补讲就是一个名词短语，没有谓语
  const stripped = stripMidSentenceNarration(s);
  if (stripped !== s) return stripped;
  if (isBareNounPhrase(s)) {
    /**
     * 第一小句就是锚点本身（「归有光，明代散文家，写过《项脊轩志》」）时，
     * 不能叠成「“归有光”是归有光，明代散文家」——把「是」直接接在锚点后面。
     */
    const clauses = s.split(/[，,；;：:]/);
    if (sameText(clauses[0], a)) {
      const rest = clauses.slice(1).join('，').trim();
      if (rest) return `“${a}”是${rest}`;
    }
    return `“${a}”是${s}`;
  }
  return s;
}

/** 两段文字去掉引号和空白后是不是同一段。 */
function sameText(x, y) {
  const clean = (t) => String(t || '').replace(/[“”「」『』"'\s]/g, '');
  return clean(x) === clean(y);
}

/**
 * 这条补讲是不是「站在书外面点评」的旁白。
 *
 * 实测（v19《藤野先生》）：
 *   「这是鲁迅在转述当时日本社会流行的偏见：国家弱，中国人就被当成低能儿……」
 *   「这句在写他离开东京时的记忆。」
 * 这类句子不带来任何原文没有的信息，只是阅读理解的批注；插进正文里
 * 读者会觉得有人在耳边念标准答案。原文紧接着就要说的转折更不该提前总结。
 * Prompt 已经明令禁止，代码再兜一层。
 */
export function isCommentaryInsertion(text) {
  const s = String(text || '').trim();
  return (
    /^这(?:是|就是)(?:作者|原文|课文|书里|小说|文章)[^。！？]{0,10}(?:在|想|要)/.test(s) ||
    /^这(?:是|就是)[^。！？]{0,6}(?:在转述|在说|在讲|在写|在描述|在讽刺|在强调|在刻画)/.test(s) ||
    /^(?:这句话|这一句|这句|此句|此处|这里)(?:是|在|说的|写的|讲的|意思是说)/.test(s) ||
    /^这(?:说明|表明)(?:了)?(?:作者|他|她)/.test(s)
  );
}

/**
 * 一条补讲里**后面几句**又用「这里指……」开场时要收掉。
 *
 * 实测（v15《范愛農》）：
 *   「……常受雇参与各种秘密活动。这里指革命党人花钱雇他们去接应徐锡麟家属。」
 * 前一整条补讲落在句号后面，读者刚读完上句，「这里」指谁还得再猜一次。
 * 前面的句子已经把对象交代过了，直接说事就行。
 */
export function stripMidSentenceNarration(text) {
  const s = String(text || '');
  const stripped = s.replace(
    /([。！？」])\s*这里(?:也)?(?:指的是|说的是|说的就是|引用的是|引用的|引的是|引的|引用了|引用|是说|说明|说|指|是|就是)[，,：:]?\s*/g,
    (whole, prev, offset, all) => {
      const rest = all.slice(offset + whole.length);
      // 收掉旁白以后站不住（「清政府的残暴。」「是……」），就不要动
      if (!rest || !hasPredicate(rest) || /^(是|指|即|就是|也就是)/.test(rest)) return whole;
      return prev;
    },
  );
  /**
   * 「这里鲁迅用来自嘲：……」「这里作者意在讽刺：……」——旁白里还夹着主语。
   *
   * 实测（v20《藤野先生》）：「“物以稀为贵”意思是东西因为稀少才显得贵重。
   * 这里鲁迅用来自嘲：仙台还没有中国学生，所以他这个中国人才被学校格外优待。」
   * 把前半截收掉，剩下的「仙台还没有中国学生，所以他……」本来就是完整一句。
   */
  return stripped.replace(
    /([。！？」])\s*这里[^，。：；！？]{0,10}?(?:用来自嘲|用来讽刺|用以|意在|其实是说|是在说|是在表达|是在讽刺|是在自嘲)[，,：:]?\s*/g,
    (whole, prev, offset, all) => {
      const rest = all.slice(offset + whole.length);
      if (!rest || !hasPredicate(rest) || /^(是|指|即|就是|也就是)/.test(rest)) return whole;
      return prev;
    },
  );
}

/**
 * 一句话里有没有谓语。
 *
 * 只用来判断「这句能不能自己站住」：有任何一个谓语标志就当成完整句子，一个字不动。
 * 宁可放过一个半截话，也不能把完整句子改成病句。
 */
const PREDICATE_RE =
  /[是有把被叫称说让使会要可以做用去到成为属给交送领丢雇花借还收放看听读写讲问答买卖杀吃喝走跑回住穿打争逃娶嫁死活改换考翻译印坐站躺睡笑哭指]|形容|意味|表示|代表|属于|包括|分为|配有|用来|不能|能够|需要|必须|并非|没有|流传|流行|发生|是指/;

function hasPredicate(text) {
  return PREDICATE_RE.test(String(text || ''));
}

/**
 * 补讲是不是「只有一个名词短语」的半截话。
 *
 * 实测（v14）这一种和「指……」一样常见，而且更隐蔽 —— 它看起来像一句解释，
 * 插在句号后面却读不通：
 *   「这大概是《新约》上的句子吧……。基督教《圣经》的后半部分。」
 *   「……是上一学年不及格的留级学生，对学校里的掌故相当熟悉。上一学年考试不及格、不能升级的学生。」
 * 两处都只是把「《新约》」「留级学生」换了个说法，读者读到的却是一个没有主语的句子。
 * 它和锚点说的本来是同一件事，所以拿锚点当主语正好：「“《新约》”是基督教《圣经》的后半部分」。
 *
 * 判定要保守 —— 判错会把好句子改成病句，所以只认两种很窄的形状：
 *   1. 整条补讲只有一个短句（没有逗号），结尾是个名词性的词；
 *   2. 第一小句里没有任何谓语，也没有「了/着/过」这类叙事标记。
 * 补讲本来就是一个完整句子时（「朱舜水是明末清初的学者，不肯降清」），两个条件都不成立。
 */
export function isBareNounPhrase(text) {
  const s = String(text || '').trim().replace(/。$/, '');
  if (!s) return false;
  if (/^[「“『(（]/.test(s)) return false;
  const clauses = s.split(/[，,；;：:]/);
  const first = clauses[0].trim();
  /**
   * 形状一：一句话讲完、结尾是名词（「上一学年考试不及格、不能升级的学生」）。
   * 里面可以有「不能」这类修饰语，所以这一条要先于谓语判断。
   * 带主语代词的（「他是学生」）不算名词短语。
   */
  const NOUN_END_RE =
    /(学生|部分|作家|读物|人物|作品|官职|称号|名称|意思|地方|时代|时期|年代|青年|先生|学者|官员|女子|男子|孩子|父亲|母亲)$/;
  if (clauses.length === 1) {
    if (/[了着过]/.test(s)) return false; // 「…了/…过」说明是叙事句，不是名词短语
    if (
      [...s].length <= 30 &&
      NOUN_END_RE.test(s) &&
      !/^(他|她|它|我|你|这|那|其|此|该)/.test(s) &&
      !/[是有]/.test(s)
    ) {
      return true;
    }
  }
  /** 谓语标志：出现任何一个，说明这句自己站得住。 */
  if (hasPredicate(first)) return false;
  // 「在」也是谓语（「日暮里在东京北边」），只是没进上面那张表
  if (/在/.test(first)) return false;
  /**
   * 形状二：第一小句没有任何谓语，后面可以有逗号。
   *
   * 实测（v18《五猖會》补讲）：「俄国作家，鲁迅曾翻译过他的作品。」
   * 第一小句只是个名词，插在句号后面读起来像半句话。
   *
   * 但时间、地点、原因状语也是「没有谓语的短句」，它们不能当主语：
   * 「日俄战争期间，他写信给皇帝」前面加「是」就成病句了。所以状语开头或
   * 状语结尾的一律不算。
   */
  if (/^(在|于|当|从|自|到|对|给|为|因|由|据|通过|经过|随着|关于|对于|由于|为了|除了|不但|虽然|尽管|因为|所以|但是|不过|而且|若|如果)/.test(first)) {
    return false;
  }
  if (/(期间|时候|时期|之后|之前|以后|以前|以来|当时|时|后|前|里|中|内|上|下|外|间)$/.test(first)) return false;
  if ([...first].length <= 18 && [...s].length <= 60) return true;
  return false;
}

/**
 * 在元素的文本节点里找到锚点，把讲解插在它后面。
 *
 * 直接改 `XmlText` 的值，行内元素（脚注链接、强调）原样保留 ——
 * 这是「只插入、不重写」的落点：模型碰不到原文，⟦n⟧ 标记不可能丢。
 *
 * 锚点必须**在一个文本节点内**逐字出现且全段唯一。
 * 跨行内元素、跨节点的锚点一律放弃（宁可少补一句，不可插错地方）。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function insertIntoElement(element, insertion, maxChars = Infinity, opts = {}) {
  if (!element) return { ok: false, reason: 'not-found' };
  const anchor = String(insertion?.anchor || '').trim();
  if (!anchor) return { ok: false, reason: 'empty-anchor' };

  const nodes = [];
  const collect = (el) => {
    for (const child of el.children || []) {
      if (child.kind === NODE.TEXT) nodes.push(child);
      else if (child.kind === NODE.ELEMENT) collect(child);
    }
  };
  collect(element);

  const all = nodes.map((n) => String(n.value ?? '')).join('');
  /**
   * 正文是简体、模型却写了一条繁体（或反过来）时，先摊成正文那一路的写法。
   *
   * 实测（v24《藤野先生》）：正文全简体，模型给的「这里說日本的翻译……」用了「說」，
   * 收旁白的规则一条都对不上，插进正文读起来是「这里说…」这种半截旁白；
   * 导出时整篇又被折成简体，毛病就留在书里了。
   * 只做「繁 → 简」：正文本身还是繁体时不动它（不能把繁体书改成简体）。
   */
  let rawInsert = String(insertion?.text || '').trim();
  if (toSimplified(all) === all && toSimplified(rawInsert) !== rawInsert) {
    rawInsert = toSimplified(rawInsert);
  }
  const inserted = repairDanglingReference(rawInsert, anchor);
  if (!inserted) return { ok: false, reason: 'empty-insert' };
  if (isCommentaryInsertion(inserted)) return { ok: false, reason: 'commentary' };
  /**
   * 第一人称的正文里，补讲改口提作者名字 —— 是旁白，不是讲解。
   *
   * 书里的作者名和模型写的名字常常一边繁体一边简体（维基文库导航表写「魯迅」，
   * 正文和补讲写「鲁迅」），按原字比对永远对不上，所以两边都摊成简体再比。
   *
   * 模型也常绕开名字，直接写「作者」：「……煮成汤味道很涩，所以作者说难以下咽。」
   * 正文是「我」在说话，这个「作者」就是读者眼里的「我」突然被推到书外面去了，
   * 和直呼其名是同一类毛病。第一人称的书里一律不收。
   */
  if (opts.firstPerson && /作者/.test(inserted)) {
    return { ok: false, reason: 'third-person' };
  }
  /**
   * 补讲里点名作者，一律不收 —— 不管这本书是不是第一人称。
   *
   * 补讲的职责是讲清原文没说的词、事、背景；「作者认为……」
   * 是把读者从书里拉到书外去看作者，任何书里都是旁白。
   */
  if (
    (opts.authorNames || []).some((n) => {
      const name = toSimplified(String(n || '').trim());
      return [...name].length >= 2 && toSimplified(inserted).includes(name);
    })
  ) {
    return { ok: false, reason: 'third-person' };
  }
  const anchorChars = [...anchor].length;
  if (anchorChars < MIN_ANCHOR_CHARS) return { ok: false, reason: 'anchor-too-short' };
  if (anchorChars > MAX_ANCHOR_CHARS) return { ok: false, reason: 'anchor-too-long' };
  /**
   * 找锚点时要跳过「已经插进去的讲解」。
   *
   * 先插的一条讲解里很可能又提到后面那个锚点（「第一句话讲日暮里……」这句讲解
   * 本身就有「日暮里」三个字），再按整段文字数命中次数，就会把后面的正常补讲
   * 误判成 anchor-ambiguous。spans 记着每次插入的位置和长度，数命中时绕开。
   */
  const spans = opts.spans || [];
  const occur = [];
  for (let from = 0; ; ) {
    const i = all.indexOf(anchor, from);
    if (i < 0) break;
    occur.push(i);
    from = i + 1;
  }
  const fresh = occur.filter((i) => !spans.some((s) => i >= s.start && i < s.end));
  if (fresh.length === 0) return { ok: false, reason: 'anchor-not-found' };
  if (fresh.length > 1) return { ok: false, reason: 'anchor-ambiguous' };
  if (all.length + inserted.length > maxChars) return { ok: false, reason: 'too-long' };

  const at = fresh[0];
  /**
   * 引文里不插话。
   *
   * 《五猖會》里张岱《陶庵梦忆》的原文是整段引文，模型选中的锚点正在引号里；
   * 插进去就把引文截断了（「……尋黑矮漢，寻梢长大汉，张岱写当时……尋頭陀」），
   * 读者会以为后面那半句也是张岱的话。引号没闭合就说明落点在引文里，放弃。
   */
  if (insideQuote(all.slice(0, at))) return { ok: false, reason: 'inside-quote' };

  /**
   * 落点必须在**整句话说完之后**，不是锚点后面。
   *
   * 早先的版本允许插在逗号后面，理由是模型总挑贴着逗号的锚点。实测这样会
   * 把一句话劈成两半 —— 《藤野先生》里原文是
   *   「北京的白菜运到浙江，就用红头绳系住菜根，倒挂在水果店门口……」
   * 锚点取「北京的白菜运到浙江」，讲解就插在逗号后：
   *   「北京的白菜运到浙江，这里是在解释……成了"稀罕物"。就用红头绳系住菜根……」
   * 后半句「就用……系住」没了主语，读者读到那儿会以为书印错了。
   *
   * 所以锚点只用来**定位是哪一句**：从锚点往后找到这一句的句末标点，
   * 讲解插在那之后。句子与讲解天然是两句，谁也不会被截断。
   */
  const cut = skipTrailingParenthetical(all, sentenceEndAfter(all, at + anchor.length));
  if (cut < 0) return { ok: false, reason: 'no-sentence-end' };
  let acc = 0;
  for (const node of nodes) {
    const value = String(node.value ?? '');
    const end = acc + value.length;
    if (cut >= acc && cut <= end) {
      const local = cut - acc;
      const sentence = endsSentence(inserted) ? inserted : `${inserted}。`;
      node.setValue(value.slice(0, local) + sentence + value.slice(local));
      // 记下这一段是插进去的，后面找锚点时不再把它当原文
      for (const span of spans) {
        if (span.start >= cut) {
          span.start += sentence.length;
          span.end += sentence.length;
        }
      }
      spans.push({ start: cut, end: cut + sentence.length });
      return { ok: true };
    }
    acc = end;
  }
  // 锚点跨了节点边界（中间夹着行内元素）—— 放弃这一条
  return { ok: false, reason: 'anchor-split' };
}

/** 句末标点：讲解只能插在这些字后面。 */
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…']);
/** 句末标点后面紧跟的收尾符号（引号、括号），讲解要插在它们之后。 */
const TAIL_CLOSERS = new Set(['」', '』', '”', '’', '"', '）', ')', '】', ']', '》', '〉']);
/** 锚点所在句子太长（一整段一句话）时放弃，免得讲解跑到段尾。 */
const MAX_SENTENCE_LOOKAHEAD = 240;

/**
 * 从 `from` 往后找到这一句结束的位置（返回插讲点：句末标点及其收尾符号之后）。
 * 找不到（句子太长、或到段尾都没有句末标点）返回 -1。
 *
 * 落在引号里的句号不算（那是引文内部的句子），继续往后找。
 */
function sentenceEndAfter(all, from) {
  const limit = Math.min(String(all).length, from + MAX_SENTENCE_LOOKAHEAD);
  for (let i = Math.max(0, from - 1); i < limit; i += 1) {
    if (!SENTENCE_END.has(all[i])) continue;
    let j = i + 1;
    // 「……」这类连着几个点算一个句末
    while (j < all.length && SENTENCE_END.has(all[j]) && (all[j] === '…' || all[j] === '!')) j += 1;
    while (j < all.length && TAIL_CLOSERS.has(all[j])) j += 1;
    if (insideQuote(all.slice(0, j))) continue;
    return j;
  }
  return -1;
}

/**
 * 句末紧跟的括号出处，讲解要插在它后面。
 *
 * 实测（v23《二十四孝圖》）：
 *   师觉授《孝子传》云，“……僵仆为婴儿啼。”（《太平御览》四百十三引）较之今说……
 * 讲解插在引号后面、出处括号前面，把「（《太平御览》四百十三引）」
 * 和自己的引文拆开了 —— 读者会以为那个出处是讲解的。
 *
 * 只跳短的、不含句末标点的括号（「（《太平御览》四百十三引）」这类）；
 * 括号里是一整句正文的，说明它不是出处，不动。
 */
function skipTrailingParenthetical(all, cut) {
  if (cut < 0) return cut;
  let i = cut;
  while (i < all.length && /\s/.test(all[i])) i += 1;
  const open = all[i];
  if (open !== '（' && open !== '(') return cut;
  const close = open === '（' ? '）' : ')';
  const end = all.indexOf(close, i);
  if (end < 0 || end - i > 40) return cut;
  if (/[。！？；]/.test(all.slice(i, end))) return cut;
  return end + 1;
}

/** 这个位置是否还在一对引号里面（有开无合）。 */
function insideQuote(before) {
  const count = (re) => (String(before).match(re) || []).length;
  if (count(/“/g) > count(/”/g)) return true;
  if (count(/「/g) > count(/」/g)) return true;
  if (count(/『/g) > count(/』/g)) return true;
  // 英文/旧式直引号：奇数个就是在引文中（撇号是另一回事，不参与计数）
  if (count(/"/g) % 2 === 1) return true;
  return false;
}

function endsSentence(text) {
  // 括号引号收尾时要看括号**里面**最后一个字：「（……。）」也算句子结束
  const tail = String(text).trim().replace(/[）)】\]》」』”"’']+$/, '');
  return /[。！？；….]$/.test(tail);
}

/**
 * 对一个 chunk 跑一遍补讲/删段。
 *
 * 失败不影响整章：返回空结果 + error，调用方只记一条告警。
 *
 * @param {Object} args
 * @param {Array<{block:any,text:string,marks:any[]}>} args.entries 当前（已改写）段落
 * @param {object} args.provider
 * @param {string} args.systemPrompt
 * @param {string} args.userTemplate
 * @param {string} [args.readerProfileBlock]
 * @param {string} [args.bookContext]
 * @param {string} [args.chapterContext]
 * @param {AbortSignal} [args.signal]
 */
export async function explainChunk(args) {
  const { entries, provider } = args;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  if (!entries.length) return { inserts: new Map(), drops: new Map(), usage, attempts: 0, error: null };

  const source = entries.map((e, i) => `【段 ${i + 1}】${e.text}`).join('\n\n');
  const userPrompt = renderTemplate(args.userTemplate, {
    READER_PROFILE: args.readerProfileBlock || '（无）',
    BOOK_CONTEXT: args.bookContext || '（无）',
    CHAPTER_CONTEXT: args.chapterContext || '（无）',
    SOURCE_TEXT: source,
  });
  const messages = [
    { role: 'system', content: args.systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const budget = checkPromptBudget(messages, {
    maxInputChars: args.maxInputChars ?? provider.maxInputChars ?? undefined,
  });
  if (!budget.ok) {
    return { inserts: new Map(), drops: new Map(), usage, attempts: 0, error: budget.message };
  }

  try {
    /**
     * 空结果要再要一次。
     *
     * 实测（v12）一章 6 块里有 5 块补讲是零产出：模型回了别的格式或者干脆
     * 什么都没给，parse 结果 0 条，而调用方只看「有没有报错」—— 于是整章悄悄
     * 少了本该有的讲解，页面上没有任何痕迹。补讲是这一版的核心增值，
     * 静默丢掉不能接受：拿到的文本里一条都解析不出来、又没说「无需处理」，
     * 就再问一遍；两次都空才认。
     */
    for (let attempt = 1; attempt <= MAX_EXPLAIN_ATTEMPTS; attempt += 1) {
      const result = await chatCompletion(messages, {
        baseUrl: provider.baseUrl,
        apiKey: effectiveApiKey(provider),
        model: provider.model,
        temperature: args.temperature ?? provider.temperature,
        topP: provider.topP,
        reasoningEffort: provider.reasoningEffort,
        maxTokens: provider.maxTokens,
        timeoutMs: provider.timeoutMs,
        maxRetries: args.maxRetries ?? 2,
        retryBaseDelayMs: args.retryBaseDelayMs ?? 2000,
        signal: args.signal,
        onRetry: args.onRetry,
      });
      usage.promptTokens += result.usage?.promptTokens || 0;
      usage.completionTokens += result.usage?.completionTokens || 0;
      usage.totalTokens += result.usage?.totalTokens || 0;
      const parsed = parseExplainOutput(result.text, entries.length);
      const found =
        [...parsed.inserts.values()].reduce((s, list) => s + list.length, 0) + parsed.drops.size;
      const saidNothingToDo = /无需处理|無需處理/.test(result.text);
      const last = attempt === MAX_EXPLAIN_ATTEMPTS;
      if (found > 0 || saidNothingToDo || last) {
        return { ...parsed, usage, attempts: attempt, error: null, empty: found === 0 && !saidNothingToDo, rawHead: String(result.text || '').slice(0, 120) };
      }
    }
    return { inserts: new Map(), drops: new Map(), usage, attempts: MAX_EXPLAIN_ATTEMPTS, error: null, empty: true };
  } catch (err) {
    if (err instanceof AbortedError) throw err;
    return { inserts: new Map(), drops: new Map(), usage, attempts: 1, error: err.message, empty: false };
  }
}
