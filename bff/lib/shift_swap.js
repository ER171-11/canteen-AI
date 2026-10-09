'use strict';
/*
 * lib/shift_swap.js — 换班「双确认」审批流（M2-T4/T5）
 *
 *   pending_peer（A 发起 → 待接手人 B 同意）
 *     → pending_manager（待店长审批）
 *       → applied（店长审批通过，写回入 actions 队列）
 *       | rejected（任一环节驳回）
 *
 * 红线：
 *   - 只有「店长审批通过」才写回；写回统一入 actions 队列（queued → 确认台 → 店内消费器 → rev 乐观锁），
 *     BFF 不直写店内 DB；
 *   - accept / approve 均做 rev 乐观锁校验，避免基于过期快照操作；
 *   - 本模块仅维护审批单状态（bff/data/shift_swaps.json），不触碰店内库。
 */
const crypto = require('crypto');
const store = require('./store');

const FILE = 'shift_swaps.json';
const OPEN = ['pending_peer', 'pending_manager'];

function load() {
  const a = store.readJSON(FILE, null);
  return Array.isArray(a) ? a : [];
}
function save(a) { store.writeJSON(FILE, a); }
function trim(v) { return String(v == null ? '' : v).trim(); }
function byId(a, id) { return a.find((v) => String(v.id) === String(id)); }

/** 列表（创建时间倒序，可按状态过滤） */
function list(status) {
  const a = load().slice();
  a.sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')));
  return status ? a.filter((x) => x.status === status) : a;
}
function get(id) { return byId(load(), id); }

/** 发起换班（A 发起，指定接手人 B）；携带班次时段供审批通过后组 payload */
function request(body, actor) {
  const b = body || {};
  const date = trim(b.date), shift = trim(b.shift);
  const from = trim(b.from_staff), to = trim(b.to_staff);
  if (!date || !shift || !from || !to) {
    return { ok: false, status: 400, error: '需 date / shift / from_staff / to_staff' };
  }
  if (from === to) return { ok: false, status: 400, error: '接手人不能与申请人相同' };

  const a = load();
  const dup = a.find((x) => OPEN.indexOf(x.status) >= 0 && x.date === date && x.shift === shift && x.from_staff === from);
  if (dup) return { ok: false, status: 409, error: '该班次已有进行中的换班申请', id: dup.id };

  const now = new Date().toISOString();
  const rec = {
    id: 'sw_' + crypto.randomBytes(6).toString('hex'),
    date, shift,
    shift_start: trim(b.start_time) || null,
    shift_end: trim(b.end_time) || null,
    shift_role: trim(b.role) || null,
    from_staff: from, from_name: trim(b.from_name) || null,
    to_staff: to, to_name: trim(b.to_name) || null,
    reason: trim(b.reason) || null,
    status: 'pending_peer',
    requested_by: (actor && (actor.account || actor.role)) || null,
    peer_by: null, peer_at: null,
    created_at: now, updated_at: now,
    approved_by: null, approved_at: null,
    rejected_by: null, rejected_at: null, reject_reason: null,
    base_rev: null, applied_rev: null, write_actions: []
  };
  a.push(rec);
  save(a);
  return { ok: true, swap: rec };
}

/** B 同意（rev 乐观锁）→ pending_manager */
function accept(id, actor, curRev, rev) {
  const a = load();
  const x = byId(a, id);
  if (!x) return { ok: false, status: 404, error: 'not found' };
  if (x.status !== 'pending_peer') return { ok: false, status: 409, error: '状态不允许同意：' + x.status };
  if (rev != null && curRev != null && String(rev) !== String(curRev)) {
    return { ok: false, status: 409, error: 'rev mismatch', expected_rev: curRev };
  }
  x.status = 'pending_manager';
  x.peer_at = new Date().toISOString();
  x.updated_at = x.peer_at;
  x.base_rev = curRev == null ? null : curRev;
  x.peer_by = (actor && (actor.account || actor.role)) || null;
  save(a);
  return { ok: true, swap: x };
}

/** 驳回（申请人 / 接手人 / 店长均可） */
function reject(id, actor, reason) {
  const a = load();
  const x = byId(a, id);
  if (!x) return { ok: false, status: 404, error: 'not found' };
  if (OPEN.indexOf(x.status) < 0) return { ok: false, status: 409, error: '状态不允许驳回：' + x.status };
  x.status = 'rejected';
  x.rejected_by = (actor && (actor.account || actor.role)) || null;
  x.rejected_at = new Date().toISOString();
  x.reject_reason = trim(reason) || '未说明';
  x.updated_at = x.rejected_at;
  save(a);
  return { ok: true, swap: x };
}

/**
 * 店长审批通过 → 写回排班（入 actions 队列）。
 * 写回口径：接手人 B 获得该班次；原值班人 A 当日该班转「休」。
 * @param enqueue (type, payload, actor) => id  注入，避免与 routes/actions 循环依赖
 */
function approve(id, actor, curRev, rev, enqueue) {
  const a = load();
  const x = byId(a, id);
  if (!x) return { ok: false, status: 404, error: 'not found' };
  if (x.status !== 'pending_manager') return { ok: false, status: 409, error: '状态不允许审批：' + x.status };
  if (rev != null && curRev != null && String(rev) !== String(curRev)) {
    return { ok: false, status: 409, error: 'rev mismatch', expected_rev: curRev };
  }
  if (typeof enqueue !== 'function') return { ok: false, status: 500, error: 'enqueue 未注入' };

  const base = {
    date: x.date, shift: x.shift,
    start_time: x.shift_start, end_time: x.shift_end, role: x.shift_role
  };
  const ids = [];
  try {
    const to = enqueue('staff.shift_upsert', Object.assign({}, base, {
      staff_id: x.to_staff, staff_name: x.to_name, swap_id: x.id, reason: '换班接手'
    }), actor);
    if (to) ids.push(to);
    const from = enqueue('staff.shift_upsert', Object.assign({}, base, {
      staff_id: x.from_staff, staff_name: x.from_name, shift: '休',
      start_time: null, end_time: null, swap_id: x.id, reason: '换班转休'
    }), actor);
    if (from) ids.push(from);
  } catch (e) {
    return { ok: false, status: 500, error: '写回入队失败：' + (e && e.message) };
  }

  x.status = 'applied';
  x.approved_by = (actor && (actor.account || actor.role)) || null;
  x.approved_at = new Date().toISOString();
  x.updated_at = x.approved_at;
  x.applied_rev = curRev == null ? null : curRev;
  x.write_actions = ids;
  save(a);
  return { ok: true, swap: x, write_actions: ids };
}

module.exports = { FILE, OPEN, list, get, request, accept, reject, approve };
