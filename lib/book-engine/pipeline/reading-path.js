/**
 * 「目录 · 怎么读这本书」页 —— 插在整本书的最前面。
 *
 * 用户的原话：
 *   「你需要对目录进行重新排序，并给章节重命名，让我知道每一章大概讲什么。」
 *   「整理排序后，你在目录里跟我说明一下：
 *     1. 整理后的目录编排是什么样的？
 *     2. 每一章对应讲哪些内容？
 *     3. 你为什么要这么编排？」
 *   「我看你导出的目录放在最后了，应该把它放在最前面。」
 *
 * 所以这一页就是**新的目录**，按他提的三点组织：
 *   一、整理后的编排 —— 按新顺序列出章节，带新名字和链接
 *   二、每章讲什么 —— 每章一段，来自规划时逐章读完全文写的卡片
 *   三、为什么这么编排 —— 结构诊断 + 逐章的处理理由
 *
 * 链接指向每个文件的**开头**（`text00008.html`，不带锚点），
 * 这样不依赖文件内部有没有锚点，也不会产生死链。
 */

import { escapeText } from '../epub/xml-dom.js';
import { pbeHeadSnippet } from '../epub/pbe-style.js';
import { VALUE_LABEL, STRATEGY_LABEL, applyOverrides, buildSpineOrder } from './book-plan.js';

/** 插入到 EPUB 里的文件名与 manifest id，固定值（重复导出不会叠加）。 */
export const READING_PATH_HREF = 'pbe-reading-path.xhtml';
export const READING_PATH_ID = 'pbe-reading-path';

/**
 * 这一页的标题，页内 `<h1>`、`<title>` 和**目录条目**共用同一个字符串。
 *
 * 三处必须一致：用户在目录面板里看到「目录 · 怎么读这本书」，
 * 点进去要看到同样一句话。第一版只在页内写了标题，目录里没有这一条，
 * 用户翻遍目录也找不到，来问「没看到目录这个分类」。
 */
export const READING_PATH_TOC_TITLE = '目录 · 怎么读这本书';

/**
 * 渲染这一页。
 *
 * @param {object} plan 规划结果
 * @param {{bookTitle?: string, generatedAt?: Date|string, cssHref?: string,
 *          hrefByIndex?: Map<number,string>}} [opts]
 *        hrefByIndex：章号 -> 该章文件在 ZIP 里的路径（用来生成链接）
 * @returns {string} XHTML
 */
export function renderReadingPathPage(plan, opts = {}) {
  const merged = applyOverrides(plan);
  const entries = merged.entries || [];
  const byIndex = new Map(entries.map((e) => [e.index, e]));
  /**
   * 各项数量**从 entries 现算**，不读 `plan.counts`。
   *
   * `counts` 是规划那一刻由 summarizePlan 算好存下来的快照。
   * 只要有谁事后动过 entries（换策略、改判、加删除），
   * 那个快照就和事实对不上了 —— 页面上于是印出「精读 12 章」而实际是 13 章。
   * 这种数字只该有一个来源：当前这份 entries。
   */
  const counts = { keep: 0, digest: 0, skip: 0, drop: 0 };
  for (const e of entries) counts[e.strategy] = (counts[e.strategy] || 0) + 1;
  const digestEntries = entries.filter((e) => e.strategy === 'digest');

  /** 章节在新顺序里的位置。没有 order 就按 index 排。 */
  const ordered = Array.isArray(merged.order) && merged.order.length
    ? buildSpineOrder(entries.map((e) => ({ index: e.index })), merged.order).order
    : entries.map((e) => e.index).sort((a, b) => a - b);

  const p = [];
  /**
   * 只有**真的压完**的章节才算数。
   *
   * `strategy === 'digest'` 只是规划，压缩可能还没跑。第一版直接按规划写
   * 「已压缩成一页提要，正文一字未删」，两处都是假话：没跑的时候正文还是全文，
   * 跑完以后又确实删掉了大量段落。页面上的话必须和书里的实际情况一致。
   */
  const digested = opts.digestedIndexes instanceof Set ? opts.digestedIndexes : new Set();
  const digestedEntries = digestEntries.filter((e) => digested.has(e.index));
  const digestedChars = digestedEntries.reduce((s, e) => s + (e.chars || 0), 0);

  /**
   * **真的**被删掉的章节。
   *
   * 删除是不可逆的一刀（读者再也看不到这一章），所以这一页必须说清楚
   * 删了哪几章、为什么 —— 不能让读者读到一半发现少了一块，
   * 还以为是自己漏看了。判定同样以实际状态为准，不看规划。
   */
  const dropped = opts.droppedIndexes instanceof Set ? opts.droppedIndexes : new Set();
  const droppedEntries = entries.filter((e) => dropped.has(e.index));
  /** 被删的章节不进目录、也不进逐章清单（书里已经没有它们了） */
  const visible = ordered.filter((i) => !dropped.has(i));

  p.push('<?xml version="1.0" encoding="utf-8"?>');
  p.push('<html xmlns="http://www.w3.org/1999/xhtml"><head>');
  p.push(`<title>${READING_PATH_TOC_TITLE}</title>`);
  if (opts.cssHref) p.push(`<link rel="stylesheet" type="text/css" href="${escAttr(opts.cssHref)}"/>`);
  /**
   * 这一页的样式必须自带。
   *
   * 原来只在传了 `cssHref` 时才连样式表，而全仓库没有任何调用方传它 ——
   * 于是正文页有原书样式、这一页却是浏览器默认样式：默认字体、蓝色
   * 下划线链接、「核心」「精读」标签直接贴在标题后面连排。同时补上
   * viewport，否则手机浏览器按 980px 排版再缩放，字小到看不清。
   */
  p.push(pbeHeadSnippet().trim());
  p.push('</head><body>');

  p.push(`<h1>${READING_PATH_TOC_TITLE}</h1>`);
  if (opts.bookTitle) p.push(`<p class="rp-book">《${escapeText(opts.bookTitle)}》</p>`);
  if (merged.frontMatterNote) p.push(`<p class="rp-lead">${prose(merged.frontMatterNote)}</p>`);
  if (digestedEntries.length) {
    /**
     * 章名里的「· 已压缩为一页提要」后缀要去掉。
     *
     * 那是给阅读器的目录面板用的（读者在那一层需要知道这章是提要），
     * 但这句话本身已经在说「已各压缩成一页提要」了，再叠 6 次
     * 就成了「…：A · 已压缩为一页提要、B · 已压缩为一页提要、…」。
     */
    const stripSuffix = (s) => String(s || '').replace(/\s*[·・]\s*已压缩为一页提要\s*$/, '').trim();
    /**
     * 名字要加「」。
     *
     * 起名模型给出的名字里自己带冒号（「小引：鲁迅自述成书背景…」），
     * 直接跟在「已各压缩成一页提要：」后面，一句话里三个冒号，
     * 读者得自己琢磨哪一段是名字。逐条加引号以后一眼就能分开。
     */
    const names = digestedEntries
      .slice(0, 6)
      .map((e) => stripSuffix(e.displayTitle || e.title))
      .filter(Boolean)
      .map((n) => `「${prose(n)}」`);
    p.push(
      `<p class="rp-note">下面 ${digestedEntries.length} 章（共约 ${num(digestedChars)} 字）` +
        `${digestedEntries.length > 1 ? '已各压缩成一页提要' : '已压缩成一页提要'}` +
        `${names.length ? `：${names.join('、')}${digestedEntries.length > names.length ? ' 等' : ''}` : ''}。` +
        `提要把「这一章讲什么、有什么值得带走」讲清楚，其余内容可以跳过；` +
        `原文中别处会跳转引用的段落仍然原样保留。</p>`,
    );
  }
  /**
   * 删掉的章节必须在这里交代清楚。
   *
   * 读者翻到这一页时手上只有成品，他不会知道原本还有几章。少了一整块
   * 却没有任何说明，最难受的是「是不是我漏看了」—— 与其让他猜，
   * 不如直接写明删了哪几章、为什么删、原文里那些章节还在。
   */
  if (droppedEntries.length) {
    const stripSuffix = (s) => String(s || '').replace(/\s*[·・]\s*已压缩为一页提要\s*$/, '').trim();
    const chars = droppedEntries.reduce((s, e) => s + (e.chars || 0), 0);
    /**
     * 删除理由**逐章**写，不用一句概括。
     *
     * 第一版这里印的是写死的一句话（「版权页、扫码提示、
     * 致谢与纯赞誉一类的内容，不含可带走的投资知识」）—— 那是
     * 某本投资书跑出来的原话，换成小说就完全不对：删的是合集页，
     * 页面却说删的是致谢。理由只能来自这一章自己的判断。
     */
    p.push(
      `<p class="rp-note">另有 ${droppedEntries.length} 章（共约 ${num(chars)} 字）已从本书中<strong>移除</strong>，` +
        `原书文件里仍然完整存在，需要时可以回去核对：</p>` +
        '<ul class="rp-dropped">' +
        droppedEntries
          .map((e) => {
            const name = stripSuffix(e.displayTitle || e.title) || `第 ${e.index} 章`;
            const why = String(e.reason || e.skipLoss || '').trim();
            return `<li><strong>「${prose(name)}」</strong>${why ? `：${prose(why)}` : ''}</li>`;
          })
          .join('') +
        '</ul>',
    );
  }
  /**
   * 脚注的去向也要交代。
   *
   * 原书有 483 条脚注，成品里一条都看不到了 —— 不说清楚的话，
   * 读者要么以为丢了，要么以为原书本来就没有。实际是：有实质内容的
   * 已经就近融进了正文，纯出处的删掉了。
   */
  if (opts.noteInline?.total) {
    const { total, stripped } = opts.noteInline;
    p.push(
      `<p class="rp-note">原书的 ${num(total)} 条脚注已<strong>就地处理</strong>：` +
        `有实质内容的（解释、判断、补充数据、编者按）就近融进了正文对应位置，用括号或顺接的一句说清楚，` +
        `读者不用再翻到书末；纯出处的（书名加页码、「见第 236 页」这类）直接删掉。` +
        `${stripped ? `书末原来那份 ${num(stripped)} 条的尾注汇编随之取消（它已经全是重复）。` : ''}` +
        `改的是知识的呈现方式，内容本身没有丢。</p>`,
    );
  }

  /* ------------------------------------------------ 一、整理后的编排 -- */
  p.push('<h2>一、整理后的编排</h2>');
  // 注意：这是 XHTML，不是 markdown —— 写 `**粗体**` 只会原样呈现成星号
  p.push('<p>下面是这本书<strong>重排之后</strong>的阅读顺序。点标题可以直接跳到那一章。</p>');
  p.push('<ol class="rp-toc">');
  for (const idx of visible) {
    const e = byIndex.get(idx);
    if (!e) continue;
    const name = e.displayTitle || e.title || `第 ${idx} 章`;
    const href = opts.hrefByIndex?.get(idx);
    const tag = tagFor(e);
    p.push(
      '<li>' +
        (href ? `<a href="${escAttr(href)}">${prose(name)}</a>` : prose(name)) +
        ` <span class="rp-tag">${escapeText(tag)}</span>` +
        `</li>`,
    );
  }
  p.push('</ol>');
  if (counts.keep || counts.digest || counts.skip) {
    /**
     * 数字要说清楚是「原书」还是「成品」。
     *
     * 原来写「共 10 章：… · 已删除 1 章」，读者一数：10 章里怎么还有删除的？
     * 原书 11 章，删掉 1 章，成品 10 章 —— 三个数字都得有出处。
     */
    const total = visible.length + droppedEntries.length;
    p.push(
      `<p class="rp-stat">全书 ${total} 章：完整精读 ${counts.keep || 0} 章 · ` +
        `压缩成提要 ${counts.digest || 0} 章 · 原样保留 ${counts.skip || 0} 章` +
        `${droppedEntries.length ? ` · 整页移除 ${droppedEntries.length} 章` : ''}；` +
        `成品共 ${visible.length} 章。</p>`,
    );
  }

  /* ------------------------------------------------ 二、每章讲什么 -- */
  p.push('<h2>二、每一章讲什么</h2>');
  for (const idx of visible) {
    const e = byIndex.get(idx);
    if (!e) continue;
    const card = e.card || {};
    /**
     * 纯封面 / 空白页没有可讲的内容，标题和字数写在目录里就够了。
     * 不跳过的话会出现一个小节：标题下面一行「23 字 · 填充 · 原样保留」，
     * 然后什么都没有 —— 读者以为排版漏了一块。
     */
    if (!card.summary && !card.knowledgePoints?.length && Number(e.chars || 0) < 200) continue;
    const name = e.displayTitle || e.title || `第 ${idx} 章`;
    p.push(`<h3>${prose(name)}</h3>`);
    /**
     * 字数要说清楚是**原来的**字数。
     *
     * 压缩过的章节，页面上只剩一页提要，却印着「5,957 字」——
     * 读者翻过去数一数，只有四百来字，像是排版丢了内容。
     */
    const charLabel = digested.has(e.index) ? `原文 ${num(e.chars || 0)} 字` : `${num(e.chars || 0)} 字`;
    const facts = [charLabel, VALUE_LABEL[e.value] || e.value, STRATEGY_LABEL[e.strategy] || e.strategy];
    p.push(`<p class="rp-meta">${escapeText(facts.join(' · '))}</p>`);
    if (card.summary) p.push(`<p>${prose(zhQuotes(card.summary))}</p>`);
    if (card.knowledgePoints?.length) {
      p.push('<p class="rp-kp">可带走的知识点：</p><ul class="rp-kp-list">');
      for (const k of card.knowledgePoints.slice(0, 8)) p.push(`<li>${prose(zhQuotes(k))}</li>`);
      p.push('</ul>');
    }
    /**
     * 「可以跳过」改写为「可快速掠过」。
     *
     * 原来的措辞是承诺：读者以为是「这些段落已经不在了」，但规划只是
     * 指出水分在哪，正文一个字没删 —— 说的和书里对不上。
     * 现在第二遍补讲**真的**会删掉没有信息量的段（有硬上限，见
     * src/pipeline/explain.js），所以：删了就写实数，没删就只建议略读。
     */
    const removed = Number(opts.droppedParagraphs?.get(idx) || 0);
    if (removed > 0) {
      p.push(`<p class="rp-skip">本章已删去 ${removed} 段读者读不到信息的内容。</p>`);
    }
    /**
     * 「可快速掠过」只对**全文保留**的章节有意义。
     * 提要章节整章已经压成半页，再告诉读者「这几段可以掠过」是废话 ——
     * 那几段本来就不在了。
     *
     * 每一条自带的句号要去掉：模型给的是一条一条短语，最后统一用「；」
     * 连起来，不清理就会出现「……属情绪铺垫。；中间罗列……」这种标点。
     */
    if (e.strategy === 'keep' && card.fillerParts?.length) {
      const parts = card.fillerParts.map((s) => String(s).trim().replace(/[。；;，,]+$/, '')).filter(Boolean);
      if (parts.length) p.push(`<p class="rp-skip">可快速掠过：${prose(parts.join('；'))}。</p>`);
    }
  }

  /* ------------------------------------------------ 三、为什么这么编排 -- */
  p.push('<h2>三、为什么这么编排</h2>');
  if (merged.overview) p.push(`<p>${prose(merged.overview)}</p>`);
  if (merged.readingPath?.length) {
    p.push('<p>阅读这个顺序的理由：</p><ol class="rp-why">');
    for (const step of merged.readingPath) p.push(`<li>${prose(step)}</li>`);
    p.push('</ol>');
  }
  /**
   * 只看书里**还在**的章节：被删的章节已经在上面那张「已移除」清单里
   * 交代过理由，这里再列一次就是同一段话出现两遍。
   */
  const reasons = visible.map((i) => byIndex.get(i)).filter((e) => e?.reason);
  if (reasons.length) {
    p.push('<p>每一章的处理理由：</p><ul class="rp-reasons">');
    for (const e of reasons) {
      p.push(`<li><strong>${prose(e.displayTitle || e.title || '')}</strong>：${prose(e.reason)}</li>`);
    }
    p.push('</ul>');
  }

  p.push(
    `<p class="rp-foot">本页由 AI Personal Book Editor 生成${
      opts.generatedAt ? `（${escapeText(formatDate(opts.generatedAt))}）` : ''
    }。` +
      `${droppedEntries.length ? `被移除的 ${droppedEntries.length} 章不再出现在本书里；` : ''}` +
      `${digestedEntries.length ? '被压缩的章节只保留提要；' : ''}` +
      `原书文件始终保留，需要时可以还原。</p>`,
  );
  p.push('</body></html>');
  return p.join('\n');
}

/** 目录里每一条后面的小标记，让读者一眼看出该怎么读。 */
function tagFor(e) {
  if (e.strategy === 'digest') return '提要';
  if (e.strategy === 'skip') return '按需查阅';
  if (e.value === 'core') return '核心';
  if (e.value === 'useful') return '精读';
  return '速读';
}

function num(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

/**
 * 中文里的英文单引号换成「」。
 *
 * 章节卡片是模型写的，它时不时写成 `'老莱娱亲'`、`'郭巨埋儿'` ——
 * 中文正文里夹英文直引号，读起来像代码注释跑进了书里。
 * 只处理成对的、中间不含引号的短串，不成对的（比如脚注符号）原样留着。
 */
function zhQuotes(s) {
  return String(s || '').replace(/'([^'\n]{1,40})'/g, '「$1」');
}

/**
 * 书名号嵌套：`《阿长与《山海经》》` → `《阿长与〈山海经〉》`。
 *
 * 章名本身就带书名号（鲁迅这篇的篇名里引了《山海经》），模型再给它套一层
 * 阅读建议的书名号，就变成两个书名号叠着收尾：读者在「第 1 步」里看到
 * 「读《阿长与《山海经》》」，像是排版错了。中文排印规矩是内层换单书名号。
 */
function nestTitleMarks(s) {
  const str = String(s || '');
  if (!str.includes('《')) return str;
  let depth = 0;
  let out = '';
  for (const ch of str) {
    if (ch === '《') {
      out += depth > 0 ? '〈' : '《';
      depth += 1;
    } else if (ch === '》') {
      if (depth > 0) depth -= 1;
      out += depth > 0 ? '〉' : '》';
    } else {
      out += ch;
    }
  }
  return out;
}

/** 模型写的正文段落：先修书名号嵌套与引号，再转义。 */
function prose(s) {
  return escapeText(nestTitleMarks(String(s || '')));
}

function formatDate(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  const z = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${z(t.getMonth() + 1)}-${z(t.getDate())} ${z(t.getHours())}:${z(t.getMinutes())}`;
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
