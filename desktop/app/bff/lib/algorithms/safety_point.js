'use strict';
/*
 * lib/algorithms/safety_point.js — 食安点位主数据写算法
 *
 * 算法约定（全项目统一）：handler(ctx, data, payload) → msg 字符串；抛错 = 动作被驳回。
 * 写库走 ctx.store（execute.js 的 makeExtStore）：insert/upsert/update 作用于快照 ext.<table>，
 * 与店内 consumer 的 ext 契约一致；后续由店内 SQLite 落库。
 *
 * 动作：
 *   safety_point.upsert  按 id 幂等新增/更新一个点位（id 缺省时生成稳定唯一 id）
 *   safety_point.seed    把某 kind 的内置默认点位批量导入为可编辑点位（一次审批）
 *   safety_point.remove  逻辑删除（enabled=0），不断历史台账的 node_id 引用
 */

const crypto = require('crypto');
const sp = require('../safety_points');

function nowIso() {
  return new Date().toISOString();
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function numSort(v) {
  const n = parseInt(v, 10);
  return isFinite(n) ? n : 0;
}

/** 生成自定义点位 id：U + 时间戳 base36 + 随机，避免与内置 K/F/C/D 前缀冲突 */
function newPointId() {
  return 'U' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function requireStore(ctx, op) {
  if (!ctx || !ctx.store) throw new Error('safety_point.' + op + ' 需要可写 store');
}

function rowFromPayload(p) {
  return {
    id: str(p.id) || newPointId(),
    name: str(p.name),
    zone: str(p.zone),
    kind: str(p.kind),
    every30: p.every30 ? 1 : 0,
    demo_image_key: p.demo_image_key === undefined || p.demo_image_key === null ? null : String(p.demo_image_key),
    demo_image_url: p.demo_image_url === undefined || p.demo_image_url === null ? null : String(p.demo_image_url),
    enabled: 1,
    sort: numSort(p.sort),
    note: p.note === undefined || p.note === null ? null : String(p.note),
    ts: nowIso()
  };
}

/** safety_point.upsert：按 id 幂等新增/更新 */
function upsertSafetyPoint(ctx, data, payload) {
  const p = payload || {};
  const kind = str(p.kind);
  if (!sp.isKind(kind)) throw new Error('safety_point kind 必填(inspection|disinfect)');
  const name = str(p.name);
  if (!name) throw new Error('safety_point name 必填');
  requireStore(ctx, 'upsert');

  const row = rowFromPayload(Object.assign({}, p, { kind: kind, name: name }));
  const out = ctx.store.upsert('fs_points', row, ['id']);
  return 'fs_points.upsert id=' + row.id + ' matched=' + (out && out.matched === true ? 1 : 0);
}

/** safety_point.seed：批量导入某 kind 的内置默认点位（幂等，按 id 覆盖写入） */
function seedSafetyPoints(ctx, data, payload) {
  const p = payload || {};
  const kind = str(p.kind) || sp.KIND_INSPECTION;
  if (!sp.isKind(kind)) throw new Error('safety_point.seed kind 非法(inspection|disinfect)');
  requireStore(ctx, 'seed');

  const defs = sp.defaultPoints(kind);
  const ts = nowIso();
  defs.forEach((d) => {
    ctx.store.upsert('fs_points', Object.assign({}, d, { ts: ts }), ['id']);
  });
  return 'fs_points.seed kind=' + kind + ' count=' + defs.length;
}

/** safety_point.remove：逻辑删除（enabled=0），保留历史台账引用 */
function removeSafetyPoint(ctx, data, payload) {
  const p = payload || {};
  const id = str(p.id);
  const kind = str(p.kind);
  if (!id || !sp.isKind(kind)) throw new Error('safety_point.remove 需 id + kind(inspection|disinfect)');
  requireStore(ctx, 'remove');

  const out = ctx.store.update('fs_points', { enabled: 0, ts: nowIso() }, { id: id, kind: kind });
  // 兼容两种 store 契约：BFF ext store 返回 {count}，店内 SQLite 适配器返回 {rowcount}
  const changed = out ? (out.count != null ? out.count : out.rowcount) : 0;
  if (!changed) throw new Error('未找到可删除的自定义点位: ' + id);
  return 'fs_points.remove id=' + id;
}

module.exports = {
  newPointId,
  upsertSafetyPoint,
  seedSafetyPoints,
  removeSafetyPoint
};
