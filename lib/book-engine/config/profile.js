/**
 * Reader Profile：长期阅读画像。
 *
 * 关键约束（需求第四 / 十七节）：
 *  - 存在项目本地 reader_profile.json，Web UI 可编辑；
 *  - 处理一本书时把当时的画像**快照**冻结到书目录里，
 *    以后改画像不会让已处理的书产生不一致；
 *  - Feedback 永远不会自动写回画像，必须由用户确认。
 */

import path from 'node:path';
import { readJson, writeJson, exists } from '../util/fsx.js';
import { currentUserContext } from '../auth/context.js';

export const PROFILE_FIELDS = [
  'about_me',
  'reading_goal',
  'preferred_style',
  'disliked_style',
  'known_topics',
  'weak_topics',
  'explanation_preferences',
  'language_preferences',
  'custom_instructions',
];

const ARRAY_FIELDS = [
  'preferred_style',
  'disliked_style',
  'known_topics',
  'weak_topics',
  'explanation_preferences',
  'language_preferences',
];

const STRING_FIELDS = ['about_me', 'reading_goal', 'custom_instructions'];

export function blankProfile() {
  return {
    about_me: '',
    reading_goal: '',
    preferred_style: [],
    disliked_style: [],
    known_topics: [],
    weak_topics: [],
    explanation_preferences: [],
    language_preferences: [],
    custom_instructions: '',
  };
}

/**
 * 画像文件位置。
 *
 * 多账号：有用户上下文时，画像属于这个账号，落在它自己的配置目录里
 * （`data/users/<id>/config/reader_profile.json`），和 providers.json 同一套
 * 归属 —— 否则 A 填的阅读偏好会悄悄指导 B 的改写，两个账号读的是同一份。
 *
 * 这里没有直接调用 `configDir(root)`：那个函数在没有用户上下文时会退回
 * PBE_CONFIG_DIR，而画像的历史位置是**项目根**（不是 config/）。
 * 为了「无上下文行为和以前一模一样」，只接管有上下文的那条分支。
 */
function profilePath(root) {
  const ctx = currentUserContext();
  if (ctx?.configDir) return path.join(ctx.configDir, 'reader_profile.json');
  return path.join(root, 'reader_profile.json');
}

/** 规范化：补齐字段、过滤非法类型、去重、限长。 */
export function normalizeProfile(input) {
  const base = blankProfile();
  if (!input || typeof input !== 'object') return base;
  const out = { ...base };
  for (const field of STRING_FIELDS) {
    const value = input[field];
    if (typeof value === 'string') out[field] = value.slice(0, 20000);
    else if (Array.isArray(value)) out[field] = value.filter((v) => typeof v === 'string').join('\n').slice(0, 20000);
  }
  for (const field of ARRAY_FIELDS) {
    const value = input[field];
    if (Array.isArray(value)) {
      out[field] = dedupe(
        value
          .flatMap((v) => (typeof v === 'string' ? v.split('\n') : []))
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.slice(0, 500)),
      ).slice(0, 60);
    } else if (typeof value === 'string') {
      out[field] = dedupe(
        value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.slice(0, 500)),
      ).slice(0, 60);
    }
  }
  return out;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function loadProfile(root) {
  const file = profilePath(root);
  if (!(await exists(file))) {
    const blank = blankProfile();
    await writeJson(file, blank);
    return blank;
  }
  return normalizeProfile(await readJson(file, blankProfile()));
}

export async function saveProfile(root, input) {
  const profile = normalizeProfile(input);
  await writeJson(profilePath(root), profile);
  return profile;
}

export function profilePathFor(root) {
  return profilePath(root);
}

/** 渲染成 prompt 里的人类可读块。 */
export function renderProfileForPrompt(profile) {
  const p = normalizeProfile(profile);
  const lines = [];
  const push = (label, value) => {
    if (!value) return;
    lines.push(`${label}：${value}`);
  };
  const pushList = (label, list) => {
    if (!list || !list.length) return;
    lines.push(`${label}：`);
    for (const item of list) lines.push(`  - ${item}`);
  };
  push('关于我', p.about_me);
  push('阅读目标', p.reading_goal);
  pushList('偏好的表达方式', p.preferred_style);
  pushList('不喜欢的表达方式', p.disliked_style);
  pushList('我已经熟悉的主题（可以少解释基础概念）', p.known_topics);
  pushList('我的薄弱主题（需要多加解释）', p.weak_topics);
  pushList('解释方式偏好', p.explanation_preferences);
  pushList('语言偏好', p.language_preferences);
  push('其他自定义要求', p.custom_instructions);
  if (lines.length === 0) return '（读者尚未填写画像，请保持中性、忠实、不过度简化的风格。）';
  return lines.join('\n');
}

/** 把一条 Feedback 汇总成建议的画像改动（不自动应用）。 */
export function suggestProfileFromFeedback(profile, feedbackText, tags = []) {
  const p = normalizeProfile(profile);
  const suggestion = normalizeProfile(p);
  const notes = [];
  const text = String(feedbackText || '');
  const has = (tag) => tags.includes(tag) || text.includes(tag);

  if (has('太短') || has('改得太短')) {
    addTo(suggestion.preferred_style, '尽量保持原书信息密度，不要压缩重要内容');
    notes.push('已建议：偏好风格中加入「保持信息密度」');
  }
  if (has('太长') || has('啰嗦')) {
    addTo(suggestion.preferred_style, '在保留全部重要信息的前提下精简重复表达');
    notes.push('已建议：偏好风格中加入「精简重复表达」');
  }
  if (has('解释太多')) {
    addTo(suggestion.disliked_style, '对基础概念做过多的入门解释');
    notes.push('已建议：不喜欢风格中加入「过多入门解释」');
  }
  if (has('解释太少')) {
    addTo(suggestion.explanation_preferences, '遇到抽象概念时补充简短解释');
    notes.push('已建议：解释偏好中加入「抽象概念补充解释」');
  }
  if (has('案例很好')) {
    addTo(suggestion.explanation_preferences, '保留并强化原文中的具体案例');
    notes.push('已建议：解释偏好中加入「强化具体案例」');
  }
  if (has('更直接') || has('希望更加直接')) {
    addTo(suggestion.preferred_style, '直接给出结论和因果关系，减少过渡性铺垫');
    notes.push('已建议：偏好风格中加入「更直接」');
  }
  if (has('小标题')) {
    addTo(suggestion.disliked_style, '过多的小标题和结构化切分');
    notes.push('已建议：不喜欢风格中加入「过多小标题」');
  }
  if (text.trim()) {
    const extra = `来自《book feedback》的原始反馈：${text.trim().slice(0, 2000)}`;
    suggestion.custom_instructions = [suggestion.custom_instructions, extra].filter(Boolean).join('\n').slice(0, 20000);
    notes.push('已建议：把原始反馈追加到自定义要求');
  }

  return { profile: suggestion, notes, changed: JSON.stringify(suggestion) !== JSON.stringify(p) };
}

function addTo(list, value) {
  if (!list.includes(value)) list.push(value);
}
