/**
 * 图片地图：结构判断 + 「哪些块不能交给模型」。
 *
 * 真实背景（《证券分析》第 6 版）：
 *  - 图注 `p.biaoti` / `p.tuti` / `p.biaozhu` / `figcaption` 原本被当正文改写，
 *    451 个图注块有 42 个被改，图注一长，版式就对不上；
 *  - 整页公式图 `div.equation_img` 只剩一个 `⟦n⟧` 占位符发给模型；
 *  - 正文里的「见表6-1」「如图0-1」必须指向正确的图。
 *
 * 这里全部用内存里的 XHTML 结构测，不碰 EPUB 文件、不调模型。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../../lib/book-engine/epub/xml-dom.js';
import { extractBlocks } from '../../lib/book-engine/epub/sanitize.js';
import {
  annotateBlocks,
  collectChapterImages,
  resolveZipPath,
  mergeImageNotes,
} from '../../lib/book-engine/epub/image-map.js';
import { prepareChapter, buildImageNotesForChunk, materializeChunk } from '../../lib/book-engine/pipeline/rewrite.js';

const CHAPTER_HREF = 'OEBPS/text/chapter6.xhtml';

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第六章</title></head>
<body>
  <h1 id="h-6">第六章 图片与表格</h1>
  <p class="biaoti" id="title2">一、这些是普通小标题，不是图注</p>
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
  <div class="equation_img"><img src="../images/eq01.png" alt="公式"/></div>
  <p id="p4">这一段在公式之后，讲的是另一件事：安全边际才是投资的核心。</p>
  <p id="p5">如图0-2 所示，曲线在 1931 年触底<img src="../images/inline02.jpg" alt="图0-2"/>，随后缓慢回升。</p>
  <figure>
    <img src="../images/figure3.png" alt="示意图"/>
    <figcaption>图6-3 安全边际示意</figcaption>
  </figure>
</body>
</html>
`;

function prepare() {
  const doc = parseXml(DOC);
  const { blocks } = extractBlocks(doc);
  const scan = annotateBlocks(doc, blocks, { chapterHref: CHAPTER_HREF });
  return { doc, blocks, scan };
}

test('collectChapterImages 认出四种图片结构，并解析出 zip 路径与图号', () => {
  const { doc, blocks } = prepare();
  const images = collectChapterImages(doc, CHAPTER_HREF, { blocks });

  assert.equal(images.length, 5, '表图 / 插图 / 公式图 / 行内图 / figure 都要认出来');
  assert.deepEqual(
    images.map((img) => img.zipPath),
    [
      'OEBPS/images/table61.jpg',
      'OEBPS/images/chart01.jpg',
      'OEBPS/images/eq01.png',
      'OEBPS/images/inline02.jpg',
      'OEBPS/images/figure3.png',
    ],
  );
  assert.equal(images[0].label, '表6-1');
  assert.equal(images[0].captionText, '表6-1 各年收益率（1927—1932）');
  assert.equal(images[0].containerClass, 'table_img');

  assert.equal(images[1].label, '图0-1');
  assert.equal(images[1].captionText, '图0-1 1927—1932 年收益率走势');
  assert.equal(images[1].containerClass, 'chatu_img');

  assert.equal(images[2].captionText, '', '公式图没有图注');
  assert.equal(images[2].containerClass, 'equation_img');

  assert.equal(images[3].label, '图0-2', '没有图注时图号从 alt 取');

  assert.equal(images[4].label, '图6-3');
  assert.equal(images[4].captionText, '图6-3 安全边际示意');
});

test('annotateBlocks：图注块与整图块标为保留，正文块不受影响', () => {
  const { blocks, scan } = prepare();
  const byId = (id) => blocks.find((b) => b.element.getAttribute('id') === id);

  assert.equal(byId('h-6').preserve, undefined, '标题要照常改写');
  assert.equal(
    byId('title2').preserve,
    undefined,
    '不在图片容器里的 p.biaoti 是小标题，不能误判成图注',
  );
  assert.equal(byId('p1').preserve, undefined, '引用图号的正文要照常改写');
  assert.equal(byId('p2').preserve, undefined);
  assert.equal(byId('p4').preserve, undefined);

  const caption = blocks.find(
    (b) => b.tag === 'p' && b.element.getAttribute('class') === 'biaoti' && b.element.textContent.includes('表6-1'),
  );
  assert.equal(caption.preserve, 'image-caption', 'p.biaoti 是图注，必须原样保留');
  const tuti = blocks.find((b) => b.tag === 'p' && b.element.getAttribute('class') === 'tuti');
  assert.equal(tuti.preserve, 'image-caption', 'p.tuti 是图注，必须原样保留');
  const figcaption = blocks.find((b) => b.tag === 'figcaption');
  assert.equal(figcaption.preserve, 'image-caption', 'figcaption 是图注，必须原样保留');

  const equation = blocks.find((b) => b.element.getAttribute('class') === 'equation_img');
  assert.equal(equation.preserve, 'image-only', '整页公式图不该发给模型');

  const inline = byId('p5');
  assert.equal(inline.preserve, undefined, '正文里夹着图，这一段仍要改写');
  assert.equal(inline.imageRefs.length, 1, '要记住这一段里的图片占位符');
  assert.equal(inline.imageRefs[0].image.zipPath, 'OEBPS/images/inline02.jpg');

  assert.deepEqual(scan.stats, {
    imageCount: 5,
    preservedCaptionBlocks: 3,
    preservedImageBlocks: 1,
  });
});

test('prepareChapter：图注与整图块不进 chunk，正文与图号引用照常进入', () => {
  const prepared = prepareChapter(DOC, { chapterHref: CHAPTER_HREF, chapterTitle: '第六章 图片与表格' });
  for (const chunk of prepared.chunks) materializeChunk(chunk);
  const texts = prepared.chunks.flatMap((c) => c.blockTexts || []).join('\n');
  const chunkBlocks = prepared.chunks.flatMap((c) => c.blocks || []);

  assert.ok(texts.includes('详细数据见表6-1'), '引用图号的正文必须还在');
  assert.ok(texts.includes('如图0-1 所示'), '正文里的图号引用必须还在');
  assert.ok(!texts.includes('表6-1 各年收益率（1927—1932）'), '图注不能进改写输入');
  assert.ok(!texts.includes('图0-1 1927—1932 年收益率走势'), '图注不能进改写输入');
  assert.ok(!texts.includes('图6-3 安全边际示意'), 'figcaption 不能进改写输入');
  assert.ok(
    !chunkBlocks.some((b) => b.element.getAttribute('class') === 'equation_img'),
    '整页公式图不能进改写输入',
  );

  assert.equal(prepared.images.length, 5);
  assert.equal(prepared.imageStats.preservedCaptionBlocks, 3);
  assert.equal(prepared.imageStats.preservedImageBlocks, 1);
});

test('buildImageNotesForChunk：带说明的图给出段号与占位符，正文提到的图号也会列出来', () => {
  const prepared = prepareChapter(DOC, { chapterHref: CHAPTER_HREF });
  for (const chunk of prepared.chunks) materializeChunk(chunk);

  const images = prepared.images.map((img, i) => ({
    ...img,
    description: `（说明 ${i}）这是一张测试图片。`,
    descriptionSource: 'vision',
  }));

  const notes = prepared.chunks
    .map((chunk) => buildImageNotesForChunk(chunk, images, { segmentNumber: (i) => i + 1 }))
    .join('\n');

  assert.match(notes, /【段 \d+】⟦\d+⟧：（说明 \d）/, '含图段落应带占位符与说明');
  assert.match(notes, /- 表6-1：/, '正文提到「表6-1」时也要把图列出来');
  assert.match(notes, /- 图0-1：/, '正文提到「图0-1」时也要把图列出来');
});

test('resolveZipPath：相对路径 / 上级目录 / 外链 / data URL', () => {
  assert.equal(resolveZipPath('../images/a.jpg', 'OEBPS/text/ch1.xhtml'), 'OEBPS/images/a.jpg');
  assert.equal(resolveZipPath('images/a.png', 'OEBPS/text/ch1.xhtml'), 'OEBPS/text/images/a.png');
  assert.equal(resolveZipPath('./pic/a.gif', 'ch1.xhtml'), 'pic/a.gif');
  assert.equal(resolveZipPath('https://example.com/a.jpg', 'OEBPS/text/ch1.xhtml'), '');
  assert.equal(resolveZipPath('data:image/png;base64,AAA', 'OEBPS/text/ch1.xhtml'), '');
});

test('mergeImageNotes：按 zipPath 把外部说明合并回章节图片', () => {
  const { doc } = prepare();
  const images = collectChapterImages(doc, CHAPTER_HREF);
  mergeImageNotes(images, [
    { zipPath: 'OEBPS/images/table61.jpg', description: '描述 A', source: 'vision', error: null },
    { zipPath: 'OEBPS/images/chart01.jpg', description: '图注：图0-1', source: 'caption', error: '模型不支持图片' },
  ]);
  assert.equal(images[0].description, '描述 A');
  assert.equal(images[0].descriptionSource, 'vision');
  assert.equal(images[1].description, '图注：图0-1');
  assert.equal(images[1].descriptionError, '模型不支持图片');
  assert.equal(images[2].description, undefined, '没匹配到的图保持原样');
});
