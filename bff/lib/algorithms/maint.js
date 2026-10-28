'use strict';
/*
 * lib/algorithms/maint.js — 测试期数据清理（隐藏维护能力）
 *
 * maint.row_delete：按 {table, where} 从 ext 表 / 店内表中物理删除数据行。
 * 用途：测试阶段人工清掉混入的假数据（如演示留样、演练单据），入口走审批队列。
 *
 * 边界（四道闸）：
 *   ① 表白名单：仅「运营日志类」表；账务（fin_*）、往来账（sup_accounts）、审计（app_audit）、
 *      有库存含义的单据（recv_accept / loss_*）一律禁删，防台账悬空；
 *   ② where 非空强制：防全表删；
 *   ③ 零命中抛错：动作置「已驳回」，避免误以为删掉了；
 *   ④ 红线②不变：只能经 /api/actions 提交，审批中心可见、可驳回、全程留痕。
 *
 * 正式版不暴露任何前端入口：前端需 localStorage 清理模式标志（?maint=1 激活）才显示删除按钮。
 */

const ALLOWED_TABLES = new Set([
  /* 食安域 */
  'fs_samples', 'fs_disinfect', 'fs_trace', 'fs_certs',
  /* 质检 / 叫号 */
  'qc_records', 'qc_force_pass', 'queue_serves', 'queue',
  /* 工单 / 巡检 */
  'sop_workorders', 'inspection_records', 'inspection_assignments',
  /* 设备 */
  'eq_maintain', 'eq_temp', 'eq_energy',
  /* 人员 / 会员 / 预订 */
  'staff_clock', 'staff_train', 'bookings', 'vip_coupons', 'vip_visits',
  /* 外卖 / 评价 */
  'takeout_reconcile', 'rv_reviews', 'rv_improve',
]);

function keyMatch(row, keys, where) {
  return keys.every((k) => String(row && row[k]) === String(where[k]));
}

/**
 * maint.row_delete 执行体。
 * @param {{store?:{remove?:Function}}} ctx  执行上下文（BFF apply 为 ext store，店内消费器为 sqlite store）
 * @param {object} data   快照 data（兜底回落行所在 data.ext.<table> 同步清理）
 * @param {{table:string, where:object}} payload
 * @returns {string} 执行回执
 */
function applyRowDelete(ctx, data, payload) {
  const p = payload || {};
  const table = String(p.table || '');
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error('maint.row_delete: 表不在清理白名单: ' + (table || '(空)'));
  }
  const where = p.where && typeof p.where === 'object' ? p.where : {};
  const keys = Object.keys(where).filter(
    (k) => where[k] !== undefined && where[k] !== null && where[k] !== ''
  );
  if (!keys.length) throw new Error('maint.row_delete: where 不能为空（防全表删）');

  let n = 0;
  if (ctx && ctx.store && typeof ctx.store.remove === 'function') {
    const r = ctx.store.remove(table, where);
    n = (r && r.rowcount) || 0;
  }
  /* data.ext.<table> 兜底副本同步清理（无 store 时由 ops.fallback 写入的回落行） */
  if (data && data.ext && Array.isArray(data.ext[table])) {
    const before = data.ext[table].length;
    data.ext[table] = data.ext[table].filter((row) => !keyMatch(row, keys, where));
    const m = before - data.ext[table].length;
    if (m > n) n = m;
  }
  if (!n) {
    throw new Error('maint.row_delete: 未命中任何行 ' + table + ' ' + JSON.stringify(where));
  }
  return '清理 ' + table + ' 删除 ' + n + ' 行（where=' + JSON.stringify(where) + '）';
}

module.exports = { applyRowDelete, ALLOWED_TABLES };
