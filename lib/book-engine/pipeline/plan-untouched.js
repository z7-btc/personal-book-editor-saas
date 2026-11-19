/**
 * 「方案要我们别碰」的章节：策略为 `skip`（原样保留）或 `drop`（整章删除）。
 *
 * 为什么单独成一个模块：
 *
 * 判断「这本书还剩多少章要处理」的地方不止一处 ——
 *   · `selectChapters()` 决定真正排进 AI 队列的章节；
 *   · `countRemaining()` 决定「继续处理（剩余 N 章）」按钮上的 N；
 *   · `Jobs._recordPendingWork()` 决定任务坞里「还有活没干完」的记录。
 *
 * 这三处口径必须完全一致。第一版只修了 `mode='all'` 一个分支：
 * 「全部改写」不再碰 skip 章，但按钮上仍写着「剩余 1 章」，
 * 用户一点（走 `resume`）就把方案要求原样保留的章节改写掉了 ——
 * 想省的钱换个入口照样花，按钮也永远归不了零。
 *
 * 这里刻意不放 `workspace.js` 之外任何依赖：`routes.js` 和 `jobs.js`
 * 互相引用，共用逻辑放它们任何一个里都会形成循环。
 */

import * as ws from './workspace.js';

/**
 * 读方案，返回 `skip` / `drop` 的章节序号集合。没有方案时返回空集合。
 *
 * 方案里的 `index` 要过一遍 `Number()`：手改过的方案文件、旧版本写出的方案
 * 都可能存成字符串 `"5"`，而调用方拿到的章节序号是数字，直接 `has()` 永远为 false。
 */
export async function readUntouchedChapters(bookId) {
  return new Set((await readUntouchedStrategies(bookId)).keys());
}

/**
 * 同上，但保留「是哪种不动」：`skip` = 原样保留，`drop` = 整章删除。
 *
 * 界面得知道区别：两者都是 stage='skipped'、都锁掉勾选框，
 * 但 hover 的说明一句话说不清就会被问「凭什么说它要保留」——
 * 方案里明明写的是删除。这一层只负责把策略带出来，措辞交给前端。
 *
 * @returns {Promise<Map<number, 'skip'|'drop'>>} 章号 -> 策略
 */
export async function readUntouchedStrategies(bookId) {
  const plan = await ws.readBookPlan(bookId).catch(() => null);
  const map = new Map();
  for (const e of plan?.entries || []) {
    if (e?.strategy !== 'skip' && e?.strategy !== 'drop') continue;
    const index = Number(e.index);
    if (Number.isFinite(index)) map.set(index, e.strategy);
  }
  return map;
}
