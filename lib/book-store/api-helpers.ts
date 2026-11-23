import 'server-only';

/**
 * 书籍 API 的公共外壳：登录校验、用户上下文、错误 → JSON、文件下载。
 *
 * 原项目是本地单人使用，没有登录；这里每个请求都必须先拿到 Better Auth
 * 会话，再把整段处理放进该用户的书柜上下文里（withBookUser）——
 * 引擎的所有路径都从上下文推出来，绝不能在没有用户的情况下跑。
 */

import { auth } from '@/lib/auth';
import { AppError } from '@/lib/book-engine/util/errors.js';
import { resolveToolAccess } from '@/lib/subscription/access';
import { withBookUser } from './storage';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export { privateHeaders };

/** 把任意错误变成统一 JSON：`{ error: { code, message } }`（与原项目一致）。 */
export function bookErrorResponse(error: unknown): Response {
  const err = error as { status?: unknown; code?: unknown; message?: unknown; expose?: unknown; stack?: unknown };
  const status = typeof err?.status === 'number' && Number.isInteger(err.status) ? err.status : 500;
  const expose = error instanceof AppError || err?.expose === true;
  const payload = {
    error: {
      code: typeof err?.code === 'string' ? err.code : 'INTERNAL',
      message: expose && typeof err?.message === 'string' ? err.message : '服务器内部错误',
      ...(expose ? {} : { detail: String(err?.stack || error).slice(0, 4000) }),
    },
  };
  if (status >= 500) console.error('[book-api]', error);
  return Response.json(payload, { status, headers: privateHeaders });
}

/**
 * 安全地把值转成 JSON（从原项目 http-util.js 移植）。
 *
 * DOM 节点带 parentNode 反向引用（循环结构），一旦混进响应体，
 * JSON.stringify 直接抛错、接口 500 而调用方完全看不出原因。
 * 这里统一兜一道：剔除 DOM 内部字段，极端情况下退化为字符串。
 */
function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    try {
      return JSON.stringify(data, (key, value) => {
        if (key === 'parentNode' || key === 'source' || key === 'children') return undefined;
        if (value && typeof value === 'object' && (value as { kind?: unknown }).kind !== undefined) {
          const node = value as { kind: number; name?: string; value?: string };
          if (node.kind === 2) return `<${node.name}>`;
          if (node.kind === 3) return String(node.value ?? '');
          return `[node:${node.kind}]`;
        }
        return value;
      });
    } catch {
      return JSON.stringify({ error: { code: 'SERIALIZE', message: '响应体无法序列化' } });
    }
  }
}

/**
 * 所有书籍接口的入口包装：未登录 401，没有有效订阅 402，其余在用户上下文里执行。
 * handler 返回值会按 JSON 输出（除非它自己返回了 Response）。
 *
 * 订阅检查放在这一层，而不是散在各 route 里：新增一个书籍接口时忘了加门槛，
 * 就会再出现「没开订阅也能整本书跑完」的漏洞。判定规则见 `lib/subscription/access.ts`。
 */
export async function withBookApi(
  request: Request,
  handler: (userId: string) => Promise<Response | unknown>,
): Promise<Response> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      throw new AppError('未登录', { code: 'UNAUTHORIZED', status: 401 });
    }
    const access = await resolveToolAccess(session.user);
    if (!access.allowed) {
      throw new AppError('需要订阅后才能使用书库和改写功能', {
        code: 'SUBSCRIPTION_REQUIRED',
        status: 402,
      });
    }
    const userId = session.user.id;
    const result = await withBookUser(userId, () => handler(userId));
    if (result instanceof Response) return result;
    return new Response(safeStringify(result), {
      headers: { ...privateHeaders, 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (error) {
    return bookErrorResponse(error);
  }
}

/**
 * 改数据的请求必须来自本站页面（CSRF 防护，与底座其他接口同一做法）。
 * GET/HEAD 不检查：浏览器导航本来就不带 Origin。
 */
export function assertSameOrigin(request: Request): void {
  const expected = new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
  if (request.headers.get('origin') !== expected) {
    throw new AppError('请求来源不可信', { code: 'INVALID_ORIGIN', status: 403 });
  }
}

/** 章节序号：必须是正整数（与原项目一致）。 */
export function parseChapterIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new AppError('章节序号必须是正整数', { code: 'VALIDATION', status: 400 });
  }
  return n;
}

/** 读取 JSON 请求体（带 8MB 上限，与原项目一致）。 */
export async function readJsonBody<T = Record<string, unknown>>(request: Request, maxBytes = 8 * 1024 * 1024): Promise<T> {
  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new AppError(`请求体过大（上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`, {
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
  }
  const text = buffer.toString('utf8').trim();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AppError(`请求体不是合法 JSON：${(err as Error).message}`, { code: 'BAD_JSON', status: 400 });
  }
}

/** 读取原始请求体（上传 EPUB 用，上限 200MB）。 */
export async function readRawBody(request: Request, maxBytes = 200 * 1024 * 1024): Promise<Buffer> {
  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new AppError(`文件过大（上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`, {
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
  }
  return buffer;
}

/**
 * Content-Disposition 的 ASCII 兜底名（从原项目 http-util.js 移植）。
 *
 * 现代浏览器优先用 `filename*=UTF-8''...`，兜底名基本看不到；
 * 但绝对不能放 `: ? *` 这类 Windows 非法字符。
 */
export function asciiFallbackName(fileName: string): string {
  const raw = String(fileName);
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '');

  const ext = /\.epub$/i.test(raw) ? '.epub' : '';
  const stem = (ext ? cleaned.replace(/\.epub$/i, '') : cleaned).replace(/^[.\s_-]+|[.\s_-]+$/g, '');
  if (stem.replace(/[^A-Za-z0-9]/g, '').length < 3) return `download${ext}`;
  return `${stem.slice(0, 150)}${ext}`;
}

/** 文件下载响应（EPUB 等二进制）。 */
export function fileResponse(
  buffer: Buffer,
  opts: { contentType?: string; fileName?: string; download?: boolean; status?: number } = {},
): Response {
  const headers: Record<string, string> = {
    'content-type': opts.contentType || 'application/octet-stream',
    'content-length': String(buffer.length),
    'cache-control': 'no-store',
    ...privateHeaders,
  };
  if (opts.fileName) {
    const ascii = asciiFallbackName(opts.fileName);
    headers['content-disposition'] =
      `${opts.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`;
  }
  const body = new Uint8Array(buffer);
  return new Response(body, { status: opts.status ?? 200, headers });
}
