/**
 * 「整理结果」报告：把这本书到底被怎么处理了，算成一组能直接显示的数字。
 *
 * ## 为什么单独一层
 *
 * 这些数字有**两个来源**，而且必须分开：
 *   · **便宜的**：metadata / book-plan.json / 各章 status.json —— 读几个小 JSON；
 *   · **贵的**：成品的链接体检 —— 要解压 93MB、扫 400 多个条目。
 *
 * 界面上两者都要，但不能每次打开书页都跑一遍全量体检。
 * 所以这里统一算，调用方自己决定要不要缓存。
 *
 * ## 脚注的去向：融进正文 vs 直接删掉
 *
 * 这是最难算对的一项。可用的信号只有「引用点在成品里消失了」——
 * 但那只能说明**处理过了**，分不出是融进句子还是丢掉。
 *
 * 现在记录里没有逐条的处置结果（模型是在自由文本里决定的），
 * 所以只能**回头比对**：拿注释原文去那一章的成品里找，
 * 找得到就是融进去了，找不到就是删了。
 *
 * 难点在于模型会改写注释的措辞（实测：「1940年委员会修正了该指数」
 * 会写成「1940年委员会修正了这个指数」），逐字比对必然漏判。
 * 所以用的是**字符片段命中率**：把注释切成若干片段，看到底有多少
 * 出现在成品里，超过阈值就算融进去了（见 noteOutcome）。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as ws from './workspace.js';
import { readEpub } from '../epub/epub-reader.js';
import { ZipReader } from '../epub/zip-reader.js';
import { buildNoteIndex } from '../epub/footnotes.js';
import { parseXml, bodyTextLength } from '../epub/xml-dom.js';

/** 一条注释的处置结果 */
export const NOTE_OUTCOME = {
  INLINED: 'inlined',
  DROPPED: 'dropped',
  KEPT: 'kept',
};

/**
 * 片段命中率超过这个值就算「融进了正文」。
 *
 * 这个 0.5 是**量出来的**，不是拍的：实测 483 条注释的命中率分布明显双峰 ——
 * 408 条落在 0.5 以上（其中 287 条在 0.7 以上，很多是逐字保留），
 * 只有 12 条落在 0.3 以下。中间那段很空，阈值放在 0.5 最稳。
 */
const INLINE_HIT_RATIO = 0.5;
/**
 * 片段长度。4 个字是量出来的最优：6 个字时模型换个说法就掉到 0.42
 * （已经确认融进正文的那条也会被误判成删掉），4 个字时同一条能到 0.9+。
 * 4 字会不会误命中？不会 —— 阈值要求半数片段命中，
 * 靠「引用点」这种常见词碰巧凑够一半是不可能的。
 */
const SHINGLE = 4;

/**
 * 比对前的归一化：去掉空白、标点、符号。
 *
 * **两侧必须用同一个函数处理。** 第一版只归一化了注释（针），
 * 没归一化章节正文（海）—— 而正文里全是换行和缩进，
 * 于是「1940年委」这种片段永远匹配不上，连那条**已经确认融进正文**
 * 的注释都被判成「删掉了」，整体结果是 355 删 / 128 融，方向完全反了。
 */
export function normalizeForMatch(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 把一段文字切成若干片段（用于模糊比对）。
 *
 * **必须逐字滑窗（步长 1），不能按片长跳着取。**
 * 步长 = 片长时，一位实测里的编者注（「1940年委员会修正了该指数……」
 * 模型写成「1940年委员会修正了这个指数……」）会因为一个字之后
 * 所有片段全部错位而被判成删掉。逐字滑窗下，一个字的改动
 * 只影响以它为中心的 SHINGLE 个片段，长注释仍能匹配上绝大部分。
 */
export function shingles(text, size = SHINGLE) {
  const clean = normalizeForMatch(text);
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const out = [];
  for (let i = 0; i + size <= clean.length; i += 1) out.push(clean.slice(i, i + size));
  return out;
}

/**
 * 这条注释最后去哪儿了？
 *
 * @param {{text: string}} note
 * @param {string} normalizedText 该章成品的纯文本，**必须先过 normalizeForMatch**
 * @returns {'inlined'|'dropped'}
 */
export function noteOutcome(note, normalizedText) {
  const parts = shingles(note?.text);
  if (!parts.length) return NOTE_OUTCOME.DROPPED;
  const hay = String(normalizedText || '');
  let hit = 0;
  for (const p of parts) if (hay.includes(p)) hit += 1;
  return hit / parts.length >= INLINE_HIT_RATIO ? NOTE_OUTCOME.INLINED : NOTE_OUTCOME.DROPPED;
}

const fmtNum = (n) => Number(n || 0);

/**
 * 量成品里每一章**实际**有多少字。
 *
 * ## 为什么不直接用 status.rewrittenChars
 *
 * 那是**改写当时**记下的数字，之后任何对 `rewritten.xhtml` 的修补都不会更新它。
 * 实测这本书差 **246 字** —— 正好是后来剥离脚注署名时从 6 个文件里删掉的那 25 处
 * （「——罗杰·洛温斯坦注」这种一处十来个字）。
 * 数字对不上，报告就没有可信度，所以成品那一侧一律**量出来**，不推算。
 *
 * 量法与 `src/epub/epub-reader.js:437`（原书 `textLength`）和
 * `src/pipeline/rewrite.js:822`（`rewrittenChars`）保持一致：
 * 取 `<body>` 的纯文本、去掉所有空白后的长度。
 *
 * @param {ZipReader} zip
 * @param {string[]} hrefs ZIP 内路径
 * @returns {Map<string, number>} href -> 字数（缺的条目不出现在结果里）
 */
export function measureSpineChars(zip, hrefs) {
  const out = new Map();
  for (const href of hrefs) {
    if (!href || !zip.has(href)) continue;
    out.set(href, bodyTextLength(zip.readText(href)));
  }
  return out;
}

/**
 * 算出「整理结果」。
 *
 * @param {string} bookId
 * @param {{deep?: boolean}} [opts] deep=true 时额外跑成品的链接体检（较慢）
 */
export async function buildBookReport(bookId, opts = {}) {
  const metadata = await ws.readBookMetadata(bookId);
  const plan = await ws.readBookPlan(bookId).catch(() => null);

  const chapters = [];
  for (const c of metadata.chapters || []) {
    const status = await ws.readChapterStatus(bookId, c.index);
    const strategy = (plan?.entries || []).find((e) => e.index === c.index)?.strategy || 'keep';
    chapters.push({
      index: c.index,
      href: c.href,
      title: (plan?.names && plan.names[String(c.index)]) || c.title,
      originalTitle: c.title,
      strategy,
      origChars: c.textLength || 0,
      /**
       * 成品里这一章实际有多少字。
       *
       * 这两个特例都不是「优化」，是**账必须对得上**：
       *   · `drop`（整章删除）=> 0。状态里可能还留着编辑前的旧字数，
       *     算进去成品就比实际多出一千多字；
       *   · `skip`（原样保留）=> 原文字数。这些章在更早的时候被改写过，
       *     磁盘上留着旧结果、状态里的数字也是旧的，但导出用的是原文。
       *
       * 报告的用处就是让人一眼看出「这本书被怎么处理了」，
       * 分类相加和总数对不上，这份报告就没有可信度。
       */
      nowChars:
        strategy === 'drop'
          ? 0
          : strategy === 'skip'
            ? c.textLength || 0
            : (status?.rewrittenChars ?? null),
      /**
       * 和界面同一口径：只有真的压完了才算「压缩章」。
       * 方案后来改成 skip/drop 的章，导出用的是原文，不能还标成压过。
       */
      digest: Boolean(status?.digest) && status?.stage === 'completed',
      noteRefsBefore: status?.noteRefsBefore || 0,
      noteRefsAfter: status?.noteRefsAfter || 0,
      quality: status?.quality || null,
      stage: status?.stage || 'pending',
    });
  }

  /* ---------------------------------------------------- 章节分类 -- */
  const byStrategy = (s) => chapters.filter((c) => c.strategy === s);
  const dropped = byStrategy('drop');
  const digested = byStrategy('digest');
  const kept = byStrategy('keep');
  const skipped = byStrategy('skip');
  const sum = (list, k) => list.reduce((a, c) => a + fmtNum(c[k]), 0);

  const totalOrig = sum(chapters, 'origChars');
  /** 先按记录推算；读到成品之后会被实测值覆盖（见下面 measured 那段）。 */
  let totalNow = sum(chapters, 'nowChars');

  /* ---------------------------------------------------- 脚注去向 -- */
  const notes = { total: 0, inlined: 0, dropped: 0, kept: 0, byKind: {} };
  try {
    const buffer = await fs.promises.readFile(ws.bookPaths(bookId).original);
    const book = readEpub(buffer);
    const noteChapters = (metadata.chapters || []).map((c) => ({
      index: c.index,
      href: c.href,
      xhtml: book.zip.has(c.href) ? book.zip.readXmlText(c.href).text : '',
    }));
    const index = buildNoteIndex(noteChapters);
    notes.total = index.totalNotes;

    /** 每条注释在正文里的引用点属于哪一章 */
    const refOwner = new Map();
    for (const c of noteChapters) {
      for (const [refId, anchorId] of index.refToNote) {
        if (c.xhtml.includes(`id="${refId}"`)) refOwner.set(anchorId, c.index);
      }
    }

    /** 成品里每一章的 HTML 与纯文本（改写过用改写版，否则用原文）。
     *  文本这里就归一化好，逐条比对时不再重复处理整章正文。 */
    const htmlOf = new Map();
    const textOf = new Map();
    for (const c of metadata.chapters || []) {
      const rewritten = await ws.readChapterRewritten(bookId, c.index);
      const html = rewritten ?? noteChapters.find((x) => x.index === c.index)?.xhtml ?? '';
      htmlOf.set(c.index, html);
      textOf.set(c.index, normalizeForMatch(html.replace(/<[^>]+>/g, ' ')));
    }

    for (const [anchorId, note] of index.notes) {
      const kind = note.kind || 'other';
      notes.byKind[kind] = notes.byKind[kind] || { total: 0, inlined: 0, dropped: 0, kept: 0 };
      notes.byKind[kind].total += 1;

      const owner = refOwner.get(anchorId);
      /**
       * 判「原样保留」要看**引用点本身还在不在**，不能只看那一章的计数。
       *
       * 实测第 18 章有 7 个引用点没被处理 —— 它们所在的段落
       * 「改写不可信、按安全机制保留了原文」。这一章的 noteRefsBefore/
       * After 是 33/7（不相等），只比计数会漏掉这 7 条，
       * 把它们错算成「删掉了」。逐条查引用点 id 才准。
       */
      const refId = index.refToNote ? [...index.refToNote].find(([, a]) => a === anchorId)?.[0] : null;
      const refAlive = refId && owner !== undefined && (htmlOf.get(owner) || '').includes(`id="${refId}"`);

      if (owner === undefined || refAlive) {
        // 引用点还在（或正文里根本没有引用点）=> 这条注释原样留着
        notes.kept += 1;
        notes.byKind[kind].kept += 1;
        continue;
      }
      const outcome = noteOutcome(note, textOf.get(owner) || '');
      if (outcome === NOTE_OUTCOME.INLINED) {
        notes.inlined += 1;
        notes.byKind[kind].inlined += 1;
      } else {
        notes.dropped += 1;
        notes.byKind[kind].dropped += 1;
      }
    }
  } catch (err) {
    notes.error = err.message;
  }

  /* ---------------------------------------------------- 成品体检 -- */
  let exportInfo = null;
  /** 成品的实测字数：href -> 字数。deep 才有。 */
  let measured = null;
  let measuredTotal = null;
  let measuredAdded = 0;
  const dir = ws.bookPaths(bookId).exports;
  let newest = null;
  try {
    const files = (await fs.promises.readdir(dir))
      .filter((n) => n.endsWith('.epub'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    newest = files[0] || null;
  } catch {
    newest = null;
  }

  if (newest) {
    const full = path.join(dir, newest.f);
    const stat = fs.statSync(full);
    exportInfo = {
      fileName: newest.f,
      size: stat.size,
      createdAt: new Date(newest.t).toISOString(),
    };
    if (opts.deep) {
      try {
        const buf = await fs.promises.readFile(full);
        const zip = new ZipReader(buf);
        const out = readEpub(buf);
        const entries = zip.list().map((e) => e.name);
        const set = new Set(entries);

        /* 成品那一侧的数字全部**量出来**，不推算（见 measureSpineChars）。 */
        /**
         * 量的是**整条 spine**，不只是 `out.chapters`。
         *
         * 阅读路径页在 spine 里，但 `readEpub` 不把它算作章节
         * （重新导入时它是上一版生成的导航页）。只量 chapters 的话，
         * 这一页会从「成品总字数」和「新增页字数」里同时消失，
         * `成品总字数 = 正文 + 新增页` 这个恒等式就对不上了。
         */
        const spineHrefs = [
          ...new Set(out.spine.map((s) => s.item?.href).filter((h) => h && set.has(h))),
        ];
        const m = measureSpineChars(zip, spineHrefs);
        const bookHrefs = new Set((metadata.chapters || []).map((c) => c.href));
        measuredTotal = [...m.values()].reduce((a, n) => a + n, 0);
        measuredAdded = [...m].reduce((a, [h, n]) => a + (bookHrefs.has(h) ? 0 : n), 0);
        // 一章都没量到（spine 是空的）就当没测过，别把「量了 0 章」当成实测
        measured = m.size ? m : null;

        const ids = new Map();
        for (const n of entries) {
          if (!/\.x?html?$/i.test(n)) continue;
          ids.set(n, new Set([...zip.readText(n).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
        }
        let links = 0;
        let dead = 0;
        let anchors = 0;
        let anchorLost = 0;
        for (const n of entries) {
          if (!/\.x?html?$/i.test(n)) continue;
          for (const m of zip.readText(n).matchAll(/(?:href|src)="([^"]+)"/g)) {
            const v = m[1];
            if (/^(https?:|mailto:|data:|javascript:|#)/i.test(v)) continue;
            const [f, a] = v.split('#');
            if (!f) continue;
            links += 1;
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(n), f));
            if (!set.has(target)) {
              dead += 1;
              continue;
            }
            if (a) {
              anchors += 1;
              if (ids.get(target) && !ids.get(target).has(a)) anchorLost += 1;
            }
          }
        }
        const ncx = out.ncxItem ? zip.readText(out.ncxItem.href) : '';
        exportInfo = {
          ...exportInfo,
          entries: entries.length,
          spineChapters: out.chapters.length,
          tocEntries: (ncx.match(/<navPoint/g) || []).length,
          firstPage: out.spine[0]?.item?.href || null,
          links,
          deadLinks: dead,
          anchors,
          anchorLost,
          droppedInSpine: dropped.filter((d) =>
            out.chapters.some((c) => c.href === d.href),
          ).length,
          chars: measuredTotal,
          addedChars: measuredAdded,
        };
      } catch (err) {
        exportInfo.deepError = err.message;
      }
    }
  }

  /**
   * 有了实测值就以实测为准。
   *
   * 上面那套 `nowChars` 是**推算**出来的：它信任每章 status.json 里的
   * `rewrittenChars`，而那个数字只在改写完成那一刻写过一次。
   * 之后任何对 `rewritten.xhtml` 的修补（剥离脚注署名、手工修复……）
   * 都不会回头改它，于是「分类相加」和「成品实际」会越差越远 ——
   * 实测这本书差 246 字，正好是后来剥掉的那 25 处署名。
   *
   * 推算是给不跑 deep 时兜底的；能实测就实测。
   */
  let reconstructedChars = totalNow;
  if (measured) {
    for (const c of chapters) {
      if (c.strategy === 'drop') c.nowChars = 0;
      /**
       * 在成品里就按实测；**不在成品里就是 0**，不能退回推算值。
       *
       * 「这一章不在成品里」和「这一章原样保留」是两件事：前者对成品的字数
       * 贡献是零。退回推算值会让账目凭空多出几万字，还会让
       * `成品总字数 = 正文 + 新增页` 这个恒等式不成立。
       */
      else c.nowChars = measured.get(c.href) ?? 0;
    }
    totalNow = sum(chapters, 'nowChars');
  }
  /** 成品里那些「原书没有、是我们新加的页」（比如「怎么读这本书」） */
  const addedChars = measured ? measuredAdded : 0;
  /**
   * 成品总字数。
   *
   * 有实测就用实测的**总和**，而不是「正文 + 新增页」——两者在 deep 模式下
   * 本来就该相等（spine 里每一页都被量过，不在 spine 里的章记 0），
   * 但用实测总和能让这句话变成事实而不是推断。
   */
  const productChars = measured ? measuredTotal : totalNow;

  const keptGain = sum(kept, 'nowChars') - sum(kept, 'origChars');
  return {
    bookId,
    title: metadata.title,
    generatedAt: new Date().toISOString(),
    original: {
      chapters: (metadata.chapters || []).length,
      chars: totalOrig,
      notes: notes.total,
    },
    result: {
      chars: productChars,
      /** 正文字数（不含新加的页）—— 账目相加用这个 */
      bodyChars: totalNow,
      addedChars,
      /** true = 逐章量过成品；false = 按记录推算，可能有小偏差 */
      measured: Boolean(measured),
      /** 推算值。和实测差得多说明状态记录过期了，别藏起来。 */
      reconstructedChars,
      ratio: totalOrig ? Number((productChars / totalOrig).toFixed(3)) : 1,
    },
    removed: {
      count: dropped.length,
      chars: sum(dropped, 'origChars'),
      chapters: dropped.map((c) => ({ index: c.index, title: c.title, chars: c.origChars })),
    },
    compressed: {
      count: digested.length,
      charsBefore: sum(digested, 'origChars'),
      charsAfter: sum(digested, 'nowChars'),
      saved: sum(digested, 'origChars') - sum(digested, 'nowChars'),
      chapters: digested.map((c) => ({
        index: c.index,
        title: c.title,
        before: c.origChars,
        after: c.nowChars,
      })),
    },
    plainLanguage: {
      count: kept.length,
      charsBefore: sum(kept, 'origChars'),
      charsAfter: sum(kept, 'nowChars'),
      added: keptGain,
      averageRatio: sum(kept, 'origChars')
        ? Number((sum(kept, 'nowChars') / sum(kept, 'origChars')).toFixed(3))
        : 1,
      chapters: kept.map((c) => ({
        index: c.index,
        title: c.title,
        before: c.origChars,
        after: c.nowChars,
        ratio: c.origChars ? Number((c.nowChars / c.origChars).toFixed(3)) : 1,
      })),
    },
    /**
     * 原样保留的章。
     *
     * 注意 `chars` 是**原文字数**，`charsAfter` 才是成品里的字数 ——
     * 两者不总是相等：这本书的尾注汇编章在导出时被剥掉了 476 条尾注，
     * 64,638 → 6,513 字。只报原文字数会让人以为成品里还有那么多字，
     * 而实际上没有。差额单独列出来，别混进「改写增益」里。
     */
    unchanged: {
      count: skipped.length,
      chars: sum(skipped, 'origChars'),
      charsAfter: sum(skipped, 'nowChars'),
      chapters: skipped.map((c) => ({
        index: c.index,
        title: c.title,
        chars: c.origChars,
        charsAfter: c.nowChars,
      })),
    },
    /** 新加的页（阅读路径页等），不属于原书任何一章 */
    added: { chars: addedChars },
    /**
     * 原样保留的章在**导出阶段**少了多少字（正数 = 变少了）。
     *
     * 这本书是尾注汇编章被剥掉 476 条尾注（64,638 → 6,513）。
     * 不单列出来，这笔账就会混进「改写增益」里，看起来像改写多写了六万字。
     */
    unchangedShrink: sum(skipped, 'origChars') - sum(skipped, 'nowChars'),
    renamed: plan?.names ? Object.keys(plan.names).length : 0,
    reordered: Boolean(plan?.order?.length),
    notes,
    export: exportInfo,
  };
}
