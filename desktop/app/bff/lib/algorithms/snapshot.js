'use strict';
/*
 * lib/algorithms/snapshot.js — 快照高危写执行器（ADR-013 D1 / D4，W2-01 + W4-01/02/03）。
 *
 * 执行链（全部走 /api/actions 队列，红线①唯一写入口）：
 *   提交 → 确认 → 入队 → action-runner → 本执行器：
 *     读备份/基线/暂存导入文件 → 强制前置备份(红线⑤) → 校验+迁移 schema → 整包回写 data+ext(± 清空档位)
 *   rev 由 action-runner 的 StoreAdapter.casWrite 递增为 curRev+1。
 *   对回滚/导入/重置这类「目标 rev ≤ 当前 rev」的覆盖，curRev+1 即 D4-2 的 max(cur, incoming)+1，
 *   绝不回退；导入文件的 rev 高于当前时以当前 rev 为准（仍单调递增），回执里同时记 incoming_rev 供审计。
 *
 * 四个执行器：
 *   snapshot.rollback         W2-01 / FP-SET-10  从 data/snapshots/<id>.json 整包恢复（D1）
 *   snapshot.import           W4-01 / FP-SET-15  从 data/imports/<id>.json 整包恢复（用户上传的备份 JSON）
 *   snapshot.reset_baseline   W4-02 / FP-SET-16  整包重置为随包基线制品 bff/baselines/baseline-<ver>.json
 *   snapshot.clear            W4-03 / FP-SET-17  清空业务数据（business）/ 回到首次安装状态（all）
 *
 * 红线：
 *   · 本执行器不直接发 HTTP、不暴露任何对外可直调端点（前端/外部只能「入队」，无第二条写通道）；
 *   · 执行前强制打一份新备份（D4-3），失败即拒绝执行（红线⑦不静默降级）；
 *   · 不物理删业务行、不掺业务语义写——只做「整包替换 / 整组清空」+ 留痕。
 */
const fs = require('fs');
const path = require('path');
const snapshotStore = require('../snapshot_store');
const importStore = require('../import_store');
const baselineStore = require('../baseline_store');
const schema = require('../schema');
const store = require('../store');
const { getAdapter } = require('../store-adapter');

/** 快照数据规模摘要（供预览「将丢弃 N 条 / 将恢复 N 条」展示） */
function countSummary(snap) {
  const data = (snap && snap.data) || {};
  const ext = (snap && snap.ext) || {};
  return {
    ings: Array.isArray(data.ings) ? data.ings.length : 0,
    recv: Array.isArray(data.recv) ? data.recv.length : 0,
    sales: Array.isArray(data.sales) ? data.sales.length : 0,
    quotes: Array.isArray(data.quotes) ? data.quotes.length : 0,
    logs: Array.isArray(data.logs) ? data.logs.length : 0,
    dishes: Array.isArray(data.dishes) ? data.dishes.length : 0,
    ext_tables: Object.keys(ext || {}).filter((k) => Array.isArray(ext[k]) && ext[k].length).length,
  };
}

function errMsg(e) {
  return (e && e.message) ? e.message : String(e);
}

/**
 * 归一化「待导入快照」输入：接受三种常见形态，统一成 {rev, data, ext}。
 *   ① 导出备份 / 快照备份全文：{rev, generated_at, size, machine, data, ext}
 *   ② 裸数据：{data, ext}
 *   ③ 包一层：{snapshot: {...}}
 * @throws 缺 data / data 非对象 / ext 非对象
 */
function normalizeIncomingSnapshot(input) {
  let obj = input;
  if (obj && typeof obj === 'object' && obj.snapshot && typeof obj.snapshot === 'object') obj = obj.snapshot;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('导入内容不是 JSON 对象');
  const data = obj.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('导入内容缺少 data 对象（不是有效的备份文件）');
  const ext = obj.ext === undefined || obj.ext === null ? {} : obj.ext;
  if (typeof ext !== 'object' || Array.isArray(ext)) throw new Error('导入内容的 ext 必须是对象');
  return {
    rev: Number.isFinite(obj.rev) ? obj.rev : null,
    data,
    ext,
  };
}

/**
 * 差异统计（只读纯计算）：当前 vs 目标。
 * @returns {{will_discard:object, will_restore:object, changed:Array<{key:string,current:number,next:number}>}}
 */
function diffOf(current, next) {
  const cur = countSummary(current);
  const nxt = countSummary(next);
  const changed = Object.keys(cur)
    .map((key) => ({ key, current: cur[key], next: nxt[key] }))
    .filter((row) => row.current !== row.next);
  return { will_discard: cur, will_restore: nxt, changed };
}

/**
 * D4-3 强制前置备份：把「当前快照」存一份；失败即拒绝执行（红线⑦）。
 * @returns {?string} 备份 id（当前无快照时返回 null）
 */
function safeguardBackup(payload, ctx, note) {
  try {
    const curSnap = getAdapter().readSnapshot();
    if (!curSnap) return null;
    const saved = snapshotStore.save(curSnap, {
      operator: (payload && payload.operator) || (ctx && ctx.operator) || 'system',
      note,
    });
    return saved.item.id;
  } catch (e) {
    throw new Error('执行前自动备份失败，已拒绝执行：' + errMsg(e));
  }
}

/** 原地整包替换 data（保持引用，executeAction 最终写回快照）+ 回写 ext 到 ctx.store */
function replaceAll(data, nextData, nextExt, ctx) {
  Object.keys(data).forEach((k) => { delete data[k]; });
  Object.assign(data, nextData);
  if (ctx && ctx.store) ctx.store.ext = nextExt;
}

/** schema 校验 / 迁移（旧目标可能落后当前版本，缺迁移函数则显式报错，绝不静默跳版本） */
function migrateOrThrow(srcData, what) {
  try {
    const m = schema.migrateData(srcData);
    return { data: m.data, steps: m.steps.length };
  } catch (e) {
    throw new Error(what + ' schema 迁移失败，已拒绝执行：' + errMsg(e));
  }
}

/**
 * snapshot.rollback 执行器（W2-01 / FP-SET-10，D1）。
 * @param {object} data 当前快照 data（将被原地替换为备份 data）
 * @param {object} payload { backup_id, target_rev?, reason?, operator? }
 * @param {object} ctx executeAction 上下文（ctx.rev = 执行时快照 rev；ctx.store 用于回写 ext）
 */
function applySnapshotRollback(data, payload, ctx) {
  const backupId = String((payload && payload.backup_id) || '').trim();
  if (!backupId) throw new Error('snapshot.rollback 需要 backup_id');
  const target = snapshotStore.read(backupId);
  if (!target) throw new Error('备份不存在或已损坏：' + backupId);
  if (!target.data || typeof target.data !== 'object') throw new Error('备份缺少 data 字段，无法回滚');

  // D4-3 强制前置备份：先把「当前快照」存一份（回滚本身也可回滚）
  const safeguardId = safeguardBackup(payload, ctx, '回滚前自动备份（目标备份 ' + backupId + '）');

  // D1 校验 + 迁移 schema
  const migrated = migrateOrThrow(target.data, '备份');
  const ext = (target.ext === undefined || target.ext === null) ? {} : target.ext;

  replaceAll(data, migrated.data, ext, ctx);

  const curRev = (ctx && typeof ctx.rev === 'number') ? ctx.rev : 0;
  const targetRev = (typeof target.rev === 'number')
    ? target.rev
    : (typeof (payload && payload.target_rev) === 'number' ? payload.target_rev : null);
  return {
    safeguard_id: safeguardId,
    backup_id: backupId,
    target_rev: targetRev,
    from_rev: curRev,
    to_rev: curRev + 1,
    reason: (payload && payload.reason) || '',
    schema_steps: migrated.steps,
  };
}

/**
 * snapshot.import 执行器（W4-01 / FP-SET-15，D4-1/2/3/7）。
 * 数据来自「暂存区」data/imports/<id>.json（上传时写入），执行器从磁盘读 → 天然绕开 body 限制。
 * @param {object} data 当前快照 data（将被整包替换）
 * @param {object} payload { import_id, reason?, operator? }
 * @param {object} ctx
 */
function applySnapshotImport(data, payload, ctx) {
  const importId = String((payload && payload.import_id) || '').trim();
  if (!importId) throw new Error('snapshot.import 需要 import_id（先上传备份文件）');
  const raw = importStore.read(importId);
  if (!raw) throw new Error('导入文件不存在或已过期（暂存最多保留 ' + importStore.KEEP + ' 份）：' + importId);
  const incoming = normalizeIncomingSnapshot(raw);

  const before = countSummary({ data, ext: (ctx && ctx.store && ctx.store.ext) || {} });
  const safeguardId = safeguardBackup(payload, ctx, '导入恢复前自动备份（来源导入文件 ' + importId + '）');

  // D4-7：整包 data + ext 一起恢复（ext 是 60+ 张业务表，只恢复 data 会半残）
  const migrated = migrateOrThrow(incoming.data, '导入文件');
  replaceAll(data, migrated.data, incoming.ext, ctx);

  const curRev = (ctx && typeof ctx.rev === 'number') ? ctx.rev : 0;
  const after = countSummary({ data, ext: incoming.ext });
  return {
    safeguard_id: safeguardId,
    import_id: importId,
    incoming_rev: incoming.rev,
    from_rev: curRev,
    to_rev: curRev + 1,
    reason: (payload && payload.reason) || '',
    schema_steps: migrated.steps,
    will_discard: before,
    restored: after,
    scope: 'data+ext',
  };
}

/**
 * snapshot.reset_baseline 执行器（W4-02 / FP-SET-16，D4-1/2/3/4）。
 * @param {object} payload { baseline_version?, reason?, operator? }
 */
function applySnapshotResetBaseline(data, payload, ctx) {
  const ver = (payload && payload.baseline_version) ? String(payload.baseline_version).trim() : '';
  const base = baselineStore.read(ver || undefined, { verify: true }); // 校验和不符 → 显式抛错

  const before = countSummary({ data, ext: (ctx && ctx.store && ctx.store.ext) || {} });
  const safeguardId = safeguardBackup(
    payload, ctx, '重置基线前自动备份（目标基线 ' + base.version + '）'
  );

  const migrated = migrateOrThrow(base.data, '基线');
  replaceAll(data, migrated.data, base.ext, ctx);

  const curRev = (ctx && typeof ctx.rev === 'number') ? ctx.rev : 0;
  return {
    safeguard_id: safeguardId,
    baseline_version: base.version,
    baseline_generated_at: base.item.generated_at,
    baseline_source: base.item.source,
    checksum_ok: base.checksum_ok,
    from_rev: curRev,
    to_rev: curRev + 1,
    reason: (payload && payload.reason) || '',
    schema_steps: migrated.steps,
    will_discard: before,
    restored: countSummary({ data, ext: base.ext }),
    scope: 'data+ext',
  };
}

/*
 * W4-03 清空档位（D4-5 / D4-6）。
 *   business：只清业务数据（默认）；
 *   all     ：额外清 config / rest / 词表 / 结算模板 / 点位，回到首次安装状态（会登出、店名丢失）。
 *
 * 「保留」一律用**白名单**表达：新增主数据键必须补进 KEEP_*，否则会被当作业务数据清掉——
 * 这是有意为之的保守取向（宁可让开发显式登记，也不让新业务表漏清成「脏数据」）。
 */
const CLEAR_KEEP_DATA_KEYS = ['v', 'seq', 'rest', 'config', 'platforms', 'suppliers', 'vendors', 'pos'];
const CLEAR_KEEP_EXT_KEYS = ['accept_standards', 'pos_tables', 'fs_points', 'staff'];
/** scope=all 额外要清的「框架文件」（账号 / 结算模板 / 登录态）；org.json 缺失会自动重新播种 */
const CLEAR_ALL_FILES = ['org.json', 'settle_template.json', 'tokens.json'];

const CLEAR_SCOPES = ['business', 'all'];

/** 计算某档位清空后的目标 data / ext（纯函数，供预览与执行共用同一口径） */
function plannedClear(cur, scope) {
  const data = (cur && cur.data) || {};
  const ext = (cur && cur.ext) || {};
  if (scope === 'all') {
    return { data: { v: schema.SCHEMA_VERSION }, ext: {}, kept_data: [], kept_ext: [] };
  }
  const nextData = {};
  const keptData = [];
  for (const k of Object.keys(data)) {
    if (CLEAR_KEEP_DATA_KEYS.indexOf(k) >= 0) { nextData[k] = data[k]; keptData.push(k); }
  }
  if (nextData.v == null) nextData.v = schema.SCHEMA_VERSION;
  const nextExt = {};
  const keptExt = [];
  for (const k of Object.keys(ext)) {
    if (CLEAR_KEEP_EXT_KEYS.indexOf(k) >= 0) { nextExt[k] = ext[k]; keptExt.push(k); }
  }
  return { data: nextData, ext: nextExt, kept_data: keptData, kept_ext: keptExt };
}

/**
 * snapshot.clear 执行器（W4-03 / FP-SET-17，D4-1/2/3/5/6）。
 * @param {object} payload { scope:'business'|'all', reason?, operator? }
 */
function applySnapshotClear(data, payload, ctx) {
  const scope = String((payload && payload.scope) || 'business').trim();
  if (CLEAR_SCOPES.indexOf(scope) < 0) {
    throw new Error('snapshot.clear 的 scope 只能是 business / all（收到：' + scope + '）');
  }
  const curExt = (ctx && ctx.store && ctx.store.ext) || {};
  const before = countSummary({ data, ext: curExt });
  const safeguardId = safeguardBackup(payload, ctx, '清空数据前自动备份（scope=' + scope + '）');

  const plan = plannedClear({ data, ext: curExt }, scope);
  replaceAll(data, plan.data, plan.ext, ctx);

  // scope=all：框架文件一并清（账号回出厂默认、结算模板回默认、登录态失效 → 需重新登录）
  const removedFiles = [];
  const failedFiles = [];
  if (scope === 'all') {
    for (const name of CLEAR_ALL_FILES) {
      try {
        fs.unlinkSync(path.join(store.DATA_DIR, name));
        removedFiles.push(name);
      } catch (e) {
        if (e && e.code !== 'ENOENT') failedFiles.push(name + ':' + errMsg(e));
      }
    }
    // 红线⑦：清不掉就报错（不静默降级）——此时数据已清，回执里同时给出已删除/失败明细便于人工处理
    if (failedFiles.length) {
      throw new Error('清空框架文件失败（数据已清空，请人工处理）：' + failedFiles.join('; '));
    }
  }

  const curRev = (ctx && typeof ctx.rev === 'number') ? ctx.rev : 0;
  return {
    safeguard_id: safeguardId,
    scope,
    from_rev: curRev,
    to_rev: curRev + 1,
    reason: (payload && payload.reason) || '',
    cleared: before,
    kept_data: plan.kept_data,
    kept_ext: plan.kept_ext,
    removed_files: removedFiles,
    remaining: countSummary({ data, ext: plan.ext }),
  };
}

module.exports = {
  applySnapshotRollback,
  applySnapshotImport,
  applySnapshotResetBaseline,
  applySnapshotClear,
  countSummary,
  diffOf,
  normalizeIncomingSnapshot,
  plannedClear,
  CLEAR_SCOPES,
  CLEAR_KEEP_DATA_KEYS,
  CLEAR_KEEP_EXT_KEYS,
  CLEAR_ALL_FILES,
};
