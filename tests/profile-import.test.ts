import { describe, expect, it } from 'vitest';
import { mergeParsedProfile, parseProfilePaste } from '@/lib/profile-import';

/**
 * 阅读画像的「粘贴 AI 回答」解析器。
 *
 * 这些断言锁的是产品承诺：用户照提示词发给 ChatGPT / Gemini，把回答整段
 * 粘回来，字段就该自动填好。模型不会每次都一模一样地输出，所以这里既测标准
 * 格式，也测几种常见的跑偏写法（中文小标题、JSON、冒号写法、空区块）。
 */
describe('parseProfilePaste', () => {
  const chatGptAnswer = [
    '好的，下面是根据我对你的了解整理的阅读画像：',
    '',
    '### about_me',
    '你在做独立开发，主要精力放在交易工具和内容站上。',
    '每天能读书的时间大约 40 分钟，多在晚上。',
    '',
    '### reading_goal',
    '把论证看明白，能讲给朋友听。',
    '',
    '### preferred_style',
    '- 先给结论，再讲论证',
    '- 多用生活里的比喻',
    '- 关键概念第一次出现时给英文原词',
    '',
    '### disliked_style',
    '- 堆砌术语',
    '- 空洞的鸡汤',
    '',
    '### known_topics',
    '- 编程',
    '- 交易',
    '',
    '### weak_topics',
    '- 宏观经济学',
    '',
    '### explanation_preferences',
    '1. 先给一句话总结',
    '2. 再展开细节',
    '',
    '### language_preferences',
    '- 简体中文，少夹英文',
    '',
    '### custom_instructions',
    '表格和数字尽量保留原样。',
    '',
    '希望这份画像对你有帮助！',
  ].join('\n');

  it('reads the exact format the on-page prompt asks for', () => {
    const parsed = parseProfilePaste(chatGptAnswer);
    expect(parsed.about_me).toBe(
      '你在做独立开发，主要精力放在交易工具和内容站上。\n每天能读书的时间大约 40 分钟，多在晚上。',
    );
    expect(parsed.reading_goal).toBe('把论证看明白，能讲给朋友听。');
    expect(parsed.preferred_style).toEqual([
      '先给结论，再讲论证',
      '多用生活里的比喻',
      '关键概念第一次出现时给英文原词',
    ]);
    expect(parsed.disliked_style).toEqual(['堆砌术语', '空洞的鸡汤']);
    expect(parsed.known_topics).toEqual(['编程', '交易']);
    expect(parsed.weak_topics).toEqual(['宏观经济学']);
    expect(parsed.explanation_preferences).toEqual(['先给一句话总结', '再展开细节']);
    expect(parsed.language_preferences).toEqual(['简体中文，少夹英文']);
    expect(parsed.custom_instructions).toBe('表格和数字尽量保留原样。');
  });

  it('ignores the greeting and closing the model adds on its own', () => {
    const parsed = parseProfilePaste(chatGptAnswer);
    expect(parsed.about_me).not.toContain('下面是');
    expect(parsed.custom_instructions).not.toContain('希望这份画像');
  });

  it('accepts Chinese bracket headings and inline colon values', () => {
    const parsed = parseProfilePaste([
      '【关于我】',
      '产品经理，读书时间零散。',
      '【阅读目标】：建立完整的判断框架。',
      '【喜欢的表达方式】',
      '、 结论先行',
      '、 举例具体',
    ].join('\n'));
    expect(parsed.about_me).toBe('产品经理，读书时间零散。');
    expect(parsed.reading_goal).toBe('建立完整的判断框架。');
    expect(parsed.preferred_style).toEqual(['结论先行', '举例具体']);
  });

  it('accepts the short Chinese headings a model writes when it paraphrases', () => {
    const parsed = parseProfilePaste([
      '【关于我】',
      '后端工程师，晚上读书。',
      '【阅读目的】',
      '把方法用在自己的项目里。',
      '【喜欢的表达】',
      '- 先说结论',
      '【不喜欢的表达】',
      '- 术语堆砌',
      '【薄弱领域】',
      '- 微观经济学',
      '【解释偏好】',
      '- 多用比喻',
      '【用词偏好】',
      '- 少夹英文',
      '【自定义指令】',
      '- 保留原文例子',
    ].join('\n'));
    expect(parsed.about_me).toBe('后端工程师，晚上读书。');
    expect(parsed.reading_goal).toBe('把方法用在自己的项目里。');
    expect(parsed.preferred_style).toEqual(['先说结论']);
    expect(parsed.disliked_style).toEqual(['术语堆砌']);
    expect(parsed.weak_topics).toEqual(['微观经济学']);
    expect(parsed.explanation_preferences).toEqual(['多用比喻']);
    expect(parsed.language_preferences).toEqual(['少夹英文']);
    expect(parsed.custom_instructions).toBe('保留原文例子');
  });

  it('recognises localized labels from the current interface language', () => {
    const parsed = parseProfilePaste([
      '読者プロフィール',
      '### 読書ゴール',
      '小説の背景を理解したい。',
      '### 好きな表現',
      '- 具体例が豊富',
    ].join('\n'), {
      about_me: '読者プロフィール',
      reading_goal: '読書ゴール',
      preferred_style: '好きな表現',
    });
    expect(parsed.reading_goal).toBe('小説の背景を理解したい。');
    expect(parsed.preferred_style).toEqual(['具体例が豊富']);
  });

  it('falls back to JSON when the model ignores the marker format', () => {
    const parsed = parseProfilePaste([
      '```json',
      '{',
      '  "about_me": "后端工程师。",',
      '  "preferred_style": ["先给例子", "少用行话"],',
      '  "unknown_field": "ignored"',
      '}',
      '```',
    ].join('\n'));
    expect(parsed.about_me).toBe('后端工程师。');
    expect(parsed.preferred_style).toEqual(['先给例子', '少用行话']);
    expect(Object.keys(parsed).sort()).toEqual(['about_me', 'preferred_style']);
  });

  it('drops empty sections, placeholder echoes and duplicate items', () => {
    const parsed = parseProfilePaste([
      '### about_me',
      '（用 100–250 字介绍我的背景、职业、知识水平）',
      '### reading_goal',
      '无',
      '### preferred_style',
      '- 结论先行',
      '- 结论先行',
      '- （例如：先给结论再讲论证）',
      '- N/A',
    ].join('\n'));
    expect(parsed.about_me).toBeUndefined();
    expect(parsed.reading_goal).toBeUndefined();
    expect(parsed.preferred_style).toEqual(['结论先行']);
  });

  it('splits a one-line list on Chinese list separators but not on commas inside a phrase', () => {
    const parsed = parseProfilePaste([
      '### preferred_style',
      '结论先行；举例具体、少用术语',
      '### known_topics',
      '- 编程, 交易',
    ].join('\n'));
    expect(parsed.preferred_style).toEqual(['结论先行', '举例具体', '少用术语']);
    expect(parsed.known_topics).toEqual(['编程, 交易']);
  });

  it('does not mistake prose that starts with a field label for a heading', () => {
    const parsed = parseProfilePaste([
      '### about_me',
      '关于我的家庭，我在一个小镇长大，家里人都爱读书。',
      '我喜欢的表达方式是那种把结论放在最前面的写法，但这一行是正文。',
    ].join('\n'));
    expect(parsed.about_me).toBe(
      '关于我的家庭，我在一个小镇长大，家里人都爱读书。\n我喜欢的表达方式是那种把结论放在最前面的写法，但这一行是正文。',
    );
    expect(parsed.preferred_style).toBeUndefined();
  });

  it('drops code fences when the model wraps its whole answer in markdown', () => {
    const parsed = parseProfilePaste([
      '```markdown',
      '### about_me',
      '后端工程师。',
      '### preferred_style',
      '- 先说结论',
      '### custom_instructions',
      '保留原书表格。',
      '```',
    ].join('\n'));
    expect(parsed.about_me).toBe('后端工程师。');
    expect(parsed.preferred_style).toEqual(['先说结论']);
    expect(parsed.custom_instructions).toBe('保留原书表格。');
    expect(JSON.stringify(parsed)).not.toContain('```');
  });

  it('drops a placeholder line that sits above real content', () => {
    const parsed = parseProfilePaste([
      '### about_me',
      '（用 100–250 字介绍我的背景、职业、知识水平）',
      '我是后端工程师，晚上读书。',
    ].join('\n'));
    expect(parsed.about_me).toBe('我是后端工程师，晚上读书。');
  });

  it('ends a section at a heading the prompt did not ask for', () => {
    const parsed = parseProfilePaste([
      '### about_me',
      '我是后端工程师。',
      '### 备注',
      '请保留原书表格。',
      '### preferred_style',
      '- 先说结论',
    ].join('\n'));
    expect(parsed.about_me).toBe('我是后端工程师。');
    expect(parsed.preferred_style).toEqual(['先说结论']);
    expect(JSON.stringify(parsed)).not.toContain('备注');
    expect(JSON.stringify(parsed)).not.toContain('请保留原书表格');
  });

  it('treats an empty answer with punctuation as empty', () => {
    const parsed = parseProfilePaste([
      '### reading_goal',
      '无。',
      '### weak_topics',
      '暂无！',
    ].join('\n'));
    expect(parsed.reading_goal).toBeUndefined();
    expect(parsed.weak_topics).toBeUndefined();
  });

  it('keeps the instruction that follows a sign-off in the same line', () => {
    const parsed = parseProfilePaste([
      '### custom_instructions',
      '希望这份画像对你有帮助！另外，请保留原书表格。',
    ].join('\n'));
    expect(parsed.custom_instructions).toBe('另外，请保留原书表格。');
  });

  it('returns nothing for text it cannot recognise instead of guessing', () => {
    expect(parseProfilePaste('这是一段随便写的话，没有字段。')).toEqual({});
    expect(parseProfilePaste('')).toEqual({});
    expect(parseProfilePaste('   \n  ')).toEqual({});
  });
});

describe('mergeParsedProfile', () => {
  const existing = {
    about_me: '旧的自我介绍',
    reading_goal: '',
    preferred_style: ['旧偏好'],
    disliked_style: [],
    known_topics: [],
    weak_topics: [],
    explanation_preferences: [],
    language_preferences: [],
    custom_instructions: '',
  };

  it('replaces only the fields present in the paste', () => {
    const { profile, fields } = mergeParsedProfile(existing, {
      about_me: '新的自我介绍',
      preferred_style: ['新偏好'],
    });
    expect(profile.about_me).toBe('新的自我介绍');
    expect(profile.preferred_style).toEqual(['新偏好']);
    // 没出现在粘贴里的字段保持原样，用户手填的内容不会被清掉。
    expect(profile.known_topics).toEqual([]);
    expect(profile.custom_instructions).toBe('');
    expect(fields.sort()).toEqual(['about_me', 'preferred_style']);
  });

  it('does not count empty values as imported', () => {
    const { profile, fields } = mergeParsedProfile(existing, { about_me: '', preferred_style: [] });
    expect(fields).toEqual([]);
    expect(profile.about_me).toBe('旧的自我介绍');
    expect(profile.preferred_style).toEqual(['旧偏好']);
  });
});
