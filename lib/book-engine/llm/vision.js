/**
 * 视觉模型：给一张书里的图片写「说明」。
 *
 * 用的还是同一个 OpenAI-compatible 客户端，只是 user message 的内容是
 * 多段数组（文本 + image_url），图片以 `data:` URL 内联发送 ——
 * 不依赖图床、不把用户的书写到第三方存储上。
 *
 * 说明的用途有两个：
 *  1. 改写时告诉模型「原文这里那张图是什么」，它才能在正文里说对；
 *  2. 图片本身不进正文，说明只作参考，提示词里明确要求不要抄。
 */

import { chatCompletion } from './client.js';
import { effectiveApiKey } from '../config/providers.js';

/** 说明的字数上限（settings.images.maxDescriptionChars 的默认值）。 */
export const DEFAULT_MAX_DESCRIPTION_CHARS = 500;

/**
 * 生成一段图片说明。
 *
 * @param {Object} args
 * @param {object} args.provider  OpenAI-compatible provider
 * @param {string} args.base64    图片字节的 base64
 * @param {string} args.mime      图片 MIME，如 image/png
 * @param {string} [args.label]   图号（表0-1 / 图2-3）
 * @param {string} [args.caption] 原书图注
 * @param {string} [args.alt]     原书 alt
 * @param {number} [args.maxChars] 说明字数上限
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{description: string, usage: object, model: string}>}
 */
export async function describeImage(args) {
  const provider = args.provider;
  if (!provider?.baseUrl || !provider?.model) {
    throw new Error('没有可用的视觉模型 Provider');
  }
  const maxChars = Math.max(80, Math.min(Number(args.maxChars) || DEFAULT_MAX_DESCRIPTION_CHARS, 2000));
  const label = String(args.label || '').trim();
  const caption = String(args.caption || '').trim();
  const alt = String(args.alt || '').trim();

  const hints = [
    label ? `图号：${label}` : '',
    caption ? `原书图注：${caption}` : '',
    alt ? `替代文本：${alt}` : '',
  ].filter(Boolean);

  const userText = [
    '这是一本书正文里的一张图片。请只根据图片本身写说明。',
    hints.length ? hints.join('\n') : '',
    `要求：\n- 用中文，不超过 ${maxChars} 字；\n- 说明图片类型（数据表 / 走势图 / 公式 / 照片 / 示意图 / 签名等）；\n- 写出图里的主要内容、图表坐标轴、关键数字和标签；\n- 看不清的地方直接说「看不清」，不要猜，也不要补充图片之外的信息。`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content:
        '你是书籍排版与图表识别助手。你的说明只用于帮助编辑理解图片，不会被印进书里。' +
        '只描述图片本身，不评价、不引申、不编造看不清的内容。',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: `data:${args.mime || 'image/jpeg'};base64,${args.base64}` } },
      ],
    },
  ];

  const result = await chatCompletion(messages, {
    baseUrl: provider.baseUrl,
    apiKey: effectiveApiKey(provider),
    model: provider.model,
    temperature: 0,
    maxTokens: Math.min(Number(provider.maxTokens) || 400, 800),
    timeoutMs: provider.timeoutMs,
    maxRetries: args.maxRetries ?? 1,
    signal: args.signal,
  });

  const description = String(result.text || '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
    .slice(0, maxChars);
  if (!description) throw new Error('视觉模型返回了空说明');
  return { description, usage: result.usage, model: result.model || provider.model };
}

/** 判断一个错误是不是「这个模型根本不支持图片输入」。 */
export function isVisionUnsupportedError(err) {
  const status = Number(err?.status);
  if (status !== 400 && status !== 422) return false;
  return /image|vision|content|multimodal|image_url/i.test(String(err?.message || ''));
}
