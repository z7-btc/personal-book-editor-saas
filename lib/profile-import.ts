/**
 * 「把 AI 的回答粘贴进来」的解析器。
 *
 * 阅读画像页顶部给用户的提示词要求 AI 按固定小标题输出：
 *
 *     ### about_me
 *     ……
 *     ### preferred_style
 *     - ……
 *
 * 这里只做纯文本解析，不联网、不调模型：粘贴 → 立刻得到字段，用户不用等，
 * 也不用为一次填写烧掉额度。为了容错，除了标准 `### key` 之外还接受：
 *
 *  - `【about_me】`、`about_me:` 这样的写法；
 *  - 本地化的小标题（「关于我」等，由调用方传入界面文案）；
 *  - AI 直接回一段 JSON（很多模型被要求「结构化输出」时会自己改成 JSON）。
 *
 * 解析不出来时如实返回空对象，由界面提示用户检查格式，绝不猜内容。
 */

export const PROFILE_STRING_FIELDS = ['about_me', 'reading_goal', 'custom_instructions'] as const;
export const PROFILE_LIST_FIELDS = [
  'preferred_style',
  'disliked_style',
  'known_topics',
  'weak_topics',
  'explanation_preferences',
  'language_preferences',
] as const;

export type ProfileStringField = (typeof PROFILE_STRING_FIELDS)[number];
export type ProfileListField = (typeof PROFILE_LIST_FIELDS)[number];
export type ProfileField = ProfileStringField | ProfileListField;

export type ParsedProfile = Partial<Record<ProfileStringField, string>> &
  Partial<Record<ProfileListField, string[]>>;

const ALL_FIELDS: ProfileField[] = [...PROFILE_STRING_FIELDS, ...PROFILE_LIST_FIELDS];
const FIELD_SET = new Set<string>(ALL_FIELDS);
const LIST_FIELD_SET = new Set<string>(PROFILE_LIST_FIELDS);

/** 英文标签（提示词里就是这些），以及界面上的中文标签。 */
const BUILTIN_ALIASES: Record<string, ProfileField> = {
  'about me': 'about_me',
  'about myself': 'about_me',
  about: 'about_me',
  'reading goal': 'reading_goal',
  'reading goals': 'reading_goal',
  'what i want from reading': 'reading_goal',
  'preferred style': 'preferred_style',
  'styles i like': 'preferred_style',
  'disliked style': 'disliked_style',
  'styles i dislike': 'disliked_style',
  'known topics': 'known_topics',
  'topics i already know': 'known_topics',
  'weak topics': 'weak_topics',
  'topics i need explained': 'weak_topics',
  'explanation preferences': 'explanation_preferences',
  'how i like things explained': 'explanation_preferences',
  'language preferences': 'language_preferences',
  'custom instructions': 'custom_instructions',
  'other instructions': 'custom_instructions',
  关于我: 'about_me',
  关于: 'about_me',
  自我介绍: 'about_me',
  阅读目标: 'reading_goal',
  阅读目的: 'reading_goal',
  我读这本书想得到什么: 'reading_goal',
  喜欢的表达方式: 'preferred_style',
  喜欢的表达: 'preferred_style',
  偏好风格: 'preferred_style',
  表达偏好: 'preferred_style',
  不喜欢的表达方式: 'disliked_style',
  不喜欢的表达: 'disliked_style',
  讨厌的表达: 'disliked_style',
  我已经熟悉的主题: 'known_topics',
  熟悉的领域: 'known_topics',
  已知主题: 'known_topics',
  已掌握的领域: 'known_topics',
  我的薄弱主题: 'weak_topics',
  薄弱领域: 'weak_topics',
  需要解释的主题: 'weak_topics',
  解释方式偏好: 'explanation_preferences',
  解释偏好: 'explanation_preferences',
  讲解偏好: 'explanation_preferences',
  语言偏好: 'language_preferences',
  用词偏好: 'language_preferences',
  语言和用词偏好: 'language_preferences',
  其他要求: 'custom_instructions',
  自定义指令: 'custom_instructions',
  自定义要求: 'custom_instructions',
  其他说明: 'custom_instructions',
};

/** 「没有内容」的同义词：AI 常拿这些填空白，导入时应当丢掉。 */
const EMPTY_TOKENS = new Set([
  '无',
  '暂无',
  '没有',
  '不清楚',
  '未知',
  '待补充',
  '—',
  '-',
  '–',
  'n/a',
  'na',
  'none',
  'null',
  'unknown',
  'not sure',
  'nothing',
  '(none)',
  '（无）',
  '（暂无）',
]);

/** 一整段只是括号里的填写说明，比如「（用 100–250 字介绍……）」。 */
const PLACEHOLDER_ONLY = /^[（(][^（()）]*[)）]$/;

/** 括号里还提到这些词时，才更像「填写说明」而不是用户自己想说的话。 */
const PLACEHOLDER_HINT = /(例如|比如|举例|填写|介绍|描述|用\s*\d|\d+\s*[-–—]\s*\d+\s*字|字左右|可选|选填|如[:：])/;

/** 模型常把整段回答包进 ``` 代码块，围栏本身不是画像内容。 */
const FENCE_LINE = /^\s*```/;

/** 模型自己加的 `### 备注` 这类小标题：它结束上一段，而不是上一段的正文。 */
const UNKNOWN_HEADING = /^#{1,6}\s+/;
const UNKNOWN_BRACKET_HEADING = /^(?:【[^】]{1,40}】|\[[^\]]{1,40}\])\s*$/;

function isPlaceholderLine(line: string): boolean {
  const text = line.trim();
  return PLACEHOLDER_ONLY.test(text) && PLACEHOLDER_HINT.test(text);
}

/** 「无。」「暂无！」和「无」一样，都是没内容。 */
function emptyKey(text: string): string {
  return text.trim().toLowerCase().replace(/[。.!！?？；;、,，\s]+$/g, '');
}

function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[*`]+/g, '')
    .replace(/[\s\-–—]+/g, '_')
    .replace(/[：:。.!！?？]+$/g, '')
    .trim();
}

function buildAliasMap(labels?: Partial<Record<ProfileField, string>>): Map<string, ProfileField> {
  const map = new Map<string, ProfileField>();
  for (const [alias, field] of Object.entries(BUILTIN_ALIASES)) map.set(normalizeKey(alias), field);
  if (labels) {
    for (const field of ALL_FIELDS) {
      const label = labels[field];
      if (label) map.set(normalizeKey(label), field);
    }
  }
  return map;
}

type HeaderMatch = { field: ProfileField; rest: string };

/**
 * 判断一行是不是字段小标题。
 *
 * 真正的正文可能碰巧以「关于我」开头，所以只有满足下面任一形式才当标题：
 * `### key`、`【key】`、`[key]`、`key:`，或者整行就是这个标签本身。
 */
function matchHeader(line: string, aliases: Map<string, ProfileField>): HeaderMatch | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80) return null;

  const hashed = trimmed.match(/^#{1,6}\s*(.+)$/);
  const bracketed = trimmed.match(/^【\s*([^】]+?)\s*】\s*(.*)$/)
    || trimmed.match(/^\[\s*([^\]]+?)\s*\]\s*(.*)$/);
  const colon = trimmed.match(/^([^:：]{1,40})[:：]\s*(.*)$/);

  let candidate: string;
  let rest = '';
  let explicit = true;
  if (hashed) {
    candidate = hashed[1];
  } else if (bracketed) {
    candidate = bracketed[1];
    rest = bracketed[2] ?? '';
  } else if (colon) {
    candidate = colon[1];
    rest = colon[2] ?? '';
  } else {
    // 没有 #、括号或冒号时，整行必须恰好就是标签，否则普通正文会被误认。
    candidate = trimmed;
    explicit = false;
  }

  // 「### about_me：内容」：冒号后是正文，不是标题的一部分。
  const inline = candidate.match(/^([^:：]{1,40})[:：]\s*(.*)$/);
  if (inline && !rest) {
    candidate = inline[1];
    rest = inline[2] ?? '';
  }

  // 「### about_me · 关于我」这类写法：只取第一个分隔符之前的部分。
  const head = candidate.split(/[·•|｜—–]/)[0].trim();
  const key = normalizeKey(head);
  const field = FIELD_SET.has(key) ? (key as ProfileField) : aliases.get(key);
  if (!field) return null;
  if (!explicit && normalizeKey(trimmed) !== key) return null;

  return { field, rest: rest.replace(/^[\s:：]+/, '').trim() };
}

function cleanListItem(raw: string): string[] {
  if (FENCE_LINE.test(raw)) return [];
  const text = raw
    .replace(/^\s*(?:[-*•·、]|\d+[.)、]|[（(]\d+[)）])\s*/, '')
    .replace(/\*\*/g, '')
    .trim()
    .replace(/[；;、]\s*$/, '');
  if (!text || FENCE_LINE.test(text)) return [];
  if (PLACEHOLDER_ONLY.test(text)) return [];
  const pieces = text
    .split(/[；;、]/)
    .map((piece) => piece.replace(/^[-*•·]\s*/, '').trim())
    .map((piece) => piece.replace(/^["'“”「」]+|["'“”「」]+$/g, '').trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    if (EMPTY_TOKENS.has(emptyKey(piece))) continue;
    if (PLACEHOLDER_ONLY.test(piece)) continue;
    out.push(piece.slice(0, 500));
  }
  return out;
}

function cleanString(lines: string[]): string {
  // 文本框字段也可能被模型按列表输出（尤其 custom_instructions）。这里只去掉
  // 行首的项目符号，保留一行一条；正文如果本来以「-」开头，去掉后也更干净。
  // 夹在正文里的填写说明（「（用 100–250 字介绍……）」）和代码围栏也一并丢掉：
  // 模型经常把它们和真内容混在同一段里。
  const text = lines
    .filter((line) => !FENCE_LINE.test(line) && !isPlaceholderLine(line))
    .map((line) => line.replace(/^\s*(?:[-*•·]|\d+[.)、]|[（(]\d+[)）])\s+/, ''))
    .join('\n')
    .replace(/\*\*/g, '')
    .trim();
  if (!text) return '';
  if (EMPTY_TOKENS.has(emptyKey(text))) return '';
  if (PLACEHOLDER_ONLY.test(text)) return '';
  return text.slice(0, 20000);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 60);
}

/**
 * AI 常在被要求「不要客套」之后，仍在最后一个区块后面补一句
 * 「希望这份画像对你有帮助！」。它属于回答的收尾，不是画像内容，
 * 只从每个区块的末尾整行剥掉，避免被塞进「其他要求」。
 */
const SIGNOFF = [
  /^希望(这份|这些|以上|上面的)?[^。！!]{0,24}(有帮助|有用|帮到你|对你有用)/,
  /^如果(你|您)?(还)?(需要|想要|希望|觉得)[^。！!]{0,24}(告诉|说|补充|调整)/,
  /^随时(告诉|联系|找我)/,
  /^(上面|以上)(就是|是)[^。！!]{0,24}(画像|内容)/,
  /^(hope (this|that) helps|let me know|feel free to|happy reading)/i,
  /^(this should|i hope this)/i,
];

/**
 * 判断一行是不是客套收尾，并把它后面的真内容分出来。
 *
 * 模型常写成「希望这份画像对你有帮助！另外，请保留原书表格。」——前半句要丢，
 * 后半句是用户想要的指令。整行删掉会丢内容，整行留下又会把客套塞进画像。
 */
function stripSignoff(line: string): { signoff: boolean; rest: string } {
  const text = line.trim();
  if (!text) return { signoff: false, rest: '' };
  const match = text.match(/^([^。！!？?]*[。！!？?])\s*(.*)$/s);
  const first = match ? match[1] : text;
  if (!SIGNOFF.some((pattern) => pattern.test(first))) return { signoff: false, rest: '' };
  return { signoff: true, rest: match ? match[2].trim() : '' };
}

/** 去掉区块末尾的空行与客套收尾；不会把区块清空。 */
function trimSignoff(lines: string[]): string[] {
  const out = [...lines];
  while (out.length) {
    const last = out[out.length - 1];
    if (!last.trim()) {
      out.pop();
      continue;
    }
    const { signoff, rest } = stripSignoff(last);
    if (!signoff) break;
    if (rest) {
      out[out.length - 1] = rest;
      break;
    }
    out.pop();
  }
  return out;
}

function parseBlocks(text: string, aliases: Map<string, ProfileField>): ParsedProfile {
  const buckets = new Map<ProfileField, string[]>();
  let current: ProfileField | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (FENCE_LINE.test(line)) continue;
    const header = matchHeader(line, aliases);
    if (header) {
      current = header.field;
      if (!buckets.has(current)) buckets.set(current, []);
      if (header.rest.trim()) buckets.get(current)!.push(header.rest.trim());
      continue;
    }
    // 模型自己加的小标题（`### 备注`、【备注】）是上一段的结束，不是正文：
    // 否则「请保留原书表格」会被并进 about_me。它后面的内容按未知段落忽略，
    // 宁可少填一个字段，也不把内容塞错地方。
    const trimmed = line.trim();
    if (UNKNOWN_HEADING.test(trimmed) || UNKNOWN_BRACKET_HEADING.test(trimmed)) {
      current = null;
      continue;
    }
    if (current) buckets.get(current)!.push(line);
  }

  const parsed: ParsedProfile = {};
  for (const [field, rawLines] of buckets) {
    const lines = trimSignoff(rawLines);
    if (LIST_FIELD_SET.has(field)) {
      const items = dedupe(lines.flatMap(cleanListItem));
      if (items.length) (parsed as Record<string, unknown>)[field] = items;
    } else {
      const value = cleanString(lines);
      if (value) (parsed as Record<string, unknown>)[field] = value;
    }
  }
  return parsed;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseJson(text: string): ParsedProfile | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const parsed: ParsedProfile = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizeKey(rawKey);
    if (!FIELD_SET.has(key)) continue;
    const field = key as ProfileField;
    if (LIST_FIELD_SET.has(field)) {
      const values = Array.isArray(rawValue)
        ? rawValue.flatMap((item) => (typeof item === 'string' ? item.split(/\r?\n/) : []))
        : typeof rawValue === 'string'
          ? rawValue.split(/\r?\n/)
          : [];
      const items = dedupe(values.flatMap(cleanListItem).filter(Boolean));
      if (items.length) (parsed as Record<string, unknown>)[field] = items;
    } else {
      const value = Array.isArray(rawValue)
        ? rawValue.map(asString).filter(Boolean).join('\n')
        : asString(rawValue);
      const cleaned = cleanString(value.split(/\r?\n/));
      if (cleaned) (parsed as Record<string, unknown>)[field] = cleaned;
    }
  }
  return Object.keys(parsed).length ? parsed : null;
}

/**
 * 解析用户粘贴的 AI 回答。`labels` 传入当前界面语言的字段名，用来识别
 * 被 AI 顺手翻译过的小标题（例如日语的「読者プロフィール」字段名）。
 */
export function parseProfilePaste(
  text: string,
  labels?: Partial<Record<ProfileField, string>>,
): ParsedProfile {
  if (typeof text !== 'string') return {};
  const trimmed = text.trim();
  if (!trimmed) return {};

  const aliases = buildAliasMap(labels);
  const fromBlocks = parseBlocks(trimmed, aliases);
  if (Object.keys(fromBlocks).length) return fromBlocks;

  // 没有小标题时，再给 JSON 一次机会：有的模型会自作主张输出 JSON。
  const fromJson = parseJson(trimmed);
  if (fromJson) return fromJson;

  return {};
}

/** 把解析结果合并进现有画像：粘贴里没有的字段保持原样。 */
export function mergeParsedProfile<T extends Record<string, unknown>>(
  base: T,
  parsed: ParsedProfile,
): { profile: T; fields: ProfileField[] } {
  const profile: Record<string, unknown> = { ...base };
  const fields: ProfileField[] = [];
  for (const field of ALL_FIELDS) {
    const value = (parsed as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (Array.isArray(value) ? value.length === 0 : !value) continue;
    profile[field] = value;
    fields.push(field);
  }
  return { profile: profile as T, fields };
}
