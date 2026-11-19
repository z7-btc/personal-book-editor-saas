/**
 * 成品 EPUB 的排版样式（PBE 自带）。
 *
 * ## 为什么单独一块样式，而不是改 main.css
 *
 * `main.css` 是**原书的**样式表。导出策略里有一条硬规矩：没被明确换掉的
 * 东西（CSS、图片、字体）原字节搬运，`smoke.mjs` 也断言它一个字节都没变。
 * 往里加规则等于毁掉这条保证 —— 而且每本书的 CSS 名字、内容都不一样，
 * 没法维护。
 *
 * 所以这里做的是**追加**：往每个我们自己重写过的页面 `<head>` 末尾插一段
 * `<style>`。它在原样式表之后，同权重的规则自然覆盖原文；原文的类名
 * （维基百科那些 floatright / mw-halign-*）一条都不碰。
 *
 * ## 解决的是哪几件事
 *
 *  1. **阅读路径页完全没有样式。** `reading-path.js` 生成的 `.rp-*` 类在
 *     任何样式表里都不存在，那一页实际用的是浏览器默认样式：默认字体、
 *     蓝色下划线链接、「核心」「精读」标签直接贴在标题后面连排。
 *  2. **手机浏览器里字小到看不清。** 没有 viewport 声明时，手机按 980px
 *     排版再整体缩放，390 宽的屏幕上等效字号只剩 6px 左右。阅读器一般
 *     自己控制排版，但「用浏览器打开」就是这个效果。
 *  3. **桌面浏览器里一行太长。** 中文没设字体栈、不限行宽，1280 宽时
 *     正文铺满约 1250px，读者得左右摇头。
 */

/** 手机浏览器的排版宽度声明。EPUB 阅读器会忽略它，浏览器会照做。 */
export const PBE_VIEWPORT =
  '<meta name="viewport" content="width=device-width, initial-scale=1"/>';

/** 标记属性：重复导入导出时不能插第二遍。 */
const PBE_STYLE_MARK = 'data-pbe-style="1"';

/**
 * 这些容器里的文字不是真标记，找 `</head>` 和标记属性时都得先让开。
 *
 *   - 注释：模板和说明里会原样写 `</head>`；
 *   - CDATA：MediaWiki 的模板样式就长这样，CSS 里出现 `content:"</head>"`
 *     完全合法，插进去会把这一页自己的样式撕坏；
 *   - script / style 正文：同理。
 *
 * 一次扫四类，等长替换成空格 —— 位置不变，插入点还是原文的插入点。
 */
const NON_MARKUP_CONTAINERS =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi;

/** 只挡注释。用来判「插过没有」：我们自己的标记就在一个 `<style>` 里，不能一起挡掉。 */
const COMMENTS_ONLY = /<!--[\s\S]*?-->/g;

const blankOut = (s) => ' '.repeat(s.length);

export const PBE_STYLE_CSS = `
/* ---- PBE 排版（追加在原样式之后，只补不抢） ---- */
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  max-width: 42em;
  margin: 0 auto;
  padding: 1.2em 1.1em 3.5em;
  font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Source Han Serif CN",
    "Songti SC", "STSong", "SimSun", serif;
  font-size: 1em;
  line-height: 1.8;
  text-align: justify;
  text-justify: inter-ideograph;
  overflow-wrap: break-word;
  word-wrap: break-word;
}
h1, h2, h3, h4 { line-height: 1.4; }
h1 { font-size: 1.55em; margin: 0.4em 0 0.8em; }
h2 { font-size: 1.28em; margin: 1.6em 0 0.7em; }
h3 { font-size: 1.1em; margin: 1.4em 0 0.6em; }
p { margin: 0 0 0.85em; }
img, svg, video { max-width: 100%; height: auto; }
table { max-width: 100%; border-collapse: collapse; }
pre { white-space: pre-wrap; overflow-wrap: break-word; }
/**
 * 链接不要浏览器默认那种亮蓝 + 粗下划线。
 *
 * 阅读路径页整页都是链接，默认样式一片蓝，像没写完的网页而不像书。
 * 换成偏墨蓝 + 浅下划线：点得出来，又不抢正文。
 */
a {
  color: #1f4e79;
  text-decoration: underline;
  text-decoration-color: rgba(31, 78, 121, 0.4);
  text-underline-offset: 0.15em;
  overflow-wrap: break-word;
}

/* ---- 「怎么读这本书」 ---- */
.rp-book { margin: 0 0 1.6em; font-size: 1.05em; color: #555555; text-align: left; }
.rp-lead { font-size: 1.02em; }
.rp-note { font-size: 0.94em; color: #555555; }
.rp-dropped { padding-left: 1.4em; }
.rp-dropped li { margin: 0 0 0.5em; }
.rp-toc { padding-left: 1.6em; }
.rp-toc li { margin: 0 0 0.55em; }
.rp-tag {
  display: inline-block;
  margin-left: 0.4em;
  padding: 0 0.45em;
  border: 1px solid #bbbbbb;
  border-radius: 3px;
  font-size: 0.78em;
  line-height: 1.6;
  color: #666666;
  vertical-align: 0.12em;
}
.rp-stat { font-size: 0.94em; color: #555555; }
.rp-meta { margin: 0 0 0.4em; font-size: 0.9em; color: #666666; }
.rp-kp { margin: 0.9em 0 0.35em; font-weight: bold; }
.rp-kp-list { margin: 0 0 1.1em; }
.rp-skip { font-size: 0.94em; color: #666666; }
.rp-why { padding-left: 1.6em; }
.rp-reasons { padding-left: 1.6em; }
.rp-reasons li { margin: 0 0 0.55em; }
/**
 * 页脚那句「本页由 AI Personal Book Editor 生成……」。
 *
 * 它和正文不是一回事，别让人把它当书的一部分读：上面一道细线隔开、字号小
 * 一档、颜色更淡。
 */
.rp-foot {
  margin: 2.2em 0 0;
  padding-top: 0.8em;
  border-top: 1px solid #dddddd;
  font-size: 0.88em;
  color: #777777;
}

/* ---- 窄屏：浮动图片改为居中独占一行，避免挤成细条或溢出 ---- */
@media (max-width: 30em) {
  body { padding-left: 0.9em; padding-right: 0.9em; }
  div.floatright, div.floatleft, div.tright, div.tleft,
  .mw-halign-right, .mw-halign-left {
    float: none;
    margin: 1em 0;
    clear: both;
  }
}
`.trim();

/**
 * 插进 `<head>` 末尾的一整段。
 *
 * 放在最后而不是最前面：原页面里 `<link rel="stylesheet">` 在前、
 * 我们这段在后，同权重规则才轮得到我们覆盖。
 */
export function pbeHeadSnippet() {
  return `${PBE_VIEWPORT}\n<style type="text/css" ${PBE_STYLE_MARK}>\n${PBE_STYLE_CSS}\n</style>\n`;
}

/**
 * 给一页 XHTML 补上 viewport 与排版样式。
 *
 * 幂等：已经插过的页面原样返回。没有 `</head>` 的页面（极少见，通常是被
 * 拆坏的文件）也原样返回 —— 宁可这页没样式，也不能把正文改坏。
 *
 * 找 `</head>` 前先把注释、CDATA、script/style 正文整段等长替换成空格：
 * 这些地方提到 `</head>` 时（模板、CSS 的 content、JS 字符串里都可能），
 * 直接正则会命中那里，样式就插进了不该插的地方、这一页静默失效；等长
 * 替换让位置不变，插的还是真正的那个。
 *
 * 「插过没有」的判定也在挡掉注释之后做：注释里恰好写了一句
 * `data-pbe-style="1"` 不该让这页跳过。
 *
 * @param {string} xhtml
 * @returns {string}
 */
export function injectPbeStyle(xhtml) {
  const text = String(xhtml || '');
  if (!text) return text;
  if (text.replace(COMMENTS_ONLY, blankOut).includes(PBE_STYLE_MARK)) return text;
  const masked = text.replace(NON_MARKUP_CONTAINERS, blankOut);
  const match = /<\/head\s*>/i.exec(masked);
  if (!match) return text;
  const at = match.index;
  return `${text.slice(0, at)}${pbeHeadSnippet()}${text.slice(at)}`;
}
