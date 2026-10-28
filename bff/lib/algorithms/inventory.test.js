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
      // W4 · ings[].type 为 Node 超集字段（食材/耗材语义分层），Python 参考实现尚未产出，平价比较前剥除（仅原料对象）
      if (k === 'type' && typeof o.id === 'string' && /^I\d+$/.test(o.id)) { delete o[k]; continue; }
      // Phase 2 · vendors[].category 为 Node 超集口径（受控词条 ID，Python 参考实现仍是自由文本），两端一并剥除后比较
      if (k === 'category' && typeof o.vendor_id === 'string' && o.vendor_id) { delete o[k]; continue; }
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
  payload: { id: 'I1', safe: 5, qty: 3, on: 1, supplier: '李四', conv: 2, yld: 0.8 }
};

fixtures.ingCreate = {
  call: 'apply_ing_upsert',
  data: { ings: [{ id: 'I5', name: 'x' }, { id: 'I12', name: 'y' }] },
  payload: { name: '新原料', sup: '王五', pack: '箱', conv: 3, safe: 2, yld: 0.6 }
};

fixtures.ingYldMax = {
  call: 'apply_ing_upsert',
  data: { ings: [{ id: 'I1', name: '面粉' }] },
  payload: { id: 'I1', yld: 1.5 }
};

fixtures.ingYldMin = {
  call: 'apply_ing_upsert',
  data: { ings: [{ id: 'I1', name: '面粉' }] },
  payload: { id: 'I1', yld: 0 }
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

  /* ---------- rest.update：新增动作（旧版无 Python 队列动作，仅 Node 单测） ---------- */
  {
    const d1 = {};
    const m1 = inv.applyRest(d1, { name: '  熊猫五福餐厅  ' });
    assert.strictEqual(d1.rest, '熊猫五福餐厅', 'rest 应写入顶层 data.rest');
    assert.strictEqual(m1, '餐厅名 → 熊猫五福餐厅');

    const d2 = { rest: '旧名', config: { a: 1 } };
    inv.applyRest(d2, { rest: '新店名' });
    assert.strictEqual(d2.rest, '新店名', 'payload.rest 也应可写');
    assert.deepStrictEqual(d2.config, { a: 1 }, 'config 不应被触碰');

    let threw = false;
    try { inv.applyRest({}, { name: '   ' }); } catch (e) { threw = true; }
    assert.ok(threw, '空名应抛错');
    pass++;
    console.log('  PASS rest.update (standalone)');
  }

  /* ---------- order.fromRestock：新增动作（旧版无 Python 队列动作，仅 Node 单测） ---------- */
  {
    const data = {
      ings: [
        { id: 'g1', name: '面粉', unit: '袋', sup: '供应商A', avg: 50, last: 48, conv: 25 },
        { id: 'g2', name: '猪肉', unit: '斤', sup: '供应商B', avg: 18, last: 20, conv: 1 },
        { id: 'g3', name: '大米', unit: '袋', sup: '供应商A', avg: 120, last: 0, conv: 50 }
      ],
      suppliers: [],
      orders: []
    };
    const msg = inv.applyRestockToOrders(data, {
      date: '2026-10-10',
      items: [
        { ing_id: 'g1', name: '面粉', qty: 2, unit: '袋' },
        { ing_id: 'g2', name: '猪肉', qty: 5, unit: '斤' },
        { ing_id: 'g3', name: '大米', qty: 1, unit: '袋' }
      ]
    });
    // 按供应商拆单：供应商A 2 行、供应商B 1 行 → 2 张 CG 单
    assert.strictEqual(data.orders.length, 2, '应按供应商拆成 2 张采购单');
    const oa = data.orders.find((o) => o.supplier === '供应商A');
    const ob = data.orders.find((o) => o.supplier === '供应商B');
    assert.ok(oa && ob, '两张单供应商应正确');
    assert.strictEqual(oa.lines.length, 2, '供应商A 单应含 2 行');
    assert.strictEqual(ob.lines.length, 1, '供应商B 单应含 1 行');
    assert.strictEqual(oa.status, 'normal', '正式采购单 status=normal');
    // 单价回落 avg：面粉 50、猪肉 18、大米 120；payable = 50*2 + 120*1 = 220（A 单）
    assert.strictEqual(oa.payable, 220, 'A 单应付 = 面粉 100 + 大米 120');
    assert.strictEqual(ob.payable, 90, 'B 单应付 = 猪肉 18*5');
    // unitCost = price/conv：面粉 50/25 = 2；大米 120/50 = 2.4
    assert.deepStrictEqual(oa.lines.map((l) => l.unitCost), [2, 2.4], 'unitCost 按换算率折算');
    // 红线：绝不 rebuildStock —— data 上无 stock 变动字段
    assert.strictEqual(data.stock, undefined, '转单不得触碰库存（不 rebuildStock）');
    // 新供应商并入 suppliers
    assert.deepStrictEqual(data.suppliers.sort(), ['供应商A', '供应商B'], '新供应商应并入 data.suppliers');
    // msg 应含拆单结果
    assert.ok(msg.indexOf('2 张采购单') >= 0 && msg.indexOf('3 个品项') >= 0, 'msg 应描述拆单结果');

    // 空明细 → 抛错
    let threw2 = false;
    try { inv.applyRestockToOrders({ orders: [] }, { items: [{ ing_id: 'x', qty: 0 }] }); } catch (e) { threw2 = true; }
    assert.ok(threw2, '无有效明细行应抛错');
    pass++;
    console.log('  PASS order.fromRestock (standalone)');
  }

  /* ---------- po.create / po.edit：新增动作（旧版为浏览器内 openDocForm，仅 Node 单测） ---------- */
  {
    const data = {
      ings: [
        { id: 'g1', name: '面粉', unit: '斤', buy: '袋', sup: '供应商A', avg: 50, conv: 25 },
        { id: 'g2', name: '猪肉', unit: '斤', buy: '斤', sup: '供应商B', avg: 18, conv: 1 }
      ],
      suppliers: ['供应商A'],
      orders: [{ id: 'o0', no: 'CG20261012-01', date: '2026-10-12' }]
    };
    const msg = inv.applyOrderCreate(data, {
      date: '2026-10-13',
      supplier: '新供应商C',
      method: '银行转账',
      note: '早市到货',
      paid: 1000,
      items: [
        { ing_id: 'g1', qty: 2, price: 50 },
        { ing_id: 'g2', qty: 5, price: 18 }
      ]
    });
    assert.strictEqual(data.orders.length, 2, '应追加 1 张采购单');
    const o = data.orders[1];
    assert.strictEqual(o.no, 'CG20261013-01', '同日张数+1 生成单号');
    // 应付 = 50*2 + 18*5 = 190；实付 1000 应封顶到 190
    assert.strictEqual(o.payable, 190, '应付 = Σ qty×price');
    assert.strictEqual(o.payments.length, 1, '实付一条付款');
    assert.strictEqual(o.payments[0].amount, 190, '超付封顶到应付');
    assert.strictEqual(o.status, 'normal', '正式采购单 status=normal');
    // conv=25 → unitCost = 50/25 = 2
    assert.strictEqual(o.lines[0].unitCost, 2, 'unitCost 按原料 conv 折算');
    // 新供应商并入 suppliers
    assert.ok(data.suppliers.indexOf('新供应商C') >= 0, '新供应商并入 data.suppliers');
    // 红线：不触碰库存
    assert.strictEqual(data.stock, undefined, '建单不得触碰库存（不 rebuildStock）');
    assert.ok(msg.indexOf('CG20261013-01') >= 0, 'msg 应含单号');

    // 空供应商 / 零数量明细 → 抛错
    let e1 = false;
    try { inv.applyOrderCreate({ orders: [] }, { supplier: '  ', items: [{ ing_id: 'g1', qty: 1, price: 1 }] }); } catch (e) { e1 = true; }
    assert.ok(e1, '缺供应商应抛错');
    let e2 = false;
    try { inv.applyOrderCreate({ orders: [], ings: [] }, { supplier: 'X', items: [{ ing_id: 'g1', qty: 0, price: 1 }] }); } catch (e) { e2 = true; }
    assert.ok(e2, '数量为 0 应抛错');

    // po.create 整单优惠/抹零：payable = 明细合计 − 优惠，行级 amount/unitCost 不动（采购单不入库、不影响均价）
    const d3 = {
      ings: [{ id: 'g1', name: '面粉', unit: '斤', buy: '袋', sup: '供应商A', avg: 50, conv: 25 }],
      suppliers: ['供应商A'],
      orders: []
    };
    inv.applyOrderCreate(d3, {
      date: '2026-10-14', supplier: '供应商A', discount: 20,
      items: [{ ing_id: 'g1', qty: 2, price: 50 }]
    });
    const od = d3.orders[0];
    assert.strictEqual(od.gross, 100, '明细合计 = Σ qty×price 不变');
    assert.strictEqual(od.discount, 20, '整单优惠落库');
    assert.strictEqual(od.payable, 80, '应付 = 明细合计 − 优惠');
    assert.strictEqual(od.lines[0].amount, 100, '行级 amount 不动');
    assert.strictEqual(od.lines[0].unitCost, 2, '行级 unitCost 不动（让利不摊入成本）');
    let e5 = false;
    try { inv.applyOrderCreate({ orders: [], ings: [{ id: 'g1', conv: 1 }] }, { supplier: 'X', discount: 101, items: [{ ing_id: 'g1', qty: 1, price: 1 }] }); } catch (e) { e5 = true; }
    assert.ok(e5, '优惠超过明细合计应抛错');
    pass++;
    console.log('  PASS po.create (standalone)');

    // po.edit：覆盖字段并重置付款为单条（旧版 openDocForm 编辑分支）
    const data2 = {
      ings: [{ id: 'g1', name: '面粉', buy: '袋', conv: 25 }],
      orders: [{
        id: 'o1', no: 'CG1', date: '2026-10-01', supplier: '旧供应商', payable: 100,
        lines: [{ ing: 'g1', qty: 2, price: 50, amount: 100, conv: 25, unitCost: 2 }],
        payments: [{ amount: 30, date: '2026-10-01', method: '现金/转账' },
          { amount: 20, date: '2026-10-02', method: '微信' }]
      }]
    };
    inv.applyOrderEdit(data2, { order_id: 'o1', date: '2026-10-13', supplier: '新供应商',
      items: [{ ing_id: 'g1', qty: 4, price: 50 }] });
    const e = data2.orders[0];
    assert.strictEqual(e.supplier, '新供应商', '供应商应被覆盖');
    assert.strictEqual(e.date, '2026-10-13', '日期应被覆盖');
    assert.strictEqual(e.payable, 200, '应付按新明细重算');
    assert.strictEqual(e.payments.length, 1, '付款重置为单条（旧版口径）');
    assert.strictEqual(e.payments[0].amount, 50, '未显式给 paid 时取已付合计（欠款口径不变）');
    let e3 = false;
    try { inv.applyOrderEdit({ orders: [] }, { order_id: 'nope' }); } catch (err) { e3 = true; }
    assert.ok(e3, '找不到采购单应抛错');

    // po.edit 整单优惠/抹零：应付重算，行级 amount/unitCost 不动
    inv.applyOrderEdit(data2, { order_id: 'o1', date: '2026-10-13', supplier: '新供应商',
      items: [{ ing_id: 'g1', qty: 4, price: 50 }], discount: 15 });
    const ed = data2.orders[0];
    assert.strictEqual(ed.gross, 200, '明细合计 = Σ qty×price 不变');
    assert.strictEqual(ed.discount, 15, '整单优惠落库');
    assert.strictEqual(ed.payable, 185, '应付 = 明细合计 − 优惠');
    assert.strictEqual(ed.lines[0].amount, 200, '行级 amount 不动');
    assert.strictEqual(ed.lines[0].unitCost, 2, '行级 unitCost 不动（让利不摊入成本）');
    let e6 = false;
    try { inv.applyOrderEdit(data2, { order_id: 'o1', items: [{ ing_id: 'g1', qty: 1, price: 1 }], discount: 999 }); } catch (err) { e6 = true; }
    assert.ok(e6, '优惠超过明细合计应抛错');
    pass++;
    console.log('  PASS po.edit (standalone)');
  }

  /* ---------- po.create / po.edit：新增原料（旧版 openNewIngForPo 回归） ---------- */
  {
    // po.create：明细含 name 无 ing_id → 按名自动建档（待完善草稿），不入库
    const d = {
      ings: [{ id: 'g1', name: '面粉', unit: '斤', buy: '袋', avg: 50, conv: 25 }],
      suppliers: ['供应商A'],
      orders: []
    };
    inv.applyOrderCreate(d, {
      date: '2026-10-15', supplier: '供应商A',
      items: [{ name: '娃娃菜', unit: '斤', cat: '蔬菜', qty: 3, price: 2.5 }]
    });
    assert.strictEqual(d.ings.length, 2, '自动建档后档案数 2');
    const ni = d.ings.find((g) => g.name === '娃娃菜');
    assert.ok(ni, '新原料应存在于档案');
    assert.strictEqual(ni.pending, true, '新原料应为待完善草稿');
    assert.strictEqual(d.orders[0].lines[0].ing, ni.id, '行原料引用应指向新档案 id');
    assert.strictEqual(d.orders[0].payable, 7.5);
    // 无 ing_id 但名称命中已有档案 → 不重复建档
    inv.applyOrderCreate(d, {
      date: '2026-10-15', supplier: '供应商A',
      items: [{ name: '面粉', qty: 1, price: 50 }]
    });
    assert.strictEqual(d.ings.length, 2, '名称命中不得重复建档');
    assert.strictEqual(d.orders[1].lines[0].ing, 'g1');

    // po.edit：同样支持按名自动建档
    const d2 = {
      ings: [{ id: 'g1', name: '面粉', buy: '袋', conv: 25 }],
      orders: [{ id: 'o1', no: 'CG1', date: '2026-10-01', supplier: '旧供应商', payable: 100, lines: [] }]
    };
    inv.applyOrderEdit(d2, { order_id: 'o1', date: '2026-10-13', supplier: '新供应商',
      items: [{ name: '萝卜', unit: '斤', cat: '蔬菜', qty: 4, price: 3 }] });
    assert.strictEqual(d2.ings.length, 2, '编辑自动建档后档案数 2');
    assert.ok(d2.ings.find((g) => g.name === '萝卜'), '萝卜应存在于档案');
    assert.strictEqual(d2.orders[0].lines[0].ing, d2.ings.find((g) => g.name === '萝卜').id);
    pass++;
    console.log('  PASS po.create/po.edit 新增原料 (standalone)');
  }

  /* ---------- restock.config / ignore / adjust：新增动作（旧版为浏览器内 JS，仅 Node 单测） ---------- */
  {
    // config：钳制与归一
    const d1 = {};
    inv.applyRestockConfig(d1, { days: 0, lead: -3, gap: 2, useOnway: '1' });
    assert.deepStrictEqual(d1.restock, { days: 1, lead: 0, gap: 2, useOnway: 1 }, '补货参数应钳制并归一');
    inv.applyRestockConfig(d1, { restock: { days: 45 } });
    assert.strictEqual(d1.restock.days, 45, '缺省键沿用现值');
    assert.strictEqual(d1.restock.gap, 2, '未给键保留原值');
    pass++;
    console.log('  PASS restock.config (standalone)');

    // ignore / adjust：建议单行状态与主数据记回
    const d2 = {
      ings: [{ id: 'g1', name: '面粉', sup: '', moq: '', pack: '25kg/袋' }],
      orders: [],
      plans: [{
        id: 'BY1', no: 'BY20261013-001', date: '2026-10-13', status: 'pending',
        lines: [
          { ing: 'g1', qty: 10, supplier: '', st: 'pending' },
          { ing: 'g2', qty: 5, supplier: '', st: 'pending' }
        ]
      }]
    };
    inv.applyRestockIgnore(d2, { ing_ids: ['g2'] });
    assert.strictEqual(d2.plans[0].lines[1].st, 'ignored', '勾选行应置 ignored');
    assert.strictEqual(d2.plans[0].status, 'part', '单状态应推进为 part');

    const msg2 = inv.applyRestockAdjust(d2, {
      rows: [{ ing: 'g1', qty: 12, supplier: '供应商A', moq: 5, packQty: 2 }]
    });
    assert.strictEqual(d2.plans[0].lines[0].qty, 12, '建议行采购量应更新');
    assert.strictEqual(d2.plans[0].lines[0].supplier, '供应商A', '建议行供应商应更新');
    assert.strictEqual(d2.ings[0].sup, '供应商A', '供应商记回原料主数据');
    assert.strictEqual(d2.ings[0].moq, 5, '起订量记回原料主数据');
    assert.strictEqual(d2.ings[0].packQty, 2, '整包规格记回 packQty');
    assert.strictEqual(d2.ings[0].pack, '25kg/袋', '包规 pack（字符串）不得被覆盖');
    assert.ok(msg2.indexOf('2 项') >= 0 || msg2.indexOf('1 项') >= 0, 'msg 应含记回项数');

    let e4 = false;
    try { inv.applyRestockIgnore({ plans: [] }, { ing_ids: ['g1'] }); } catch (err) { e4 = true; }
    assert.ok(e4, '无建议单时应抛错');
    pass++;
    console.log('  PASS restock.ignore/adjust (standalone)');
  }

  /* ---------- quote.upsert：归属键归一 + 默认供应商（Node 超集，见 registry/inventory 注释） ---------- */
  {
    /* 历史脏数据：q.ing 存的是原料名；本次按原料 id 补录同一供应商 → 应「更新」而非「重建」 */
    const d = {
      ings: [{ id: 'I1', name: '东古一品鲜500ml', sup: '' }],
      quotes: [{ id: 'Q200', ing: '东古一品鲜500ml', src: '测试商', price: 1, per: 'buy', date: '2026-10-01' }]
    };
    const m1 = inv.applyQuoteUpsert(d, { ing: 'I1', name: '东古一品鲜500ml', src: '测试商', price: 1.5, per: 'buy' });
    assert.strictEqual(m1, 'quote 更新 I1@测试商 → ¥1.5', 'msg 应按原料 id 归并更新: ' + m1);
    assert.strictEqual(d.quotes.length, 1, '同一供应商同一原料不得重复建条');
    assert.strictEqual(d.quotes[0].ing, 'I1', '历史按名录入的行应就地归一为原料 id');
    assert.strictEqual(d.quotes[0].price, 1.5, '价格应被覆盖');

    /* 覆盖既有报价时勾「设为默认供应商」同样生效（FP-PRICE-15） */
    inv.applyQuoteUpsert(d, { ing: 'I1', name: '东古一品鲜500ml', src: '供应商B', price: 2, set_default_sup: true });
    assert.strictEqual(d.ings[0].sup, '供应商B', '新建分支应写入默认供应商');
    inv.applyQuoteUpsert(d, { ing: 'I1', name: '东古一品鲜500ml', src: '供应商B', price: 1.8, set_default_sup: true });
    assert.strictEqual(d.ings[0].sup, '供应商B', '覆盖既有报价时默认供应商应保持生效');

    /* 名称找不到对应原料时不得误改：仍按原样建条 */
    const d2 = { ings: [{ id: 'I9', name: '面粉' }], quotes: [] };
    inv.applyQuoteUpsert(d2, { ing: '未登记原料', name: '未登记原料', src: 'A', price: 3 });
    assert.strictEqual(d2.quotes[0].ing, '未登记原料', '无对应原料时保留原键，不编造 id');
    pass++;
    console.log('  PASS quote.upsert 归属键归一/默认供应商 (standalone)');
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
