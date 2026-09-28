'use strict';
/*
 * 进销存算法平价测试：Node inventory.js 输出 vs Python queue_consumer.py 输出。
 * 同一 fixture 分别跑两端，归一化易变字段（uuid id/_u/ts/随机编号）后深比较。
 * 用法：node bff/lib/algorithms/inventory.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const inv = require('./inventory');
const { runPython: execPy } = require('./_python');

const PY = path.join(__dirname, '../../../old/store-inventory-legacy/python-runtime/queue_consumer.py');

/* ---------- Python 侧执行器：一次性 import，避免重复开销 ---------- */
function runPython(call, data, payload, withDb) {
  let dbLine = 'None';
  if (withDb) {
    const db = path.join(os.tmpdir(), 'inv_test_' + Math.random().toString(16).slice(2) + '.db');
    fs.writeFileSync(db, '');
    dbLine = JSON.stringify(db);
  }
  const py = `
import json, sys, sqlite3
import importlib.util
spec = importlib.util.spec_from_file_location("qc", ${JSON.stringify(PY)})
qc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qc)
data = json.loads(sys.stdin.read())
payload = data.pop("__payload__")
db = ${dbLine}
if db: qc.ensure_tables(db)
if db:
    _c = sqlite3.connect(db)
    _c.execute("CREATE TABLE IF NOT EXISTS sup_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id TEXT, kind TEXT, amount REAL, ts TEXT, ref_no TEXT, rev INTEGER)")
    _c.commit(); _c.close()
call = ${JSON.stringify(call)}
if call == "apply_restock": msg = qc.apply_restock(data, payload)
elif call == "apply_config": msg = qc.apply_config(data, payload)
elif call == "apply_ing_upsert": msg = qc.apply_ing_upsert(data, payload)
elif call == "apply_quote_upsert": msg = qc.apply_quote_upsert(data, payload)
elif call == "apply_loss_report": msg = qc.apply_loss_report(data, payload)
elif call == "apply_recv_inbound": msg = qc.apply_recv_inbound(data, payload)
elif call == "apply_order_mark": msg = qc.apply_order_mark(data, payload)
elif call == "upsert_vendor": msg = qc.upsert_vendor(db, data, payload)
elif call == "apply_stock_count": msg = qc.apply_stock_count(data, db, payload)
elif call == "insert_supply_po": msg = "supply.po+" + str(qc.insert_supply_po(db, payload))
elif call == "insert_recv_accept": msg = qc.insert_recv_accept(db, payload)
elif call == "insert_stock_count": msg = qc.insert_stock_count(db, payload)
else: raise SystemExit("unknown call " + call)
print(json.dumps({"data": data, "msg": msg}, ensure_ascii=False))
`;
  const out = execPy(py, JSON.stringify(Object.assign({ __payload__: payload }, data)));
  return JSON.parse(out);
}

/* ---------- 归一化：去掉 uuid / 时间戳 / 随机编号，保留确定性字段 ---------- */
function normalize(d) {
  const clone = JSON.parse(JSON.stringify(d));
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (k === '_u' || k === 'ts') { o[k] = '<TS>'; continue; }
      if (k === 'id') {
        if (typeof o[k] === 'string' && /^[A-Z]+[0-9a-fA-F]{6,}$/.test(o[k])) o[k] = '<ID>';
        continue;
      }
      if (k === 'no' && typeof o[k] === 'string'
        && /^[A-Z]+\d{8}-\d{2}$/.test(o[k])) { o[k] = '<NO>'; continue; }
      walk(o[k]);
    }
  };
  walk(clone);
  return clone;
}

/** 消息归一化：把 uuid 片段替换为 <ID> */
function normMsg(s) {
  return String(s)
    .replace(/[A-Z]{1,3}[0-9a-fA-F]{6,}/g, '<ID>')
    .replace(/[A-Z]+\d{8}-\d{2}/g, '<NO>');
}

const fixtures = {};

fixtures.restock = {
  call: 'apply_restock',
  data: { orders: [{ date: '2026-09-01', no: 'CG1' }] },
  payload: {
    date: '2026-09-10',
    items: [
      { ing_id: 'I1', name: '面粉', qty: '500g', unit: 'g', price: '3.5' },
      { name: '猪肉', qty: 2, price: 0 }
    ],
    supplier: '张三',
    sku_id: 'SKU1', qty: 5
  }
};

fixtures.config = {
  call: 'apply_config',
  data: { config: { a: 1, nest: { x: 1, y: 2 } } },
  payload: { config: { nest: { x: 9, z: 3 }, b: 2, type: 'config.update' } }
};

fixtures.ingUpdate = {
  call: 'apply_ing_upsert',
  data: { ings: [{ id: 'I1', name: '面粉', buy: '袋' }] },
  payload: { id: 'I1', safe: 5, qty: 3, on: 1, supplier: '李四', conv: 2 }
};

fixtures.ingCreate = {
  call: 'apply_ing_upsert',
  data: { ings: [{ id: 'I5', name: 'x' }, { id: 'I12', name: 'y' }] },
  payload: { name: '新原料', sup: '王五', pack: '箱', conv: 3, safe: 2 }
};

fixtures.quoteNew = {
  call: 'apply_quote_upsert',
  data: { ings: [{ id: 'I1', name: '面粉' }], quotes: [{ id: 'Q3', ing: 'I2', src: 'A' }] },
  payload: { ing: 'I1', src: 'A', price: 4.2, set_default_sup: true }
};

fixtures.quoteUpdate = {
  call: 'apply_quote_upsert',
  data: { quotes: [{ id: 'Q1', ing: 'I1', src: 'A', price: 1, per: 'buy', date: '2026-01-01' }] },
  payload: { ing: 'I1', src: 'A', price: 9.9, per: 'kg', date: '2026-09-01' }
};

fixtures.lossMatched = {
  call: 'apply_loss_report',
  data: { ings: [{ id: 'I1', name: '面粉', initStock: 10, initAvg: 2, stock: 0, avg: 0 }] },
  payload: { name: '面粉', qty: 2, reason: '过期', date: '2026-09-05' }
};

fixtures.lossUnmatched = {
  call: 'apply_loss_report',
  data: { ings: [{ id: 'I1', name: '面粉' }] },
  payload: { name: '不存在', qty: 1, reason: '破损' }
};

fixtures.recvByOrder = {
  call: 'apply_recv_inbound',
  data: {
    ings: [{ id: 'I1', name: '面粉', initStock: 0, stock: 0, avg: 0 }],
    orders: [{ id: 'PO1', no: 'CG-1', date: '2026-09-01', lines: [{ ing: 'I1', qty: 5, price: 2 }], payable: 10 }],
    recv: []
  },
  payload: { order_id: 'PO1', date: '2026-09-06' }
};

fixtures.recvByItems = {
  call: 'apply_recv_inbound',
  data: { ings: [{ id: 'I1', name: '面粉', stock: 0, avg: 0 }], recv: [] },
  payload: { date: '2026-09-07', items: [{ ing_id: 'I1', name: '面粉', qty: 3, price: 2.5 }] }
};

fixtures.recvById = {
  call: 'apply_recv_inbound',
  data: {
    ings: [{ id: 'I1', name: '面粉', stock: 0, avg: 0 }],
    recv: [{ id: 'R1', no: 'JH1', date: '2026-09-01', lines: [{ ing: 'I1', qty: 4, price: 1 }], note: 'x' }]
  },
  payload: { id: 'R1' }
};

fixtures.recvKimi = {
  call: 'apply_recv_inbound',
  data: { ings: [{ id: 'I1', name: '面粉' }], recv: [], logs: [] },
  payload: { kimi_draft: true, supplier: 'Kimi', note: '验货ok' }
};

fixtures.orderMark = {
  call: 'apply_order_mark',
  data: { orders: [{ id: 'PO1', no: 'CG-1', status: '草稿', note: '' }] },
  payload: { order_id: 'PO1', status: '已下单', note: '快发货' }
};

fixtures.vendorNew = {
  call: 'upsert_vendor',
  withDb: true,
  data: { vendors: [], suppliers: ['旧供应商'] },
  payload: { vendor_id: 'VAAA0001', name: '新供应商', contact: '张三', phone: '138', category: '蔬菜', level: 4.5 }
};

fixtures.stockCount = {
  call: 'apply_stock_count',
  withDb: true,
  data: {
    ings: [{ id: 'I1', name: '面粉', initStock: 0, stock: 0, qty: 0, avg: 0 }],
    logs: []
  },
  payload: { name: '面粉', book_qty: 10, real_qty: 7.5, note: '盘点', date: '2026-09-08' }
};

fixtures.supplyPo = {
  call: 'insert_supply_po',
  withDb: true,
  data: {},
  payload: { vendor_id: 'V1', amount: 100, po_no: 'PO-X' }
};

fixtures.recvAccept = {
  call: 'insert_recv_accept',
  withDb: true,
  data: {},
  payload: { recv_id: 'R1', items: [
    { ing_name: '面粉', qty_ordered: 10, qty_received: 9, verdict: 'pass' },
    { name: '猪肉', qty: 5 }
  ] }
};

/* 兜底类型：None → null 的 JSON 保真（Python .get 缺键） */
fixtures.ingCreateNulls = {
  call: 'apply_ing_upsert',
  data: { ings: [] },
  payload: { name: '空料' }
};

fixtures.restockMinimal = {
  call: 'apply_restock',
  data: { orders: [] },
  payload: { date: '2026-09-10', items: [{ name: '菜', qty: 2 }] }
};

/* ---------- 错误语义平价：两端都应抛错，且错误关键词一致 ---------- */
const errorCases = [
  { name: 'lossZero', call: 'apply_loss_report', data: { logs: [] }, payload: { name: 'x', qty: 0 }, kw: '数量不能为 0' },
  { name: 'recvEmpty', call: 'apply_recv_inbound', data: { recv: [] }, payload: {}, kw: '需提供 id / order_id / items' },
  { name: 'orderNoId', call: 'apply_order_mark', data: { orders: [] }, payload: {}, kw: '缺 order_id' },
  { name: 'orderDone', call: 'apply_order_mark', data: { orders: [{ id: 'P', status: '已入库' }] }, payload: { order_id: 'P' }, kw: '已入库，不能再改状态' },
  { name: 'quoteNoPrice', call: 'apply_quote_upsert', data: { quotes: [] }, payload: { ing: 'I1', src: 'A' }, kw: '缺少 price' },
  { name: 'configEmpty', call: 'apply_config', data: { config: {} }, payload: { config: { type: 'config.update' } }, kw: '无有效配置键' }
];

function runPyExpectError(call, data, payload) {
  const py = `
import json, sys
import importlib.util
spec = importlib.util.spec_from_file_location("qc", ${JSON.stringify(PY)})
qc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qc)
d = json.loads(sys.stdin.read())
payload = d.pop("__payload__")
call = ${JSON.stringify(call)}
try:
    fn = getattr(qc, call)
    fn(d, payload)
    print(json.dumps({"err": None}))
except Exception as e:
    print(json.dumps({"err": str(e)}, ensure_ascii=False))
`;
  const out = execPy(py, JSON.stringify(Object.assign({ __payload__: payload }, data)));
  return JSON.parse(out).err;
}

function runNodeExpectError(call, data, payload) {
  const nd = JSON.parse(JSON.stringify(data));
  const fns = {
    apply_restock: () => inv.applyRestock(nd, payload),
    apply_config: () => inv.applyConfig(nd, payload),
    apply_ing_upsert: () => inv.applyIngUpsert(nd, payload),
    apply_quote_upsert: () => inv.applyQuoteUpsert(nd, payload),
    apply_loss_report: () => inv.applyLossReport(nd, payload, {}),
    apply_recv_inbound: () => inv.applyRecvInbound(nd, payload),
    apply_order_mark: () => inv.applyOrderMark(nd, payload)
  };
  try {
    fns[call]();
    return null;
  } catch (e) {
    return e.message;
  }
}

/* ---------- 主流程 ---------- */
function main() {
  let pass = 0;
  for (const [name, fx] of Object.entries(fixtures)) {
    let nodeMsg;
    const nd = JSON.parse(JSON.stringify(fx.data));
    switch (fx.call) {
      case 'apply_restock': nodeMsg = inv.applyRestock(nd, fx.payload); break;
      case 'apply_config': nodeMsg = inv.applyConfig(nd, fx.payload); break;
      case 'apply_ing_upsert': nodeMsg = inv.applyIngUpsert(nd, fx.payload); break;
      case 'apply_quote_upsert': nodeMsg = inv.applyQuoteUpsert(nd, fx.payload); break;
      case 'apply_loss_report': nodeMsg = inv.applyLossReport(nd, fx.payload, {}); break;
      case 'apply_recv_inbound': nodeMsg = inv.applyRecvInbound(nd, fx.payload); break;
      case 'apply_order_mark': nodeMsg = inv.applyOrderMark(nd, fx.payload); break;
      case 'upsert_vendor': nodeMsg = inv.upsertVendor(nd, fx.payload, {}); break;
      case 'apply_stock_count': nodeMsg = inv.applyStockCount(nd, fx.payload, {}); break;
      case 'insert_supply_po': nodeMsg = 'supply.po+' + inv.insertSupplyPo({}, fx.payload); break;
      case 'insert_recv_accept': nodeMsg = inv.insertRecvAccept({}, fx.payload); break;
      default: throw new Error('unknown call ' + fx.call);
    }
    const py = runPython(fx.call, fx.data, fx.payload, fx.withDb);
    const nm = fx.call === 'insert_supply_po' ? 'supply.po+<ROW>' : normMsg(nodeMsg);
    const pm = fx.call === 'insert_supply_po' ? 'supply.po+<ROW>' : normMsg(py.msg);
    assert.strictEqual(nm, pm, '[' + name + '] msg: ' + nodeMsg + ' != ' + py.msg);
    assert.deepStrictEqual(normalize(nd), normalize(py.data), '[' + name + '] data mismatch');
    pass++;
    console.log('  PASS ' + name);
  }

  for (const ec of errorCases) {
    const nerr = runNodeExpectError(ec.call, ec.data, ec.payload);
    const perr = runPyExpectError(ec.call, ec.data, ec.payload);
    assert.ok(nerr !== null, '[' + ec.name + '] Node 未抛错');
    assert.ok(perr !== null, '[' + ec.name + '] Python 未抛错');
    assert.ok(nerr.indexOf(ec.kw) >= 0, '[' + ec.name + '] Node 错误: ' + nerr);
    assert.ok(perr.indexOf(ec.kw) >= 0, '[' + ec.name + '] Python 错误: ' + perr);
    pass++;
    console.log('  PASS ' + ec.name + ' (error)');
  }
  console.log('[inventory.test] PASS ' + pass + ' cases');
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[inventory.test] FAIL:', e.message);
    if (e.actual !== undefined) {
      console.error('actual  :', JSON.stringify(e.actual));
      console.error('expected:', JSON.stringify(e.expected));
    }
    process.exit(1);
  }
}
