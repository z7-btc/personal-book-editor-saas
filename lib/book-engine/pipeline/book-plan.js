/**
 * 重新规划这本书的阅读路径。
 *
 * 起因是用户的实际困扰：
 *   「有些书的章节排版不是特别好。目录里的某些章节压根就不重要，像序言之类的，
 *     有好几章大概都是在吹这本书有多好。看这些内容既获取不到什么知识，
 *     又浪费时间。」
 *
 * 他这本书的真实情况：纯前言后记（版权页 / 题词 / 献词 / 推荐序一、二 /
 * 译者序 / 目录 / 第1、2版前言 / 跋 / 致谢）加起来约 1.46 万字 ——
 * 只占全书 66.7 万字的 2.2%，**但它们全部堵在最前面**。
 * 所以问题不是「书太长」，是「门口堆了一堆东西」。
 *
 * ## 为什么分两级，而不是把整本书塞进去问一次
 *
 * 容量上塞得下（实测 60 万字符输入没问题），但实测表明**输入越大模型越敷衍**：
 * 同一章「切块 vs 整章一次」的对照里，整章一次的改写率从 44% 掉到 20%。
 * 30 万 token 的上下文里，模型对中段内容「看得到但记不住」，
 * 让它基于全书面做重构，产出的一定是「建议合并序言、按主题重组」这种
 * 放到任何一本书上都成立、因而毫无用处的方案。
 *
 * 所以：
 *   第一级  buildChapterCards()  —— 逐章产出卡片（输入是全书，输出只有几千字）
 *   第二级  synthesizePlan()     —— 只把卡片喂进去做重排（约 1 万字，模型能认真看完）
 *
 * 关键认识：**做决策需要的是卡片，不是原文。** 这也是为什么规划很便宜 ——
 * 输出是一份目录，不是一整本书。
 *
 * ## 一条不能越过的线
 *
 * 卡片里的 `value` / `strategy` 是**建议**，不是判决。
 * 「哪一章没价值」是价值判断，模型会判错 —— 用户这本书里，卡拉曼写的前言
 * 开头确实在夸这本书，但第 5~12 段讲了价值投资的定义、安全边际、市场先生、
 * 风险规避，一刀切删掉就丢知识了。
 * 所以规划结果必须能被人工改判（见 book-plan.json 的 `overrides`）。
 */

import { chatCompletion } from '../llm/client.js';
import { loadPromptTemplate, renderTemplate, splitPromptTemplate } from '../llm/prompts.js';

/** 章节的价值分级。 */
export const VALUE_LEVELS = ['core', 'useful', 'context', 'filler'];

export const VALUE_LABEL = {
  core: '核心',
  useful: '有用',
  context: '背景',
  filler: '填充',
};

/**
 * 规划阶段的单次输入上限（字符）。
 *
 * 比 Provider 里那个 maxInputChars 大得多，因为两件事完全不同：
 *   · 改写是「原文进、改写后的原文出」，输入体积和输出体积挂钩，要克制；
 *   · 规划是「整章进、几百字卡片出」，输出很小，输入大一点没有放大效应。
 * 而且实测这个模型吃 60 万字符输入没问题（见 docs/PHASES.md 实测数据）。
 *
 * 一张卡片要判断「哪几段是水分」，就得看得见整章 —— 只给摘要的话，
 * 模型只能复述标题，judgment 会退化成猜。
 */
export const PLAN_INPUT_CHARS = 200_000;

/**
 * 超长章节的压缩投喂：保留小标题和每段开头，够判断价值即可。
 *
 * 只在章节超过 PLAN_INPUT_CHARS 时才会用到。裁剪时刻意**保留段落顺序**，
 * 因为「第 3 段在夸这本书、第 5 段开始讲正事」这种判断依赖顺序。
 */
export function condenseForCard(text, maxChars = PLAN_INPUT_CHARS) {
  const s = String(text || '');
  if (s.length <= maxChars) return { text: s, condensed: false };

  const paras = s.split(/\n{2,}/);
  const perPara = Math.max(80, Math.floor(maxChars / Math.max(1, paras.length)) - 4);
  const shortened = paras.map((p) => (p.length > perPara ? `${p.slice(0, perPara)}…` : p));
  let out = shortened.join('\n\n');
  if (out.length <= maxChars) return { text: out, condensed: true };

  // 还是太长：均匀抽样，但保留所有小标题
  const keep = [];
  const step = Math.ceil(out.length / maxChars);
  for (let i = 0; i < shortened.length; i += 1) {
    const p = shortened[i];
    const isHeading = /^#{0,3}\s*.{0,30}$/.test(p) && p.length < 40;
    if (isHeading || i % step === 0) keep.push(p);
  }
  out = keep.join('\n\n').slice(0, maxChars);
  return { text: out, condensed: true };
}

/** 建议动作。 */
export const STRATEGIES = ['keep', 'digest', 'skip', 'drop'];

export const STRATEGY_LABEL = {
  keep: '照常精读改写',
  digest: '压缩成提要',
  skip: '原样保留，不处理',
  drop: '整章删除',
};

/**
 * 只有 `filler` 才允许整章删除。
 *
 * 这是比 `digest` 更狠的一刀：`digest` 至少还把这一章讲了什么留下几百字，
 * `drop` 是从书里彻底拿掉，读者再也看不到。
 *
 * 所以护栏比 `digest` 更硬：**只要有独立知识就不许删**。
 * `context`（背景）也不行 —— 推荐序、各版前言里经常有作者自己交代的
 * 写作意图和版本差异，那些是读书的钥匙，压成提要可以，删掉不行。
 * 用户的原话是「把那些和知识无关、纯粹吹牛赞美这本书的章节删掉」，
 * 那就严格按这个范围来：只删 filler。
 */
export function dropAllowed(value) {
  return value === 'filler';
}

/**
 * 从模型返回的 JSON 里取卡片，并做保守的兜底。
 *
 * 兜底原则：**拿不准就当有用**。
 * 判错成 filler 会让用户丢掉知识，判错成 useful 只是多读几页。
 *
 * 这里有一道**硬闸**，来自一次真实的翻车：第一次拿真书跑规划时，
 * 模型给 5 个 `value: useful` 的章节（其中一章 13 万字，装着整本
 * 《固定价值投资》）都标了 `strategy: digest` —— 理由是它们**内部**
 * 有几段水分。照这个执行会把全书 47.6% 的正文压成提要。
 *
 * 所以代码层面强制一条不变量：**只要有独立知识，就完整保留。**
 * 提示词里也写了同样的规则，但不能只靠提示词 —— 这是不可逆的内容损失，
 * 必须有确定性护栏。
 */
export function normalizeCard(raw, chapter) {
  const rawValue = VALUE_LEVELS.includes(raw?.value) ? raw.value : 'useful';
  /**
   * 拿不准就升级：模型给的值缺失或非法时按 useful 处理，
   * 而不是按 filler —— 宁可多读，不可误删。
   */
  const value = rawValue;
  let strategy = STRATEGIES.includes(raw?.strategy) ? raw.strategy : value === 'filler' ? 'digest' : 'keep';
  if ((value === 'core' || value === 'useful') && strategy !== 'keep') {
    // 有独立知识的章节一律完整保留，不接受任何「因为里面有几段水分」的理由
    strategy = 'keep';
  }
  /**
   * `drop` 只对 filler 开放，其它价值档次一律降级。
   *
   * 降级到哪一档要分情况：`context` 只是「不是知识主体」，
   * 不是「没用」—— 压成提要仍然留着它讲了什么；`core`/`useful` 更是
   * 一个字都不能少。所以非法 drop 统一降成 digest 更合适，
   * 而 core/useful 已经被上面那条拦成 keep 了，走不到这里。
   */
  if (strategy === 'drop' && !dropAllowed(value)) {
    strategy = 'digest';
  }

  const list = (v, max = 12) =>
    (Array.isArray(v) ? v : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .slice(0, max);

  return {
    index: chapter.index,
    title: chapter.title || '',
    chars: chapter.textLength || 0,
    value,
    strategy,
    role: String(raw?.role || '').trim().slice(0, 80),
    summary: String(raw?.summary || '').trim().slice(0, 400),
    knowledgePoints: list(raw?.knowledgePoints),
    dependsOn: (Array.isArray(raw?.dependsOn) ? raw.dependsOn : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 8),
    fillerParts: list(raw?.fillerParts, 8),
    skipLoss: String(raw?.skipLoss || '').trim().slice(0, 300),
    digestOf: String(raw?.digestOf || '').trim().slice(0, 200),
  };
}

/**
 * 从模型输出里抠出 JSON（模型有时会包一层 ```json 或加说明文字）。
 */
export function extractJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 第一级：给一章产出一张卡片。
 *
 * @param {object} args
 * @param {{id: number, title: string, text: string}} args.chapter
 * @param {object} args.provider
 * @param {string} args.projectRoot
 * @param {string} [args.bookTitle]
 * @param {string} [args.bookContext]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{card: object, usage: object|null, raw: string}>}
 */
export async function buildChapterCard({ chapter, provider, projectRoot, bookTitle, bookContext, signal }) {
  const loaded = await loadPromptTemplate(projectRoot, 'prompts/book-plan-card.txt');
  const { system, user } = splitPromptTemplate(loaded.template);

  const fed = condenseForCard(chapter.text);
  const messages = [
    { role: 'system', content: system || String(loaded.template) },
    {
      role: 'user',
      content: renderTemplate(user || String(loaded.template), {
        BOOK_TITLE: bookTitle || '（未知）',
        BOOK_CONTEXT: bookContext || '（无）',
        CHAPTER_INDEX: String(chapter.index),
        CHAPTER_TITLE: chapter.title || '（无标题）',
        CHAPTER_TEXT: fed.text,
      }),
    },
  ];

  const result = await chatCompletion(messages, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    temperature: 0.2,
    maxTokens: Math.max(1200, Number(provider.planMaxTokens) || 2000),
    maxInputChars: PLAN_INPUT_CHARS,
    timeoutMs: provider.timeoutMs,
    maxRetries: 2,
    reasoningEffort: provider.reasoningEffort,
    signal,
  });

  const json = extractJson(result.text);
  if (!json) {
    /**
     * 解析失败不能让整本书的规划塌掉：降级成一张「拿不准，当有用」的卡片。
     * 宁可让用户多读几页，也不能因为一次格式错误就把某一章判成填充。
     */
    return {
      card: normalizeCard({ role: '（卡片解析失败，按有用处理）', value: 'useful', strategy: 'keep' }, chapter),
      usage: result.usage,
      raw: result.text,
      parseFailed: true,
    };
  }
  return { card: normalizeCard(json, chapter), usage: result.usage, raw: result.text };
}

/**
 * 第二级：把所有卡片汇总成一份阅读路径。
 *
 * 输入只有卡片（约 1 万字），模型能真正看完，所以这一步的判断才可能是具体的。
 *
 * @param {object} args
 * @param {object[]} args.cards
 * @param {object} args.provider
 * @param {string} args.projectRoot
 * @param {string} [args.bookTitle]
 * @param {AbortSignal} [args.signal]
 */
export async function synthesizePlan({ cards, provider, projectRoot, bookTitle, signal }) {
  const loaded = await loadPromptTemplate(projectRoot, 'prompts/book-plan-synthesis.txt');
  const { system, user } = splitPromptTemplate(loaded.template);

  const cardText = cards
    .map((c) => {
      const lines = [
        `### 第 ${c.index} 章 · ${c.title}（${c.chars} 字）`,
        `价值判断：${VALUE_LABEL[c.value] || c.value}｜建议动作：${STRATEGY_LABEL[c.strategy] || c.strategy}`,
        c.role ? `它是什么：${c.role}` : '',
        c.summary ? `讲了什么：${c.summary}` : '',
        c.knowledgePoints.length ? `知识点：${c.knowledgePoints.join('；')}` : '',
        c.dependsOn.length ? `依赖：第 ${c.dependsOn.join('、')} 章` : '',
        c.digestOf ? `可保留的精髓：${c.digestOf}` : '',
        c.fillerParts.length ? `水分在哪：${c.fillerParts.join('；')}` : '',
        c.skipLoss ? `跳过的代价：${c.skipLoss}` : '',
      ];
      return lines.filter(Boolean).join('\n');
    })
    .join('\n\n');

  const messages = [
    { role: 'system', content: system || String(loaded.template) },
    {
      role: 'user',
      content: renderTemplate(user || String(loaded.template), {
        BOOK_TITLE: bookTitle || '（未知）',
        CHAPTER_CARDS: cardText,
      }),
    },
  ];

  const result = await chatCompletion(messages, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    temperature: 0.3,
    maxTokens: Math.max(2000, Number(provider.planMaxTokens) || 4000),
    timeoutMs: provider.timeoutMs,
    maxRetries: 2,
    reasoningEffort: provider.reasoningEffort,
    signal,
  });

  const json = extractJson(result.text);
  if (!json) {
    return { plan: null, usage: result.usage, raw: result.text, parseFailed: true };
  }
  return { plan: normalizePlan(json, cards), usage: result.usage, raw: result.text };
}

/**
 * 规整第二级的输出。
 *
 * 只保留「指向真实存在的章节」的条目 —— 模型偶尔会编出第 99 章。
 */
export function normalizePlan(raw, cards) {
  const byIndex = new Map(cards.map((c) => [c.index, c]));
  const entries = (Array.isArray(raw?.entries) ? raw.entries : [])
    .map((e) => {
      const index = Number(e?.index);
      if (!byIndex.has(index)) return null;
      const base = byIndex.get(index);
      const value = VALUE_LEVELS.includes(e?.value) ? e.value : base.value;
      let strategy = STRATEGIES.includes(e?.strategy) ? e.strategy : base.strategy;
      /**
       * 汇总阶段同样要过那道硬闸。
       *
       * 卡片阶段拦过一次，但汇总阶段模型可以**改判**（那正是它的职责）。
       * 第一次真书实测里，模型正是想借汇总把几章核心正文压掉 ——
       * 理由写得头头是道（「压缩保留核心方法论即可」），
       * 但那一章有 13 万字，压完等于把这本书砍掉一半。
       */
      if ((value === 'core' || value === 'useful') && strategy !== 'keep') strategy = 'keep';
      // 同一道闸：只有 filler 能被整章删除（见 dropAllowed）
      if (strategy === 'drop' && !dropAllowed(value)) strategy = 'digest';
      return {
        index,
        title: base.title,
        chars: base.chars,
        value,
        strategy,
        reason: stripContradictoryAction(String(e?.reason || '').trim().slice(0, 200), strategy),
        // 保留卡片原文，人工改判时用得上
        card: base,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  const known = new Set(entries.map((e) => e.index));
  for (const c of cards) {
    if (known.has(c.index)) continue;
    entries.push({ index: c.index, title: c.title, chars: c.chars, value: c.value, strategy: c.strategy, reason: '', card: c });
  }
  entries.sort((a, b) => a.index - b.index);

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    overview: String(raw?.overview || '').trim().slice(0, 2000),
    /**
     * 正文重排顺序。
     *
     * 模型只负责给「有卡片的章节」排序；纯图片页 / 空白页它根本没见过，
     * 由 `buildSpineOrder()` 粘到相邻章节旁边。
     * 这里只做「数字、去重、限定在已有卡片范围内」的清洗 ——
     * 完整性校验交给 buildSpineOrder（它才知道完整的 spine 有哪些项）。
     */
    order: Array.isArray(raw?.order)
      ? raw.order
          .map((n) => Number(n))
          .filter((n) => byIndex.has(n))
          .filter((n, i, arr) => arr.indexOf(n) === i)
      : [],
    readingPath: (Array.isArray(raw?.readingPath) ? raw.readingPath : [])
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 30),
    frontMatterNote: String(raw?.frontMatterNote || '').trim().slice(0, 1200),
    entries,
    /** 用户手工改判：{ [章号]: { strategy, value, note } } */
    overrides: {},
  };
}

/**
 * 给每一章起一个「说人话」的名字。
 *
 * 用户的原话：「你是可以去修改这些目录对应的名字的，这样能让我更容易去查看、
 * 学习和理解。」他对比了原版和 AI 版目录，发现只有顺序变了、名字没变 ——
 * 而「第二部分 固定价值投资」这样的名字并不能告诉他这一章讲什么。
 *
 * 输入是卡片（不是全文），所以这一步很便宜；输出也只有几百字。
 *
 * @param {object} args
 * @param {object[]} args.cards
 * @param {object} args.provider
 * @param {string} args.projectRoot
 * @param {string} [args.bookTitle]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{names: Record<string,string>, usage: object|null}>}
 */
export async function buildChapterNames({ cards, provider, projectRoot, bookTitle, signal }) {
  const loaded = await loadPromptTemplate(projectRoot, 'prompts/book-plan-names.txt');
  const { system, user } = splitPromptTemplate(loaded.template);

  const cardText = cards
    .map((c) => {
      const lines = [
        `### 第 ${c.index} 章 · 原名：${c.title || '（无标题）'}（${c.chars} 字）`,
        c.role ? `它是什么：${c.role}` : '',
        c.summary ? `讲了什么：${c.summary}` : '',
        c.knowledgePoints.length ? `知识点：${c.knowledgePoints.join('；')}` : '',
        c.strategy === 'digest' ? '（这一章会被压缩成一页提要）' : '',
      ];
      return lines.filter(Boolean).join('\n');
    })
    .join('\n\n');

  const messages = [
    { role: 'system', content: system || String(loaded.template) },
    { role: 'user', content: renderTemplate(user || String(loaded.template), { BOOK_TITLE: bookTitle || '（未知）', CHAPTER_CARDS: cardText }) },
  ];

  const result = await chatCompletion(messages, {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    temperature: 0.3,
    maxTokens: 4000,
    timeoutMs: provider.timeoutMs,
    maxRetries: 2,
    reasoningEffort: provider.reasoningEffort,
    signal,
  });

  const json = extractJson(result.text);
  const known = new Set(cards.map((c) => String(c.index)));
  const names = {};
  if (json?.names && typeof json.names === 'object') {
    for (const [k, v] of Object.entries(json.names)) {
      const key = String(Number(k));
      if (!known.has(key)) continue; // 编出来的章节号不要
      const name = String(v ?? '').trim().slice(0, 60);
      if (name) names[key] = name;
    }
  }
  return { names, usage: result.usage };
}

/**
 * 章名后面「· 已压缩为一页提要」这类**按当时方案写的**后缀。
 *
 * 起名字那一步的卡片上会注明「这一章会被压缩成一页提要」，模型有时
 * 就把这句写进标题里。问题是这句会在方案改判之后变成假话：这一章
 * 后来判成「照常精读」，标题里却还写着已压缩、正文也是全文 ——
 * 用户在目录里一眼看到，就觉得整个改造不靠谱。
 * 压缩 / 原样保留在界面和阅读路径页都是**单独标注**的，标题里不需要。
 */
/**
 * 章名里的「· 已压缩为一页提要」。
 *
 * 有时在**末尾**（「小引：写作缘起 · 已压缩为一页提要」），
 * 有时夹在**中间**、正好在冒号前面（「小引·已压缩为一页提要：鲁迅自述…」）——
 * 后者那句会原样印成章节标题，读者以为章名就叫这个。
 */
const STRATEGY_SUFFIX_RES = [
  /\s*[·・]\s*已压缩为一页提要(?=\s*[：:]|\s*$)/,
  /\s*[·・]\s*已压缩为提要(?=\s*[：:]|\s*$)/,
];

export function stripStrategySuffix(name) {
  let out = String(name || '').trim();
  for (const re of STRATEGY_SUFFIX_RES) out = out.replace(re, '').trim();
  return out;
}

/**
 * 理由里「怎么处理」的说法，和最终动作对不上时，把那一句删掉。
 *
 * 真实案例（《朝花夕拾》成品）：「后记」被判成 `useful`，代码硬闸把它
 * 保成 keep，模型写的理由是「后记考据偏版本校勘，与目录页重复，
 * **压成提要即可**」。这一页连同理由会原样印在「怎么读这本书」上：
 *
 *     后记：考证……  5,957 字 · 有用 · 照常精读改写
 *     理由：……压成提要即可。
 *
 * 读者会以为这章被压过，翻过去却看到全文；同一页的导读也说
 * 「读第 10 章后记提要」。看上去像整个工具坏了。
 *
 * 为什么是删而不是改判：核心 / 有用的章节不许压缩（那道闸是有意的），
 * 所以唯一和事实一致的改法是「这句话不成立，删掉」。理由的其余部分
 * （「考据偏版本校勘」）仍然有用，保留。
 *
 * 只认很硬的说法、并排除否定式（「不必压缩」「不能删掉」），
 * 免得把正常的理由误删。
 */
const ACTION_CUES = {
  digest: [/压(?:缩)?成(?:一页|一份)?提要/, /压缩为提要/, /做成提要/, /只要提要即可/, /保留提要即可/],
  skip: [/原样保留即可/, /不做处理/, /不必处理/, /无需处理/],
  keep: [/必须精读/, /不可跳过/, /不能跳过/, /都要精读/, /一律精读/],
  drop: [/整页删除/, /整章删除/, /整页移除/, /整章移除/],
};

const NEGATION_TAIL = /(?:不|无需|不必|不能|不要|不该|不用|别)\s*$/;

/** 这一句里有没有「按 X 处理」的硬说法（不算被否定的）。 */
function statesAction(text, action) {
  for (const re of ACTION_CUES[action] || []) {
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (NEGATION_TAIL.test(before)) continue;
    return true;
  }
  return false;
}

export function stripContradictoryAction(reason, strategy) {
  const text = String(reason || '').trim();
  if (!text) return '';
  const others = Object.keys(ACTION_CUES).filter((k) => k !== strategy);
  const contradicts = (s) => others.some((k) => statesAction(s, k));
  if (!contradicts(text)) return text;

  /** 先按句切；整句都是别人的动作就整句删，否则只删句子里那半句。 */
  const sentences = text.split(/(?<=[。；！？])/).map((s) => s.trim()).filter(Boolean);
  const kept = [];
  for (const s of sentences) {
    if (!contradicts(s)) {
      kept.push(s);
      continue;
    }
    const tail = s.replace(/[。；！？]+$/, '');
    const clauses = tail.split(/[，,]/).map((c) => c.trim()).filter(Boolean);
    const survivors = clauses.filter((c) => !contradicts(c));
    if (!survivors.length) continue;
    kept.push(`${survivors.join('，')}。`);
  }
  return kept.join('');
}

/**
 * 书里的「家具页」：封面、书名页、版权页、目录页。
 *
 * 起名模型会给它们写出「封面：无正文，整页图片或空白页」这种句子 ——
 * 对正文是帮忙，对家具页反而是噪音：读者在目录面板里看到这么一条，
 * 像是一句说明跑进了书名。这类页面保留原名（「封面」）。
 */
const FURNITURE_TITLE_RE = /^\s*(封面|書名頁|书名页|封面頁|版权页|版權頁|扉页|扉頁|目录|目錄)\s*$/;

/**
 * 把「名字」叠加到规划上；没起名的章节保留原名（不能出现空标题）。
 */
export function applyNames(plan, names = {}) {
  const merged = { ...(plan.names || {}), ...names };
  for (const e of plan.entries || []) {
    if (FURNITURE_TITLE_RE.test(String(e.title || ''))) delete merged[String(e.index)];
  }
  return {
    ...plan,
    names: merged,
    entries: (plan.entries || []).map((e) => {
      const furniture = FURNITURE_TITLE_RE.test(String(e.title || ''));
      const displayTitle = furniture
        ? String(e.title || '')
        : stripStrategySuffix(merged[String(e.index)] || e.displayTitle || e.title || '') ||
          e.displayTitle ||
          e.title ||
          '';
      return { ...e, displayTitle };
    }),
  };
}

/**
 * 把 spine 里**不是正文章节**的页面（封面、版权页、分册扉页、说明页）
 * 按它们在原书 spine 里的位置挂到相邻正文章节上。
 *
 *   · 原书第一个正文章节**之前**的页面（封面、书名页）—— 留在最前面，
 *     不管第一章被排到哪里：封面不属于任何一章；
 *   · 夹在两章之间的页面（分册扉页、整页插图）—— 贴在它后面第一个
 *     正文章节**前面**，跟那一章一起走；
 *   · 最后一章之后的页面（「关于本书」）—— 留在最后。
 *
 * 早先的做法是把这些页面一股脑追加到末尾：成品里封面排到第 10 页，
 * 读者打开书先看到目录页，封面反而在结尾。
 *
 * @param {string[]} spineIds 原书 spine 的 idref 顺序
 * @param {Iterable<string>} chapterIds 会被重排的正文章节 id
 * @param {string[]} orderedIds 重排后的正文章节 id 顺序
 * @returns {string[]} 新的 spine idref 顺序
 */
export function attachRestToChapters(spineIds, chapterIds, orderedIds) {
  const isChapter = chapterIds instanceof Set ? chapterIds : new Set(chapterIds || []);
  const ordered = (orderedIds || []).filter((id) => isChapter.has(id));
  const ids = Array.isArray(spineIds) ? spineIds : [];
  /** 每个位置之后（含自身）的第一个正文章节 id */
  const nextChapterAt = new Array(ids.length).fill(null);
  let nextId = null;
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    if (isChapter.has(ids[i])) nextId = ids[i];
    nextChapterAt[i] = nextId;
  }
  const firstChapterAt = ids.findIndex((id) => isChapter.has(id));
  const front = [];
  const beforeMap = new Map();
  const trailing = [];
  ids.forEach((id, i) => {
    if (isChapter.has(id)) return;
    const anchor = nextChapterAt[i];
    if (!anchor) {
      trailing.push(id);
    } else if (firstChapterAt < 0 || i < firstChapterAt) {
      front.push(id);
    } else {
      if (!beforeMap.has(anchor)) beforeMap.set(anchor, []);
      beforeMap.get(anchor).push(id);
    }
  });
  return [...front, ...ordered.flatMap((id) => [...(beforeMap.get(id) || []), id]), ...trailing];
}

/**
 * 把「模型排过序的章节」和「它没见过的页面」合成一份完整顺序。
 *
 * 模型只拿到有正文的章节卡片，所以纯图片页 / 空白页（版权页、分册扉页、
 * 整页插图）它没法排。这些页面不该被丢掉，也不该乱插，做法是：
 * **粘在它原本后面第一个被排过序的章节旁边**，跟着那个章节一起走。
 * 这样「下册扉页」会跟着它后面的正文，而不是孤零零留在开头。
 *
 * @param {Array<{index: number}>} allChapters 完整的章节列表（按原顺序）
 * @param {number[]} orderedIndexes 模型给的顺序（可能不完整、可能乱序）
 * @returns {{order: number[], moved: boolean, reason: string}}
 */
export function buildSpineOrder(allChapters, orderedIndexes) {
  const original = allChapters.map((c) => c.index);
  const known = new Set(original);
  const wanted = (Array.isArray(orderedIndexes) ? orderedIndexes : [])
    .map(Number)
    .filter((n) => known.has(n))
    .filter((n, i, arr) => arr.indexOf(n) === i);

  if (!wanted.length) {
    return { order: original, moved: false, reason: '模型没有给出顺序，保持原样' };
  }

  /**
   * 把没被排序的页面，粘到它**后面第一个**被排过序的章节上 ——
   * 也就是在成品里排在那个章节**前面**。
   *
   * 为什么是「后面第一个」而不是「前面最近的那个」：
   * 这些页面通常是分册扉页、整页插图、扫码页，性质上属于**下一节的开场**。
   * 比如第 9 章是「下册扉页」，夹在第 8 章和第 10 章之间；
   * 第 10 章被排到后面去了，扉页就该跟着第 10 章走 ——
   * 粘到第 8 章后面的话，读者会在上册末尾看到一张下册扉页。
   */
  const before = new Map(); // 锚点章节号 -> 排在它前面的页面
  const orderedSet = new Set(wanted);
  let pending = [];
  for (const idx of original) {
    if (orderedSet.has(idx)) {
      before.set(idx, pending);
      pending = [];
    } else {
      pending.push(idx);
    }
  }
  const trailing = pending; // 末尾那些后面没有已排序章节的页面

  const order = [];
  for (const idx of wanted) {
    order.push(...(before.get(idx) || []), idx);
  }
  order.push(...trailing);

  // 收尾自检：必须是完整排列，否则退回原顺序
  const okLength = order.length === original.length;
  const okUnique = new Set(order).size === original.length;
  const okCover = original.every((n) => order.includes(n));
  if (!okLength || !okUnique || !okCover) {
    return { order: original, moved: false, reason: '合成出来的顺序不是完整排列，已退回原顺序' };
  }

  const moved = order.some((n, i) => n !== original[i]);
  return { order, moved, reason: moved ? '按模型建议重排' : '模型给的就是原顺序' };
}

/** 把用户的改判叠加到规划上。 */
export function applyOverrides(plan, overrides = {}) {
  const merged = { ...plan, overrides: { ...(plan.overrides || {}), ...overrides } };
  merged.entries = (plan.entries || []).map((e) => {
    const o = merged.overrides[e.index] || merged.overrides[String(e.index)];
    if (!o) return e;
    return {
      ...e,
      strategy: STRATEGIES.includes(o.strategy) ? o.strategy : e.strategy,
      value: VALUE_LEVELS.includes(o.value) ? o.value : e.value,
      reason: o.note ? `（人工改判）${o.note}` : e.reason,
      overridden: true,
    };
  });
  return merged;
}

/**
 * 压缩总量的安全线：超过全书的这个比例就要报警。
 *
 * 用户真正想压的是前面那堆推荐序 / 献词 / 致谢（实测约占 2~3%）。
 * 一旦方案要压掉四分之一以上的正文，几乎肯定是模型把
 * 「章内有些水分」误当成了「整章没价值」—— 那正是第一次实测发生的事，
 * 它一口气要压掉 47.6%。
 */
export const DIGEST_RATIO_WARN = 0.25;

/** 汇总：这本书最终要做什么。 */
export function summarizePlan(plan) {
  const merged = applyOverrides(plan);
  const counts = { keep: 0, digest: 0, skip: 0 };
  const values = { core: 0, useful: 0, context: 0, filler: 0 };
  let digestChars = 0;
  let totalChars = 0;
  for (const e of merged.entries) {
    counts[e.strategy] = (counts[e.strategy] || 0) + 1;
    values[e.value] = (values[e.value] || 0) + 1;
    totalChars += e.chars || 0;
    if (e.strategy === 'digest') digestChars += e.chars || 0;
  }
  const digestRatio = totalChars ? digestChars / totalChars : 0;
  const warnings = [];
  if (digestRatio > DIGEST_RATIO_WARN) {
    warnings.push(
      `方案要压缩 ${digestChars} 字，占全书的 ${(digestRatio * 100).toFixed(1)}% —— 太多了。` +
        `请逐条检查这些章节是不是真的「读完带不走知识」，尤其别把正文当成水分压掉。`,
    );
  }
  return {
    ...merged,
    counts,
    values,
    totalChars,
    digestChars,
    digestRatio,
    warnings,
    /** 压缩后能省下多少阅读量 —— 这是用户真正关心的数字 */
    savedChars: digestChars,
  };
}
