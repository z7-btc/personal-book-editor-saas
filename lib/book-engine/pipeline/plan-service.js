/**
 * 「整理这本书」的第一步：让模型读完整本书，产出**整理方案**。
 *
 * ## 为什么必须单独有这一步
 *
 * 用户问的是「以后上传任意一本书都会自动处理吗」。答案是：
 * 改大白话和脚注就地化是自动的（点 Rewrite All 就做），
 * 但**删哪些章、压哪些章、每章叫什么名字、按什么顺序读** ——
 * 这些都得先有人把整本书读一遍才能决定，模型不能边改边猜。
 *
 * 这一段逻辑原先只活在 `scripts/plan-book.mjs` 里，**没有 API、没有界面**，
 * 也就是说用户在网页上根本走不到这一步 —— 那四项处理里有三项就落不了地。
 *
 * ## 三级流水线
 *
 *   1. **逐章判断**（并发）：每章一张卡片 —— 它是什么、讲了什么、
 *      有没有独立知识、哪几段是水分、跳过会损失什么；
 *   2. **汇总**：把卡片合成一份完整方案 —— 阅读顺序、价值分级、
 *      每章的动作（精读 / 压缩 / 原样保留 / 删除）；
 *   3. **起名字**：按「这一章到底讲什么」给每章起一个说人话的名字。
 *
 * 三级的输出都会过 `normalizeCard` / `normalizePlan` 里那道**硬闸**：
 * 判`core`/`useful` 的章节一律不许压缩、更不许删除；
 * `drop` 只对 `filler` 开放。提示词里写了同样的规则，
 * 但这是不可逆的内容损失，不能只靠提示词。
 */

import { readEpub } from '../epub/epub-reader.js';
import { cleanChapterXhtml } from '../epub/mediawiki.js';
import * as ws from './workspace.js';
import {
  buildChapterCard,
  synthesizePlan,
  buildChapterNames,
  applyNames,
  summarizePlan,
  condenseForCard,
  buildShortPageCard,
  MIN_JUDGEABLE_CHARS,
  VALUE_LABEL,
  STRATEGY_LABEL,
  STRATEGIES,
} from './book-plan.js';

/** 卡片阶段的并发度：别把 API 打爆，也别慢得离谱。 */
export const DEFAULT_PLAN_CONCURRENCY = 4;

/**
 * 这一章值不值得送到模型面前判断。
 *
 * 三类不送：
 *   · 导入时就判定没有可改写正文的（整页图片 / 空白页 / 扫码页）；
 *   · `tiny` 短页（不到 80 字）；
 *   · 去掉空白后仍不足 MIN_JUDGEABLE_CHARS 的页面 —— 材料不够，
 *     模型只能编（42 字题词被写成「正文第二章」就是实例）。
 *
 * 不送不等于丢掉：它们仍然会得到一张只复述原文的卡片，按 `skip` 原样保留。
 */
export function isJudgeableChapter(chapter) {
  if (!chapter || chapter.rewritable === false) return false;
  const kind = String(chapter.kind || '');
  if (kind === 'tiny' || kind === 'image-only' || kind === 'empty' || kind === 'prompt') return false;
  /**
   * 字数和 `isShortPage` 用**同一把尺**：去掉空白再数。
   * 一个用带空白的长度、一个用去空白的长度，英文书里会出现
   * 「判断队列说够长，卡片阶段却当短页」的分歧。
   */
  return String(chapter.text || '').replace(/\s/g, '').length >= MIN_JUDGEABLE_CHARS;
}

/**
 * 把一章的 XHTML 变成「够判断价值」的纯文本。
 *
 * 超长章节会被 `condenseForCard` 压到 PLAN_INPUT_CHARS 以内 ——
 * 裁剪时刻意保留段落顺序，因为「第 3 段在夸这本书、第 5 段开始讲正事」
 * 这种判断依赖顺序。
 */
/**
 * 从 XHTML 里取**正文**（`<body>`）的纯文字。
 *
 * 不能直接把整篇标签剥掉：维基文库把许可横幅的 CSS 写在 `<style>` 里，
 * 一章几千字，全是 `div:first-of-type{display:table…}` 这种。
 * 它们一旦算进正文，每章字数虚高一倍（规划按字数判断篇幅），
 * 而且各章看起来内容高度重复（同一段 CSS 人人都有）。
 */
function bodyTextOf(xhtml) {
  const m = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(String(xhtml || ''));
  const body = m ? m[1] : String(xhtml || '');
  return body
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function plainTextOf(xhtml) {
  return bodyTextOf(xhtml)
    .replace(/⟦\/?\d+⟧/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHINGLE_SIZE = 32;
const SHINGLE_STEP = 16;

/** 合集页的判定线：九成以上的字能在别处读到。 */
export const REDUNDANT_COVERAGE_THRESHOLD = 0.9;

/** 一章切成窗口：`full` 给去重比对，`samples` 是抽样，用来估覆盖率。 */
function shinglesOf(text) {
  const full = new Set();
  const samples = [];
  const s = String(text || '');
  for (let i = 0; i + SHINGLE_SIZE <= s.length; i += 1) full.add(s.slice(i, i + SHINGLE_SIZE));
  for (let i = 0; i + SHINGLE_SIZE <= s.length; i += SHINGLE_STEP) {
    samples.push(s.slice(i, i + SHINGLE_SIZE));
  }
  return { full, samples };
}

/**
 * 第 `targetIndex` 章有多少比例的字，能在 `covererIndexes` 这几章里读到。
 *
 * 这是**最终方案出来以后**再判一次用的：删一整章不可逆，而「覆盖它的章节
 * 还在不在方案里」只有等到方案定了才知道。
 */
export function coverageByChapterIndexes(chapters, targetIndex, covererIndexes) {
  const byIndex = new Map(chapters.map((c) => [c.index, c]));
  const target = byIndex.get(targetIndex);
  if (!target) return 0;
  const { samples } = shinglesOf(target.text);
  if (!samples.length) return 0;
  const union = new Set();
  for (const index of covererIndexes) {
    const c = byIndex.get(index);
    if (!c) continue;
    for (const s of shinglesOf(c.text).full) union.add(s);
  }
  let hit = 0;
  for (const s of samples) if (union.has(s)) hit += 1;
  return hit / samples.length;
}

/**
 * 从「能覆盖它的章节」里挑出**真正出力**的那几章。
 *
 * 只收集合里所有更短的章节是不行的：一本短篇集里，能覆盖合集页的章节集合
 * 里必然还混着一堆跟它毫无重叠的短章。拿这份名单去问「这些章还在不在方案里」，
 * 随便哪个不相关的短章被保留都会让答案变成「还在」，于是合集页被删掉、
 * 而真正被删的是另一篇正文 —— 内容就真丢了。
 *
 * 所以这里按贪心集合覆盖挑：每次选「能补上最多还没覆盖的字」的那一章，
 * 直到覆盖集合空掉。挑出来的就是它实际依赖的那几篇。
 */
function pickContributingCoverers(samples, coverers, allShingles) {
  const left = new Set();
  for (const o of coverers) {
    const full = allShingles.get(o.index).full;
    for (const s of samples) if (full.has(s)) left.add(s);
  }
  const used = new Set();
  const picked = [];
  while (left.size) {
    let best = null;
    let bestGain = 0;
    let bestSet = null;
    for (const o of coverers) {
      if (used.has(o.index)) continue;
      const full = allShingles.get(o.index).full;
      let gain = 0;
      const gainSet = [];
      for (const s of left) {
        if (full.has(s)) {
          gain += 1;
          gainSet.push(s);
        }
      }
      if (gain > bestGain) {
        best = o;
        bestGain = gain;
        bestSet = gainSet;
      }
    }
    if (!best || !bestGain) break;
    used.add(best.index);
    picked.push(best);
    for (const s of bestSet) left.delete(s);
  }
  return picked;
}

/**
 * 找出「合集页 / 目录页」：一章有九成以上的字，都能在**别的更短的章节**里读到。
 *
 * 这不是某一本书的特例。维基文库的「整部作品页」就是这个样子：
 * 一本书的首页把各篇全文都放了一份，下面又各自单独成章。
 * 规划模型看到这一页，会认真给它写提要、排进目录，于是成品里
 * 同一段内容出现两遍（一遍是提要，一遍是正文）。
 *
 * 判定条件是「被**更短的**章节覆盖」，方向很重要：
 *
 *   · 合集页（6500 字）被 小引（722）+ 後記（5731）覆盖 98% —— 该删；
 *   · 後記自己也被合集页覆盖 100%，但覆盖它的只有更长的合集页 —— 不该删。
 *
 * 只比更短的章节，就是把「合集页」和「其中一篇」区分开的唯一依据，
 * 也保证了不会出现「两章互相覆盖、被一起删掉」这种情况。
 *
 * `coveredBy` 只列**实际贡献了覆盖**的章节（见 pickContributingCoverers），
 * 不是「所有更短的章节」。删不删由调用方拿这份名单再核一次。
 *
 * @param {Array<{index:number,text:string,rewritable?:boolean}>} chapters
 * @param {{minChars?: number, threshold?: number}} [opts]
 * @returns {Map<number, {coverage:number, coveredBy:number[]}>}
 */
export function findRedundantChapters(chapters, opts = {}) {
  const minChars = opts.minChars ?? 400;
  const threshold = opts.threshold ?? REDUNDANT_COVERAGE_THRESHOLD;
  const pool = chapters.filter((c) => c.rewritable !== false && (c.text || '').length >= 200);

  const allShingles = new Map();
  for (const c of pool) allShingles.set(c.index, shinglesOf(c.text));

  const out = new Map();
  for (const c of pool) {
    if (c.text.length < minChars) continue;
    const { samples } = allShingles.get(c.index);
    if (!samples.length) continue;

    /**
     * 只取「更短」的章节（等长时按章序，靠前的留下）。
     * 这一步把「合集页」和「其中一篇」分开了 —— 见函数注释。
     */
    const coverers = pool.filter(
      (o) =>
        o !== c &&
        (o.text.length < c.text.length ||
          (o.text.length === c.text.length && o.index < c.index)),
    );
    const union = new Set();
    for (const o of coverers) for (const s of allShingles.get(o.index).full) union.add(s);
    let hit = 0;
    for (const s of samples) if (union.has(s)) hit += 1;
    const coverage = hit / samples.length;
    if (coverage >= threshold) {
      const contributors = pickContributingCoverers(samples, coverers, allShingles);
      out.set(c.index, { coverage, coveredBy: contributors.map((o) => o.index) });
    }
  }
  return out;
}

/**
 * 方案定稿前最后一刀：确认「这一页是重复的」在最终方案里依然成立，然后才删。
 *
 * 卡片阶段已经告诉过汇总模型这一页是重复的，但汇总可以改判，被它依赖的章节
 * 也可能在别处被删、被压。删一整章不可逆，所以这里用**最终方案里真的留下来
 * 的章节**重算一遍覆盖率：
 *
 *   · 覆盖率仍 ≥ 阈值：这一页确实只是副本，删；
 *   · 覆盖率掉下来了：覆盖它的章节没留住，这一页就是唯一副本，退回卡片原本判断。
 *
 * 第一版拿「所有更短的章节里有没有一个被保留」来判，而且对已经是 `drop`
 * 的条目直接跳过复查 —— 最常见的路径（卡片判重复 → 汇总照抄成 drop）
 * 于是完全绕过了这道安全线：合集页被删的同时，它里面那一篇在别处也被删了，
 * 读者的书就缺了一段，而且缺了都不知道。
 *
 * @param {object} args
 * @param {object} args.plan 汇总后的方案（entries 已过 normalizePlan）
 * @param {Array<{index:number,text:string}>} args.chapters
 * @param {Map<number, {coverage:number, coveredBy:number[]}>} args.redundant
 * @param {number} [args.threshold]
 * @returns {object} 处理后的方案（有改动会重新 summarize）
 */
export function applyRedundantDrops({ plan, chapters, redundant, threshold = REDUNDANT_COVERAGE_THRESHOLD }) {
  if (!redundant?.size) return plan;
  const entries = plan.entries || [];
  const byIndex = new Map(entries.map((e) => [e.index, e]));
  const kept = new Set(
    entries.filter((e) => e.strategy === 'keep' || e.strategy === 'digest').map((e) => e.index),
  );
  let changed = 0;
  for (const [index, info] of redundant) {
    const entry = byIndex.get(index);
    // 「原样保留」不是删除，别动它
    if (!entry || entry.strategy === 'skip') continue;
    const stillKept = info.coveredBy.filter((i) => kept.has(i));
    const coverage = coverageByChapterIndexes(chapters, index, stillKept);
    if (coverage >= threshold) {
      if (entry.strategy === 'drop') continue;
      const titles = stillKept
        .map((i) => byIndex.get(i)?.title)
        .filter(Boolean)
        .slice(0, 3)
        .join('、');
      entry.strategy = 'drop';
      entry.value = 'filler';
      entry.redundantOf = stillKept;
      entry.reason =
        `这一页 ${Math.round(coverage * 100)}% 的内容在「${titles}」里已经有了` +
        '（合集页 / 目录页），留着就是同一段内容读两遍，整页删掉';
      changed += 1;
      continue;
    }
    /**
     * 覆盖它的章节没留在方案里 —— 这一页是唯一副本，不能删。
     * 退回模型原本的判断（精读 / 压缩 / 原样保留都行），宁可多看一遍，
     * 也不能让读者拿到一本缺内容的书。
     */
    if (entry.strategy !== 'drop') continue;
    const original = entry.card?.redundantOriginal;
    const fallback = original && STRATEGIES.includes(original.strategy) ? original.strategy : 'keep';
    entry.strategy = fallback;
    if (original?.value) entry.value = original.value;
    entry.redundantOf = [];
    entry.reason =
      '覆盖这一页的章节在最终方案里没有被保留，删掉就没有第二份了，' +
      `按原判断「${STRATEGY_LABEL[fallback] || fallback}」处理`;
    changed += 1;
  }
  return changed ? summarizePlan(plan) : plan;
}

/**
 * 跑一遍完整规划，并把结果写进 `books/<id>/book-plan.json`。
 *
 * @param {object} args
 * @param {string} args.bookId
 * @param {object} args.provider
 * @param {string} args.projectRoot
 * @param {number} [args.concurrency]
 * @param {AbortSignal} [args.signal]
 * @param {(info: object) => void} [args.onProgress]
 * @returns {Promise<{plan: object, cards: object[], usage: object, stats: object}>}
 */
export async function planBook({
  bookId,
  provider,
  projectRoot,
  concurrency = DEFAULT_PLAN_CONCURRENCY,
  signal,
  onProgress,
}) {
  const metadata = await ws.readBookMetadata(bookId);
  const buffer = await (await import('node:fs/promises')).readFile(ws.bookPaths(bookId).original);
  const book = readEpub(buffer);

  const chapters = (metadata.chapters || []).map((c) => {
    const raw = book.zip.has(c.href) ? book.zip.readXmlText(c.href).text : '';
    /**
     * 判断价值之前先去掉网页外壳（导航表 / 姊妹计划 / 许可声明 / 导出水印）。
     * 不去的后果很实在：模型会把这些当成正文的一部分，
     * 判断篇幅、判断「这一章在讲什么」全都偏。
     */
    const cleaned = cleanChapterXhtml(raw, { lang: book.metadata.language || metadata.language || 'zh' });
    return {
      index: c.index,
      title: c.title,
      /** 导入时判定的页面性质：content / tiny / image-only / prompt / empty */
      kind: c.kind || 'content',
      textLength: c.textLength || 0,
      rewritable: c.rewritable !== false,
      text: plainTextOf(cleaned.xhtml),
    };
  });

  const targets = chapters.filter((c) => isJudgeableChapter(c));
  const trivial = chapters.filter((c) => !isJudgeableChapter(c));

  const bookTitle = metadata.title || '';
  const bookContext = `共 ${metadata.chapterCount || chapters.length} 个文件，${metadata.totalChars || 0} 字`;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usage.promptTokens += u.promptTokens || 0;
    usage.completionTokens += u.completionTokens || 0;
    usage.totalTokens += u.totalTokens || 0;
  };

  onProgress?.({
    phase: 'cards',
    message: `逐章判断：${targets.length} 章要判断，${trivial.length} 个短页 / 图片页按原文直接标记`,
  });

  /* ------------------------------------------------ 第一级：卡片 -- */
  const cards = [];
  const queue = [...targets];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) throw new Error('已取消');
      const ch = queue.shift();
      try {
        const { card } = await buildChapterCard({
          chapter: ch,
          provider,
          projectRoot,
          bookTitle,
          bookContext,
          signal,
        });
        cards.push(card);
        done += 1;
        onProgress?.({
          phase: 'cards',
          done,
          total: targets.length,
          message: `第 ${ch.index} 章 → ${VALUE_LABEL[card.value] || card.value} / ${STRATEGY_LABEL[card.strategy] || card.strategy}  ${card.role || ''}`,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        done += 1;
        // 单章判断失败不能让整本书停住；这一章会留空，汇总时按「拿不准」处理
        onProgress?.({ phase: 'cards', done, total: targets.length, message: `第 ${ch.index} 章判断失败：${err.message}` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, () => worker()));

  /**
   * 短页 / 无可读正文的页面：不花 API，卡片只复述看得见的事实。
   *
   * 这里以前统一写成「没有可读正文（整页图片 / 空白页 / 只有几个字）」，
   * 起名模型拿到这张卡片，就给封面起名「整页图片：无正文内容」。
   * 现在按页面性质分开写，并且**不再把这些卡片送去起名**（见 book-plan.js）。
   */
  for (const c of trivial) {
    cards.push(buildShortPageCard(c));
  }
  cards.sort((a, b) => a.index - b.index);

  /**
   * 合集页 / 目录页：内容在别的章节里已经有了。
   *
   * **必须在汇总之前算**，并且写进卡片里。第一版等到方案出来以后
   * 才由代码改判，于是汇总模型写的前言还说着「第 2 章是小引加后记的合集，
   * 已压缩成提要放在正文之后」—— 而成品里那一章其实是被整页删掉的。
   * 读者翻到「怎么读这本书」第一段就看到一句假话。
   *
   * 这条判断只能由代码做：模型看到的每章正文是截断过的，
   * 「这一页有 98% 的字在另外两章里」只有全文对得上才看得出来。
   */
  const redundant = findRedundantChapters(chapters, { threshold: REDUNDANT_COVERAGE_THRESHOLD });
  if (redundant.size) {
    const cardByIndex = new Map(cards.map((c) => [c.index, c]));
    for (const [index, info] of redundant) {
      const card = cardByIndex.get(index);
      if (!card) continue;
      const titles = info.coveredBy
        .map((i) => chapters.find((c) => c.index === i)?.title)
        .filter(Boolean)
        .slice(0, 3)
        .join('、');
      /**
       * 改判之前把模型自己的判断存下来。
       *
       * 这一页到底删不删，最后还要看「覆盖它的那几章有没有留在方案里」。
       * 不留的话它就是唯一副本，得退回模型原本的判断 —— 没有这份原值，
       * 一改判就再也退不回去了（v26 之前就是这么把正文删丢的）。
       */
      card.redundantOriginal = {
        strategy: card.strategy,
        value: card.value,
        role: card.role,
        skipLoss: card.skipLoss,
      };
      card.value = 'filler';
      card.strategy = 'drop';
      card.role =
        `这是合集页 / 目录页：${Math.round(info.coverage * 100)}% 的文字在` +
        `${titles ? `「${titles}」` : '别的章节'}里已经完整有了`;
      card.skipLoss = '无 —— 同样内容在其它章节里完整保留，这一页只是重复';
    }
  }

  /* ------------------------------------------------ 第二级：汇总 -- */
  onProgress?.({ phase: 'synthesis', message: '汇总成一份完整方案…' });
  const synth = await synthesizePlan({ cards, provider, projectRoot, bookTitle, signal });
  if (!synth.plan) {
    const err = new Error('汇总失败：模型没有返回可解析的方案');
    err.raw = String(synth.raw || '').slice(0, 500);
    throw err;
  }
  addUsage(synth.usage);

  // synthesizePlan 内部已经过 normalizePlan 那道硬闸，这里只做汇总统计
  let plan = summarizePlan(synth.plan);

  /* ------------------------------------------------ 第三级：起名 -- */
  onProgress?.({ phase: 'names', message: '给每一章起一个说人话的名字…' });
  const named = await buildChapterNames({ cards, provider, projectRoot, bookTitle, signal });
  addUsage(named.usage);
  plan = applyNames(plan, named.names);

  plan.overview = plan.overview || synth.plan.overview || '';
  plan.updatedAt = new Date().toISOString();

  /**
   * 兜底：方案定了以后再判一次「这一页到底能不能删」。
   *
   * 卡片阶段已经告诉过汇总模型这一页是重复的（见上面那段），但汇总可以改判，
   * 而被覆盖的章节也可能在别处被删、被压 —— 删一整章不可逆，所以这里必须
   * 用**最终方案里真的保留下来的章节**重新算一遍覆盖率：
   *
   *   · 覆盖率仍 ≥ 阈值：这一页确实只是副本，删；
   *   · 覆盖率掉下来了：覆盖它的章节没留住，这一页就是唯一副本，退回卡片原本判断。
   *
   * 第一版是拿「所有更短的章节」里有没有一个被保留来判的，而且对已经是
   * `drop` 的条目直接 `continue` 跳过复查 —— 于是最常见的路径
   * （卡片判重复 → 汇总照抄成 drop）完全绕过了这道安全线：
   * 合集页被删的同时，它里面那一篇在别处也被删了，读者的书就缺了一段。
   */
  if (redundant.size) plan = applyRedundantDrops({ plan, chapters, redundant });

  onProgress?.({ phase: 'saving', message: '写入整理方案…' });
  await ws.writeBookPlan(bookId, plan);

  return {
    plan,
    cards,
    usage,
    stats: {
      totalChapters: chapters.length,
      judged: targets.length,
      trivial: trivial.length,
      named: Object.keys(named.names || {}).length,
    },
  };
}
