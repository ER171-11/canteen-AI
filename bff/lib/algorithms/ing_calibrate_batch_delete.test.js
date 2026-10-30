'use strict';
/*
 * ADR-013 第 3 批（D3）回归：W3-01 手工校准 / W3-02 批量设置 / W3-03 删除原料（零依赖，node 直跑）
 *
 * 守的事：
 *   W3-01 ① 只改均价时数量不变，且「手工调整」流水 inCost = 新均价（rebuild 据此回写 avg）；
 *         ② 普通盘点不再把均价清 0（原缺陷：inCost 写死 0 → 盘点后库存总值变 0 元）；
 *         ③ 再进货后均价不被冲回（移动加权基于校准后的均价）；
 *         ④ 校准无原因一律抛错（红线 #7 不静默降级）；
 *         ⑤ 只改均价不写盘点差异表（不制造伪损耗差异）。
 *   W3-02 ① 整批一次改写多个原料（一条动作）；② 零命中 / 缺参显式报错；③ yld 钳制 0.05~1。
 *   W3-03 ① 流水/进货单/采购单/报价/销售/配方 任一引用即禁删，且错误信息提示「停用」；
 *         ② 无引用才物理摘除该行；③ 零命中显式报错。
 *
 * 运行：node bff/lib/algorithms/ing_calibrate_batch_delete.test.js
 */
const assert = require('assert');
const inv = require('./inventory');
const { rebuildStock } = require('./stock');
const algo = require('./index');
require('./registry');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}
function throws(fn, kw) {
  let msg = null;
  try { fn(); } catch (e) { msg = String(e && e.message); }
  assert.ok(msg !== null, '应抛错但没抛');
  if (kw) assert.ok(msg.indexOf(kw) >= 0, '错误信息应含「' + kw + '」：' + msg);
  return msg;
}

/* ---------------- W3-01 手工校准 ---------------- */

function calibData(extra) {
  return Object.assign({
    ings: [{ id: 'I1', name: '面粉', unit: '斤', stock: 10, qty: 10, avg: 5 }],
    logs: [],
    recv: [],
  }, extra || {});
}

ok('W3-01 只改均价：数量不变、均价生效、流水 inCost=新均价', () => {
  const d = calibData();
  const msg = inv.applyStockCount(d, { ing_id: 'I1', name: '面粉', avg: 6.5, note: '供应商调价核对' }, {});
  assert.strictEqual(d.ings[0].stock, 10, '数量不应变化');
  assert.strictEqual(d.ings[0].avg, 6.5, '均价应改为 6.5');
  const log = d.logs[d.logs.length - 1];
  assert.strictEqual(log.type, '手工调整');
  assert.strictEqual(log.qty, 10);
  assert.strictEqual(log.inCost, 6.5);
  assert.strictEqual(log.note, '供应商调价核对');
  assert.ok(/均价5\.0→6\.5/.test(msg), msg);
});

ok('W3-01 普通盘点不再把均价清 0（原缺陷回归）', () => {
  const d = calibData();
  inv.applyStockCount(d, { ing_id: 'I1', name: '面粉', book_qty: 10, real_qty: 7, note: '月末盘点' }, {});
  assert.strictEqual(d.ings[0].stock, 7);
  assert.strictEqual(d.ings[0].avg, 5, '盘点后均价应保留，不应变 0');
  assert.strictEqual(d.ings[0].stock * d.ings[0].avg, 35, '库存总值不应变 0 元');
});

ok('W3-01 数量+均价一起校准：两者都生效', () => {
  const d = calibData();
  inv.applyStockCount(d, { ing_id: 'I1', name: '面粉', book_qty: 10, real_qty: 8, avg: 4.2, note: '盘亏核对' }, {});
  assert.strictEqual(d.ings[0].stock, 8);
  assert.strictEqual(d.ings[0].avg, 4.2);
});

ok('W3-01 校准后再次进货：均价按移动加权推，不被冲回', () => {
  const d = calibData();
  inv.applyStockCount(d, { ing_id: 'I1', name: '面粉', avg: 6.5, note: '校正均价' }, {});
  d.recv.push({ id: 'R1', no: 'JH1', date: '2026-11-01', lines: [{ ing: 'I1', qty: 4, price: 8 }] });
  rebuildStock(d);
  assert.strictEqual(d.ings[0].stock, 14);
  /* (10×6.5 + 4×8) / 14 = 6.929 */
  assert.strictEqual(d.ings[0].avg, 6.929);
});

ok('W3-01 校准必须填原因（缺原因显式报错，且不改数据）', () => {
  const d = calibData();
  throws(() => inv.applyStockCount(d, { ing_id: 'I1', name: '面粉', avg: 6 }, {}), '必须填写原因');
  throws(() => inv.applyStockCount(d, { ing_id: 'I1', name: '面粉', avg: 6, note: '   ' }, {}), '必须填写原因');
  assert.strictEqual(d.ings[0].avg, 5, '被拒后均价不应被改');
  assert.strictEqual(d.logs.length, 0, '被拒后不应写流水');
});

ok('W3-01 校准未匹配原料：显式报错（不静默登记差异表）', () => {
  const d = calibData();
  throws(() => inv.applyStockCount(d, { name: '不存在料', avg: 3, note: 'x' }, {}), '未匹配');
});

ok('W3-01 只改均价不写盘点差异表（无伪损耗差异）', () => {
  const d = calibData();
  const rows = [];
  const ctx = { store: { insert: (t, row) => { rows.push({ t, row }); return 1; } } };
  inv.applyStockCount(d, { ing_id: 'I1', name: '面粉', avg: 6.5, note: '校正均价' }, ctx);
  assert.strictEqual(rows.length, 0, '纯均价校准不应写 loss_inventory_diff');
});

ok('W3-01 盘点路径仍写差异表（存量行为不变）', () => {
  const d = calibData();
  const rows = [];
  const ctx = { store: { insert: (t, row) => { rows.push({ t, row }); return 1; } } };
  inv.applyStockCount(d, { ing_id: 'I1', name: '面粉', book_qty: 10, real_qty: 9, note: '盘点' }, ctx);
  assert.ok(rows.length >= 1, '盘点应登记差异表');
  assert.strictEqual(rows[0].t, 'loss_inventory_diff');
});

/* ---------------- W3-02 批量设置 ---------------- */

function batchData() {
  return {
    ings: [
      { id: 'I1', name: '面粉', safe: 0, yld: 1 },
      { id: 'I2', name: '猪肉', safe: 0, yld: 1 },
      { id: 'I3', name: '青菜', safe: 0, yld: 1 },
    ],
  };
}

ok('W3-02 整批一次改写多个原料（安全线）', () => {
  const d = batchData();
  const msg = inv.applyIngBatch(d, { ids: ['I1', 'I2'], safe: 12.5 });
  assert.strictEqual(d.ings[0].safe, 12.5);
  assert.strictEqual(d.ings[0].safety, 12.5, 'safety 与 safe 同步');
  assert.strictEqual(d.ings[1].safe, 12.5);
  assert.strictEqual(d.ings[2].safe, 0, '未勾选的原料不应被改');
  assert.ok(/更新 2 个原料/.test(msg) && /安全线 12\.5/.test(msg), msg);
});

ok('W3-02 安全线 + 出成率一起批改', () => {
  const d = batchData();
  const msg = inv.applyIngBatch(d, { ids: ['I1', 'I2', 'I3'], safe: 3, yld: 0.85 });
  for (const g of d.ings) {
    assert.strictEqual(g.safe, 3);
    assert.strictEqual(g.yld, 0.85);
  }
  assert.ok(/出成率 85%/.test(msg), msg);
});

ok('W3-02 yld 钳制到 0.05~1', () => {
  const d = batchData();
  inv.applyIngBatch(d, { ids: ['I1'], yld: 0 });
  assert.strictEqual(d.ings[0].yld, 0.05);
  inv.applyIngBatch(d, { ids: ['I1'], yld: 3 });
  assert.strictEqual(d.ings[0].yld, 1);
});

ok('W3-02 零命中 / 缺参 / 负数一律显式报错', () => {
  const d = batchData();
  throws(() => inv.applyIngBatch(d, { ids: ['NOPE'], safe: 1 }), '零命中');
  throws(() => inv.applyIngBatch(d, { ids: [], safe: 1 }), '至少一项');
  throws(() => inv.applyIngBatch(d, { ids: ['I1'] }), 'safe 或 yld');
  throws(() => inv.applyIngBatch(d, { ids: ['I1'], safe: -1 }), '不能为负');
});

ok('W3-02 未匹配项在回执里计数（部分命中不静默）', () => {
  const d = batchData();
  const msg = inv.applyIngBatch(d, { ids: ['I1', 'GHOST'], safe: 2 });
  assert.ok(/未匹配 1 项/.test(msg), msg);
});

/* ---------------- W3-03 删除原料 ---------------- */

ok('W3-03 无引用原料可删（只摘该行）', () => {
  const d = { ings: [{ id: 'I1', name: '面粉' }, { id: 'I2', name: '猪肉' }], logs: [], recv: [], orders: [], quotes: [], sales: [] };
  const msg = inv.applyIngDelete(d, { id: 'I1' });
  assert.strictEqual(d.ings.length, 1);
  assert.strictEqual(d.ings[0].id, 'I2');
  assert.ok(/ing 删除 I1/.test(msg), msg);
});

ok('W3-03 有库存流水：禁删并提示停用', () => {
  const d = { ings: [{ id: 'I1', name: '面粉' }], logs: [{ ing: 'I1', qty: 3 }] };
  throws(() => inv.applyIngDelete(d, { id: 'I1' }), '库存流水');
  throws(() => inv.applyIngDelete(d, { id: 'I1' }), '停用');
  assert.strictEqual(d.ings.length, 1, '禁删时原料应保留');
});

ok('W3-03 有进货单 / 采购单引用：禁删', () => {
  throws(() => inv.applyIngDelete(
    { ings: [{ id: 'I1', name: '面粉' }], recv: [{ id: 'R1', lines: [{ ing: 'I1', qty: 1 }] }] },
    { id: 'I1' }), '进货单');
  throws(() => inv.applyIngDelete(
    { ings: [{ id: 'I1', name: '面粉' }], orders: [{ id: 'PO1', lines: [{ ing: 'I1', qty: 1 }] }] },
    { id: 'I1' }), '采购单');
});

ok('W3-03 有报价引用（含历史按名录入）：禁删', () => {
  throws(() => inv.applyIngDelete(
    { ings: [{ id: 'I1', name: '面粉' }], quotes: [{ ing: 'I1', src: 'A', price: 2 }] },
    { id: 'I1' }), '报价');
  throws(() => inv.applyIngDelete(
    { ings: [{ id: 'I1', name: '面粉' }], quotes: [{ ing: '面粉', src: 'A', price: 2 }] },
    { id: 'I1' }), '报价');
});

ok('W3-03 有销售引用：禁删', () => {
  throws(() => inv.applyIngDelete(
    { ings: [{ id: 'I1', name: '面粉' }], sales: [{ id: 'S1', lines: [{ ing: 'I1', qty: 2 }] }] },
    { id: 'I1' }), '出餐销售');
});

ok('W3-03 被配方引用（data.rec 对象行 / 字符串行 / 菜谱主数据）：禁删', () => {
  throws(() => inv.applyIngDelete(
    { ings: [{ id: 'I1', name: '面粉' }], rec: { D1: [{ ing: 'I1', qty: 500, unit: 'g' }] } },
    { id: 'I1' }), '配方');
  throws(() => inv.applyIngDelete(
    { ings: [{ id: 'I1', name: '面粉' }], rec: { D1: ['面粉500g'] } },
    { id: 'I1' }), '配方');
  throws(() => inv.applyIngDelete(
    { ings: [{ id: 'I1', name: '面粉' }], recipes: [{ name: '馒头', main: ['面粉500g'] }] },
    { id: 'I1' }), '配方');
  throws(() => inv.applyIngDelete(
    {
      ings: [{ id: 'I1', name: '面粉' }],
      ext: { recipes: [{ name: '馒头', aux: [{ name: '面粉', qty: 500, unit: 'g' }] }] },
    },
    { id: 'I1' }), '配方');
});

ok('W3-03 配方近似名不误伤（「高筋面粉」不应拦住删除「面粉」）', () => {
  const d = { ings: [{ id: 'I1', name: '面粉' }], rec: { D1: ['高筋面粉500g'] } };
  inv.applyIngDelete(d, { id: 'I1' });
  assert.strictEqual(d.ings.length, 0);
});

ok('W3-03 零命中 / 缺参显式报错', () => {
  throws(() => inv.applyIngDelete({ ings: [] }, { id: 'X' }), '找不到原料');
  throws(() => inv.applyIngDelete({ ings: [] }, {}), '缺 id/name');
});

/* ---------------- 注册表收口 ---------------- */

ok('ing.batch / ing.delete / stock.count 均已登记', () => {
  for (const t of ['ing.batch', 'ing.delete', 'stock.count']) {
    assert.ok(typeof algo.get(t) === 'function', '未登记：' + t);
  }
});

if (failed) {
  console.error('\nFAILED ' + failed);
  process.exit(1);
}
console.log('\nALL PASS（ADR-013 第 3 批）');
