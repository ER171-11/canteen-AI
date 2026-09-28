'use strict';
/*
 * POS/桌台/收银 + BOM 扣料算法平价测试。
 * 同一 fixture 分别跑 Node pos.js 与 Python queue_consumer.py，归一化易变字段后深比较。
 * 用法：node bff/lib/algorithms/pos.test.js
 *
 * BOM 场景：Python 用临时 sqlite(recipes/sop_workorders)；Node 侧用等价内存 store
 * （ctx.recipes 提供菜谱行，ctx.store 提供 query/insert/update），因 store 适配层是
 * 算法与 sqlite 的边界，语义保持一一对应。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pos = require('./pos');
const { runPython: execPy } = require('./_python');

const PY = path.join(__dirname, '../../../old/store-inventory-legacy/python-runtime/queue_consumer.py');

/* ---------- 内存 store（对齐 ctx.store 契约） ---------- */
function makeStore(opts) {
  const o = opts || {};
  return {
    recipes: o.recipes || [],
    workorders: o.workorders || [],
    inserts: [],
    updates: [],
    query(sql, params) {
      if (/FROM recipes/i.test(sql)) {
        const key = String(params[0]);
        if (/sku_id=\?/i.test(sql)) return this.recipes.filter((r) => String(r.sku_id) === key);
        return this.recipes.filter((r) => String(r.name) === key);
      }
      if (/FROM sop_workorders/i.test(sql)) {
        return this.workorders.filter((w) => w.bom_deducted === 1
          && w.table_id === String(params[1])
          && String(w.date) === String(params[0]));
      }
      return [];
    },
    insert(table, row) {
      this.inserts.push({ table, row });
      if (table === 'sop_workorders') this.workorders.push(Object.assign({ id: this.workorders.length + 1 }, row));
      return this.workorders.length;
    },
    update(table, sets, where) {
      this.updates.push({ table, sets, where });
      return 0;
    }
  };
}

/* ---------- Python 侧执行器 ---------- */
function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function materialize(dbRows) {
  if (!dbRows) return dbRows;
  const clone = JSON.parse(JSON.stringify(dbRows));
  for (const w of clone.workorders || []) {
    if (w.date === '<TODAY>') w.date = localToday();
  }
  return clone;
}

function runPython(call, data, payload, dbRowsIn) {
  const dbRows = materialize(dbRowsIn);
  let dbLine = 'None';
  if (dbRows) {
    const db = path.join(os.tmpdir(), 'pos_test_' + Math.random().toString(16).slice(2) + '.db');
    const setup = `
import sqlite3
c = sqlite3.connect(${JSON.stringify(db)})
c.execute("CREATE TABLE recipes (sku_id TEXT PRIMARY KEY, name TEXT, main TEXT, aux TEXT, seasoning TEXT)")
c.execute("CREATE TABLE sop_workorders (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, sku_id TEXT, qty REAL, planned_start TEXT, status TEXT, qc_records TEXT, table_id TEXT, table_no TEXT, bom_deducted INTEGER DEFAULT 0)")
import json as _j
for r in _dbrows.get("recipes") or []:
    c.execute("INSERT INTO recipes VALUES (?,?,?,?,?)", (r.get("sku_id"), r.get("name"), _j.dumps(r.get("main"), ensure_ascii=False) if r.get("main") is not None else None, _j.dumps(r.get("aux"), ensure_ascii=False) if r.get("aux") is not None else None, _j.dumps(r.get("seasoning"), ensure_ascii=False) if r.get("seasoning") is not None else None))
for w in _dbrows.get("workorders") or []:
    c.execute("INSERT INTO sop_workorders (date, sku_id, qty, status, table_id, bom_deducted) VALUES (?,?,?,?,?,?)", (w.get("date"), w.get("sku_id"), w.get("qty"), w.get("status"), w.get("table_id"), w.get("bom_deducted", 0)))
c.commit(); c.close()
`;
    dbLine = JSON.stringify(db);
    var pySetup = setup;
  } else {
    var pySetup = '';
  }
  const py = `
import json, sys, sqlite3
import importlib.util
spec = importlib.util.spec_from_file_location("qc", ${JSON.stringify(PY)})
qc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qc)
_doc = json.loads(sys.stdin.read())
_payload = _doc.pop("__payload__")
_dbrows = _doc.pop("__dbrows__", {})
_db = _doc.pop("__db__", None)
${pySetup}
db = ${dbLine}
data = _doc
payload = _payload
call = ${JSON.stringify(call)}
if call == "table_state": msg = qc.apply_pos_table_state(data, payload, db_path=db)
elif call == "table_upsert": msg = qc.apply_pos_table_upsert(data, payload)
elif call == "table_remove": msg = qc.apply_pos_table_remove(data, payload)
elif call == "service_note": msg = qc.apply_pos_service_note(data, payload, ${JSON.stringify((dbRows && dbRows.kind) || 'rush')}, db_path=db)
elif call == "void": msg = qc.apply_pos_void(data, payload)
elif call == "pay": msg = qc.apply_pos_pay(data, payload, db_path=db)
elif call == "merge": msg = qc.apply_pos_merge_split(data, payload, "merge")
elif call == "split": msg = qc.apply_pos_merge_split(data, payload, "split")
elif call == "append_sale": msg = qc.append_sale(data, payload, channel=payload.get("channel") or "堂食")
elif call == "bom_sale": msg = qc._deduct_bom_for_sale_items(db, data, payload.get("items"), ref=payload.get("ref") or "结账#T1", table_id=payload.get("table_id"))
elif call == "bom_wo": msg = qc._deduct_bom_for_workorder(db, data, payload.get("sku"), payload.get("wo_qty"), payload.get("wid"))
elif call == "parse_bom": msg = qc._parse_bom_qty_line(payload.get("line"))
elif call == "prep_skus": msg = sorted(qc._prep_deducted_skus(db, payload.get("table_id")))
else: raise SystemExit("unknown call " + call)
print(json.dumps({"data": data, "msg": msg}, ensure_ascii=False))
`;
  const out = execPy(py, JSON.stringify(Object.assign({ __payload__: payload, __dbrows__: dbRows || {} }, data)));
  return JSON.parse(out);
}

/* ---------- 归一化 ---------- */
function normalize(d) {
  const clone = JSON.parse(JSON.stringify(d));
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (k === '_u' || k === 'ts') { o[k] = '<TS>'; continue; }
      if (k === 'id' && typeof o[k] === 'string' && /^[A-Z]+[0-9a-fA-F]{6,}$/.test(o[k])) { o[k] = '<ID>'; continue; }
      if (k === 'no' && typeof o[k] === 'string' && /^[A-Z]+\d{8}-\d{2}$/.test(o[k])) { o[k] = '<NO>'; continue; }
      if (k === 'id' && typeof o[k] === 'string' && /^S\d{12}[0-9a-fA-F]{4}$/.test(o[k])) { o[k] = '<SALE>'; continue; }
      walk(o[k]);
    }
  };
  walk(clone);
  // 数值口径：Python 4.0 vs JS 4 → 统一为 Number
  const numWalk = (o) => {
    if (Array.isArray(o)) { o.forEach(numWalk); return; }
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'number') o[k] = Number(o[k]);
      else if (o[k] && typeof o[k] === 'object') numWalk(o[k]);
    }
  };
  numWalk(clone);
  return clone;
}

function normMsg(s) {
  return JSON.stringify(s)
    .replace(/[A-Za-z]{1,3}[0-9a-fA-F]{6,}/g, '<ID>')
    .replace(/S\d{12}[0-9a-fA-F]{4}/g, '<SALE>')
    .replace(/[A-Z]+\d{8}-\d{2}/g, '<NO>');
}

/* ---------- BOM 等价 store 生产 ---------- */
const RECIPES = [
  { sku_id: 'SKU1', name: '饺子', main: [{ name: '面粉', qty: 500, unit: 'g' }, { name: '猪肉', qty: 2, unit: '斤' }], aux: ['白菜 300g'] },
  { sku_id: 'SKU2', name: '包子', main: [{ name: '面粉', qty: 200, unit: 'g' }] }
];

const fixtures = [];
function fx(name, call, data, payload, dbRows) { fixtures.push({ name, call, data, payload, dbRows }); }

/* 1) 桌态：新建/更新/挂单 */
fx('tableState.newBusy', 'table_state',
  {}, { table_id: 'T1', state: 'busy', items: [{ name: '饺子', qty: 2 }, { sku: 'S9', qty: 3 }] });
fx('tableState.updateFree', 'table_state',
  { pos: [{ id: 'T1', state: 'busy', bill: [{ name: '饺子', qty: 1 }], amount: 12, bill_summary: '饺子×1' }] },
  { table_id: 'T1', state: '空闲' });
fx('tableState.amountOnly', 'table_state',
  { pos: [{ id: 'T2', state: 'busy' }] }, { table_id: 'T2', state: '就餐', amount: '88.5', bill_summary: '拼桌' });
fx('tableState.cleanSpawnNo', 'table_state',
  { pos: [{ id: 'T3', state: 'busy' }] }, { table_id: 'T3', state: 'busy', items: [{ name: '包子', qty: 4 }], spawn_kitchen: true });

/* 2) 桌台主数据 */
fx('tableUpsert.new', 'table_upsert', { pos: [] }, { zone: 'vip', seats: 8, no: 5 });
fx('tableUpsert.update', 'table_upsert',
  { pos: [{ id: 'T1', name: '旧', no: '1', seats: 4, zone: '大厅' }] },
  { table_id: 'T1', name: '包间A', seats: 12, state: 'rsv' });

/* 3) 删桌 */
fx('tableRemove.free', 'table_remove', { pos: [{ id: 'T1', state: 'free' }, { id: 'T2', state: 'busy' }] }, { table_id: 'T1' });
fx('tableRemove.force', 'table_remove', { pos: [{ id: 'T2', state: 'busy' }] }, { table_id: 'T2', force: true });

/* 4) 传菜状态机 */
fx('service.rush', 'service_note', { pos: [{ id: 'T1', state: 'busy', passed: true }] }, { table_id: 'T1', note: '快些' }, { kind: 'rush' });
fx('service.ready', 'service_note', { pos: [{ id: 'T1', state: 'busy' }] }, { table_id: 'T1' }, { kind: 'ready' });
fx('service.pass', 'service_note',
  { pos: [{ id: 'T1', state: 'busy', service_flags: { rush: { ts: 'x' }, ready: { ts: 'y' } } }] },
  { table_id: 'T1' }, { kind: 'pass' });
fx('service.pack', 'service_note', { pos: [{ id: 'T1', state: 'busy' }] }, { table_id: 'T1', note: '打包' }, { kind: 'pack' });

/* 5) 退菜 */
fx('void.partial', 'void',
  { pos: [{ id: 'T1', state: 'busy', bill: [{ name: '饺子', qty: 3, price: 10 }, { name: '包子', qty: 2 }], amount: 50 }] },
  { table_id: 'T1', dish: '饺子', qty: 1, reason: '客人退' });
fx('void.bySku', 'void',
  { pos: [{ id: 'T1', state: 'busy', bill: [{ name: '饺子', sku_id: 'SKU1', qty: 2, amount: 30 }], amount: 30 }] },
  { table_id: 'T1', sku_id: 'SKU1', qty: 1 });
fx('void.noBill', 'void',
  { pos: [{ id: 'T1', state: 'busy', bill_summary: '旧摘要' }] },
  { table_id: 'T1', dish: '饺子', qty: 2, reason: '缺货' });

/* 6) 结账 */
fx('pay.amountGiven', 'pay',
  { pos: [{ id: 'T1', state: 'busy', bill: [{ name: '饺子', qty: 2 }, { sku: 'S9', qty: 3 }], amount: 30 }], ings: [] },
  { table_id: 'T1', amount: 30, method: '微信' });
fx('pay.fromBill', 'pay',
  { pos: [{ id: 'T1', state: 'busy', bill: [{ name: '饺子', qty: 2 }], amount: 20, bill_summary: '饺子' }], ings: [] },
  { table_id: 'T1' });

/* 6b) 结账联动 BOM 扣料（有菜品/菜谱） */
fx('pay.withBom', 'pay',
  {
    pos: [{ id: 'T1', state: 'busy', bill: [{ name: '饺子', sku_id: 'SKU1', qty: 40 }], amount: 60 }],
    ings: [{ id: 'I1', name: '面粉' }, { id: 'I2', name: '猪肉' }, { id: 'I3', name: '白菜' }],
    dishes: [], logs: []
  },
  { table_id: 'T1', amount: 60 },
  { recipes: RECIPES });

/* 7) 并桌/拆桌 */
fx('merge', 'merge',
  { pos: [{ id: 'A', state: 'busy', bill: [{ name: '饺子', qty: 1 }] }, { id: 'B', state: 'free' }] },
  { from: 'A', to: 'B' });
fx('split', 'split',
  { pos: [{ id: 'A', state: 'busy' }, { id: 'B', state: 'free' }] },
  { from: 'A', to: 'B', seats: 6 });

/* 8) BOM 扣料（含 recipes） */
fx('bom.saleScale', 'bom_sale',
  { ings: [{ id: 'I1', name: '面粉' }, { id: 'I2', name: '猪肉' }, { id: 'I3', name: '白菜' }], logs: [], dishes: [{ id: 'D1', name: '饺子', sku_id: 'SKU1' }] },
  { items: [{ id: 'D1', name: '饺子', qty: 40 }], ref: '结账#T1', table_id: 'T1' },
  { recipes: RECIPES });
fx('bom.saleByName', 'bom_sale',
  { ings: [{ id: 'I1', name: '面粉' }], logs: [], dishes: [] },
  { items: [{ name: '包子', qty: 10 }], ref: '结账#T2', table_id: 'T2' },
  { recipes: RECIPES });
fx('bom.saleMiss', 'bom_sale',
  { ings: [], logs: [], dishes: [] },
  { items: [{ name: '无此菜', qty: 1 }], ref: '结账#T3', table_id: 'T3' },
  { recipes: RECIPES });
fx('bom.saleSkipPrepped', 'bom_sale',
  { ings: [{ id: 'I1', name: '面粉' }], logs: [], dishes: [] },
  { items: [{ name: '饺子', sku_id: 'SKU1', qty: 20 }], ref: '结账#T4', table_id: 'T4' },
  { recipes: RECIPES, workorders: [{ date: '<TODAY>', sku_id: 'SKU1', qty: 20, table_id: 'T4', bom_deducted: 1 }] });
fx('bom.workorder', 'bom_wo',
  { ings: [{ id: 'I1', name: '面粉' }, { id: 'I2', name: '猪肉' }], logs: [] },
  { sku: 'SKU1', wo_qty: 20, wid: 7 },
  { recipes: RECIPES });
fx('bom.workorderNoRecipe', 'bom_wo',
  { ings: [], logs: [] }, { sku: 'NOPE', wo_qty: 20, wid: 8 }, { recipes: RECIPES });

/* 9) parse_bom_qty_line */
fx('parse.dict', 'parse_bom', {}, { line: { name: '面粉', qty: '2.5', unit: 'kg' } });
fx('parse.str', 'parse_bom', {}, { line: '猪肉 2斤' });
fx('parse.nomatch', 'parse_bom', {}, { line: '只有名字' });

/* ---------- Node 侧执行 ---------- */
function runNode(fxv) {
  const data = JSON.parse(JSON.stringify(fxv.data));
  const p = fxv.payload;
  const dbRows = materialize(fxv.dbRows);
  const ctx = dbRows
    ? { store: makeStore({ recipes: RECIPES, workorders: dbRows.workorders || [] }), recipes: RECIPES }
    : {};
  let msg;
  switch (fxv.call) {
    case 'table_state': msg = pos.applyPosTableState(data, p, ctx); break;
    case 'table_upsert': msg = pos.applyPosTableUpsert(data, p); break;
    case 'table_remove': msg = pos.applyPosTableRemove(data, p); break;
    case 'service_note': msg = pos.applyPosServiceNote(data, p, (dbRows && dbRows.kind) || 'rush', ctx); break;
    case 'void': msg = pos.applyPosVoid(data, p); break;
    case 'pay': msg = pos.applyPosPay(data, p, ctx); break;
    case 'merge': msg = pos.applyPosMergeSplit(data, p, 'merge', ctx); break;
    case 'split': msg = pos.applyPosMergeSplit(data, p, 'split', ctx); break;
    case 'bom_sale': msg = pos.deductBomForSaleItems(ctx, data, p.items, p.ref, p.table_id); break;
    case 'bom_wo': msg = pos.deductBomForWorkorder(ctx, data, p.sku, p.wo_qty, p.wid); break;
    case 'parse_bom': msg = pos.parseBomQtyLine(p.line); break;
    default: throw new Error('unknown call ' + fxv.call);
  }
  return { data, msg };
}

/* ---------- 错误语义 ---------- */
const errorCases = [
  { name: 'tableState.badState', call: 'table_state', data: {}, payload: { table_id: 'T1', state: '乱' }, kw: '非法桌态' },
  { name: 'tableState.noId', call: 'table_state', data: {}, payload: {}, kw: '缺少 table_id' },
  { name: 'tableUpsert.badSeats', call: 'table_upsert', data: { pos: [] }, payload: { seats: 99 }, kw: '座位数' },
  { name: 'tableRemove.missing', call: 'table_remove', data: { pos: [] }, payload: { table_id: 'X' }, kw: '找不到桌台' },
  { name: 'tableRemove.busyReject', call: 'table_remove', data: { pos: [{ id: 'T2', state: 'busy' }] }, payload: { table_id: 'T2' }, kw: '仅空闲可删' },
  { name: 'void.noTable', call: 'void', data: { pos: [] }, payload: { table_id: 'X', dish: 'a' }, kw: '桌台不存在' },
  { name: 'void.negQty', call: 'void', data: { pos: [{ id: 'T1' }] }, payload: { table_id: 'T1', dish: 'a', qty: -1 }, kw: '退菜数量须 > 0' },
  { name: 'pay.noId', call: 'pay', data: { pos: [] }, payload: {}, kw: '缺少 table_id' },
  { name: 'merge.noFromTo', call: 'merge', data: { pos: [] }, payload: {}, kw: '需要 from/to' }
];

function runPyError(ec, dbRows) {
  const py = `
import json, sys, sqlite3
import importlib.util
spec = importlib.util.spec_from_file_location("qc", ${JSON.stringify(PY)})
qc = importlib.util.module_from_spec(spec); spec.loader.exec_module(qc)
d = json.loads(sys.stdin.read()); payload = d.pop("__payload__")
call = ${JSON.stringify(ec.call)}
try:
    if call == "table_state": qc.apply_pos_table_state(d, payload)
    elif call == "table_upsert": qc.apply_pos_table_upsert(d, payload)
    elif call == "table_remove": qc.apply_pos_table_remove(d, payload)
    elif call == "void": qc.apply_pos_void(d, payload)
    elif call == "pay": qc.apply_pos_pay(d, payload)
    elif call == "merge": qc.apply_pos_merge_split(d, payload, "merge")
    print(json.dumps({"err": None}))
except Exception as e:
    print(json.dumps({"err": str(e)}, ensure_ascii=False))
`;
  const out = execPy(py, JSON.stringify(Object.assign({ __payload__: ec.payload }, ec.data)));
  return JSON.parse(out).err;
}

function runNodeError(ec) {
  const data = JSON.parse(JSON.stringify(ec.data));
  const ctx = { store: makeStore({ recipes: RECIPES }), recipes: RECIPES };
  try {
    switch (ec.call) {
      case 'table_state': pos.applyPosTableState(data, ec.payload, ctx); break;
      case 'table_upsert': pos.applyPosTableUpsert(data, ec.payload); break;
      case 'table_remove': pos.applyPosTableRemove(data, ec.payload); break;
      case 'void': pos.applyPosVoid(data, ec.payload); break;
      case 'pay': pos.applyPosPay(data, ec.payload, ctx); break;
      case 'merge': pos.applyPosMergeSplit(data, ec.payload, 'merge', ctx); break;
    }
    return null;
  } catch (e) {
    return e.message;
  }
}

/* ---------- 主流程 ---------- */
function main() {
  let pass = 0;
  for (const fxv of fixtures) {
    const n = runNode(fxv);
    const pr = runPython(fxv.call, fxv.data, fxv.payload, fxv.dbRows);
    assert.strictEqual(normMsg(n.msg), normMsg(pr.msg), '[' + fxv.name + '] msg: ' + n.msg + ' != ' + pr.msg);
    assert.deepStrictEqual(normalize(n.data), normalize(pr.data), '[' + fxv.name + '] data mismatch');
    pass++;
    console.log('  PASS ' + fxv.name);
  }
  for (const ec of errorCases) {
    const nerr = runNodeError(ec);
    const perr = runPyError(ec);
    assert.ok(nerr !== null, '[' + ec.name + '] Node 未抛错');
    assert.ok(perr !== null, '[' + ec.name + '] Python 未抛错');
    assert.ok(nerr.indexOf(ec.kw) >= 0, '[' + ec.name + '] Node 错误: ' + nerr);
    assert.ok(perr.indexOf(ec.kw) >= 0, '[' + ec.name + '] Python 错误: ' + perr);
    pass++;
    console.log('  PASS ' + ec.name + ' (error)');
  }
  console.log('[pos.test] PASS ' + pass + ' cases');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[pos.test] FAIL:', e.message);
    if (e.actual !== undefined) {
      console.error('actual  :', JSON.stringify(e.actual));
      console.error('expected:', JSON.stringify(e.expected));
    }
    process.exit(1);
  }
}
