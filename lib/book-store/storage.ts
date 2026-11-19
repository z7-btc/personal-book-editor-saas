/**
 * 书籍文件的"文件柜"：按用户隔离的本地磁盘存储。
 *
 * 和引擎（lib/book-engine）的分工：
 *  - 引擎只管"怎么处理书"，它通过工作区根目录 + 配置目录干活；
 *  - 这里决定"这两样东西放在哪"——每个用户一套，互不可见。
 *
 * 目录布局（BOOK_STORAGE_ROOT 默认 ./data）：
 *
 *   data/users/<userId>/workspace/      书稿与中间产物（引擎的 workspace）
 *   data/users/<userId>/config/         settings.json / providers.json / reader_profile.json
 *
 * 为什么先落本地磁盘而不是对象存储：引擎带着 374 个测试按文件语义工作，
 * 第一阶段不动它；上线前如果要多实例部署，换的是这一层的实现，
 * 引擎和路由层不用改。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { withUserContext } from '../book-engine/auth/context.js';

/** 用户 id 只允许 Better Auth 会生成的字符集；其余一律拒绝，防止路径穿越。 */
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafeUserId(userId: string): string {
  const id = String(userId || '');
  if (!SAFE_USER_ID.test(id)) {
    throw new Error(`非法的用户 id: ${id.slice(0, 40)}`);
  }
  return id;
}

/** 存储根目录。部署环境会变（本地盘 / 云盘挂载点），所以走环境变量。 */
export function storageRoot(): string {
  const configured = process.env.BOOK_STORAGE_ROOT?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), 'data');
}

export function userRoot(userId: string): string {
  return path.join(storageRoot(), 'users', assertSafeUserId(userId));
}

export function userWorkspaceRoot(userId: string): string {
  return path.join(userRoot(userId), 'workspace');
}

export function userConfigDir(userId: string): string {
  return path.join(userRoot(userId), 'config');
}

export async function ensureUserDirs(userId: string): Promise<{ workspaceRoot: string; configDir: string }> {
  const workspaceRoot = userWorkspaceRoot(userId);
  const configDir = userConfigDir(userId);
  await fs.mkdir(path.join(workspaceRoot, 'books'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'exports'), { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await seedUserPrompts(configDir);
  return { workspaceRoot, configDir };
}

/**
 * 给用户配置目录播一份提示词模板（只在该用户还没有 prompts/ 时做）。
 *
 * 提示词是"可改的默认值"：仓库 prompts/ 下是出厂模板，复制进用户目录后
 * 用户改的是自己那份，不影响别人。复制失败（比如 standalone 没带 prompts/）
 * 就跳过——引擎会用内置兜底模板，功能不受影响。
 */
async function seedUserPrompts(configDir: string): Promise<void> {
  const target = path.join(configDir, 'prompts');
  if (await fs.access(target).then(() => true).catch(() => false)) return;
  try {
    const source = path.join(projectRoot(), 'prompts');
    const files = await fs.readdir(source);
    await fs.mkdir(target, { recursive: true });
    for (const f of files) {
      if (!f.endsWith('.txt')) continue;
      await fs.copyFile(path.join(source, f), path.join(target, f)).catch(() => {});
    }
  } catch {
    /* 没有出厂模板目录：交给引擎的内置兜底 */
  }
}

/**
 * 在某个用户的书柜上下文里执行 fn。
 *
 * 引擎里所有路径（工作区、配置、画像、Provider Key）都从
 * AsyncLocalStorage 读当前用户——这是防串台的关键，不要在别处
 * 手动拼用户目录。
 */
export async function withBookUser<T>(userId: string, fn: () => T): Promise<T> {
  const { workspaceRoot, configDir } = await ensureUserDirs(userId);
  return withUserContext({ userId: assertSafeUserId(userId), workspaceRoot, configDir }, fn);
}

/**
 * 引擎提示词模板所在的项目根目录。
 *
 * 提示词文件在仓库根的 prompts/ 下。dev 从仓库根启动时 process.cwd()
 * 就是它；standalone 构建部署时要确保 prompts/ 被拷进运行目录
 * （部署阶段处理，见 docs）。
 */
export function projectRoot(): string {
  return process.cwd();
}
