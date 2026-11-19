/**
 * 处理方式的三档预设。
 *
 * 为什么是这三档（实测数据见 scripts/measure-chunking.mjs）：
 * Reader Profile + System Prompt 是每次调用都要重复发一遍的固定开销，
 * 所以「AI 每次看多少原文」直接决定账单。9 万字的章节实测：
 *
 *   chunk 1200 -> 67 次调用，固定开销占 79%
 *   chunk 2800 -> 31 次调用，占 64%
 *   chunk 5000 -> 17 次调用，占 45%   ← 推荐
 *   chunk 6000 -> 15 次调用，占 46%
 *
 * maxCharsPerChunk 必须明显大于 target，否则切分逻辑没有腾挪空间
 * （它是"到目标值后开始找下一个可断点"的实现基础）。
 */

export const SPEED_PRESETS = [
  {
    id: 'careful',
    label: '稳妥（每次少看一些）',
    hint: '模型每次只看一小段，最容易保持专注。但调用次数最多、最贵。',
    target: 2800,
    max: 6000,
  },
  {
    id: 'balanced',
    label: '平衡（推荐）',
    hint: '成本和稳定性兼顾。默认用这个。',
    target: 5000,
    max: 9000,
  },
  {
    id: 'frugal',
    label: '省钱（每次多看一些）',
    hint: '调用次数最少，最省 token。适合长书，或你已经确认这个模型很稳。',
    target: 6000,
    max: 9000,
  },
];

/** 默认档位（新增设置时用）。 */
export const DEFAULT_SPEED_PRESET = 'balanced';

/**
 * 找出与给定 targetCharsPerChunk 最接近的档位。
 *
 * 用「最接近」而不是「精确相等」很重要：老配置文件里可能是
 * 某个历史默认值（例如 2800），或者用户手改过一个中间值。
 * 如果只做精确匹配，界面上会出现「一个都没选中」或者
 * 明明推荐平衡却显示稳妥，让人以为程序坏了。
 */
export function findSpeedPreset(targetCharsPerChunk) {
  const value = Number(targetCharsPerChunk);
  if (!Number.isFinite(value) || value <= 0) {
    return SPEED_PRESETS.find((p) => p.id === DEFAULT_SPEED_PRESET);
  }
  let best = SPEED_PRESETS[0];
  let bestDiff = Infinity;
  for (const preset of SPEED_PRESETS) {
    // 用相对距离，避免大数值档位天然占优
    const diff = Math.abs(Math.log(value) - Math.log(preset.target));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = preset;
    }
  }
  return best;
}

/** 默认设置里用的那一档。 */
export function defaultSpeedSettings() {
  const preset = SPEED_PRESETS.find((p) => p.id === DEFAULT_SPEED_PRESET);
  return { targetCharsPerChunk: preset.target, maxCharsPerChunk: preset.max };
}
