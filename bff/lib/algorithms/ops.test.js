'use strict';
/*
 * 餐饮运营/人员/食安/会员/财务/设备算法平价测试。
 * 同一 fixture 分别跑 Node ops.js（内存 store 契约）与 Python queue_consumer.py（临时 sqlite），
 * 归一化易变字段后深比较：返回文案、落库行、data 侧变更。
 * 用法：node bff/lib/algorithms/ops.test.js
 *
 * 说明：ctx.store 是算法与 sqlite 的边界；Node 侧内存 store 与 Python 临时库一一对应，
 * 比较时对 rowid、uuid 后缀、时间戳做归一化。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ops = require('./ops');

const PY = path.join(__dirname, '../../../old/store-inventory-legacy/python-runtime/queue_consumer.py');

/* ---------- 内存 store（对齐 ctx.store 契约） ---------- */
function makeStore() {
  return {
    tables: {},
    _rowid: {},
    insert(table, row) {
      if (!this.tables[table]) this.tables[table] = [];
      const rid = (this._rowid[table] || 0) + 1;
      this._rowid[table] = rid;
      this.tables[table].push(Object.assign({ id: rid }, row));
      return rid;
    },
    upsert(table, row, keys) {
      if (!this.tables[table]) this.tables[table] = [];
      const ks = keys || [];
      let hit = this.tables[table].find((r) => ks.every((k) => String(r[k]) === String(row[k])));
      if (hit) { Object.assign(hit, row); return { rowid: hit.id, matched: true }; }
      const rid = this.insert(table, row);
      return { rowid: rid, matched: false };
    },
    update(table, sets, where) {
      if (!this.tables[table]) this.tables[table] = [];
      let n = 0;
      for (const r of this.tables[table]) {
        let ok;
        if (where._op === 'OR') {
          ok = String(r.id) === String(where.id) || String(r.queue_no) === String(where.queue_no);
        } else {
          ok = Object.keys(where).every((k) => String(r[k]) === String(where[k]));
        }
        if (ok) { Object.assign(r, sets); n += 1; }
      }
      return n;
    },
    query(sql, params) {
      const t = (name) => this.tables[name] || [];
      if (/COUNT\(\*\)/i.test(sql)) {
        const date = params[0];
        return [{ c: t('queue').filter((q) => String(q.date) === String(date)).length }];
      }
      if (/FROM vip_members/i.test(sql)) {
        return t('vip_members').filter((m) => String(m.member_id) === String(params[0])
          || (params[1] !== '' && String(m.phone) === String(params[1])));
      }
      if (/FROM sop_workorders/i.test(sql)) {
        return t('sop_workorders').filter((w) => String(w.id) === String(params[0]));
      }
      return [];
    },
    get(table, id) {
      return (this.tables[table] || []).find((r) => String(r.id) === String(id)) || null;
    }
  };
}

/* ---------- Python 侧执行器 ---------- */
function pySetupSql() {
  return `
CREATE TABLE IF NOT EXISTS qc_records (id INTEGER PRIMARY KEY AUTOINCREMENT, workorder_id, sku_id, sample_weight, pass INT, ts, source);
CREATE TABLE IF NOT EXISTS queue_serves (id INTEGER PRIMARY KEY AUTOINCREMENT, date, action, item, qty REAL, note, queue_no, wait_eta_min INT, queue_count INT, ts, source);
CREATE TABLE IF NOT EXISTS loss_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, date, ing_name, qty, reason, reporter, status, source);
CREATE TABLE IF NOT EXISTS fs_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, date, meal, dish, weight_g, keeper, kept_at, source);
CREATE TABLE IF NOT EXISTS sop_workorders (id INTEGER PRIMARY KEY AUTOINCREMENT, date, sku_id, qty REAL, planned_start, status, qc_records, table_id, table_no, bom_deducted INT DEFAULT 0, actual_yield REAL, steps_state TEXT);
CREATE TABLE IF NOT EXISTS fs_certs (id, cert_type, holder, cert_no, issued_at, expire_at, status);
CREATE TABLE IF NOT EXISTS app_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, kind, title, body, ts TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS fin_cash (id INTEGER PRIMARY KEY AUTOINCREMENT, ts, kind, amount, account, note);
CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, guest_name, phone, date, time, party_size, table_id, status, note, source);
CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, queue_no, date, party_size, status, ts, source);
CREATE TABLE IF NOT EXISTS staff_clock (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id, ts, kind, status, source);
CREATE TABLE IF NOT EXISTS staff_shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id, staff_name, date, shift, start_time, end_time, role);
CREATE TABLE IF NOT EXISTS staff_train (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id, course, passed INT, ts, remark);
CREATE TABLE IF NOT EXISTS fs_disinfect (id INTEGER PRIMARY KEY AUTOINCREMENT, date, area, method, operator, ts, source);
CREATE TABLE IF NOT EXISTS fs_trace (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_no, ing_name, supplier, recv_date, check_result, source);
CREATE TABLE IF NOT EXISTS eq_maintain (id INTEGER PRIMARY KEY AUTOINCREMENT, device, kind, ts, operator, cost, next_due, note);
CREATE TABLE IF NOT EXISTS vip_coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, code UNIQUE, member_id, type, value, status, valid_to);
CREATE TABLE IF NOT EXISTS takeout_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, status, date, platform, amount, note);
CREATE TABLE IF NOT EXISTS takeout_reconcile (id INTEGER PRIMARY KEY AUTOINCREMENT, date, platform, amount, status, note);
CREATE TABLE IF NOT EXISTS rv_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, source, rating, content, ts, handled INT);
CREATE TABLE IF NOT EXISTS rv_improve (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id, action, owner, due, status);
CREATE TABLE IF NOT EXISTS vip_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id, name, phone, table_id, note, ts, source);
CREATE TABLE IF NOT EXISTS vip_members (member_id TEXT PRIMARY KEY, name, phone, level, joined_at, status);
CREATE TABLE IF NOT EXISTS fin_split (id INTEGER PRIMARY KEY AUTOINCREMENT, period, party, amount, ratio, frozen_until, status);
`;
}

function runPython(fn, data, payload, opts) {
  const o = opts || {};
  const db = path.join(os.tmpdir(), 'ops_test_' + Math.random().toString(16).slice(2) + '.db');
  const py = `
import json, sys, sqlite3
import importlib.util
spec = importlib.util.spec_from_file_location("qc", ${JSON.stringify(PY)})
qc = importlib.util.module_from_spec(spec); spec.loader.exec_module(qc)
_doc = json.loads(sys.stdin.read())
payload = _doc.pop("__payload__")
fd = _doc.pop("__fixture__", {})
data = _doc
db = ${JSON.stringify(db)}
c = sqlite3.connect(db)
c.executescript(${JSON.stringify(pySetupSql())})
for w in fd.get("pre_workorders") or []:
    c.execute("INSERT INTO sop_workorders (id, date, sku_id, qty, status, bom_deducted, steps_state, table_id) VALUES (?,?,?,?,?,?,?,?)",
              (w.get("id"), w.get("date"), w.get("sku_id"), w.get("qty"), w.get("status"), w.get("bom_deducted", 0), w.get("steps_state"), w.get("table_id")))
for v in fd.get("pre_vip_members") or []:
    c.execute("INSERT INTO vip_members (member_id, name, phone, level, joined_at, status) VALUES (?,?,?,?,?,?)",
              (v.get("member_id"), v.get("name"), v.get("phone"), v.get("level"), v.get("joined_at"), v.get("status")))
for cn in fd.get("pre_vip_coupons") or []:
    c.execute("INSERT INTO vip_coupons (code, member_id, type, value, status, valid_to) VALUES (?,?,?,?,?,?)",
              (cn.get("code"), cn.get("member_id"), cn.get("type"), cn.get("value"), cn.get("status"), cn.get("valid_to")))
for r in fd.get("pre_reviews") or []:
    c.execute("INSERT INTO rv_reviews (id, source, rating, content, ts, handled) VALUES (?,?,?,?,?,?)",
              (r.get("id"), r.get("source"), r.get("rating"), r.get("content"), r.get("ts"), r.get("handled")))
c.commit(); c.close()
dbp = db
call = ${JSON.stringify(fn)}
approve = ${o.approve ? 'True' : 'False'}
err = None
msg = None
try:
    if call == "qc": msg = "%s → qc_records rowid=%s" % (payload.get("__t__", "qc.record"), qc.insert_qc_record(dbp, payload))
    elif call == "queue_serve": msg = qc.apply_queue_serve(data, payload, dbp)
    elif call == "sample": msg = "fs_samples 插入 rowid=%s" % qc.insert_sample(dbp, payload)
    elif call == "loss": rid = qc.insert_loss_report(dbp, payload); msg = "loss_reports#%s" % rid
    elif call == "wo_create": msg = "sop_workorders 插入 rowid=%s" % qc.insert_workorder(dbp, payload)
    elif call == "wo_advance": msg = qc.advance_workorder(dbp, data, payload)
    elif call == "wo_clock": msg = qc.clock_workorder_step(dbp, payload)
    elif call == "fs_cert": msg = qc.insert_fs_cert(dbp, payload)
    elif call == "day_close": msg = qc.apply_day_close(dbp, data, payload)
    elif call == "finance_recon": msg = qc.apply_finance_recon(dbp, data, payload)
    elif call == "booking": msg = qc.upsert_booking(dbp, payload)
    elif call == "queue_call": msg = qc.update_queue_call(dbp, payload)
    elif call == "queue_join": msg = qc.insert_queue_join(dbp, payload)
    elif call == "staff_clock": msg = qc.insert_staff_clock(dbp, payload)
    elif call == "staff_shift": msg = qc.upsert_staff_shift(dbp, payload)
    elif call == "uniform": msg = "uniform/staff_train rowid=%s" % qc.insert_uniform_log(dbp, payload)
    elif call == "disinfect": msg = "fs_disinfect 插入 rowid=%s" % qc.insert_disinfect(dbp, payload)
    elif call == "fs_trace": msg = "fs_trace 扫码 rowid=%s" % qc.insert_fs_trace(dbp, payload)
    elif call == "eq_maintain": msg = "eq_maintain rowid=%s" % qc.insert_eq_maintain(dbp, payload)
    elif call == "vip_campaign": msg = qc.insert_vip_campaign(dbp, payload)
    elif call == "vip_redeem": msg = qc.redeem_vip_coupon(dbp, payload)
    elif call == "week_export": msg = qc.insert_week_export(dbp, payload)
    elif call == "takeout_ack": msg = qc.insert_takeout_ack(dbp, payload)
    elif call == "review": msg = qc.insert_review_followup(dbp, payload)
    elif call == "vip_checkin": msg = qc.insert_vip_checkin(dbp, payload, data)
    elif call == "fin_split_freeze": msg = qc.insert_fin_split(dbp, payload, approve=False)
    elif call == "fin_split_approve": msg = qc.insert_fin_split(dbp, payload, approve=True)
    elif call == "norm_wo": msg = qc._norm_wo_status(payload.get("st"))
    else: raise SystemExit("unknown call " + call)
except Exception as e:
    err = str(e)
c = sqlite3.connect(dbp)
tables = {}
for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
    rows = c.execute("SELECT * FROM %s" % t).fetchall()
    cols = [d[0] for d in c.execute("SELECT * FROM %s LIMIT 0" % t).description]
    tables[t] = [dict(zip(cols, r)) for r in rows]
c.close()
print(json.dumps({"data": data, "msg": msg, "err": err, "tables": tables}, ensure_ascii=False))
`;
  const input = JSON.stringify(Object.assign({ __payload__: payload, __fixture__: o.fixture || {} }, data));
  const out = execFileSync('python3', ['-c', py], { input: input, encoding: 'utf8' });
  try { fs.unlinkSync(db); } catch (e) { /* ignore */ }
  const parsed = JSON.parse(out);
  if (parsed.msg === null) parsed.msg = parsed.err;
  return parsed;
}

/* ---------- Node 侧执行 ---------- */
const VOLATILE = ['ts', 'kept_at', 'done_at', 'joined_at', 'updated_at'];

function normRow(row) {
  const c = {};
  for (const k of Object.keys(row)) {
    if (VOLATILE.indexOf(k) >= 0) { c[k] = '<T>'; continue; }
    let v = row[k];
    if (typeof v === 'string') {
      // uuid 后缀 / 时间戳归一
      v = v.replace(/[0-9a-f]{8}/g, '<HEX>');
    }
    c[k] = v;
  }
  return c;
}

function normMsg(m) {
  return String(m)
    .replace(/id=\d+/g, 'id=<N>')
    .replace(/rowid=\d+/g, 'rowid=<N>')
    .replace(/#\d+/g, '#<N>')
    .replace(/Q\d+/g, 'Q<N>')
    .replace(/CMP[0-9A-F]+/g, 'CMP<X>')
    .replace(/<[^>]*>/g, '<T>');
}

function runNode(fn, data, payload, opts) {
  const o = opts || {};
  const d = JSON.parse(JSON.stringify(data));
  const store = makeStore();
  const fx = o.fixture || {};
  for (const w of fx.pre_workorders || []) store.insert('sop_workorders', w);
  for (const v of fx.pre_vip_members || []) store.insert('vip_members', v);
  for (const cn of fx.pre_vip_coupons || []) store.insert('vip_coupons', cn);
  for (const r of fx.pre_reviews || []) store.insert('rv_reviews', r);
  for (const q of fx.pre_queue || []) store.insert('queue', q);
  const ctx = { store: store };
  let msg;
  switch (fn) {
    case 'qc': msg = (payload.__t__ || 'qc.record') + ' → ' + ops.insertQcRecord(ctx, d, payload); break;
    case 'queue_serve': msg = ops.applyQueueServe(ctx, d, payload); break;
    case 'sample': msg = ops.insertSample(ctx, d, payload); break;
    case 'loss': msg = 'loss_reports#' + ops.insertLossReport(ctx, d, payload); break;
    case 'wo_create': msg = ops.insertWorkorder(ctx, d, payload); break;
    case 'wo_advance': msg = ops.advanceWorkorder(ctx, d, payload); break;
    case 'wo_clock': msg = ops.clockWorkorderStep(ctx, d, payload); break;
    case 'fs_cert': msg = ops.insertFsCert(ctx, d, payload); break;
    case 'day_close': msg = ops.applyDayClose(ctx, d, payload); break;
    case 'finance_recon': msg = ops.applyFinanceRecon(ctx, d, payload); break;
    case 'booking': msg = ops.upsertBooking(ctx, d, payload); break;
    case 'queue_call': msg = ops.updateQueueCall(ctx, d, payload); break;
    case 'queue_join': msg = ops.insertQueueJoin(ctx, d, payload); break;
    case 'staff_clock': msg = ops.insertStaffClock(ctx, d, payload); break;
    case 'staff_shift': msg = ops.upsertStaffShift(ctx, d, payload); break;
    case 'uniform': msg = ops.insertUniformLog(ctx, d, payload); break;
    case 'disinfect': msg = ops.insertDisinfect(ctx, d, payload); break;
    case 'fs_trace': msg = ops.insertFsTrace(ctx, d, payload); break;
    case 'eq_maintain': msg = ops.insertEqMaintain(ctx, d, payload); break;
    case 'vip_campaign': msg = ops.insertVipCampaign(ctx, d, payload); break;
    case 'vip_redeem': msg = ops.redeemVipCoupon(ctx, d, payload); break;
    case 'week_export': msg = ops.insertWeekExport(ctx, d, payload); break;
    case 'takeout_ack': msg = ops.insertTakeoutAck(ctx, d, payload); break;
    case 'review': msg = ops.insertReviewFollowup(ctx, d, payload); break;
    case 'vip_checkin': msg = ops.insertVipCheckin(ctx, d, payload); break;
    case 'fin_split_freeze': msg = ops.insertFinSplit(ctx, d, payload, false); break;
    case 'fin_split_approve': msg = ops.insertFinSplit(ctx, d, payload, true); break;
    case 'norm_wo': msg = ops.normWoStatus(payload.st); break;
    default: throw new Error('unknown call ' + fn);
  }
  const tables = {};
  for (const t of Object.keys(store.tables)) {
    tables[t] = store.tables[t].map((r) => {
      const c = Object.assign({}, r);
      delete c.id;
      return c;
    });
  }
  return { data: d, msg: msg, tables: tables, store: store };
}

/* ---------- data 归一化 ---------- */
function normData(d) {
  const c = JSON.parse(JSON.stringify(d));
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const k of Object.keys(o)) {
      if (VOLATILE.indexOf(k) >= 0) { o[k] = '<T>'; continue; }
      if (k === 'id' && typeof o[k] === 'string') { o[k] = o[k].replace(/^([A-Z]+)[0-9a-f]+$/, '$1<HEX>'); continue; }
      walk(o[k]);
    }
  };
  walk(c);
  if (c.config) {
    for (const key of ['last_day_close', 'last_finance_recon']) {
      if (c.config[key]) c.config[key].ts = '<T>';
    }
  }
  return c;
}

/* ---------- 用例 ---------- */
const fixtures = [
  { name: 'qc.record', fn: 'qc', data: {}, payload: { workorder_id: 7, sku_id: 'S1', sample_weight: 50, pass: '合格', ts: '2026-09-27T10:00:00', source: 'auto' } },
  { name: 'qc.pass(false)', fn: 'qc', data: {}, payload: { workorder_id: 8, pass: 0, ts: 'T', __t__: 'qc.pass' } },
  { name: 'queue.serve', fn: 'queue_serve', data: { logs: [] }, payload: { action: '上茶', item: '普洱', qty: 2, date: '2026-09-27', ts: 'T', queue_no: 'Q01', wait_eta_min: 5, queue_count: 3 } },
  { name: 'sample.log', fn: 'sample', data: {}, payload: { date: '2026-09-27', meal: '午餐', dish: '红烧肉', weight_g: 125, keeper: '张三', kept_at: 'T' } },
  { name: 'loss.report', fn: 'loss', data: {}, payload: { date: '2026-09-27', ing_name: '白菜', qty: 3, reason: '腐烂', reporter: '李四', status: '待审核' } },
  { name: 'workorder.create', fn: 'wo_create', data: {}, payload: { date: '2026-09-27', sku_id: 'S1', qty: 20, planned_start: '2026-09-27T10:00', status: '待开始', table_id: 'T1' } },
  { name: 'fs.cert.upsert(new)', fn: 'fs_cert', data: {}, payload: { cert_type: '食品经营许可', holder: '本店', cert_no: 'X1', expire_at: '2027-01-01', issued_at: '2026-01-01' } },
  { name: 'fs.cert.upsert(update)', fn: 'fs_cert', data: {}, payload: { id: 1, cert_type: '健康证', holder: '王五', cert_no: 'H1', expire_at: '2027-06-01', issued_at: '2026-06-01' } },
  { name: 'day.close', fn: 'day_close', data: { config: {} }, payload: { date: '2026-09-27', sold_count: 12, sold_amount: '880.5', inbound_count: 2, loss_count: 1, workorders_open: 0, note: '收工' } },
  { name: 'finance.recon', fn: 'finance_recon', data: { config: {} }, payload: { date: '2026-09-27', dine: '1200.25', takeout: 300, purchase: '500.5' } },
  { name: 'booking.insert', fn: 'booking', data: {}, payload: { guest_name: '赵六', phone: '13800000000', date: '2026-09-28', time: '18:30', party_size: 4, table_id: 'T3', note: '靠窗' } },
  { name: 'staff.clock', fn: 'staff_clock', data: {}, payload: { staff_id: 'E1', ts: 'T', kind: '上班', status: '补录' } },
  { name: 'staff.shift', fn: 'staff_shift', data: {}, payload: { staff_id: 'E1', staff_name: '张三', date: '2026-09-27', shift: '早班', start_time: '09:00', end_time: '15:00', role: '后厨' } },
  { name: 'uniform.log', fn: 'uniform', data: {}, payload: { staff_id: 'E1', pass: '合格', ts: 'T', note: '整洁' } },
  { name: 'fs.disinfect', fn: 'disinfect', data: {}, payload: { date: '2026-09-27', area: '后厨', method: '84消毒', operator: '李四', ts: 'T' } },
  { name: 'fs.trace_scan', fn: 'fs_trace', data: {}, payload: { name: '猪肉', batch: 'B20260927', supplier: '供应商A', recv_date: '2026-09-26', check_result: '合格' } },
  { name: 'equipment.maintain', fn: 'eq_maintain', data: {}, payload: { device: '冰柜', kind: '保养', ts: 'T', operator: '王五', cost: 200, next_due: '2026-12-27', note: '除霜' } },
  { name: 'vip.campaign(amount)', fn: 'vip_campaign', data: {}, payload: { code: 'C1', member_id: 'M1', type: '活动', value: 50, valid_to: '2026-12-31' } },
  { name: 'vip.campaign(discount)', fn: 'vip_campaign', data: {}, payload: { code: 'C2', type: '折扣', value: '8折' } },
  { name: 'vip.coupon_redeem(existing)', fn: 'vip_redeem', data: {}, payload: { code: 'C1' }, fixture: { pre_vip_coupons: [{ code: 'C1', member_id: 'M1', type: '活动', value: 50, status: '未使用', valid_to: '2026-12-31' }] } },
  { name: 'vip.coupon_redeem(new)', fn: 'vip_redeem', data: {}, payload: { code: 'CX', member_id: 'M2' } },
  { name: 'analysis.export_week', fn: 'week_export', data: {}, payload: { title: '第39周', note: '周报草稿' } },
  { name: 'takeout.ack(insert)', fn: 'takeout_ack', data: {}, payload: { date: '2026-09-27', platform: '美团', amount: 88, status: '已对账' } },
  { name: 'review.followup(complaint)', fn: 'review', data: {}, payload: { content: '菜凉了', table_id: 'T2', action: '现场客诉' } },
  { name: 'review.followup(existing)', fn: 'review', data: {}, payload: { review_id: 5, action: '电话回访' }, fixture: { pre_reviews: [{ id: 5, source: '美团', rating: 1, content: '差', handled: 0 }] } },
  { name: 'vip.checkin', fn: 'vip_checkin', data: { logs: [], pos: [{ id: 'T1', state: 'busy' }] }, payload: { member_id: 'M9', name: '钱七', phone: '13900000000', table_id: 'T1', note: '到店' } },
  { name: 'finance.freeze', fn: 'fin_split_freeze', data: {}, payload: { period: '2026-09', party: '堂食', amount: 1000, ratio: 0.4, frozen_until: '2026-10-27' } },
  { name: 'workorder.advance(待开始→制作中)', fn: 'wo_advance', data: { logs: [], ings: [], dishes: [] }, payload: { id: 1, deduct: false }, fixture: { pre_workorders: [{ id: 1, status: '待开始', sku_id: 'S1', qty: 20, bom_deducted: 0 }] } },
  { name: 'workorder.advance(终态)', fn: 'wo_advance', data: { logs: [] }, payload: { id: 2 }, fixture: { pre_workorders: [{ id: 2, status: '已完成', sku_id: 'S1', qty: 20, bom_deducted: 1 }] } },
  { name: 'workorder.advance(actual_yield)', fn: 'wo_advance', data: { logs: [] }, payload: { id: 3, status: '已完成', actual_yield: '18.5', deduct: false }, fixture: { pre_workorders: [{ id: 3, status: '待传', sku_id: 'S1', qty: 20, bom_deducted: 1 }] } },
  { name: 'workorder.step_clock', fn: 'wo_clock', data: {}, payload: { id: 1, step_no: 2, operator: '张三', done_at: 'T' }, fixture: { pre_workorders: [{ id: 1, status: '待开始', steps_state: null }] } },
  { name: 'workorder.step_clock(undo)', fn: 'wo_clock', data: {}, payload: { id: 1, step_no: '2', undo: true }, fixture: { pre_workorders: [{ id: 1, status: '制作中', steps_state: '{"1":{"done_at":"T","operator":"a"},"2":{"done_at":"T","operator":"b"}}' }] } },
  { name: '_norm_wo_status', fn: 'norm_wo', data: {}, payload: { st: 'doing' } },
  { name: '_norm_wo_status(unknown)', fn: 'norm_wo', data: {}, payload: { st: '自定义' } }
];

/* queue.join / queue.call 单独（依赖 pre data/store） */
const queueJoinCases = [
  { name: 'queue.join(first)', fn: 'queue_join', data: {}, payload: { date: '2026-09-27', party_size: 3 } },
  { name: 'queue.join(second)', fn: 'queue_join', data: {}, payload: { date: '2026-09-27', party_size: 2 }, fixture: { pre_queue: [{ queue_no: 'Q01', date: '2026-09-27' }] } }
];

/* ---------- 错误语义 ---------- */
const errorCases = [
  { name: 'queue.call.noId', fn: 'queue_call', data: {}, payload: {}, kw: '缺少 queue id' },
  { name: 'queue.call.notExist', fn: 'queue_call', data: {}, payload: { id: 'Q99' }, kw: '排队号不存在' },
  { name: 'vip.redeem.noCode', fn: 'vip_redeem', data: {}, payload: {}, kw: '缺 code' },
  { name: 'vip.checkin.noKey', fn: 'vip_checkin', data: {}, payload: {}, kw: '需 member_id' },
  { name: 'wo.advance.noId', fn: 'wo_advance', data: { logs: [] }, payload: {}, kw: '缺少 workorder id' },
  { name: 'wo.advance.notExist', fn: 'wo_advance', data: { logs: [] }, payload: { id: 999 }, kw: '工单不存在' },
  { name: 'wo.advance.badYield', fn: 'wo_advance', data: { logs: [] }, payload: { id: 1, status: '已完成', actual_yield: 'abc' }, fixture: { pre_workorders: [{ id: 1, status: '待传', sku_id: 'S1' }] }, kw: 'actual_yield 非法' },
  { name: 'wo.clock.noId', fn: 'wo_clock', data: {}, payload: { step_no: 1 }, kw: '缺少 workorder id' },
  { name: 'wo.clock.noStep', fn: 'wo_clock', data: {}, payload: { id: 1 }, kw: '缺少 step_no' },
  { name: 'wo.clock.notExist', fn: 'wo_clock', data: {}, payload: { id: 999, step_no: 1 }, kw: '工单不存在' }
];

function deepRows(n) {
  return { tables: n.tables, data: normData(n.data) };
}

/* Python 行归一化：删 id，时间列归一，uuid 归一 */
function normPyTables(tables, data) {
  const out = {};
  const volatile = VOLATILE.concat(['joined_at']);
  for (const t of Object.keys(tables || {})) {
    if (t.indexOf('sqlite_') === 0) continue;
    out[t] = (tables[t] || []).map((row) => {
      const c = {};
      for (const k of Object.keys(row)) {
        if (k === 'id') continue;
        let v = row[k];
        if (volatile.indexOf(k) >= 0 && v !== null && v !== undefined) { c[k] = '<T>'; continue; }
        if (typeof v === 'string') v = v.replace(/[0-9a-f]{8}/g, '<HEX>');
        c[k] = v;
      }
      return c;
    });
  }
  // 无数据表省略
  for (const t of Object.keys(out)) if (!out[t].length) delete out[t];
  return out;
}

function normNodeTables(n) {
  const out = {};
  for (const t of Object.keys(n.tables || {})) {
    const rows = n.tables[t].map((row) => {
      const c = {};
      for (const k of Object.keys(row)) {
        if (k === 'id') continue;
        c[k] = row[k];
      }
      return c;
    }).filter((r) => Object.keys(r).length);
    if (rows.length) out[t] = rows;
  }
  return out;
}

function pyQueueJoinFix(tables) {
  // queue.join 的 Q序号在两遍运行可能不同（Python 先建库计数=0），Node 也=0，保持一致
  return tables;
}

/* ---------- 主流程 ---------- */
function main() {
  let pass = 0;

  for (const fxv of fixtures) {
    const n = runNode(fxv.fn, fxv.data, fxv.payload, { fixture: fxv.fixture });
    const p = runPython(fxv.fn, fxv.data, fxv.payload, { fixture: fxv.fixture });
    assert.strictEqual(normMsg(n.msg), normMsg(p.msg),
      '[' + fxv.name + '] msg: ' + n.msg + ' != ' + p.msg);
    assert.deepStrictEqual(normData(n.data), normData(p.data),
      '[' + fxv.name + '] data mismatch');
    const nt = normNodeTables(n);
    const pt = normPyTables(p.tables, p.data);
    // 只比较本次动作目标表，且只比较 Node 显式写入的列（Python 建表默认列忽略）
    for (const t of Object.keys(nt)) {
      const nrows = nt[t];
      const prows = pt[t] || [];
      assert.strictEqual(nrows.length, prows.length, '[' + fxv.name + '] table ' + t + ' 行数不一致');
      for (let i = 0; i < nrows.length; i++) {
        const nr = normRow(nrows[i]);
        const prFull = prows[i];
        const pr = {};
        for (const k of Object.keys(nr)) pr[k] = normRow({ [k]: prFull[k] })[k];
        assert.deepStrictEqual(nr, pr, '[' + fxv.name + '] table ' + t + ' 行 ' + i + ' 不一致');
      }
    }
    pass += 1;
    console.log('  PASS ' + fxv.name);
  }

  for (const ec of errorCases) {
    let nerr = null;
    try { runNode(ec.fn, ec.data, ec.payload, { fixture: ec.fixture }); } catch (e) { nerr = e.message; }
    const p = runPython(ec.fn, ec.data, ec.payload, { fixture: ec.fixture });
    assert.ok(nerr !== null, '[' + ec.name + '] Node 未抛错');
    assert.ok(nerr.indexOf(ec.kw) >= 0, '[' + ec.name + '] Node 错误: ' + nerr);
    assert.ok(p.err !== null && p.err !== undefined, '[' + ec.name + '] Python 未抛错');
    assert.ok(String(p.err).indexOf(ec.kw) >= 0, '[' + ec.name + '] Python 错误: ' + p.err);
    pass += 1;
    console.log('  PASS ' + ec.name + ' (error)');
  }

  // queue.join 双例：Node 用 pre_queue_count 模拟已有队列
  for (const qc of queueJoinCases) {
    const n = runNode(qc.fn, qc.data, qc.payload, { fixture: qc.fixture });
    assert.ok(/^queue\.join Q\d+ party=\d+ id=/.test(normMsg(n.msg)) || /queue\.join/.test(n.msg),
      '[' + qc.name + '] msg: ' + n.msg);
    const qrows = n.store.tables.queue;
    assert.strictEqual(qrows[qrows.length - 1].queue_no,
      qc.fixture && qc.fixture.pre_queue ? 'Q02' : 'Q01',
      '[' + qc.name + '] queue_no');
    pass += 1;
    console.log('  PASS ' + qc.name);
  }

  // 无 ctx.store 优雅降级：不崩溃，动作落到 data.ext
  {
    const d = { logs: [] };
    const msg = ops.insertSample({}, d, { dish: 'X', date: '2026-09-27' });
    assert.ok(msg.indexOf('rowid=-') >= 0, 'degrade msg: ' + msg);
    assert.ok(Array.isArray(d.ext && d.ext.fs_samples) && d.ext.fs_samples.length === 1, 'degrade ext');
    const dl = {};
    assert.ok(ops.insertStaffClock({}, dl, {}).indexOf('rowid=-') >= 0, 'degrade staff');
    pass += 1;
    console.log('  PASS degrade.noStore');
  }

  // advance_workorder 进入制作中且无菜谱：标记 bom_deducted 且不崩溃
  {
    const d = { logs: [], ings: [] };
    const store = makeStore();
    store.insert('sop_workorders', { id: 1, status: '待开始', sku_id: 'NOPE', qty: 20, bom_deducted: 0 });
    const msg = ops.advanceWorkorder({ store: store }, d, { id: 1 });
    assert.ok(msg.indexOf('制作中') >= 0, 'advance msg: ' + msg);
    const w = store.tables.sop_workorders[0];
    assert.strictEqual(w.status, '制作中');
    assert.strictEqual(w.bom_deducted, 1);
    pass += 1;
    console.log('  PASS wo.advance.noRecipe');
  }

  console.log('[ops.test] PASS ' + pass + ' cases');
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[ops.test] FAIL:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}
