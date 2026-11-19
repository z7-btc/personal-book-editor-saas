/**
 * 脚注处理。
 *
 * ## 为什么要有这一层
 *
 * 用户的原话：「脚注一般都是名词解释之类的，如果是重要的内容，就不需要用脚注，
 * 直接放在书里的括号里解释一下就行了；如果不重要的，直接删了也没有关系。」
 *
 * 他的判断方向对，但这本书的实际情况和数据不一样（实测 483 条脚注）：
 *
 *   编者注（有署名）  69 条  14%   6,196 字   ← 卡拉曼/马克斯这一级的人写的补充论述
 *   实质说明         188 条  39%  39,047 字   ← 带具体数据和案例
 *   短说明           198 条  41%  14,156 字   ← 交叉引用、简短补充
 *   纯出处            28 条   6%   1,654 字   ← 《伦巴底街》第245页，纽约，1892年
 *
 * 只有 6% 是纯书目出处。所以「一刀切删掉」会丢掉 4.5 万字的实质内容。
 *
 * ## 做法：就地化（inline）
 *
 * 把注释内容融进正文（括号或紧接的一句），然后**删掉标记**。三个好处：
 *   1. 读者不用来回翻 —— 这才是脚注烦人的根本原因；
 *   2. 实质内容一条不丢；
 *   3. **交叉引用冲突自动消失**：标记没了，脚注汇编那一章就没人指向了，
 *      于是它可以被自由压缩。
 *
 * 第 3 点很关键。原本「压缩脚注汇编」和「不切断全书 483 个脚注链接」
 * 是矛盾的 —— 就地化之后这个矛盾从设计上消失了，而不是靠忽略死链绕过去。
 */

/** 注释的四种类型。 */
export const NOTE_KINDS = ['editor', 'substantive', 'brief', 'citation'];

export const NOTE_KIND_LABEL = {
  editor: '编者注（有署名）',
  substantive: '实质说明',
  brief: '短说明',
  citation: '纯出处',
};

/**
 * 给一条注释分类。
 *
 * 只看形式特征，不做语义判断 —— 语义判断交给模型（在改写正文时）。
 * 这里的作用是：决定质量检查时「哪些注释必须能在成品里找到」。
 */
export function classifyNote(text) {
  const body = String(text || '').replace(/^\(\d+\)\s*/, '').trim();
  if (!body) return 'brief';
  // 有署名的编者注：结尾是「——某某注」
  if (/——[^—]{1,14}注\s*$/.test(body)) return 'editor';
  const bookish = (body.match(/《|》|页|出版社|年版|译|著|第\d+版|Press|University/g) || []).length;
  const sentences = (body.match(/[。；！？]/g) || []).length;
  if (bookish >= 1 && sentences <= 1 && body.length < 90) return 'citation';
  if (body.length >= 100 && sentences >= 2) return 'substantive';
  return 'brief';
}

/** 这些类型的内容「必须」能在成品里找到，否则就是丢知识。 */
export function isMustKeep(kind) {
  return kind === 'editor' || kind === 'substantive';
}

/**
 * 把注释文本切成适合校验的特征片段。
 *
 * 取较长的句子片段而不是整段：模型的措辞会变，逐字比对必然失败；
 * 但像「亏钱常常会让人不安」这种特征片段，改写时通常还能对上大半。
 */
export function noteFingerprints(text, minLen = 12) {
  return String(text || '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/——[^—]{1,14}注\s*$/, '')
    .split(/[。；！？\n]/)
    .map((s) => s.replace(/[，,、：:\s"'“”‘’()（）]/g, '').trim())
    .filter((s) => s.length >= minLen)
    .slice(0, 3);
}

/**
 * 注释内容「还在不在」的模糊校验。
 *
 * 不能用逐字比对：模型把注释融进正文时**一定会改写措辞**
 * （「亏钱常常会让人不安」→「亏损难免让人心里发慌」），
 * 逐字比对会把「改写成功」误报成「内容丢失」，那这个检查就没用了。
 *
 * 做法：把注释切成特征片段，再看成品里有没有**足够像**的句子。
 * 用字符二元组的重叠度（bigram Jaccard），中文短句上比编辑距离稳。
 *
 * @param {string} noteText
 * @param {string[]} sentences 成品切好的句子（去掉标点后的）
 * @param {{threshold?: number}} [opts]
 * @returns {{covered: boolean, best: number, bestAgainst: string}}
 */
export function noteCoverage(noteText, sentences, opts = {}) {
  const threshold = opts.threshold ?? 0.55;
  const fps = noteFingerprints(noteText, 10).map(stripPunct);
  if (!fps.length) return { covered: true, best: 0, bestAgainst: '' };

  let best = 0;
  let bestAgainst = '';
  for (const fp of fps) {
    for (const s of sentences) {
      const v = bigramSim(fp, stripPunct(s));
      if (v > best) {
        best = v;
        bestAgainst = s;
      }
    }
  }
  return { covered: best >= threshold, best, bestAgainst };
}

function stripPunct(s) {
  return String(s || '').replace(/[\s，,、：:；;。！？!?“”‘’"'()（）《》〈〉\-—…·]/g, '');
}

function bigramSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return (2 * inter) / (ga.size + gb.size);
}

/** 把一段正文切成句子（用于覆盖率检查）。 */
export function splitSentences(text) {
  return String(text || '')
    .split(/[。！？；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

/**
 * 整章的脚注覆盖率报告。
 *
 * ## 这是开发期的诊断工具，**不要**接进用户界面
 *
 * 用户明确说过「注释被删这件事不需要我看见」。这是对的：
 *
 *   一条注释没出现在成品里，证明不了任何事情。「留哪条、删哪条」
 *   本来就是交给模型的**编辑判断** —— 纯出处的删掉、有时效性的举例
 *   可留可删、有实质内容的融进正文。用户的判断标准是「我读着顺不顺」，
 *   不是「11 条里保住了几条」。
 *
 * 更关键的是：**据此做机械兜底是错的**。实测里被删的那条是
 * 「2007年7月次贷危机是最新最富戏剧性的案例——卡拉曼注」，
 * 挂在「但每隔一段时间……」这句后面。原文那句话本来就完整，
 * 注释只是补了个有时效性的例子；把它硬塞回去，段落反而更差。
 *
 * 真正要防的「意外丢失」有别的信号：输出被截断（finish_reason=length）、
 * 整块被压成一句话（summaryCollapse）、占位符大量丢失（corrupted）。
 * 那些都有独立的检测，不靠这个。
 *
 * @param {string} rewrittenText 成品正文的纯文字
 * @param {Map<string, {text: string, kind: string}>} noteRefs
 * @returns {{checked: number, kept: number, dropped: Array<{ref: string, kind: string, preview: string, best: number}>}}
 */
export function checkNoteCoverage(rewrittenText, noteRefs) {
  const sentences = splitSentences(rewrittenText);
  let checked = 0;
  let kept = 0;
  const dropped = [];
  for (const [ref, note] of noteRefs) {
    if (!isMustKeep(note.kind)) continue;
    checked += 1;
    const r = noteCoverage(note.text, sentences);
    if (r.covered) kept += 1;
    else dropped.push({ ref, kind: note.kind, preview: note.text.slice(0, 60), best: Number(r.best.toFixed(2)) });
  }
  return { checked, kept, dropped };
}

/**
 * 扫全书，建立「脚注锚点 -> 注释内容」的索引。
 *
 * ## 怎么认出真正的脚注（这一步不能靠猜）
 *
 * 第一版实现是「凡是带 id 又被别处引用的元素都算注释」，结果在这本书上
 * 捞出 1038 条 —— 而真正的脚注只有 483 条。多出来的是**目录锚点**：
 * 目录指向 `text00002.html#pre2_2`，而那个 `id` 挂在标题上，
 * 于是「各方赞誉」这四个字被当成了一条注释。
 *
 * 真正的脚注有一个**结构性特征**：它是**成对的互相引用** ——
 *   正文里：`<a id="jzyy_1_28" href="text00027.html#jz_1_28">(1)</a>`
 *   注释里：`<a id="jz_1_28" href="text00009.html#jzyy_1_28">(1)</a> 注释正文…`
 * 前者指过去、后者指回来。目录锚点只有单向引用，所以会被排除掉。
 *
 * 注释正文取的是**包含它的那个块**的文字（注释正文在 `<a>` 外面，
 * 不是它的内容）—— 这一点如果搞错，取到的就只是 "(1)" 这种标记本身。
 *
 * @param {Array<{index: number, href: string, xhtml: string}>} chapters
 * @returns {{notes: Map<string, {text: string, kind: string, chapter: number}>,
 *            refToNote: Map<string, string>, totalNotes: number}}
 */
export function buildNoteIndex(chapters) {
  /** 每个 <a> 的 id -> 它指向的锚点 */
  const outgoing = new Map();
  /** 每个 <a> 出现在哪一章 */
  const owner = new Map();

  for (const c of chapters) {
    const html = String(c.xhtml || '');
    for (const m of html.matchAll(/<a\s([^>]*)>/gi)) {
      const attrs = m[1];
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
      const href = (attrs.match(/\bhref="([^"]+)"/) || [])[1];
      if (!id) continue;
      owner.set(id, c.index);
      if (href && href.includes('#')) outgoing.set(id, href.split('#').pop());
    }
  }

  /** 成对判定：A -> B 且 B -> A，才算脚注 */
  const pairs = [];
  for (const [a, b] of outgoing) {
    if (outgoing.get(b) === a) pairs.push([a, b]);
  }

  const refToNote = new Map();
  const notes = new Map();

  for (const c of chapters) {
    const html = String(c.xhtml || '');
    // 块级元素：注释正文在标记所在的块里
    for (const m of html.matchAll(/<(p|div|li|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const inner = m[3];
      for (const pm of inner.matchAll(/<a\s([^>]*)>/gi)) {
        const attrs = pm[1];
        const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
        if (!id) continue;
        const counterpart = outgoing.get(id);
        if (!counterpart || outgoing.get(counterpart) !== id) continue;

        /**
         * 哪一头是「注释」？
         *
         * 用**标记在块里的位置**判断，这是唯一可靠的信号：
         *   · 注释那一头写成 `<p class="fn…"><a id="jz_1_28">(1)</a> 注释正文…</p>`
         *     —— 标记是块的**第一个**内容；
         *   · 正文那一头写成 `…带来的痛苦<a id="jzyy_1_28">(1)</a>。假如…`
         *     —— 标记前面还有正文。
         *
         * 第一版用「块的文字长度 > 20」判断，结果两头都符合（正文段落当然也长），
         * 于是每条脚注被数了两遍，483 条变成了 940 条。
         */
        const anchorIndex = pm.index ?? 0;
        const before = inner.slice(0, anchorIndex);
        const beforeHasText = before.replace(/<[^>]*>/g, '').trim().length > 0;
        if (beforeHasText) continue; // 这一头是正文里的引用点，不是注释

        const text = inner
          .replace(/<[^>]+>/g, ' ')
          .replace(/⟦\/?\d+⟧/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          /**
           * 去掉开头的序号标记 `(1)`。
           *
           * 它属于「脚注系统的外壳」，不属于注释内容。留着的话会被
           * 原样融进正文，读者会读到「……带来的痛苦。(1) 正如格雷厄姆所言……」
           * 这种带着旧编号的句子。
           */
          .replace(/^[（(]\s*\d+\s*[)）]\s*/, '');
        if (!text) continue;
        if (!notes.has(id)) {
          notes.set(id, { text, kind: classifyNote(text), chapter: c.index });
        }
        refToNote.set(counterpart, id);
      }
    }
  }

  return { notes, refToNote, totalNotes: notes.size };
}

/**
 * 这个行内元素是不是「脚注标记」。
 *
 * 判据：它是 `<a>`（或含 `<a>`），href 指向一个已知的注释锚点。
 * 只用结构判断，不猜类名 —— 不同出版社的 HTML 差别很大。
 */
export function noteAnchorOf(el, refToNote, notes) {
  if (!el || typeof el.getAttribute !== 'function') return null;
  const id = el.getAttribute('id');
  if (id && refToNote.has(id)) {
    const anchor = refToNote.get(id);
    if (notes.has(anchor)) return anchor;
  }
  const href = el.getAttribute('href');
  if (href && href.includes('#')) {
    const anchor = href.split('#').pop();
    if (notes.has(anchor)) return anchor;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 脚注署名（「——某某注」）
// ---------------------------------------------------------------------------

/**
 * 原书的注释正文常常自带署名：
 *
 *     ……《巴菲特传》，第35页。——罗杰·洛温斯坦注
 *     ……抑制了长期资本管理公司的运转。——梅尔金注
 *
 * 署名是「这是一条脚注」的**外壳**，不是内容。用户原话（User said (m01869)）：
 * 「我让你融进文字之中，就是把脚注当中有用的信息给融进文字之中，
 *   你就不用标注它是脚注了。」
 *
 * ## 为什么必须在「送进模型之前」剥掉
 *
 * 这些署名**来自原书**，不是模型编的 —— 实测这本书 483 条尾注里有 69 条带署名
 * （格兰特注 23 / 译者注 14 / 卡拉曼注 11 / 梅尔金注 10 / 罗杰·洛温斯坦注 5 /
 *   唐朝注 4 / 作者注 1 / 编者注 1）。模型把整条注释搬进正文时，
 * 署名是跟着一起搬的。只在输出端拦，等于每一条都得靠模型「记得别写」；
 * 在输入端剥掉，模型从头到尾就没见过它。
 *
 * 输出端（`applyChunkResults`）仍然再拦一道 —— 模型有时会自己补一个
 * 「——译者注」上去，那种情况输入端拦不住。
 */

/**
 * 署名形状：破折号 + 短名字 + 尾词。
 *
 * 尾词分两组，因为**误伤风险差很多**：
 *  · `注` / `按` —— 「——格兰特注」「——编者按」。形状本身够特征，再加
 *    位置判据（前面是句末标点）就基本不会误伤。
 *  · `译` / `校` / `撰` / `记` —— 「——张三译」。这些字太常见
 *    （「——翻译，就是把……」），形状上不设防会吃掉正文，所以
 *    **只在名字是确定人称、或已在这本书的署名闭集里**时才认。
 *
 * 名字限 10 字以内 —— 这条上限本身就是一道防线：「——因为如果你去翻
 * 资产负债表的脚注」名字有 13 字，正则根本匹配不上，整句保住。
 */
const ATTR_TAIL_WORDS = '注按';
const ATTR_VERB_WORDS = '译校撰记';
const ATTR_NAME = '[\\u4e00-\\u9fa5A-Za-z][\\u4e00-\\u9fa5A-Za-z·．.\\u00b7]{0,9}?';
const ATTR_DASH = '[—–\\-－]{1,2}[ \\t\\u00a0]*';
const ATTR_END = `(?=[。．.，,、！!？?；;：:)）\\]」』】 \\t\\u00a0]|$)`;

/** 破折号署名，全文扫描（输出端用）。 */
const NOTE_ATTR_PATTERN = new RegExp(
  `${ATTR_DASH}(${ATTR_NAME})([${ATTR_TAIL_WORDS}${ATTR_VERB_WORDS}])${ATTR_END}`,
  'g',
);

/** 只认「缀在末尾」的那一个（输入端用）。原书注释的署名一律在末尾。 */
const NOTE_ATTR_TAIL_RE = new RegExp(
  `${ATTR_DASH}(${ATTR_NAME})([${ATTR_TAIL_WORDS}${ATTR_VERB_WORDS}])[。．.]?[ \\t\\u00a0]*$`,
);

/**
 * 括号包起来的署名：「（译者注）」「【编者注】」——另一套很常见的排版。
 * 形状本身没有歧义（「（作者注明的）」不会匹配，`注` 后面不是闭括号），
 * 但仍然要求名字是确定人称或在这本书的闭集里：宁可漏，不可错删正文。
 */
const NOTE_ATTR_BRACKET_RE = new RegExp(
  `[（(【\\[](${ATTR_NAME})([${ATTR_TAIL_WORDS}])[）)】\\]]`,
  'g',
);

/** 顶在句首的括号署名：「【译者注】此处原文为拉丁文。」——只摘招牌，内容留着。 */
const NOTE_ATTR_HEAD_RE = new RegExp(
  `^[ \\t\\u00a0]*[【\\[](${ATTR_NAME})([${ATTR_TAIL_WORDS}])[】\\]][ \\t\\u00a0]*`,
);

/**
 * 缀在末尾的括号署名：「……此处原文为拉丁文（译者注）。」——连括号一起摘。
 * 用前瞻锚定句尾但**不吃后面的句号**：署名夹在句子中间，句号是那句话的
 * 结尾，跟着摘掉就少个句点。（破折号署名不一样，那个句号本来就是署名自带的。）
 */
const NOTE_ATTR_TAIL_BRACKET_RE = new RegExp(
  `[（(【\\[](${ATTR_NAME})([${ATTR_TAIL_WORDS}])[）)】\\]](?=[。．.]?[ \\t\\u00a0]*$)`,
);

/**
 * 「署名前面必须是句末标点」—— 真实署名总是挂在某句话的末尾。
 * 这条是为了把「——准确说是一连串这样的注。」「——每个赌注」这类
 * 句子里本来就有的「注」排除掉（实测误报全部靠这条挡下）。
 *
 * 刻意**不**接受「开头」：`^` 会让「——准确说是一连串这样的注。」这种
 * 整段以破折号开头的句子通过（前面什么都没有，自然满足「前面是边界」），
 * 而真署名在成品里 100% 跟在标点后面 —— 实测 25 处无一例外。
 * 宁可漏掉一个「整段以署名开头」的极端情况，也不能吃掉一句话。
 *
 * 也接受英文句点 `.`（英文书、以及「见前引书.-- 格兰特注.」这种写法）。
 *
 * **刻意不接受省略号 `…`**：实测「……——每个赌注」会被判成署名、整句被吃掉。
 * 省略号太常出现在句尾，「……——」后面跟一串字的情况里，正文远多于署名。
 * 代价是「……——译者注」这种（署名挂在省略号后面）会漏掉 —— 但真署名
 * 前面 99% 是句号，而且漏掉只是读者多看一句署名，吃掉正文是不可逆的。
 */
const ATTR_LEAD_RE = /(?:[。．.！!？?；;：:)）\]」』】"”’])[ \t\u00a0]*$/;

/**
 * 这几个人称是确定的署名，出现在哪里都是署名。
 * `译` / `原` 是单字形态：「（译注）」「——原注」。
 */
const NOTE_ATTR_ROLES = new Set([
  '译者',
  '编者',
  '作者',
  '校者',
  '注者',
  '审校',
  '责编',
  '点评',
  '译',
  '原',
]);

/**
 * 判断一个候选是不是真署名 —— **输入端和输出端共用这一个判据**。
 *
 * 之前输入端只看「末尾 + 破折号」，输出端还看位置，两边判据不一样。
 * 后果实测：输入端把「——准确说是一连串这样的注。」整段剥成了空字符串。
 * 同一件事两套判据，迟早会分叉 —— 所以合成这一个函数。
 *
 * 满足其一即算真署名：
 *  1. 这个署名在这本书的署名闭集里（`known`）—— 最硬的证据；
 *  2. 名字是「译者/编者/作者…」这类确定的人称；
 *  3. 尾词是「注/按」且前面紧挨着句末标点 —— 位置判据，兜底。
 *
 * @param {string} name
 * @param {string} tail
 * @param {string} lead 署名之前的全部文本
 * @param {Set<string>|null} known
 * @returns {boolean}
 */
function isRealAttribution(name, tail, lead, known) {
  if (known?.has(`${name}${tail}`)) return true;
  if (NOTE_ATTR_ROLES.has(name)) return true;
  return ATTR_TAIL_WORDS.includes(tail) && ATTR_LEAD_RE.test(lead);
}

/**
 * 收集时用的判据 —— 比 `isRealAttribution` 松一点，但**不松在位置上**。
 *
 * 收的是「这本书的署名闭集」，闭集一旦被污染，输出端就会到处错删，
 * 所以这里必须挡住「——准确说是一连串这样的注。」这类句子碎片的尾巴：
 * 真实署名一定挂在某句话的末尾（前面是句末标点），句子碎片不会。
 * 尾词则可以放宽到「译/校/撰/记」—— 反正是从注释正文末尾收的。
 *
 * @param {string} name
 * @param {string} lead
 * @returns {boolean}
 */
function isCollectableAttribution(name, lead) {
  return NOTE_ATTR_ROLES.has(name) || ATTR_LEAD_RE.test(lead);
}

/**
 * 模型把脚注内容括进正文时爱留的另一块招牌：「（卡拉曼的注：……）」
 * 「（卡拉曼在这里加了一条注：……）」。
 *
 * 这也是「标注它是脚注」——用户要的是把有用的信息融进句子，不是换成
 * 另一种写法继续告诉读者这里原本有条脚注。所以只摘掉招牌、保留内容，
 * 括号留着（读起来就是一个补充说明）。
 *
 * 只认两种名字：这本书注释里真的出现过的署名，和上面那几个人称。
 * 不做泛化匹配 —— 「（因为……注：」这种写法一旦被误吃就是删正文。
 *
 * @param {Set<string>|null} known
 * @returns {RegExp|null}
 */
function buildLeadInRe(known) {
  const names = new Set(NOTE_ATTR_ROLES);
  if (known) for (const label of known) names.add(label.replace(/注$/, ''));
  names.delete('');
  if (!names.size) return null;
  const alt = [...names]
    .sort((a, b) => b.length - a.length) // 长的排前面，「罗杰·洛温斯坦」不能被「罗杰」截断
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(
    `[（(][ \\t\\u00a0]*(?:${alt})[ \\t\\u00a0]*` +
      `(?:的注|注|在这里(?:又)?加了?一?条?注|(?:又)?加了?一?条?注)` +
      `[ \\t\\u00a0]*[：:]`,
    'g',
  );
}

/**
 * 从**末尾**取出一条注释正文的署名（取不到返回 null）。
 *
 * 只认末尾，是因为原书里署名就是缀在注释正文背后的；正文中间出现
 * 「——某某注」的情况在这本书里不存在，放宽了只会误伤。
 *
 * @param {string} text
 * @returns {string|null} 形如 `格兰特注` / `张三译`
 */
export function extractNoteAttribution(text) {
  const s = String(text ?? '');
  const m = s.match(NOTE_ATTR_TAIL_RE);
  if (!m) return null;
  return isCollectableAttribution(m[1], s.slice(0, m.index)) ? `${m[1]}${m[2]}` : null;
}

/**
 * 把注释正文**末尾**的署名剥掉，返回注释内容本身。
 *
 * 输入端用它：原书 483 条尾注里有 69 条末尾缀着「——格兰特注」这类署名。
 * 不剥掉的话，模型会把整条注释（连署名一起）搬进正文，读者就会看到
 * 「……第35页。——罗杰·洛温斯坦注。几年之后，他……」。
 *
 * @param {string} text
 * @param {{signatures?: Set<string>}} [opts] 这本书的署名闭集（可选，有就更准）
 * @returns {{text: string, stripped: number}}
 */
export function stripTrailingNoteAttribution(text, opts = {}) {
  const s = String(text ?? '');
  const known = opts.signatures instanceof Set && opts.signatures.size ? opts.signatures : null;

  const m = s.match(NOTE_ATTR_TAIL_RE);
  if (m && isRealAttribution(m[1], m[2], s.slice(0, m.index), known)) {
    return { text: tidyAfterAttrRemoval(s.slice(0, m.index)).trim(), stripped: 1 };
  }

  /**
   * 括号形态也要在输入端剥掉。它是另一套排版，同样是在告诉读者
   * 「这里本来有条脚注」—— 模型看见「（译者注）」就可能把它搬进正文。
   * 输出端能兜住，但让模型从一开始就没见过才是确定性的。
   */
  const b = s.match(NOTE_ATTR_TAIL_BRACKET_RE);
  if (b && (known?.has(`${b[1]}${b[2]}`) || NOTE_ATTR_ROLES.has(b[1]))) {
    // 括号在句子中间，摘掉它、保留后面那个句号
    const kept = s.slice(0, b.index) + s.slice(b.index + b[0].length);
    return { text: tidyAfterAttrRemoval(kept).trim(), stripped: 1 };
  }

  const h = s.match(NOTE_ATTR_HEAD_RE);
  if (h && (known?.has(`${h[1]}${h[2]}`) || NOTE_ATTR_ROLES.has(h[1]))) {
    return { text: tidyAfterAttrRemoval(s.slice(h[0].length)).trim(), stripped: 1 };
  }

  return { text: s, stripped: 0 };
}

/**
 * 收集一批注释正文里用到的全部署名 —— 也就是**这本书的署名闭集**。
 *
 * 有了这个闭集，判据就不必依赖「前面是不是句末标点」这种位置猜测：
 * 只要署名是这本书真的在用的，出现在哪里都可以剥。
 *
 * ⚠️ 闭集一旦被污染（收进一句正文的尾巴），输出端就会到处错删，
 * 所以收集用的是 `isCollectableAttribution` —— 位置判据照旧不放宽。
 *
 * @param {Iterable<string>} noteTexts
 * @returns {Set<string>}
 */
export function collectNoteAttributions(noteTexts) {
  const set = new Set();
  for (const t of noteTexts || []) {
    const label = extractNoteAttribution(t);
    if (label) set.add(label);
  }
  return set;
}

/**
 * 找出正文里**所有**该剥掉的脚注署名，返回待删除区间。
 *
 * 判据见 `isRealAttribution`（输入端 `stripTrailingNoteAttribution` 用的是
 * 同一个函数）。另外还认三种形状：
 *  · 括号署名「（译者注）」「【编者注】」；
 *  · 顶在句首的括号署名「【译者注】此处原文为拉丁文。」——只摘招牌，内容留着；
 *  · 招牌「（某某的注：…）」（`buildLeadInRe`）——同样只摘招牌。
 *
 * @param {string} text
 * @param {{signatures?: Set<string>}} [opts]
 * @returns {Array<{start: number, end: number, label: string}>}
 */
export function findNoteAttributions(text, opts = {}) {
  const src = String(text ?? '');
  // 尾词不止「注」一个（还有按/译/校/撰/记），这个快速短路必须跟着放宽 ——
  // 只写 includes('注') 会把「——编者按」整条漏掉。
  if (!/[注按译校撰记]/.test(src)) return [];
  const known = opts.signatures instanceof Set && opts.signatures.size ? opts.signatures : null;

  const out = [];
  for (const m of src.matchAll(new RegExp(NOTE_ATTR_PATTERN.source, 'g'))) {
    const [, name, tail] = m;
    if (!isRealAttribution(name, tail, src.slice(0, m.index), known)) continue;

    let start = m.index;
    let end = m.index + m[0].length;
    // 署名两侧的空白属于署名，一起吃掉，否则会留下「市盈率。 这个系数」这种空隙。
    while (start > 0 && /[ \t\u00a0]/.test(src[start - 1])) start -= 1;
    while (end < src.length && /[ \t\u00a0]/.test(src[end])) end += 1;
    /**
     * 署名自己带的那个句末句点也一起吃掉 —— 但**只在前面已经有一个**的时候。
     * 「市盈率。——编者注。这个系数」剥完是「市盈率。这个系数」；
     * 不带上句点就会变成「市盈率。。这个系数」，而事后收拾标点碎屑
     * 又分不清那两个点是「剥署名留下的」还是正文里本来就有的
     * （英文书里的 `...` 会被一起压掉）。
     */
    const before = src.slice(0, start).replace(/[ \t\u00a0]+$/, '');
    if (/[。．.]$/.test(before) && /[。．.]/.test(src[end] ?? '')) end += 1;
    out.push({ start, end, label: `${name}${tail}` });
  }

  // 括号署名：「……此处原文为拉丁文（译者注）。」——连括号一起摘掉。
  for (const m of src.matchAll(NOTE_ATTR_BRACKET_RE)) {
    const [, name, tail] = m;
    if (!(known?.has(`${name}${tail}`) || NOTE_ATTR_ROLES.has(name))) continue;
    out.push({ start: m.index, end: m.index + m[0].length, label: `${name}${tail}` });
  }

  // 顶在句首的括号署名：只摘「【译者注】」，后面的内容留着。
  // 上面那个括号正则已经盖住同样一段（两者区间完全相同），所以要去重，
  // 否则 `stripped` 会把同一处数两次。
  const head = src.match(NOTE_ATTR_HEAD_RE);
  if (
    head &&
    (known?.has(`${head[1]}${head[2]}`) || NOTE_ATTR_ROLES.has(head[1])) &&
    !out.some((d) => d.start === 0 && d.end >= head[0].length)
  ) {
    out.push({ start: 0, end: head[0].length, label: `${head[1]}${head[2]}` });
  }

  const leadInRe = buildLeadInRe(known);
  if (leadInRe) {
    for (const m of src.matchAll(leadInRe)) {
      // 开括号留着（内容本来就括在里面），只摘掉「某某的注：」这一截。
      out.push({ start: m.index + 1, end: m.index + m[0].length, label: m[0].slice(1).trim() });
    }
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 剥掉正文里的脚注署名，并把剥完留下的标点碎屑收拾干净。
 *
 * @param {string} text
 * @param {{signatures?: Set<string>}} [opts]
 * @returns {{text: string, stripped: number}}
 */
export function stripNoteAttributions(text, opts = {}) {
  const src = String(text ?? '');
  const drops = findNoteAttributions(src, opts);
  if (!drops.length) return { text: src, stripped: 0 };

  let out = '';
  let cursor = 0;
  for (const { start, end } of drops) {
    const from = Math.max(start, cursor);
    if (from >= end) continue;
    out += src.slice(cursor, from);
    cursor = end;
  }
  out += src.slice(cursor);
  return { text: tidyAfterAttrRemoval(out), stripped: drops.length };
}

/**
 * 署名剥掉后会留下标点碎屑（`市盈率。——编者注 ，这个系数` -> `市盈率。，这个系数`）。
 * 这里只收拾**由删除直接造成**的相邻标点，不做任何别的编辑。
 */
function tidyAfterAttrRemoval(s) {
  return s
    .replace(/。\s*。/g, '。')
    .replace(/。\s*([，、：])/g, '$1')
    .replace(/，\s*，/g, '，')
    .replace(/。\s*([）)」』】])/g, '$1')
    .replace(/，\s*([）)」』】])/g, '$1');
}
