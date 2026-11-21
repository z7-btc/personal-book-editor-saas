/**
 * 生成用于测试的 EPUB 样本（不依赖任何第三方库）。
 *
 * 刻意做得「难一点」，覆盖真实电子书里容易出问题的结构：
 *  - EPUB 3 nav + EPUB 2 NCX 同时存在
 *  - 脚注：noteref 链接 + 独立 endnotes 文档 + 反向链接
 *  - 图片、CSS、封面
 *  - 实体引用（&amp; &#8212; &nbsp;）
 *  - 表格 / 代码块 / 行内嵌套标记（<em><a>…</a></em>）
 *  - 章节里带 id 的锚点，且 TOC 指向它
 *  - 中文正文 + 数字（年份 / 百分比 / 金额）用于质量检查测试
 */

import { writeEpubZip } from '../../lib/book-engine/epub/zip-writer.js';

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>
    <dc:title>测试之书：个人化编辑验证</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>Fixture Press</dc:publisher>
    <dc:date>2024-05-01</dc:date>
    <dc:subject>测试</dc:subject>
    <meta property="dcterms:modified">2024-05-01T00:00:00Z</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="fig1" href="images/figure1.png" media-type="image/png"/>
    <item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/chapter3.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/endnotes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
    <itemref idref="notes"/>
  </spine>
</package>
`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="text/chapter1.xhtml">第一章 起点</a></li>
      <li><a href="text/chapter2.xhtml">第二章 深入</a>
        <ol><li><a href="text/chapter2.xhtml#sec-2-1">2.1 一个子节</a></li></ol>
      </li>
      <li><a href="text/chapter3.xhtml">第三章 表格与代码</a></li>
      <li><a href="text/endnotes.xhtml">注释</a></li>
    </ol>
  </nav>
</body>
</html>
`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:12345678-1234-1234-1234-123456789abc"/></head>
  <docTitle><text>测试之书</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>第一章 起点</text></navLabel><content src="text/chapter1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>第二章 深入</text></navLabel><content src="text/chapter2.xhtml"/></navPoint>
    <navPoint id="np3" playOrder="3"><navLabel><text>第三章 表格与代码</text></navLabel><content src="text/chapter3.xhtml"/></navPoint>
  </navMap>
</ncx>
`;

const CSS = `body { font-family: serif; line-height: 1.6; margin: 1em; }
h1, h2 { font-family: sans-serif; }
p { text-indent: 2em; margin: 0 0 .6em; }
.note-ref { vertical-align: super; font-size: .7em; }
table { border-collapse: collapse; }
td, th { border: 1px solid #999; padding: 4px 8px; }
pre { background: #f4f4f4; padding: 8px; }
`;

const CHAPTER1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head>
  <title>第一章 起点</title>
  <link rel="stylesheet" type="text/css" href="../styles/main.css"/>
</head>
<body>
  <section epub:type="chapter" id="ch1">
    <h1 id="h-1">第一章 起点</h1>
    <p>在 1973 年，这本书第一次出版，当时的通胀率高达 <strong>12.3%</strong>。作者认为，投资者最大的敌人不是市场，而是自己&#8212;这句话后来被引用了无数次。</p>
    <p>他在第 42 页写道：<q>安全边际（margin of safety）是投资的核心概念</q>，并给出了一个具体的例子：如果一家公司每股净资产为 <em>50 美元</em>，而你只用 30 美元买入，那么你的安全边际就是 <strong>40%</strong><a class="note-ref" href="endnotes.xhtml#n1" id="ref1"><sup>1</sup></a>。</p>
    <p>值得注意的是，作者并没有说这种方法永远有效。他明确写道：<em>在极端情况下，这个结论可能不成立</em>。这一点常被读者忽略。</p>
    <p>另一些人（例如 Mr. Graham 的批评者）则认为，账面价值本身并不可靠&nbsp;——尤其是对于轻资产公司。</p>
    <figure>
      <img src="../images/figure1.png" alt="示意图"/>
      <figcaption>图 1：安全边际示意</figcaption>
    </figure>
    <p>最后，他提醒读者：<a href="chapter2.xhtml">请继续阅读第二章</a>，因为那里讨论了更复杂的情形。</p>
  </section>
</body>
</html>
`;

const CHAPTER2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>第二章 深入</title><link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>
<body>
  <section epub:type="chapter" id="ch2">
    <h1>第二章 深入</h1>
    <p>这一章讨论 <abbr title="Discounted Cash Flow">DCF</abbr> 模型。作者用了三家公司作为案例：Acme Corp.、Beta Industries 和 Gamma Holdings。</p>
    <h2 id="sec-2-1">2.1 一个子节</h2>
    <p>在 2008 年金融危机期间，这些公司的市值分别下跌了 55%、62% 和 48%。作者指出，<strong>下跌幅度与公司质量并不完全相关</strong>。</p>
    <blockquote>
      <p>市场短期是投票机，长期是称重机。</p>
    </blockquote>
    <p>不过他也承认，这个比喻有局限：<em>它假设称重机的读数最终一定正确</em>，而现实中并非总是如此。</p>
    <ul>
      <li>第一，估值方法本身有误差。</li>
      <li>第二，管理层的资本配置能力差异很大。</li>
      <li>第三，<a href="endnotes.xhtml#n2">参见注释 2</a> 中对会计口径的说明。</li>
    </ul>
  </section>
</body>
</html>
`;

const CHAPTER3 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>第三章 表格与代码</title><link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>
<body>
  <section epub:type="chapter" id="ch3">
    <h1>第三章 表格与代码</h1>
    <p>下面这张表列出了 1999 年至 2020 年的年化收益率。这类表格不应该被 AI 改写。</p>
    <table>
      <thead><tr><th>年份</th><th>收益率</th></tr></thead>
      <tbody>
        <tr><td>1999</td><td>21.0%</td></tr>
        <tr><td>2008</td><td>-37.0%</td></tr>
        <tr><td>2020</td><td>18.4%</td></tr>
      </tbody>
    </table>
    <p>计算复利的代码片段如下：</p>
    <pre><code>let value = 1000;
for (const r of rates) value *= 1 + r;</code></pre>
    <p>行内代码 <code>value *= 1 + r</code> 也应当原样保留。</p>
    <p>最后一段包含一个数学公式：<span class="math">E = mc<sup>2</sup></span>，其中的上标不能被破坏。</p>
  </section>
</body>
</html>
`;

const ENDNOTES = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>注释</title><link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>
<body>
  <section epub:type="endnotes" id="notes">
    <h1>注释</h1>
    <aside epub:type="footnote" id="n1">
      <p><a href="chapter1.xhtml#ref1">1.</a> 安全边际的概念最早由 Benjamin Graham 与 David Dodd 在 1934 年提出。</p>
    </aside>
    <aside epub:type="footnote" id="n2">
      <p><a href="chapter2.xhtml">2.</a> 会计口径差异会显著影响账面价值的可比性。</p>
    </aside>
  </section>
</body>
</html>
`;

/**
 * 造一本「脚注成对互指」的样本，用来测脚注就地化。
 *
 * 真实脚注的结构特征是**成对的互相引用**：
 *   正文里：`<a id="jzyy_1_1" href="endnotes.xhtml#jz_1_1">(1)</a>`
 *   尾注里：`<a id="jz_1_1" href="chapter1.xhtml#jzyy_1_1">(1)</a> 注释正文…`
 * 只认单向引用会把目录锚点也当成注释（实测 483 条被数成 1038 条）。
 *
 * 注意注释正文在 `<a>` **外面** —— 取错了就只会拿到 "(1)" 这个标记本身。
 *
 * @returns {Buffer}
 */
export function makeFootnoteFixtureEpub() {
  const head = (title) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>
<body>`;

  const chapter1 = `${head('第一章')}
  <h1 id="h-1">第一章 起点</h1>
  <p id="p1">他在第 42 页写道，安全边际是投资的核心概念<a id="jzyy_1_1" href="endnotes.xhtml#jz_1_1"><sup>(1)</sup></a>，并给了一个例子。</p>
  <p id="p2">这一段没有任何脚注，讲的是别的事情。</p>
  <p id="p3">作者先把这个词拆开来讲：价格是你付出的，价值是你得到的，两者之间的差距才叫安全边际。这个说法听起来简单，真正难的是给价值定一个范围，而不是一个精确到小数点的数字。</p>
  <p id="p4">接着他用一家制造业公司做演示：账面资产、清算价值、盈利能力分别算一遍，得到三个不同的数，最后取最保守的那个作为估值的起点。保守不是悲观，而是给自己留出犯错的空间。</p>
  <p id="p5">本章余下的部分都在说明一件事：市场报价每天变，企业的内在价值不会跟着每天变。把这两者分开看，很多让人心慌的波动就只是噪音，而不是需要立刻行动的信号。</p>
</body>
</html>
`;

  const endnotes = `${head('注释')}
  <h1 id="h-notes">注释</h1>
  <p id="note-1"><a id="jz_1_1" href="chapter1.xhtml#jzyy_1_1">(1)</a> 安全边际的概念最早由 Benjamin Graham 与 David Dodd 在 1934 年提出。</p>
  <p id="note-2"><a id="jz_1_2" href="chapter1.xhtml">(2)</a> 这一条在正文里没有引用点，属于孤儿注释。</p>
</body>
</html>
`;

  return writeEpubZip([
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/toc.ncx', data: NCX },
    { name: 'OEBPS/styles/main.css', data: CSS },
    { name: 'OEBPS/images/cover.png', data: PNG_COVER },
    { name: 'OEBPS/images/figure1.png', data: PNG_1PX },
    { name: 'OEBPS/text/chapter1.xhtml', data: chapter1 },
    { name: 'OEBPS/text/chapter2.xhtml', data: CHAPTER2 },
    { name: 'OEBPS/text/chapter3.xhtml', data: CHAPTER3 },
    { name: 'OEBPS/text/endnotes.xhtml', data: endnotes },
  ]);
}

/**
 * 造一本「图片密集」的样书，用来测图片说明与图注保留。
 *
 * 结构照着真实书（《证券分析》第 6 版）里那几种反复出现的写法：
 *  - `<div class="table_img"><p class="biaoti">表6-1 …</p><img/></div>`（表扫描图，图注在上）
 *  - `<div class="chatu_img"><img/><p class="tuti">图0-1 …</p></div>`（插图，图注在下）
 *  - `<div class="equation_img"><img/></div>`（整页公式图，没有任何文字）
 *  - 正文段落里「见表6-1」「如图0-1」这类指代
 *  - 正文中夹着的行内图片（占位符必须留在原句里）
 *
 * @returns {Buffer}
 */
export function makeImageFixtureEpub() {
  const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>第六章 图片与表格</title><link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>
<body>
  <section epub:type="chapter" id="ch6">
    <h1 id="h-6">第六章 图片与表格</h1>
    <p id="p1">下面这张表列出了 1927 年至 1932 年的收益率，详细数据见表6-1。</p>
    <div class="table_img">
      <p class="biaoti">表6-1 各年收益率（1927—1932）</p>
      <img src="../images/table61.jpg" alt="表6-1"/>
    </div>
    <p id="p2">从表中可以看出，1931 年的亏损最大，如图0-1 所示。</p>
    <div class="chatu_img">
      <img src="../images/chart01.jpg" alt="图0-1"/>
      <p class="tuti">图0-1 1927—1932 年收益率走势</p>
    </div>
    <p id="p3">计算年化收益率时使用下面的公式：</p>
    <div class="equation_img"><img src="../images/eq01.png" alt=""/></div>
    <p id="p4">这一段在公式之后，讲的是另一件事：安全边际才是投资的核心。</p>
    <p id="p5">如图0-2 所示，曲线在 1931 年触底<img src="../images/inline02.jpg" alt="图0-2"/>，随后缓慢回升。</p>
  </section>
</body>
</html>
`;
  const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
  <li><a href="text/chapter1.xhtml">第六章 图片与表格</a></li>
</ol></nav></body>
</html>
`;
  const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:image-fixture"/></head>
  <docTitle><text>图片样书</text></docTitle>
  <navMap><navPoint id="np1" playOrder="1"><navLabel><text>第六章 图片与表格</text></navLabel><content src="text/chapter1.xhtml"/></navPoint></navMap>
</ncx>
`;
  const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:image-fixture</dc:identifier>
    <dc:title>图片样书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2024-05-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    <item id="img-table" href="images/table61.jpg" media-type="image/jpeg"/>
    <item id="img-chart" href="images/chart01.jpg" media-type="image/jpeg"/>
    <item id="img-eq" href="images/eq01.png" media-type="image/png"/>
    <item id="img-inline" href="images/inline02.jpg" media-type="image/jpeg"/>
    <item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>
`;
  /** 假 JPEG：不识图，只当作字节送进 data URL；刻意做 2KB 左右，方便测 maxBytes。 */
  const fakeJpeg = (tag) => Buffer.from(`FFD8FFE0-fake-jpeg-${tag}-${'0'.repeat(2048)}`, 'utf8');

  return writeEpubZip([
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: 'OEBPS/toc.ncx', data: NCX },
    { name: 'OEBPS/styles/main.css', data: CSS },
    { name: 'OEBPS/images/table61.jpg', data: fakeJpeg('table61') },
    { name: 'OEBPS/images/chart01.jpg', data: fakeJpeg('chart01') },
    { name: 'OEBPS/images/eq01.png', data: PNG_1PX },
    { name: 'OEBPS/images/inline02.jpg', data: fakeJpeg('inline02') },
    { name: 'OEBPS/text/chapter1.xhtml', data: CHAPTER },
  ]);
}

/** 一个最小的合法 PNG（1x1 透明）。 */const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 封面用稍大一点的假 PNG（内容无所谓，只要 manifest 指向的文件存在）。 */
const PNG_COVER = Buffer.concat([PNG_1PX, Buffer.alloc(512)]);

/**
 * 生成测试用 EPUB。
 * @param {{legacy?: boolean}} [opts] legacy=true 时去掉 nav（模拟纯 EPUB 2）
 * @returns {Buffer}
 */
export function makeFixtureEpub(opts = {}) {
  const legacy = Boolean(opts.legacy);
  const manifest = legacy
    ? OPF.replace('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n    ', '')
        .replace('version="3.0"', 'version="2.0"')
        .replace(/\s*<meta property="dcterms:modified">[^<]*<\/meta>/, '')
    : OPF;

  const entries = [
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: manifest },
    { name: 'OEBPS/toc.ncx', data: NCX },
    { name: 'OEBPS/styles/main.css', data: CSS },
    { name: 'OEBPS/images/cover.png', data: PNG_COVER },
    { name: 'OEBPS/images/figure1.png', data: PNG_1PX },
    { name: 'OEBPS/text/chapter1.xhtml', data: CHAPTER1 },
    { name: 'OEBPS/text/chapter2.xhtml', data: CHAPTER2 },
    { name: 'OEBPS/text/chapter3.xhtml', data: CHAPTER3 },
    { name: 'OEBPS/text/endnotes.xhtml', data: ENDNOTES },
  ];
  if (!legacy) entries.splice(2, 0, { name: 'OEBPS/nav.xhtml', data: NAV });

  return writeEpubZip(entries);
}

export const FIXTURE_FILES = {
  'META-INF/container.xml': CONTAINER_XML,
  'OEBPS/content.opf': OPF,
  'OEBPS/nav.xhtml': NAV,
  'OEBPS/toc.ncx': NCX,
  'OEBPS/styles/main.css': CSS,
  'OEBPS/text/chapter1.xhtml': CHAPTER1,
  'OEBPS/text/chapter2.xhtml': CHAPTER2,
  'OEBPS/text/chapter3.xhtml': CHAPTER3,
  'OEBPS/text/endnotes.xhtml': ENDNOTES,
};

/**
 * 造一本「第 1 章被全书大量锚点指着」的样本。
 *
 * 真实对应：用户那本书的脚注汇编章（延伸阅读）被 **483** 条脚注链接指着，
 * 压它等于切断全书的脚注跳转 —— `digestRisk` 判为 `blocked`。
 * 这里用 `links` 个各不相同的锚点复现同一种局面（默认 120 > 阈值 100）。
 *
 * @param {number} links 指向第 1 章的锚点个数
 * @returns {Buffer}
 */
export function makeWidelyLinkedFixtureEpub(links = 120) {
  const ids = [];
  const targetBody = [];
  for (let i = 1; i <= links; i += 1) {
    ids.push(`m${i}`);
    targetBody.push(`<p id="m${i}">第 ${i} 条注释的正文内容。</p>`);
  }
  const head = (title) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>
<body>`;

  const chapter1 = `${head('第一章 注释汇编')}
  <h1 id="h-1">第一章 注释汇编</h1>
${targetBody.join('\n')}
</body>
</html>
`;
  const chapter2 = `${head('第二章 正文')}
  <h1 id="h-2">第二章 正文</h1>
  <p>下面这些标记指向第一章的每一条注释。</p>
${ids.map((id) => `  <p><a class="note-ref" href="chapter1.xhtml#${id}"><sup>${id.slice(1)}</sup></a></p>`).join('\n')}
</body>
</html>
`;

  return writeEpubZip([
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: 'OEBPS/toc.ncx', data: NCX },
    { name: 'OEBPS/styles/main.css', data: CSS },
    { name: 'OEBPS/images/cover.png', data: PNG_COVER },
    { name: 'OEBPS/images/figure1.png', data: PNG_1PX },
    { name: 'OEBPS/text/chapter1.xhtml', data: chapter1 },
    { name: 'OEBPS/text/chapter2.xhtml', data: chapter2 },
    { name: 'OEBPS/text/chapter3.xhtml', data: CHAPTER3 },
    { name: 'OEBPS/text/endnotes.xhtml', data: ENDNOTES },
  ]);
}

/**
 * 生成一本「第一章很长」的样本，用于测试分块、长度检查与摘要化检测。
 * 长章节里同时包含脚注链接、数字与专有名词，保证质量检查有东西可查。
 *
 * @param {number} paragraphs 段落数（每段约 300 字）
 * @returns {Buffer}
 */
export function makeLongFixtureEpub(paragraphs = 12) {
  const body = [];
  for (let i = 1; i <= paragraphs; i += 1) {
    const noteRef =
      i % 3 === 0
        ? `<a class="note-ref" href="endnotes.xhtml#n1" id="longref${i}"><sup>1</sup></a>`
        : '';
    body.push(
      `<p>第 ${i} 段讨论 ${['Acme Corp.', 'Beta Industries', 'Gamma Holdings'][i % 3]} 在 ${
        1900 + i * 7
      } 年的表现。` +
        `作者指出，当时的收益率是 ${(i * 3.7).toFixed(1)}%，而通胀率只有 ${(i % 5) + 1}.2%。` +
        `他强调，安全边际（margin of safety）这个概念必须结合具体情况来判断，` +
        `不能简单套用公式；并且明确写道，在极端情况下这个结论可能不成立${noteRef}。` +
        `这一段刻意写得比较长，用来确保分块逻辑、长度检查与摘要化检测都有足够的样本量。` +
        `他还举了一个例子：如果一家公司的账面价值被高估，那么任何折价买入都可能是假的安全边际。</p>`,
    );
  }
  // 再补一段「专名集中」的段落，且不含占位符：
  // 这样才测得出「数字 / 专名被改掉」——否则整段会因行内元素丢失而被判定不可信、
  // 自动回退原文，反而掩盖了数字与专名的变化。
  body.push(
    `<p>作为对照，Benjamin Graham 与 David Dodd 在 1934 年合著的书里，` +
      `把 Acme Corp.、Beta Industries 与 Gamma Holdings 的账面价值并列比较，` +
      `发现三者的折价率分别是 40%、25% 和 12%，这个结论在 2008 年再次被引用。</p>`,
  );

  const LONG_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>第一章 起点</title><link rel="stylesheet" type="text/css" href="../styles/main.css"/></head>
<body>
  <section epub:type="chapter" id="ch1">
    <h1 id="h-1">第一章 起点</h1>
${body.join('\n')}
  </section>
</body>
</html>
`;

  return writeEpubZip([
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: 'OEBPS/toc.ncx', data: NCX },
    { name: 'OEBPS/styles/main.css', data: CSS },
    { name: 'OEBPS/images/cover.png', data: PNG_COVER },
    { name: 'OEBPS/images/figure1.png', data: PNG_1PX },
    { name: 'OEBPS/text/chapter1.xhtml', data: LONG_CHAPTER },
    { name: 'OEBPS/text/chapter2.xhtml', data: CHAPTER2 },
    { name: 'OEBPS/text/chapter3.xhtml', data: CHAPTER3 },
    { name: 'OEBPS/text/endnotes.xhtml', data: ENDNOTES },
  ]);
}
