'use strict';
/*
 * lib/store-adapter/index.js — 存储接缝层（ADR-010 Phase 0）
 *
 * 目的：把「主存」与「动作队列 / 审计」的读写收口到一个可替换接口，使
 *   本地实现（json / sqlite）与将来的云端实现（pg）共用同一套调用方，
 *   Phase 1 换云只换适配器，不重写业务算法。
 *
 * 接口契约（Phase 0 全部为**同步**方法；JSON / node:sqlite 均为同步）：
 *   readSnapshot(storeId?) -> snapshot|null
 *   writeSnapshot(storeId?, snapshot) -> void              // 盲写（push/回滚/导入）
 *   casWrite(storeId?, expectedRev, snapshot) -> {ok, rev, conflict?}  // 乐观锁
 *   loadQueue() -> action[]
 *   saveQueue(actions) -> void                              // 整体替换（路由侧 sweep/dedup 用）
 *   enqueue(action) -> action
 *   claim(workerId, limit) -> action[]                      // 原子认领：待执行 → 执行中
 *   ack(id, patch) -> {ok, action?}
 *   appendAudit(entry) -> void
 *   listAudit(limit) -> entry[]
 *   close() -> void
 *
 * 为什么是同步：`lib/scheduler.js` / `lib/si_mission.js` 在同步上下文调用
 *   `propose/enqueue`，若接口异步会波及 10+ 调用方。Phase 1 接 PG 时再统一
 *   改为 await（届时调用方本就要改），本阶段不提前制造异步传染。
 *
 * 选型：STORE_ADAPTER=json（默认）|sqlite|pg
 *   - json   ：生产现状（bff/data/snapshot.json + actions_queue.json）
 *   - sqlite ：本地替身 / 契约测试（node:sqlite 内置，零安装）
 *   - pg     ：腾讯云 PostgreSQL（Phase 1，当前为占位，UNVERIFIED）
 */
const KINDS = ['json', 'sqlite', 'pg'];

let _singleton = null;

/** 按类型创建适配器（不经单例，供测试/worker 使用） */
function createAdapter(kind, opts) {
  const k = String(kind || process.env.STORE_ADAPTER || 'json').toLowerCase();
  if (k === 'json') return require('./json').create(opts);
  if (k === 'sqlite') return require('./sqlite').create(opts);
  if (k === 'pg') return require('./pg').create(opts);
  throw new Error('unknown store adapter: ' + kind + '（可用：' + KINDS.join('/') + '）');
}

/** 当前进程选定的类型（非法值回落 json，不因配置错误阻断启动） */
function currentKind() {
  const k = String(process.env.STORE_ADAPTER || 'json').toLowerCase();
  return KINDS.indexOf(k) >= 0 ? k : 'json';
}

/** 进程内单例：路由侧各模块共用同一个适配器（sqlite 不会反复开库） */
function getAdapter() {
  if (!_singleton) _singleton = createAdapter(currentKind());
  return _singleton;
}

/** 仅测试用：释放单例（sqlite 关库后允许换目录重开） */
function resetAdapter() {
  if (_singleton && typeof _singleton.close === 'function') {
    try { _singleton.close(); } catch (e) { /* ignore */ }
  }
  _singleton = null;
}

module.exports = { KINDS, createAdapter, getAdapter, resetAdapter, currentKind };
