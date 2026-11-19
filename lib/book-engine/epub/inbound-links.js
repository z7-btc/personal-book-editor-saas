/**
 * 跨文件链接分析：哪些章节、哪些锚点被别的文件指着。
 *
 * ## 为什么必须做这一步
 *
 * 「压缩某一章」的做法是把它的正文删成一页提要。原本以为只要
 * **不动文件位置**就不会破坏链接 —— 错的。
 *
 * 实测用户这本书：全书有 **1051 条跨文件链接**，其中
 *   · 第 28 章（延伸阅读）被 **483** 条链接指向，每条都带锚点
 *     （`text00027.html#jz_1_28` —— 整本书的脚注都落在这里）；
 *   · 第 8 章（目录）指向每一个章节的开头锚点
 *     （`text00004.html#pre4_4`）。
 *
 * 把第 28 章压成一页提要，全书的脚注就全断了 ——
 * 而 EPUB 阅读器**不会报错**，读者点一下，什么都不会发生。
 *
 * 所以规则是：**带锚点的段落不能删**。压缩一章时，
 * 凡是「带着别人要跳过来的锚点」的块，必须原样保留。
 */

/**
 * 从一组章节里统计出「谁指着谁、指着哪个锚点」。
 *
 * @param {Array<{index: number, href: string, xhtml: string}>} chapters
 * @returns {{
 *   inbound: Map<number, Array<{from: number, anchor: string}>>,
 *   anchorHits: Map<number, Set<string>>,
 *   totalLinks: number
 * }}
 *   anchorHits：章号 -> 被别人指向的锚点 id 集合（这些块不能删）
 */
export function analyzeInboundLinks(chapters) {
  /** 文件名 -> 章号 */
  const byFile = new Map();
  for (const c of chapters) {
    const base = String(c.href || '').split('/').pop();
    if (base) byFile.set(base, c.index);
  }

  const inbound = new Map();
  const anchorHits = new Map();
  let totalLinks = 0;

  for (const c of chapters) {
    const html = String(c.xhtml || '');
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|data:|#)/.test(target)) continue;
      // 资源文件不算（CSS / 图片 / 字体）
      if (/\.(css|png|jpe?g|gif|svg|ttf|otf|woff2?|mp3|mp4)$/i.test(target)) continue;
      totalLinks += 1;
      const [file, anchor] = target.split('#');
      const base = String(file || '').split('/').pop() || String(c.href || '').split('/').pop();
      const to = byFile.get(base);
      if (to === undefined || to === c.index) continue;

      if (!inbound.has(to)) inbound.set(to, []);
      inbound.get(to).push({ from: c.index, anchor: anchor || '' });
      if (anchor) {
        if (!anchorHits.has(to)) anchorHits.set(to, new Set());
        anchorHits.get(to).add(anchor);
      }
    }
  }

  return { inbound, anchorHits, totalLinks };
}

/**
 * 这一章压缩起来有多大风险。
 *
 * 判据不用「有没有入链」（几乎每一章都有 —— 目录页会指向所有章节），
 * 而用**「有多少锚点落在正文里面」**，分三档：
 *
 *   low      锚点 ≤ 3：提要里保住标题和开头就够了，随便压。
 *   guarded  锚点 4~100：可以压，但**带锚点的段落必须原样保留**，
 *            只压其余的段落（执行层负责，见 digest 的实现）。
 *   blocked  锚点 > 100：这一章几乎每一段都被人指着（比如全书 483 条
 *            脚注都落在第 28 章），压完等于什么都没压、还把跳转全切断。
 *            直接判为「不能压」。
 *
 * @param {number} index
 * @param {Map<number, Set<string>>} anchorHits
 * @param {{safeAnchors?: number, blockedAnchors?: number}} [opts]
 */
export function digestRisk(index, anchorHits, opts = {}) {
  const safeAnchors = opts.safeAnchors ?? 3;
  const blockedAnchors = opts.blockedAnchors ?? 100;
  const anchors = anchorHits.get(index);
  const count = anchors ? anchors.size : 0;

  if (count <= safeAnchors) {
    return {
      level: 'low',
      anchors: count,
      reason: count ? `只有 ${count} 个入链锚点，提要里保住开头即可` : '没有入链锚点',
    };
  }
  if (count > blockedAnchors) {
    return {
      level: 'blocked',
      anchors: count,
      reason: `有 ${count} 个锚点被别的文件指着，这一章几乎整篇都是跳转目标，压缩会切断全书的脚注与目录`,
    };
  }
  return {
    level: 'guarded',
    anchors: count,
    reason: `有 ${count} 个锚点被指着：压缩时必须把这些锚点所在的段落原样留下`,
  };
}
