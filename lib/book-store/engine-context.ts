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
  images?: { describe?: boolean; providerId?: string | null };
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
  /** 图片理解用的 Provider；关掉图片理解或没单独指定时，就是主 Provider */
  imageProvider: ProviderLike | null;
  /**
   * 明确指定了图片 Provider、但它不存在或配置无效时的原因。
   * 这种情况不能退回主 Provider：用户就是想把图发给那个模型的。
   * 调用方应只用图注兜底并写日志。
   */
  imageProviderIssue: string | null;
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

  /**
   * 图片理解用的 Provider。
   * 单独指定的必须是能用的 Provider，配错了就退回「只用图注」，
   * 不能因为视觉通道配坏而让整本书改写失败。
   *
   * 「没配置」和「配了但无效」必须分开：
   *  - 没配置（settings.images.providerId 为空）：用主 Provider，行为不变；
   *  - 配了但找不到 / 校验不过：imageProvider 置 null，同时记下原因。
   *    调用方不能拿主 Provider 顶替 —— 那等于把图片发给了用户没指定的模型。
   */
  let imageProvider: ProviderLike | null = null;
  let imageProviderIssue: string | null = null;
  if (settings.images?.describe !== false) {
    if (settings.images?.providerId) {
      const wanted = String(settings.images.providerId);
      const found = (await getProvider(root, wanted)) as ProviderLike | null;
      if (!found) {
        imageProviderIssue = `找不到 ID 为 ${wanted} 的 Provider`;
      } else {
        const errors = validateProvider(found) as string[];
        if (errors.length) {
          imageProviderIssue = `Provider「${found.name || wanted}」不可用：${errors.join('；')}`;
        } else {
          imageProvider = found;
        }
      }
    } else {
      imageProvider = provider;
    }
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

  return { provider, reviewProvider, imageProvider, imageProviderIssue, settings, profile, projectRoot: promptRoot, bookContext };
}

/** 只取 Provider（Provider 设置页的连通性测试等轻量场景用）。 */
export async function getActiveProvider(): Promise<ProviderLike | null> {
  const root = projectRoot();
  const data = (await loadProviders(root)) as ProvidersFile;
  return data.providers.find((p) => p.id === data.activeId) || null;
}
