/**
 * 请求级用户上下文（AsyncLocalStorage）。
 *
 * 为什么必须用 ALS：服务是单进程、并发处理请求的。如果用一个模块级
 * 变量 `currentUserId`，A 请求刚设完、还没读完文件，B 请求就把它改成
 * 了 B —— A 的后续读取全落在 B 的目录里，这叫串台，是数据事故。
 * AsyncLocalStorage 把上下文绑在「这次请求的异步调用链」上，两个请求
 * 交错执行也各读各的。
 *
 * 上下文结构：
 *   { userId, workspaceRoot, configDir }
 *
 * 没有上下文时（命令行脚本、现有测试、启动自检），workspaceRoot() /
 * configDir() 必须和改动之前一模一样 —— 这是不回归的前提。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * 在指定用户上下文里执行 fn。fn 的同步/异步调用链都能读到 ctx，
 * 包括它在里面启动、之后才跑完的后台任务。
 * @template T
 * @param {{userId: string, workspaceRoot: string, configDir: string}} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function withUserContext(ctx, fn) {
  if (!ctx || !ctx.userId) return fn();
  return storage.run(ctx, fn);
}

/** 当前上下文；不在任何用户上下文里时返回 null。 */
export function currentUserContext() {
  return storage.getStore() || null;
}

export function currentUserId() {
  const ctx = storage.getStore();
  return ctx?.userId || null;
}
