'use strict';
/*
 * lib/algorithms/index.js — 算法层注册表（action.type → 处理函数）
 *
 * 目标（迁移 store-inventory/queue_consumer.py 的业务算法到 BFF）：
 *   - 把原先藏在店内 Python 的 apply_* 业务算法上提为 BFF 统一算法层；
 *   - 每个算法为「纯函数优先」：输入 (data, payload, ctx) → 输出 {patch|mutate, logs, result}；
 *   - 与 SQLite 强耦合的写库逻辑（insert_* 新表）统一走 ctx.store 适配，便于后续替换数据访问。
 *
 * 约定：
 *   handler(ctx, data, payload) → result
 *     ctx: { store?, dbPath?, rev?, traceId?, now? }  运行上下文（数据访问/时间/追踪）
 *     data: 当前快照 data 对象（可原地 mutate，与 Python 版一致）
 *     payload: 动作载荷
 *   返回：任意结果对象（写入 action.result）；抛错则视为驳回。
 *
 * 分批迁移，未登记的 type 由 BFF 返回 need-manual，不静默丢弃。
 */

const registry = new Map();

/** 登记一个 action type 的算法 */
function register(type, handler) {
  if (!type || typeof handler !== 'function') {
    throw new Error('register(type, handler) 参数非法: ' + type);
  }
  registry.set(String(type), handler);
}

/** 批量登记 */
function registerAll(map) {
  for (const [type, handler] of Object.entries(map || {})) register(type, handler);
}

function get(type) {
  return registry.get(String(type)) || null;
}

function has(type) {
  return registry.has(String(type));
}

function listTypes() {
  return Array.from(registry.keys()).sort();
}

/** 执行一个动作：命中算法则运行，否则返回 {handled:false} 交由上层走 need-manual */
function run(type, ctx, data, payload) {
  const handler = get(type);
  if (!handler) return { handled: false, type: String(type) };
  const result = handler(ctx || {}, data, payload || {});
  return { handled: true, type: String(type), result };
}

module.exports = { register, registerAll, get, has, listTypes, run };
