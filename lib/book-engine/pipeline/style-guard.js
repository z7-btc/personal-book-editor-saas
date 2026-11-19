/**
 * 文风守卫：拦住模型自作主张加上的「模板腔」。
 *
 * 真实事故（用户反馈的原话）：
 *   「不行啊，这个质量太差了……我看你塞一小段一小段，观感太差了」
 *
 * 他把成品发过来，一章 16k 字的正文里出现了 **20 次**
 * 「这一节的核心结论是：」，而且是连续 8 个自然段每段一次。
 * 读者的感受是「一段一段的」，不像一本书。
 *
 * 更气人的是：用户自己的 Reader Profile 里**明确写了禁止**：
 *   「不要在段落里贴『核心结论』『Mental Model』这类标签」
 *   「原文已经是结论式的段落，不要重复加一遍结论」
 * 模型还是照加不误 —— 因为提示词层面的「请不要」永远只是概率性的。
 *
 * 所以这里做一件提示词做不到的事：**机械地检查并删除**。
 * 判据必须极其保守，宁可漏删也不能误删正文：
 *
 *   1. 只看段落的**开头**，且必须是一句完整的「标签 + 冒号/破折号」；
 *   2. 标签句里不能有原文没有的实词 —— 也就是只认下面这张白名单；
 *   3. 原文自己就带这个说法的，绝不删（那是作者的话）。
 *
 * 删除动作本身也要留痕：删了多少处会进入质量统计，
 * 用户能看见「模型被纠正了 20 次」而不是悄悄发生。
 */

/**
 * 允许被删除的引导语。全部是「空话标签」——
 * 它们不承载任何事实、数字、观点或限定条件，删掉不丢信息。
 *
 * 每条都是正则，匹配段落**最开头**的那一小截（含后面的标点）。
 */
const LEAD_IN_PATTERNS = [
  // 「这一节的核心结论是：」「本节的核心结论是——」
  /^(?:这|本|该)?(?:一)?(?:个)?(?:小)?(?:章|节|段|部分|篇|讲|课)(?:的)?(?:核心)?(?:结论|要点|主旨|重点|大意|意思|中心思想)(?:是|为|在于)?\s*[：:，,。.、—-]+\s*/,
  // 「核心结论是：」「结论先行：」
  /^(?:核心)?(?:结论|要点|主旨|重点|大意)(?:是|为|在于|先行)?\s*[：:，,。.、—-]+\s*/,
  // 「这一节我们先说清楚：」「本节要回答的问题是：」——只在没带实词时才算模板
  /^(?:这|本)(?:一)?(?:章|节|段|部分)(?:我们)?(?:先|要)?(?:说|讲|回答|解决|讨论)(?:清楚|明白)?(?:的)?(?:问题)?(?:是)?\s*[：:，,。.、—-]+\s*/,
  // 「小结：」「总结：」「一句话总结：」
  /^(?:一句(?:话)?)?(?:小结|总结|概括|概言之|简言之|总而言?之)\s*[：:，,。.、—-]+\s*/,
  // 「换句话说，」「简而言之，」「值得注意的是，」「需要强调的是，」
  /^(?:换句话说|简而言之|简单来说|说白了|值得(?:一提|注意)的是|需要(?:强调|说明)的是|必须(?:强调|指出)的是)\s*[：:，,。.、—-]+\s*/,
  // 「综上(所述)，」
  /^综上(?:所述)?\s*[：:，,。.、—-]+\s*/,
];

/**
 * 剥离模板腔时，正文至少要剩下这么多字。
 * 低于这个数说明这一整段就是句空话，删了等于把段落弄没了 —— 宁可留着。
 */
const MIN_REMAINDER_CHARS = 8;

/**
 * 小标题的下限可以低得多。
 *
 * 因为标题本身就是短的：`<h1>这一节的核心结论是：第一章 起点</h1>`
 * 如果也要求剩 8 个字，这条脏标签就永远清不掉，会直接印在成品的小标题上。
 * 标题的职责就是「当标签用」，剥完剩两个字也算正常标题；
 * 而「不能删作者的话」这条保险由 existsInOriginal() 独立负责，不受影响。
 */
const MIN_REMAINDER_CHARS_HEADING = 2;

/**
 * 判断一段文字是否以「模板腔引导语」开头，并算出它占了多少字符（不含）。
 *
 * 这些正则都是「锚定在开头 + 标签词紧跟冒号/破折号」的结构，
 * 所以它们天然吃不到实词：一旦标签词后面接的是正常内容
 * （例如「本节的核心结论是安全边际这个概念」），匹配直接失败。
 * 真正需要防的是「把作者的话当标签删掉」，那由 existsInOriginal() 兜底。
 *
 * @param {string} text
 * @param {{minRemainder?: number}} [opts] 标题可以传更小的下限
 * @returns {number} 需要删掉的字符数；0 表示不动
 */
export function detectTemplateLeadIn(text, opts = {}) {
  const minRemainder = Number.isFinite(opts.minRemainder) ? opts.minRemainder : MIN_REMAINDER_CHARS;
  const s = String(text || '');
  // 只跳过开头的空白，不动任何实际字符
  const lead = s.match(/^\s*/)[0].length;
  const body = s.slice(lead);
  if (!body) return 0;

  for (const re of LEAD_IN_PATTERNS) {
    const m = re.exec(body);
    if (!m) continue;
    // 删完得剩下点东西，否则整段就没了
    if (body.slice(m[0].length).trim().length < minRemainder) continue;
    return lead + m[0].length;
  }
  return 0;
}

/**
 * 这段「标签」是不是作者自己写的？
 *
 * 只要原文里出现过同样的说法，就认定是原文自带，一律不动。
 * 这是最重要的一道保险：宁可漏删，也不能把作者的话删掉。
 *
 * @param {string} originalText 原文（含占位符也没关系）
 * @param {string} leadIn 被判定为标签的那一小截
 */
function existsInOriginal(originalText, leadIn) {
  const src = String(originalText || '');
  // 取标签里最长的连续「实词」片段来判断，避免标点差异导致误判
  const keywords = leadIn
    .replace(/[：:，,。.、—\-\s]/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 2);
  if (!keywords.length) return false;
  return keywords.some((w) => src.includes(w));
}

/**
 * 清理一段模型输出里被硬加上的模板腔引导语。
 *
 * @param {string} rewrittenText 模型返回的段落文字
 * @param {string} originalText  同一段的原文
 * @returns {{text: string, stripped: number, removed: string[]}}
 */
export function stripTemplateLeadIn(rewrittenText, originalText, opts = {}) {
  let text = String(rewrittenText ?? '');
  const removed = [];
  /**
   * 最多剥两次。
   *
   * 模型确实会写「这一节的核心结论是：简而言之，……」，剥一层还剩一层。
   * 但不能无限剥 —— 万一某本书的正文本身就是这种腔调，
   * 无限剥会把作者的话吃光。两层的上限是个刻意的止损点。
   */
  for (let round = 0; round < 2; round += 1) {
    const consumed = detectTemplateLeadIn(text, opts);
    if (!consumed) break;
    const leadIn = text.slice(0, consumed);
    if (existsInOriginal(originalText, leadIn)) break;
    removed.push(leadIn.trim());
    text = text.slice(consumed);
  }
  return { text, stripped: removed.length, removed };
}

/**
 * 一整块（可能多段）的输出清理。
 *
 * 段落之间用空行分隔，逐段判断 —— 因为「这一节的核心结论是」
 * 是逐段贴的，只处理段首是不够的。
 *
 * 注意这里**没有**「章节开头可以点题」这种例外：
 * 用户的 Reader Profile 写的是「不要在段落里贴『核心结论』这类标签」，
 * 而且剥掉标签不会丢掉那句话 —— 「这一节的核心结论是：市场并不总是有效的」
 * 剥完就是「市场并不总是有效的」，结论照样在最前面。
 * 少的是模板腔，不是内容。
 *
 * @param {string} rewrittenText
 * @param {string} originalText
 * @param {{minRemainder?: number}} [opts]
 */
export function stripTemplateLeadIns(rewrittenText, originalText, opts = {}) {
  const rewrittenParts = String(rewrittenText ?? '').split(/\n{2,}/);
  const originalWhole = String(originalText ?? '');
  let stripped = 0;
  const removed = [];

  const out = rewrittenParts.map((part) => {
    const result = stripTemplateLeadIn(part, originalWhole, opts);
    stripped += result.stripped;
    removed.push(...result.removed);
    return result.text;
  });

  return { text: out.join('\n\n'), stripped, removed };
}

export { MIN_REMAINDER_CHARS, MIN_REMAINDER_CHARS_HEADING };
