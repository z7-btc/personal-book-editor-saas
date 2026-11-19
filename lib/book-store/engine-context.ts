/**
 * 引擎运行上下文：一次改写/规划需要的东西（Provider / 画像 / 设置 / 书籍信息）。
 *
 * 这是原项目 src/server/index.js 里 getRewriteContext 的移植，只是
 * 所有磁盘位置都从「当前用户上下文」推出来（见 storage.ts）。
 * 调用前必须已经处在 withBookUser() 里，否则读到的是全局默认目录 ——
 * 那样 A 用户的 Provider Key 会被 B 用户用上，是数据事故。
 */

import { loadSettings } from '../book-engine/config/settings.js';
import { loadProviders, getProvider, validateProvider } from '../book-engine/config/providers.js';
import { loadProfile } from '../book-engine/config/profile.js';
import { readBookMetadata, readBookMemory } from '../book-engine/pipeline/workspace.js';
import { AppError } from '../book-engine/util/errors.js';
import { currentUserContext } from '../book-engine/auth/context.js';
import { projectRoot } from './storage';

/** 引擎是纯 JS，这里给它用到的几个形状补上类型，避免 any 满天飞。 */
export type ProviderLike = {
  id: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  topP?: number;
  maxInputChars?: number;
  reasoningEffort?: string;
  presetId?: string;
  createdAt?: string;
  updatedAt?: string;
  lastTest?: unknown;
};

type ProvidersFile = { activeId: string | null; providers: ProviderLike[] };

export type SettingsLike = {
  review?: { enabled?: boolean; providerId?: string | null };
} & Record<string, unknown>;

export type ProfileLike = Record<string, unknown>;

export type BookMetadataLike = {
  title: string;
  authors: string[];
  language: string;
  chapterCount: number;
};

export type RewriteContext = {
  provider: ProviderLike | null;
  reviewProvider: ProviderLike | null;
  settings: SettingsLike;
  profile: ProfileLike;
  projectRoot: string;
  bookContext: {
    title: string;
    authors: string[];
    language: string;
    chapterCount: number;
    summary: string;
  } | null;
};

export async function getRewriteContext(bookId?: string | null): Promise<RewriteContext> {
  const ctx = currentUserContext();
  if (!ctx?.userId) {
    // 明确拒绝而不是「默默用默认目录」：这里宁可报错，也不能让请求
    // 落到无归属的全局书柜里。
    throw new AppError('缺少用户上下文，拒绝读取书稿', { code: 'NO_USER_CONTEXT', status: 500 });
  }

  const root = projectRoot();
  const promptRoot = ctx.configDir; // 提示词按用户隔离（仓库模板在 ensureUserDirs 里已播种）
  const settings = (await loadSettings(root)) as SettingsLike;

  const data = (await loadProviders(root)) as ProvidersFile;
  const provider = data.providers.find((p) => p.id === data.activeId) || null;
  const errors = validateProvider(provider) as string[];
  if (errors.length) {
    throw new AppError(`当前 Provider 不可用：${errors.join('；')}`, { code: 'PROVIDER_INVALID', status: 400 });
  }

  const profile = (await loadProfile(root)) as ProfileLike;

  let reviewProvider: ProviderLike | null = null;
  if (settings.review?.enabled) {
    reviewProvider = settings.review.providerId
      ? ((await getProvider(root, settings.review.providerId)) as ProviderLike | null)
      : provider;
    if (reviewProvider && (validateProvider(reviewProvider) as string[]).length) reviewProvider = null;
  }

  let bookContext: RewriteContext['bookContext'] = null;
  if (bookId) {
    try {
      const metadata = (await readBookMetadata(bookId)) as BookMetadataLike;
      const memory = (await readBookMemory(bookId)) as { book_summary?: string } | null;
      bookContext = {
        title: metadata.title,
        authors: metadata.authors,
        language: metadata.language,
        chapterCount: metadata.chapterCount,
        summary: memory?.book_summary || '',
      };
    } catch {
      bookContext = null;
    }
  }

  return { provider, reviewProvider, settings, profile, projectRoot: promptRoot, bookContext };
}

/** 只取 Provider（Provider 设置页的连通性测试等轻量场景用）。 */
export async function getActiveProvider(): Promise<ProviderLike | null> {
  const root = projectRoot();
  const data = (await loadProviders(root)) as ProvidersFile;
  return data.providers.find((p) => p.id === data.activeId) || null;
}
