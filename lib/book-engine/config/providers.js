/**
 * API Provider 配置（OpenAI-compatible）。
 *
 * 需求第十一节：Provider Name / Base URL / API Key / Model / Max tokens / Temperature。
 * API Key 只保存在本地 config/providers.json，不上传任何第三方服务器。
 * 对外（HTTP API）返回时永远打码，只暴露 hasApiKey / apiKeyPreview。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { readJson, writeJson, readText, exists } from '../util/fsx.js';
import { configDir } from './settings.js';

/** 常见服务商预设，方便用户一键选择。 */
export const PROVIDER_PRESETS = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    docs: 'https://platform.openai.com/docs/api-reference',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    docs: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3.5-sonnet',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    docs: 'https://openrouter.ai/docs',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    docs: 'https://docs.siliconflow.cn/',
  },
  {
    // SuperGPT 的多模型中转：OpenAI 兼容协议用 https://api.supergpt.dev/v1
    // 作为 Base URL（客户端会自动补 /chat/completions）。
    // 模型以密钥所属分组为准，这里只是主分组的常用默认值。
    id: 'supergpt',
    name: 'SuperGPT',
    baseUrl: 'https://api.supergpt.dev/v1',
    model: 'gpt-5.6-terra',
    apiKeyEnv: 'SUPERGPT_API_KEY',
    docs: 'https://console.supergpt.dev/help/clients',
  },
  {
    id: 'ollama',
    name: '本地模型 (Ollama)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:14b',
    apiKeyEnv: '',
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
  },
  {
    id: 'lmstudio',
    name: '本地模型 (LM Studio)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    apiKeyEnv: '',
    docs: 'https://lmstudio.ai/docs/local-server',
  },
  {
    id: 'custom',
    name: '自定义 / 中转 API',
    baseUrl: '',
    model: '',
    apiKeyEnv: '',
    docs: '',
  },
];

export function blankProviders() {
  return { activeId: null, providers: [] };
}

export function providersPath(root) {
  return path.join(configDir(root), 'providers.json');
}

function newId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 规范化单个 provider。 */
export function normalizeProvider(input, existing = null) {
  const src = input && typeof input === 'object' ? input : {};
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const provider = {
    id: typeof src.id === 'string' && src.id ? src.id : existing?.id || newId(),
    name: String(src.name ?? existing?.name ?? '未命名 Provider').slice(0, 100) || '未命名 Provider',
    baseUrl: String(src.baseUrl ?? existing?.baseUrl ?? '').trim().slice(0, 500),
    model: String(src.model ?? existing?.model ?? '').trim().slice(0, 200),
    apiKey: resolveApiKey(src, existing),
    apiKeyEnv: String(src.apiKeyEnv ?? existing?.apiKeyEnv ?? '').trim().slice(0, 100),
    maxTokens: num(src.maxTokens ?? existing?.maxTokens, 8000, 256, 200000),
    temperature: num(src.temperature ?? existing?.temperature, 0.3, 0, 2),
    timeoutMs: num(src.timeoutMs ?? existing?.timeoutMs, 300000, 5000, 3600000),
    topP: num(src.topP ?? existing?.topP, 1, 0, 1),
    // 单次请求的输入体积上限（字符）。Reader Profile 很长时，
    // 加上原文可能超出模型上下文；在这里设一个安全线，超了就提前报错。
    // 0 或负数表示不限制。
    maxInputChars: Math.round(
      num(src.maxInputChars ?? existing?.maxInputChars, 60000, 0, 2000000),
    ),
    /**
     * 思考模式（推理模型的思维链）。
     *
     * 默认 'none'（关闭），原因有两个：
     *  1. 思维链 token 算在 max_tokens 里。额度不够时模型会「想完就没了」，
     *     正文一个字都不输出（finish_reason=length）。deepseek-flash 这类
     *     推理模型默认就会思考，连通性测试只给 32 tokens 时必然踩到。
     *  2. 思维链按输出计费。本书改写是「忠实重述」而不是解数学题，
     *     长思考既没必要，还会让成本成倍上升。
     *
     * 可选值：'' 不干预（用服务端默认）/ 'none' / 'low' / 'medium' / 'high'
     */
    reasoningEffort: normalizeReasoningEffort(src.reasoningEffort ?? existing?.reasoningEffort),
    presetId: String(src.presetId ?? existing?.presetId ?? '').slice(0, 50),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTest: existing?.lastTest || null,
  };
  return provider;
}

/** 允许的思考档位。未知值一律退回默认的 none。 */
export const REASONING_EFFORTS = ['', 'none', 'low', 'medium', 'high'];

export function normalizeReasoningEffort(value) {
  if (value === undefined || value === null) return 'none';
  const v = String(value).trim().toLowerCase();
  return REASONING_EFFORTS.includes(v) ? v : 'none';
}

/** apiKey 语义：undefined = 保持不变；'' = 清除；其他 = 设置。 */
function resolveApiKey(src, existing) {
  if (!Object.prototype.hasOwnProperty.call(src, 'apiKey')) return existing?.apiKey || '';
  const value = src.apiKey;
  if (value === undefined || value === null) return existing?.apiKey || '';
  if (value === '__KEEP__') return existing?.apiKey || '';
  if (value === '__CLEAR__') return '';
  return String(value).slice(0, 4000);
}

/**
 * 生成给前端看的打码版本。
 *
 * 安全要求：**任何长度的 Key 都不能在预览里泄露**。
 * 早期实现用 `${key.slice(0,4)}***${key.slice(-4)}`，
 * 结果 10 位以内的 Key（`sk-smoke`、`test`）会原样输出。
 * 现在最多只暴露 4 位，且 Key 太短时全部打码。
 */
export function maskProvider(provider) {
  if (!provider) return null;
  const key = provider.apiKey || '';
  const envKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '';
  const effective = key || envKey;
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKeyEnv: provider.apiKeyEnv,
    maxTokens: provider.maxTokens,
    temperature: provider.temperature,
    timeoutMs: provider.timeoutMs,
    topP: provider.topP,
    maxInputChars: provider.maxInputChars,
    reasoningEffort: provider.reasoningEffort,
    presetId: provider.presetId,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    lastTest: provider.lastTest,
    hasApiKey: Boolean(effective),
    apiKeyPreview: previewOf(effective, key ? 'file' : envKey ? 'env' : 'none', provider.apiKeyEnv),
    apiKeySource: key ? 'file' : envKey ? 'env' : 'none',
  };
}

/** 生成安全的 Key 预览。 */
function previewOf(key, source, envName) {
  if (!key) return '';
  if (source === 'env') return `(环境变量 ${envName})`;
  const len = key.length;
  if (len <= 8) return '*'.repeat(len);
  if (len <= 12) return `${key.slice(0, 2)}${'*'.repeat(len - 4)}${key.slice(-2)}`;
  return `${key.slice(0, 4)}${'*'.repeat(Math.min(12, len - 8))}${key.slice(-4)}`;
}

export async function loadProviders(root) {
  const file = providersPath(root);
  if (!(await exists(file))) {
    const blank = blankProviders();
    await writeJson(file, blank);
    return blank;
  }
  const data = await readJson(file, blankProviders());
  return normalizeProvidersFile(data);
}

export function normalizeProvidersFile(data) {
  const src = data && typeof data === 'object' ? data : {};
  const providers = Array.isArray(src.providers)
    ? src.providers.filter((p) => p && typeof p === 'object').map((p) => normalizeProvider(p, p))
    : [];
  let activeId = typeof src.activeId === 'string' ? src.activeId : null;
  if (activeId && !providers.some((p) => p.id === activeId)) activeId = null;
  if (!activeId && providers.length) activeId = providers[0].id;
  return { activeId, providers };
}

export async function saveProviders(root, data) {
  const normalized = normalizeProvidersFile(data);
  await writeJson(providersPath(root), normalized);
  return normalized;
}

/**
 * 把当前 providers.json 备份一份。
 *
 * 为什么需要：这份文件存着用户的 API Key，而它**不在任何版本控制里**
 * （.gitignore 明确排除），一旦被覆盖就彻底找不回来。
 * 这真的发生过：一次调试时用测试用的 Provider 覆盖了用户配好的 DeepSeek，
 * 他的 Key 就此丢失，只能去后台重新生成一个。
 *
 * 备份带时间戳，永不被自动删除 —— 用户可以自己翻出来找回 Key。
 */
export async function backupProviders(root, reason = '') {
  const file = providersPath(root);
  if (!(await exists(file))) return null;
  try {
    const raw = await readText(file);
    const parsed = JSON.parse(raw);
    // 内容损坏或结构不对就不备份，免得覆盖掉有用的旧备份
    if (!Array.isArray(parsed?.providers) || parsed.providers.length === 0) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${file}.backup-${stamp}`;
    await writeJson(target, {
      ...parsed,
      _backupAt: new Date().toISOString(),
      _backupReason: reason,
    });
    return target;
  } catch {
    return null;
  }
}

/** 列出已有的备份，最近的在前（供用户手动找回 Key）。 */
export async function listProviderBackups(root) {
  const file = providersPath(root);
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((n) => n.startsWith(`${base}.backup-`))
      .sort()
      .reverse()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

export async function getProvider(root, id) {
  const data = await loadProviders(root);
  if (!id) return data.providers.find((p) => p.id === data.activeId) || null;
  return data.providers.find((p) => p.id === id) || null;
}

/** 解析出真正可用的 API Key（文件优先，其次环境变量）。 */
export function effectiveApiKey(provider) {
  if (!provider) return '';
  if (provider.apiKey) return provider.apiKey;
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv];
  return '';
}

/** 校验 provider 是否可用于调用。 */
export function validateProvider(provider, { requireKey = true } = {}) {
  const errors = [];
  if (!provider) return ['未选择 Provider'];
  if (!provider.baseUrl) errors.push('缺少 Base URL');
  else if (!/^https?:\/\//i.test(provider.baseUrl)) errors.push('Base URL 必须以 http:// 或 https:// 开头');
  if (!provider.model) errors.push('缺少 Model');
  if (requireKey && !effectiveApiKey(provider) && !isLocalProvider(provider)) {
    errors.push('缺少 API Key（本地模型可留空）');
  }
  return errors;
}

export function isLocalProvider(provider) {
  if (!provider?.baseUrl) return false;
  try {
    const url = new URL(provider.baseUrl);
    return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}
