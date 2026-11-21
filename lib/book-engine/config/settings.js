/**
 * 处理设置（非机密）。
 * 所有阈值都可在设置页调整，并对 Phase 1 的「无 AI 重打包」完全无关。
 */

import path from 'node:path';
import { readJson, writeJson, exists } from '../util/fsx.js';
import { currentUserContext } from '../auth/context.js';
import { defaultSpeedSettings, SPEED_PRESETS, DEFAULT_SPEED_PRESET } from './speed-presets.js';

const SPEED = defaultSpeedSettings();

export const DEFAULT_SETTINGS = {
  workspaceDir: '', // 空 = 使用 ./workspace
  processing: {
    // 「处理方式」三档对应的数字。界面上只暴露三档，不暴露这两个值。
    targetCharsPerChunk: SPEED.targetCharsPerChunk,
    maxCharsPerChunk: SPEED.maxCharsPerChunk,
    concurrentChapters: 1,
    maxRetries: 3,
    retryBaseDelayMs: 2000,
    chapterPauseMs: 300,
    temperature: null, // null = 使用 provider 的设置
    /**
     * 改写完之后再跑一遍「读者补讲 / 删段」。
     *
     * 默认开：这一遍才是「让读者看得懂」的实际来源 —— 改写那一遍只能
     * 把旧白话翻成现代汉语，讲不清典故和术语（实测见 docs/PHASES.md）。
     * 代价是每章多一次调用（约多 20–40% token），关掉它就退回「换词版」。
     */
    explainPass: true,
  },
  quality: {
    minLengthRatio: 0.45,
    maxLengthRatio: 2.2,
    failLengthRatio: 0.25,
    numberKeepRatio: 0.85,
    entityKeepRatio: 0.8,
    autoRetryOnFail: true,
    maxQualityRetries: 1,
  },
  review: {
    enabled: false,
    providerId: null,
    maxRounds: 1,
  },
  memory: {
    enabled: true,
    keepPreviousChunkSummary: true,
  },
  /**
   * 图片理解。改写时先给每张图写说明，模型才知道「这里那张表说的是什么」；
   * 图注本身原样保留，不交给模型改写。
   */
  images: {
    /** 关掉就只用图注当说明，不调视觉模型 */
    describe: true,
    /** 指定给视觉模型用的 Provider；null = 跟着当前改写 Provider */
    providerId: null,
    /** 每本书最多识别多少张（0 = 不限）——防止一本 400 张图的书烧掉一大笔钱 */
    maxPerBook: 120,
    /** 单张图片字节上限，超过就退回图注 */
    maxBytes: 4194304,
    /** 单张说明的字数上限 */
    maxDescriptionChars: 500,
  },
  prompt: {
    systemFile: 'prompts/rewrite-system.txt',
    reviewFile: 'prompts/review-system.txt',
    memoryFile: 'prompts/memory-system.txt',
    explainFile: 'prompts/explain-system.txt',
  },
  ui: {
    showSkippedBlocks: false,
    diffContextLines: 6,
  },
  /**
   * 配置版本号，用于一次性迁移。
   * 早期版本没有这个字段，读到的就是 undefined。
   */
  schemaVersion: 0,
};

/** 当前配置版本。改默认值并希望老用户也享受到时，把它 +1 并加一条迁移。 */
export const CURRENT_SETTINGS_VERSION = 2;

/**
 * 把老配置升级到当前版本。
 *
 * 为什么需要：处理方式的三档是后加的，老配置里存的是历史默认值
 * （targetCharsPerChunk: 2800），界面上会显示成「稳妥」，
 * 但推荐档其实是「平衡」。用户没改过任何东西，却看到推荐项没被选中，
 * 会以为程序出问题了。这里做一次性对齐。
 *
 * 只在实际改动了内容时返回 changed = true，避免每次都重写文件。
 */
export function migrateSettings(settings) {
  const next = settings;
  const from = Number(next.schemaVersion || 0);
  let changed = false;

  if (from < 1) {
    const preset = SPEED_PRESETS.find((p) => p.id === DEFAULT_SPEED_PRESET);
    const legacyDefaults = [2800, 6000]; // 旧版本的默认组合
    const target = Number(next.processing?.targetCharsPerChunk);
    const max = Number(next.processing?.maxCharsPerChunk);
    const isUntouchedLegacyDefaults =
      legacyDefaults.includes(target) && (max === 6000 || max === undefined);

    if (isUntouchedLegacyDefaults) {
      next.processing = {
        ...next.processing,
        targetCharsPerChunk: preset.target,
        maxCharsPerChunk: preset.max,
      };
      changed = true;
    }
    next.schemaVersion = 1;
    changed = true;
  }

  /**
   * v2：新增 images（图片理解）。
   * 默认值已经由 deepMerge 补齐，这里只把版本号写进去 ——
   * 不覆盖用户已经改过的值，也不用重复搬一遍字段。
   */
  if (from < 2) {
    next.schemaVersion = 2;
    changed = true;
  }

  return { settings: next, changed, from };
}


function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return override;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * 配置文件所在目录。
 *
 * 默认是项目下的 config/，但可以用环境变量 PBE_CONFIG_DIR 覆盖。
 * 这样测试 / 冒烟脚本可以指向临时目录，**永远不会碰到用户真实的配置**
 * —— 之前冒烟脚本直接在项目目录里删 providers.json，
 * 把用户在界面上配好的 API Key 删掉了，这个环境变量就是为此加的。
 *
 * 多账号：请求上下文里有当前用户时，用该用户自己的 config 目录，
 * 优先级高于 PBE_CONFIG_DIR —— 两个账号不能共用一份 Provider / API Key。
 * 没有用户上下文时（命令行、测试、启动自检）行为和以前完全相同。
 *
 * 注意：调用时才读环境变量（不在模块加载时固化），
 * 这样同进程内改 env 也能生效。
 */
export function configDir(root) {
  const ctx = currentUserContext();
  if (ctx?.configDir) return ctx.configDir;
  const override = process.env.PBE_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(root, 'config');
}

export function settingsPath(root) {
  return path.join(configDir(root), 'settings.json');
}

export async function loadSettings(root) {
  const file = settingsPath(root);
  if (!(await exists(file))) {
    await writeJson(file, DEFAULT_SETTINGS);
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  const data = await readJson(file, {});
  const merged = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), data);

  // 老配置一次性升级（例如把历史默认的 chunk 大小对齐到推荐档）
  const { settings: migrated, changed } = migrateSettings(merged);
  if (changed) {
    try {
      await writeJson(file, migrated);
    } catch {
      // 迁移写盘失败不该阻止程序启动，内存里已经是升级后的值
    }
  }
  return migrated;
}

export async function saveSettings(root, patch) {
  const current = await loadSettings(root);
  const next = deepMerge(current, patch || {});
  await writeJson(settingsPath(root), next);
  return next;
}

export { deepMerge };
