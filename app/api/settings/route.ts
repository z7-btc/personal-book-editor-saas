import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from '@/lib/book-engine/config/settings.js';
import {
  DEFAULT_SPEED_PRESET,
  SPEED_PRESETS,
  findSpeedPreset,
} from '@/lib/book-engine/config/speed-presets.js';
import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSameOrigin, readJsonBody, withBookApi } from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

type SettingsLike = { processing?: { targetCharsPerChunk?: number } } & Record<string, unknown>;

/** GET /api/settings —— 处理设置 + 三档速度预设 + 我的工作区路径。 */
export async function GET(request: Request) {
  return withBookApi(request, async () => {
    const settings = (await loadSettings(projectRoot())) as SettingsLike;
    const preset = findSpeedPreset(settings.processing?.targetCharsPerChunk) as { id: string };
    return {
      settings,
      defaults: DEFAULT_SETTINGS,
      // 三档处理方式放在服务端定义，前端只负责渲染，避免两边各写一份慢慢漂移
      speedPresets: SPEED_PRESETS,
      defaultSpeedPreset: DEFAULT_SPEED_PRESET,
      currentSpeedPreset: preset.id,
      workspace: ws.workspaceRoot(),
    };
  });
}

/**
 * PUT / POST /api/settings —— 保存设置。
 *
 * 注意：workspaceDir 在 SaaS 版里**不允许用户改**——工作区按用户由
 * 存储层决定（storage.ts），可改的话一个人就能把服务端的全局状态改掉。
 */
export async function PUT(request: Request) {
  return writeSettings(request);
}

export async function POST(request: Request) {
  return writeSettings(request);
}

async function writeSettings(request: Request) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const body = await readJsonBody<{ settings?: Record<string, unknown> }>(request);
    const input = { ...(body.settings || (body as Record<string, unknown>)) };
    delete input.workspaceDir;
    const settings = (await saveSettings(projectRoot(), input)) as SettingsLike;
    await ws.ensureWorkspace();
    return { settings, workspace: ws.workspaceRoot() };
  });
}
