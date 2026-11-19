/**
 * 书籍编辑器前端用到的所有接口封装。
 *
 * 约定（与 app/api/** 一一对应）：
 *  - 成功返回 JSON 的 `data` 部分；失败一律抛 ApiError（带 code/status）。
 *  - 改数据的请求浏览器会自动带 Origin，服务端 assertSameOrigin 才放行；
 *    所以这里绝不能用 no-cors、也不能把它挪到别的域名。
 *  - 下载走浏览器直连（<a href>），不经过 fetch，才能触发浏览器的另存为。
 */

import DOMPurify from 'dompurify';

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    throw new ApiError('网络错误，请检查连接后重试', 'NETWORK', 0);
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      err?.message || `请求失败（HTTP ${response.status}）`,
      err?.code || 'HTTP_ERROR',
      response.status,
    );
  }
  return payload as T;
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ 类型 -- */

export type BookSummary = {
  bookId: string;
  title: string;
  authors?: string[];
  language?: string;
  chapterCount: number;
  sourceSize?: number;
  createdAt?: string;
  updatedAt?: string;
  warnings?: string[];
  progress: {
    total: number;
    completed: number;
    failed: number;
    processing: number;
    pending: number;
    skipped: number;
    rewritable: number;
    totalTokens: number;
    percent: number;
  };
  processed: null | {
    at: string | null;
    counts: Record<string, number>;
    renamed: number;
    reordered: boolean;
    notes?: { before: number; after: number } | null;
  };
  pendingWork: null | {
    reason?: string;
    updatedAt?: string;
    remaining?: number;
    partialChapters?: number[];
    failedChapters?: number[];
  };
  exports: ExportFile[];
  latestExport?: ExportFile | null;
  exportCount?: number;
  status?: string;
};

export type ExportFile = { name: string; size: number; createdAt: string };

export type BookProgress = {
  total: number;
  completed: number;
  failed: number;
  processing: number;
  pending: number;
  skipped: number;
  rewritable: number;
  totalTokens: number;
  percent: number;
};

/**
 * 书库列表里的「目录卡」（GET /api/books）。
 *
 * 它只查数据库里的目录，字段比工作台的 BookDetail 少：没有 exports 数组
 * （只有 exportCount / latestExport 两个摘要），processed 里也只有 counts。
 */
export type BookCard = {
  bookId: string;
  title: string;
  authors?: string[];
  language?: string;
  chapterCount: number;
  status?: string;
  progress: BookProgress | null;
  exportCount: number;
  latestExport: ExportFile | null;
  processed: null | { counts: Record<string, number> };
  pendingWork: null | {
    reason?: string;
    updatedAt?: string;
    remaining?: number;
    partialChapters?: number[];
    failedChapters?: number[];
  };
  createdAt?: string;
  updatedAt?: string;
};

export type ChapterRow = {
  index: number;
  title: string;
  href: string;
  kind?: string;
  rewritable?: boolean;
  textLength?: number;
  blockCount?: number;
  imageCount?: number;
  stage?: string;
  skippedReason?: string | null;
  note?: string | null;
  chunkTotal?: number;
  chunkDone?: number;
  quality?: {
    ok?: boolean;
    score?: number;
    reasons?: string[];
    lengthRatio?: number;
    numberKeepRatio?: number;
    entityKeepRatio?: number;
  } | null;
  usage?: { totalTokens?: number } | null;
  error?: string | null;
  rewrittenChars?: number;
  digest?: boolean;
  updatedAt?: string | null;
};

export type BookDetail = BookSummary & {
  chapters: ChapterRow[];
};

export type PlanEntry = {
  index: number;
  title: string;
  chars: number;
  value: string;
  strategy: 'keep' | 'digest' | 'skip' | 'drop';
  reason?: string;
  overridden?: boolean;
};

export type PlanView = {
  entries: PlanEntry[];
  names?: Record<string, string>;
  order?: number[];
  overview?: string;
  warnings?: string[];
  counts?: Record<string, number>;
  values?: Record<string, number>;
  totalChars?: number;
  digestChars?: number;
  digestRatio?: number;
  savedChars?: number;
  updatedAt?: string;
  createdAt?: string;
} | null;

export type ReportView = {
  bookId: string;
  title: string;
  generatedAt: string;
  original: { chapters: number; chars: number; notes: number };
  result: {
    chars: number;
    bodyChars: number;
    addedChars: number;
    measured: boolean;
    reconstructedChars?: number;
    ratio: number;
  };
  removed: { count: number; chars: number; chapters: Array<{ index: number; title: string; chars: number }> };
  compressed: {
    count: number;
    charsBefore: number;
    charsAfter: number;
    saved: number;
    chapters: Array<{ index: number; title: string; before: number; after: number }>;
  };
  plainLanguage: {
    count: number;
    charsBefore: number;
    charsAfter: number;
    added: number;
    averageRatio: number;
    chapters: Array<{ index: number; title: string; before: number; after: number; ratio: number }>;
  };
  unchanged: {
    count: number;
    chars: number;
    charsAfter: number;
    chapters: Array<{ index: number; title: string; chars: number; charsAfter: number }>;
  };
  added: { chars: number };
  unchangedShrink: number;
  renamed: number;
  reordered: boolean;
  notes: { total: number; inlined: number; dropped: number; kept: number; byKind?: Record<string, number> };
  export: null | {
    fileName?: string;
    size?: number;
    createdAt?: string;
    entries?: number;
    spineChapters?: number;
    tocEntries?: number;
    links?: number;
    deadLinks?: number;
    anchors?: number;
    anchorLost?: number;
    droppedInSpine?: number;
    [key: string]: unknown;
  };
};

export type JobView = {
  id: string;
  kind: 'plan' | 'rewrite' | 'auto' | string;
  mode?: string;
  bookId: string;
  chapters?: number[];
  status: 'queued' | 'running' | 'pausing' | 'paused' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled' | string;
  createdAt?: string;
  finishedAt?: string | null;
  elapsedMs?: number;
  currentChapter?: number | null;
  completed?: number[];
  failed?: number[];
  skipped?: number[];
  message?: string;
  error?: string | null;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
  log?: string[];
  result?: unknown;
};

export type JobHistoryRow = {
  id: string;
  bookId: string;
  kind: string;
  status: string;
  progress?: {
    message?: string;
    completed?: number[];
    failed?: number[];
    elapsedMs?: number | null;
  } | null;
  createdAt: string;
  updatedAt?: string;
  error?: string | null;
};

export type RewriteStatus = {
  total: number;
  done: number;
  remaining: number;
  remainingChapters: number[];
  resumableChapters: number[];
  pending: null | {
    reason?: string;
    updatedAt?: string;
    remaining?: number;
    partialChapters?: number[];
    failedChapters?: number[];
  };
  running: unknown;
};

export type ProviderView = {
  id: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number | null;
  timeoutMs?: number;
  maxInputChars?: number;
  reasoningEffort?: string | null;
  apiKeyEnv?: string;
  hasApiKey?: boolean;
  apiKeyPreview?: string;
  keySource?: string;
  lastTest?: {
    at?: string;
    ok?: boolean;
    latencyMs?: number;
    model?: string;
    error?: string;
  } | null;
  [key: string]: unknown;
};

export type ProviderPreset = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  docs?: string;
};

export type SettingsPayload = {
  settings: Record<string, unknown> & {
    processing?: Record<string, number | boolean | null>;
    quality?: Record<string, number | boolean>;
    review?: { enabled?: boolean; providerId?: string | null; maxRounds?: number };
    memory?: { enabled?: boolean; keepPreviousChunkSummary?: boolean };
  };
  defaults: Record<string, unknown>;
  speedPresets: Array<{ id: string; label: string; hint: string; target: number; max: number }>;
  defaultSpeedPreset: string;
  currentSpeedPreset: string;
  workspace: string;
};

export type ProfileView = {
  about_me: string;
  reading_goal: string;
  preferred_style: string[];
  disliked_style: string[];
  known_topics: string[];
  weak_topics: string[];
  explanation_preferences: string[];
  language_preferences: string[];
  custom_instructions: string;
};

export type PromptView = {
  file: string;
  source: string;
  warning: string | null;
  variables: string[];
  preview: string;
  content?: string;
  length: number;
};

export type ChapterDiff = {
  diff: Array<{ type: 'same' | 'add' | 'del' | 'insert' | 'delete' | string; text: string }>;
  originalChars: number;
  rewrittenChars: number;
};

/* ------------------------------------------------------------------ 接口 -- */

const base = (bookId: string) => `/api/books/${encodeURIComponent(bookId)}`;

export const booksApi = {
  /* 书库 -------------------------------------------------------------- */
  list: () => request<{ books: BookCard[] }>('/api/books'),
  get: (bookId: string) => request<{ book: BookDetail }>(base(bookId)),
  remove: (bookId: string) => request<{ ok: boolean }>(base(bookId), { method: 'DELETE' }),
  chapters: (bookId: string) =>
    request<{ chapters: ChapterRow[]; summary: { total: number; rewritable: number; noText: number } }>(
      `${base(bookId)}/chapters`,
    ),

  /* 上传（XHR 为了进度条） ------------------------------------------- */
  upload(file: File, onProgress?: (percent: number) => void): Promise<{ book: BookDetail }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/books/upload?filename=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('content-type', 'application/epub+zip');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        let payload: { book?: BookDetail; error?: { code?: string; message?: string } } = {};
        try {
          payload = JSON.parse(xhr.responseText || '{}');
        } catch {
          payload = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload as { book: BookDetail });
        } else {
          reject(
            new ApiError(
              payload.error?.message || `上传失败（HTTP ${xhr.status}）`,
              payload.error?.code || 'HTTP_ERROR',
              xhr.status,
            ),
          );
        }
      };
      xhr.onerror = () => reject(new ApiError('上传中断，请重试', 'NETWORK', 0));
      xhr.send(file);
    });
  },

  /* 整理与改写 -------------------------------------------------------- */
  plan: (bookId: string) => request<{ plan: PlanView }>(`${base(bookId)}/plan`),
  startPlan: (bookId: string) => request<{ job: JobView }>(`${base(bookId)}/plan`, { method: 'POST' }),
  auto: (bookId: string) => request<{ job: JobView }>(`${base(bookId)}/auto`, { method: 'POST' }),
  report: (bookId: string, deep = false) =>
    request<{ report: ReportView | null }>(`${base(bookId)}/report${deep ? '?deep=1' : ''}`),
  status: (bookId: string) => request<RewriteStatus>(`/api/rewrite/status/${encodeURIComponent(bookId)}`),
  rewrite: (body: { bookId: string; chapters?: number[]; mode?: string; resume?: boolean }) =>
    request<{ job: JobView }>('/api/rewrite', json(body)),
  checkProvider: (providerId?: string | null) =>
    request<{ ok: boolean; errors: string[]; provider: ProviderView | null }>(
      '/api/rewrite/check-provider',
      json({ providerId: providerId || null }),
    ),

  /* 章节 -------------------------------------------------------------- */
  chapterView: (bookId: string, index: number, mode: 'original' | 'rewritten') =>
    request<{ mode: string; xhtml: string }>(`${base(bookId)}/chapters/${index}/view?mode=${mode}`),
  chapterDiff: (bookId: string, index: number) => request<ChapterDiff>(`${base(bookId)}/chapters/${index}/diff`),
  rewriteChapter: (bookId: string, index: number) =>
    request<{ job: JobView }>(`${base(bookId)}/chapters/${index}/rewrite`, { method: 'POST' }),
  retryChapter: (bookId: string, index: number) =>
    request<{ job: JobView }>(`${base(bookId)}/chapters/${index}/retry`, { method: 'POST' }),
  resetChapter: (bookId: string, index: number) =>
    request<{ ok: boolean }>(`${base(bookId)}/chapters/${index}/rewritten`, { method: 'DELETE' }),
  extractAll: (bookId: string) => request<{ results: unknown[] }>(`${base(bookId)}/extract`, json({})),

  /* 导出 -------------------------------------------------------------- */
  exports: (bookId: string) => request<{ exports: ExportFile[] }>(`${base(bookId)}/exports`),
  exportBook: (bookId: string) =>
    request<{ export: ExportFile; book: BookDetail }>(`${base(bookId)}/export`, { method: 'POST' }),
  deleteExport: (bookId: string, fileName: string) =>
    request<{ ok: boolean }>(`${base(bookId)}/exports/${encodeURIComponent(fileName)}`, { method: 'DELETE' }),
  exportDownloadUrl: (bookId: string, fileName: string) =>
    `${base(bookId)}/exports/${encodeURIComponent(fileName)}/download`,
  originalDownloadUrl: (bookId: string) => `${base(bookId)}/original`,

  /* 任务 -------------------------------------------------------------- */
  jobs: () => request<{ jobs: JobView[]; history: JobHistoryRow[] }>('/api/jobs'),
  pauseJob: (jobId: string) => request<{ job: JobView }>(`/api/jobs/${encodeURIComponent(jobId)}/pause`, { method: 'POST' }),

  /* 设置 -------------------------------------------------------------- */
  settings: () => request<SettingsPayload>('/api/settings'),
  saveSettings: (settings: Record<string, unknown>) =>
    request<{ settings: Record<string, unknown>; workspace: string }>('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    }),

  /* Provider ---------------------------------------------------------- */
  providers: () =>
    request<{ activeId: string | null; providers: ProviderView[]; presets: ProviderPreset[]; configPath: string }>(
      '/api/providers',
    ),
  createProvider: (provider: Record<string, unknown>) =>
    request<{ provider: ProviderView; activeId: string | null }>('/api/providers', json({ provider })),
  updateProvider: (id: string, provider: Record<string, unknown>) =>
    request<{ provider: ProviderView }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean; activeId: string | null }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  testProvider: (id: string) =>
    request<{ result: { latencyMs?: number; model?: string; sample?: string; ok?: boolean; error?: string } }>(
      `/api/providers/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    ),
  activateProvider: (id: string) =>
    request<{ ok: boolean; activeId: string }>(`/api/providers/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
    }),

  /* 画像与提示词 ------------------------------------------------------ */
  profile: () => request<{ profile: ProfileView }>('/api/profile'),
  saveProfile: (profile: ProfileView) =>
    request<{ profile: ProfileView }>('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile }) }),
  prompts: (full = false) => request<{ prompts: PromptView[] }>(`/api/prompts${full ? '?full=1' : ''}`),
  savePrompt: (file: string, content: string) =>
    request<{ ok: boolean; file: string; length: number }>('/api/prompts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, content }),
    }),
};

/* --------------------------------------------------------------- 小工具 -- */

/** 人类可读的文件大小。 */
export function formatBytes(bytes: number | undefined | null): string {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** 本地化的“多久以前 / 具体时间”。 */
export function formatDate(value: string | undefined | null, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** 耗时：1 分 23 秒 → 便于阅读的短形式。 */
export function formatDuration(ms: number | undefined | null): string {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * 从章节 XHTML 里取出 <body> 内容。
 *
 * 改写稿的 XHTML 带 html/head/body，直接塞进容器会把整个文档结构套进去。
 * 用 DOMParser 解析（不是正则）：原项目也是这么做的，实体与命名空间都能正确处理。
 */
export function extractBody(xhtml: string): string {
  try {
    const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
    const parseError = doc.querySelector('parsererror');
    const raw = parseError || !doc.body
      ? new DOMParser().parseFromString(xhtml, 'text/html').body?.innerHTML || ''
      : doc.body.innerHTML;
    return sanitizeBody(raw);
  } catch {
    return '';
  }
}

/**
 * 预览用的消毒。
 *
 * 内容来自用户自己的书和模型输出，但没有理由假设它无害：EPUB 里可以带
 * `<img onerror>`，模型也可能原样吐出书里的脚本。innerHTML 插入的
 * `<script>` 不执行，事件属性却会执行 —— 交给 DOMPurify（业界标准，
 * 白名单式过滤），只保留排版需要的标签。
 */
function sanitizeBody(html: string): string {
  // 服务端渲染阶段没有 DOM；这个函数只在浏览器里被调用，兜一道防止意外。
  if (typeof window === 'undefined') return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'div', 'span', 'br', 'hr', 'em', 'i', 'strong', 'b', 'u', 's', 'sub', 'sup',
      'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'figure', 'figcaption',
      'table', 'thead', 'tbody', 'tr', 'td', 'th', 'caption', 'ruby', 'rt', 'rp', 'small', 'mark',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'colspan', 'rowspan', 'lang', 'dir', 'width', 'height'],
    ALLOW_DATA_ATTR: false,
  });
}
