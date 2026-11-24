/**
 * OpenAI-compatible LLM 客户端。
 *
 * 只用 Node 内置 fetch，无第三方 SDK —— 这样任何「OpenAI 兼容」服务
 * （OpenAI / DeepSeek / OpenRouter / SiliconFlow / SuperGPT / Ollama / 中转 API）
 * 都能直接用，用户填 Base URL + Key + Model 即可。
 *
 * 稳定性要求（需求第十九节）：
 *  - 429 / 5xx / 网络错误自动指数退避重试；
 *  - 尊重 Retry-After；
 *  - 支持 AbortSignal，可被 Pause 立刻打断；
 *  - 失败的调用抛 LlmError，带 retryable 标记。
 */

import { LlmError, AbortedError } from '../util/errors.js';
import { sleep } from '../util/fsx.js';
import { effectiveApiKey } from '../config/providers.js';

/**
 * @typedef {Object} ChatMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} ChatOptions
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {number} [temperature]
 * @property {number} [topP]
 * @property {number} [maxTokens]
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]
 * @property {number} [retryBaseDelayMs]
 * @property {AbortSignal} [signal]
 * @property {(info: object) => void} [onRetry]
 * @property {object} [extraBody]
 */

/**
 * 生成请求 body。
 *
 * reasoning_effort 说明（踩过的坑）：
 *   像 deepseek-flash 这类**推理模型**默认会先输出思维链，而思维链 token
 *   也算在 max_tokens 里。如果 max_tokens 给小了（例如连通性测试只给 32），
 *   额度会被思考吃光，正文一个字都没输出就 finish_reason=length。
 *   对「忠实改写」这种任务，长思考既没必要也很贵（思维链按输出计费），
 *   所以本项目默认传 "none" 关掉它。
 *
 *   某些服务商不认这个参数会返回 400，调用方需要能降级（见 chatCompletion）。
 */
export function buildRequestBody(messages, options) {
  const body = {
    model: options.model,
    messages,
    temperature: options.temperature ?? 0.3,
    stream: false,
  };

  if (options.topP !== undefined && options.topP !== null && options.topP !== 1) {
    body.top_p = options.topP;
  }
  if (options.maxTokens) body.max_tokens = options.maxTokens;

  // none 表示关闭思考；空字符串/undefined 表示不干预，用服务端默认
  if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;

  return { ...body, ...(options.extraBody || {}) };
}

/** 服务端因为不认识某个参数而报错时用得上（例如老网关不认 reasoning_effort）。 */
function isUnsupportedParamError(err) {
  if (!(err instanceof LlmError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /reasoning_effort|thinking|unrecognized|unknown|unsupported|invalid.*param/i.test(err.message);
}

/**
 * 发起一次 chat completion。
 * @param {ChatMessage[]} messages
 * @param {ChatOptions} options
 * @returns {Promise<{text: string, usage: object, model: string, finishReason: string, truncated: boolean, raw: object}>}
 */
export async function chatCompletion(messages, options) {
  const url = buildChatUrl(options.baseUrl);
  const maxRetries = options.maxRetries ?? 3;
  const retryBase = options.retryBaseDelayMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 300000;

  let attempt = 0;
  /** @type {Error|null} */
  let lastError = null;
  /** 被 max_tokens 截断时，一次调用内把额度加倍重试（上限 4 倍）。 */
  let maxTokens = options.maxTokens;
  let reasoningEffort = options.reasoningEffort;

  for (;;) {
    if (options.signal?.aborted) throw new AbortedError();
    attempt += 1;
    try {
      return await once(messages, { ...options, url, timeoutMs, maxTokens, reasoningEffort });
    } catch (err) {
      lastError = err;

      // 情况 A：服务端不认识 reasoning_effort —— 去掉这个参数重试一次
      if (reasoningEffort && isUnsupportedParamError(err)) {
        options.onRetry?.({ attempt, maxRetries, reason: '该服务端不支持 reasoning_effort，已去掉该参数重试' });
        reasoningEffort = undefined;
        attempt -= 1; // 这不算一次"失败重试"，不该消耗重试额度
        continue;
      }

      // 情况 B：输出被 max_tokens 截断 —— 加倍额度重试，比让用户自己去猜有用得多
      if (err instanceof LlmError && err.code === 'TRUNCATED_EMPTY' && maxTokens && attempt <= maxRetries) {
        const next = Math.min(maxTokens * 4, 32768);
        if (next > maxTokens) {
          options.onRetry?.({
            attempt,
            maxRetries,
            reason: `输出被 max_tokens=${maxTokens} 截断（推理模型会先消耗思考额度），自动提高到 ${next} 重试`,
          });
          maxTokens = next;
          continue;
        }
      }

      const retryable = err instanceof LlmError ? err.retryable : false;
      if (!retryable || attempt > maxRetries) throw err;
      const wait = err.retryAfterMs ?? Math.min(60000, retryBase * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 400);
      options.onRetry?.({ attempt, maxRetries, waitMs: wait + jitter, error: err.message });
      await sleep(wait + jitter);
    }
  }
}

async function once(messages, options) {
  const { url, signal } = options;
  const body = buildRequestBody(messages, options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  const onAbort = () => controller.abort(new Error('user-abort'));
  signal?.addEventListener('abort', onAbort, { once: true });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(options),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw new AbortedError();
    if (err?.name === 'AbortError') {
      throw new LlmError(`请求超时（${Math.round(options.timeoutMs / 1000)}s）`, {
        code: 'TIMEOUT',
        retryable: true,
        cause: err,
      });
    }
    throw new LlmError(describeNetworkError(err, url), {
      code: 'NETWORK',
      retryable: true,
      cause: err,
    });
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);

  const text = await response.text();

  if (!response.ok) {
    const detail = extractErrorDetail(text);
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    const retryable = response.status === 429 || response.status >= 500 || response.status === 408;
    throw new LlmError(
      `API 返回 ${response.status}${detail ? `：${detail}` : ''}`,
      {
        code: `HTTP_${response.status}`,
        status: response.status,
        retryable,
        retryAfterMs: retryAfter,
      },
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError(`API 返回的不是 JSON（前 200 字符）：${text.slice(0, 200)}`, {
      code: 'BAD_JSON',
      retryable: true,
    });
  }

  const choice = json?.choices?.[0];
  const content =
    choice?.message?.content ??
    choice?.text ??
    (typeof choice?.delta?.content === 'string' ? choice.delta.content : null) ??
    json?.output_text ??
    '';
  const finishReason = choice?.finish_reason || '';

  if (typeof content !== 'string' || content.trim() === '') {
    // finish_reason=length 表示「输出被 max_tokens 截断」。
    // 这种情况重试多少次都是同样结果（上限没变），所以标记为不可重试，
    // 并直接告诉用户该改什么——否则只会看到一句没头没脑的「返回了空内容」。
    if (finishReason === 'length') {
      const reasoning = json?.usage?.completion_tokens_details?.reasoning_tokens;
      throw new LlmError(
        '模型在输出第一个字之前就撞上了 max_tokens 上限（finish_reason=length），没有产生任何可用内容。' +
          '常见原因：max_tokens 设得太小；这个模型把额度先用在思维链上' +
          (reasoning ? `（本次思考就用了约 ${reasoning} tokens）` : '') +
          '；或者任务本身要求的输出太长（例如让它把整份 JSON 重新抄回来）。' +
          '处理：调大该 Provider 的 Max tokens，或换一个不先做长思考的模型。',
        { code: 'TRUNCATED_EMPTY', status: 502, retryable: false },
      );
    }
    throw new LlmError(`API 返回了空内容（finish_reason=${finishReason || 'unknown'}）`, {
      code: 'EMPTY_CONTENT',
      retryable: true,
    });
  }

  return {
    text: content,
    usage: normalizeUsage(json.usage),
    model: json.model || options.model,
    finishReason,
    truncated: finishReason === 'length',
    raw: json,
  };
}

/**
 * 把 Node 的底层网络错误翻译成用户能照着修的中文提示。
 *
 * Node 的 fetch 只会给一句 `fetch failed`，真正的原因藏在 err.cause.code 里。
 * 直接把 `fetch failed` 显示在界面上等于没说，用户不知道该改什么。
 */
export function describeNetworkError(err, url) {
  const code = err?.cause?.code || err?.code || '';
  const target = safeHostOf(url);

  const map = {
    ECONNREFUSED: `连接被拒绝（${target}）。请确认服务已启动，且 Base URL 和端口正确。`,
    ENOTFOUND: `无法解析域名（${target}）。请检查 Base URL 是否写错，或本机 DNS 是否正常。`,
    EAI_AGAIN: `DNS 查询超时（${target}）。请检查网络连接。`,
    ECONNRESET: `连接被重置（${target}）。可能是代理或服务端中断了连接。`,
    ETIMEDOUT: `连接超时（${target}）。请检查网络，或把设置里的 Timeout 调大。`,
    EHOSTUNREACH: `网络不可达（${target}）。`,
    ENETUNREACH: `网络不可达（${target}）。`,
    UND_ERR_CONNECT_TIMEOUT: `连接超时（${target}）。`,
    CERT_HAS_EXPIRED: `TLS 证书已过期（${target}）。`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `TLS 证书是自签名的，未被信任（${target}）。`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `无法验证 TLS 证书（${target}）。`,
  };

  if (map[code]) return map[code];
  if (!code) return `无法连接到 API（${target}）：${err?.message || '未知错误'}`;
  return `网络错误 ${code}（${target}）：${err?.message || ''}`.trim();
}

function safeHostOf(url) {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return String(url || '');
  }
}

function buildHeaders(options) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const key = options.apiKey || '';
  if (key) headers.authorization = `Bearer ${key}`;
  // OpenRouter 建议带来源标识（无害，其他服务会忽略）
  headers['http-referer'] = 'http://localhost/personal-book-editor';
  headers['x-title'] = 'Personal Book Editor';
  // opencode.ai 的 zen/go 网关要求 x-opencode-session（内容不校验，缺失则 400 MissingSessionID）
  if (isOpencodeGateway(options.url || options.baseUrl)) {
    headers['x-opencode-session'] = 'personal-book-editor';
  }
  return headers;
}

/** 判断是否 opencode.ai 的网关地址。 */
function isOpencodeGateway(url) {
  try {
    return /(^|\.)opencode\.ai$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function buildChatUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new LlmError('缺少 Base URL', { code: 'NO_BASE_URL' });
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/* ------------------------------------------------------- 体积预算 -- */

/**
 * 粗略估算 token 数。
 *
 * 中文大致 1 字 ≈ 1 token（BPE 对汉字的压缩率接近 1:1），
 * 英文大致 4 字符 ≈ 1 token。取两者较大值做保守估计。
 * 目的不是精确计费，而是**在请求发出去之前发现明显超限**。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 3.5);
}

/**
 * 默认的输入体积上限（字符数）。
 *
 * 大多数主流模型上下文在 32k~200k token 之间，
 * 取 60k 字符作为保守默认值：中文下约等于 60k token，
 * 留足空间给 system prompt 与输出。
 */
export const DEFAULT_MAX_INPUT_CHARS = 60000;

/**
 * 检查一次调用是否会超限。
 * @param {ChatMessage[]} messages
 * @param {{maxInputChars?: number, maxOutputTokens?: number}} [opts]
 * @returns {{ok: boolean, chars: number, tokens: number, limit: number, message?: string}}
 */
export function checkPromptBudget(messages, opts = {}) {
  const chars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
  const tokens = estimateTokens(messages.map((m) => m.content).join('\n'));

  // 上限为 0 / 负数 / 未设置时表示不限制
  const configured = opts.maxInputChars;
  const limit = configured === undefined || configured === null
    ? DEFAULT_MAX_INPUT_CHARS
    : Number(configured);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: true, chars, tokens, limit: 0 };
  }

  if (chars > limit) {
    return {
      ok: false,
      chars,
      tokens,
      limit,
      message:
        `本次请求输入约 ${chars} 字符（≈${tokens} tokens），超过该 Provider 的输入上限 ${limit} 字符。` +
        `请在设置页把「每 chunk 最大字符数」调小，或精简 Reader Profile，` +
        `也可以调大 Provider 的「输入上限」。`,
    };
  }
  return { ok: true, chars, tokens, limit };
}

function extractErrorDetail(text) {
  if (!text) return '';
  try {
    const json = JSON.parse(text);
    const message = json?.error?.message || json?.message || json?.error || '';
    if (typeof message === 'string') return message.slice(0, 400);
    return JSON.stringify(message).slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(120000, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(120000, date - Date.now()));
  return undefined;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}

/**
 * 用 provider 配置跑一次「连通性测试」。
 *
 * 两个坑都踩过：
 *  1. max_tokens 只给 32：推理模型（deepseek-flash 等）会先消耗思考额度，
 *     结果正文没开始输出就被截断（finish_reason=length），
 *     用户看到的是「连接失败」，但密钥其实是好的。
 *  2. 不同服务商对 reasoning_effort 的支持不一致，有的会直接 400。
 *
 * 所以这里：默认关掉思考 + 给足额度；两种策略都失败才报错。
 *
 * @param {object} provider
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function testProvider(provider, opts = {}) {
  const started = Date.now();
  const messages = [
    { role: 'system', content: '你是一个连通性测试端点。' },
    { role: 'user', content: '请只回复两个字：可用' },
  ];
  const base = {
    baseUrl: provider.baseUrl,
    apiKey: effectiveApiKey(provider),
    model: provider.model,
    temperature: 0,
    // 给推理模型留出思考空间：它可能先烧掉几百 tokens 才开始回答
    maxTokens: 2048,
    timeoutMs: Math.min(provider.timeoutMs || 60000, 90000),
    maxRetries: 1,
    signal: opts.signal,
  };

  let result;
  let effort = provider.reasoningEffort;
  try {
    result = await chatCompletion(messages, { ...base, reasoningEffort: effort });
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    // 关思考失败（服务端不认这个参数 / 或额度依然不够）=> 放开思考并加大额度再试一次
    if (effort) {
      result = await chatCompletion(messages, { ...base, maxTokens: 8192, reasoningEffort: '' });
      effort = '';
    } else {
      throw err;
    }
  }

  return {
    ok: true,
    latencyMs: Date.now() - started,
    model: result.model,
    sample: result.text.slice(0, 80),
    usage: result.usage,
    reasoningEffort: effort || '(服务端默认)',
    truncated: Boolean(result.truncated),
  };
}

/**
 * 从模型输出里稳健地抽出 JSON（容忍代码块围栏和前后废话）。
 * @param {string} text
 */
export function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    // 退化为「找第一个 { 到最后一个 }」
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    throw new LlmError('模型输出不是合法 JSON', { code: 'BAD_JSON', retryable: true });
  }
}
