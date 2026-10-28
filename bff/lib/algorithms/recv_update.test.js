'use strict';
/*
 * recv.update（编辑进货单）行为测试。
 *
 * 覆盖 Node 侧对旧版 openRecv 编辑态（HTML:1642-1654）的忠实迁移 + 超集安全项：
 *   · 编辑替换 明细/日期/供应商/备注/付款方式/应付，并 rebuildStock 重算库存；
 *   · 保留「补付」（recv.pay）追加的 payments（带 source/ts），仅覆盖初始付款；
 *   · 超付拒绝、已作废单不可编辑、空明细拒绝。
 *
 * 用法：node bff/lib/algorithms/recv_update.test.js
 */
const assert = require('assert');
const inv = require('./inventory');

function mkData() {
  return {
    ings: [
      { id: 'i1', name: '五花肉', unit: '斤', buy: '斤', stock: 0, avg: 0 },
      { id: 'i2', name: '青菜', unit: '斤', buy: '斤', stock: 0, avg: 0 }
    ],
    recv: [
      {
        id: 'R1', no: 'JH20260929-01', date: '2026-09-29',
        supplier: '海南菜篮子', method: '现金/转账',
        lines: [{ ing: 'i1', name: '五花肉', qty: 10, price: 30, conv: 1, amount: 300, unitCost: 30 }],
        payable: 300, payments: [{ amount: 100, date: '2026-09-29', method: '现金/转账' }],
        status: '已入库', note: ''
      }
    ],
    logs: []
  };
}

const BASE = { id: 'R1', source: 'admin-web/inventory/inbound' };

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  PASS ' + name);
}

/* 1) 编辑供应商 + 明细行：应付重算、库存按 rebuildStock 重算 */
ok('编辑：供应商改名 + 改数量，应付=520（10×30+20×11）、库存按新行重算', () => {
  const data = mkData();
  const msg = inv.applyRecvUpdate(data, Object.assign({}, BASE, {
    supplier: '新供应商',
    items: [{ ing_id: 'i1', qty: 10, price: 30 }, { ing_id: 'i2', qty: 20, price: 11 }]
  }));
  const d = data.recv[0];
  assert.strictEqual(d.supplier, '新供应商');
  assert.strictEqual(d.lines.length, 2);
  assert.strictEqual(d.payable, 520);
  assert.strictEqual(d.lines[1].ing, 'i2');
  assert.strictEqual(data.ings[1].stock, 20, '青菜库存应随编辑后的行重算');
  assert.ok(/rebuild_stock 完成/.test(msg));
});

/* 2) 编辑保留补付记录：仅覆盖初始付款，不丢 history 补付 */
ok('编辑保留补付：prior 带 source 的 payments 不被覆盖', () => {
  const data = mkData();
  data.recv[0].payments.push({ amount: 50, date: '2026-09-30', method: '微信', source: 'admin-web/inventory/inbound', ts: '2026-09-30T10:00:00Z' });
  inv.applyRecvUpdate(data, Object.assign({}, BASE, { paid: 120, method: '支付宝' }));
  const d = data.recv[0];
  assert.strictEqual(d.payments.length, 2, '初始 1 + 补付 1');
  assert.strictEqual(d.payments[0].amount, 120);
  assert.strictEqual(d.payments[0].method, '支付宝');
  assert.strictEqual(d.payments[1].source, 'admin-web/inventory/inbound', '补付记录应保留');
  assert.strictEqual(d.payments[1].amount, 50);
});

/* 3) 编辑不传 paid：保留原 payments 不变 */
ok('编辑不传 paid：payments 原样保留', () => {
  const data = mkData();
  inv.applyRecvUpdate(data, Object.assign({}, BASE, { note: '改备注' }));
  const d = data.recv[0];
  assert.strictEqual(d.note, '改备注');
  assert.strictEqual(d.payments.length, 1);
  assert.strictEqual(d.payments[0].amount, 100);
});

/* 4) 超付拒绝（同 recv.inbound 口径，不静默截断） */
ok('编辑超付被拒', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvUpdate(data, Object.assign({}, BASE, { paid: 301 })),
    /超过应付/
  );
});

/* 5) 已作废单不可编辑 */
ok('已作废单编辑被拒', () => {
  const data = mkData();
  data.recv[0].status = '已作废';
  assert.throws(
    () => inv.applyRecvUpdate(data, Object.assign({}, BASE, { supplier: 'x' })),
    /已作废/
  );
});

/* 6) 空明细拒绝 */
ok('编辑后明细无有效数量行被拒', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvUpdate(data, Object.assign({}, BASE, { items: [{ ing_id: 'i1', qty: 0, price: 3 }] })),
    /无有效数量行/
  );
});

/* 7) 找不到单被拒 */
ok('找不到进货单被拒', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvUpdate(data, { id: 'NOPE', items: [{ ing_id: 'i1', qty: 1, price: 1 }] }),
    /未找到进货单/
  );
});

/* 8) 整单优惠：仅改 discount 不改明细 → 应付重算，行级 amount/unitCost 不动 */
ok('编辑只改优惠：discount=20 → 应付 280，明细 amount/unitCost 不变', () => {
  const data = mkData();
  inv.applyRecvUpdate(data, Object.assign({}, BASE, { discount: 20 }));
  const d = data.recv[0];
  assert.strictEqual(d.discount, 20);
  assert.strictEqual(d.gross, 300);
  assert.strictEqual(d.payable, 280);
  assert.strictEqual(d.lines[0].amount, 300, '行级 amount 不动');
  assert.strictEqual(d.lines[0].unitCost, 30, '行级 unitCost 不动（让利不摊入成本）');
});

/* 9) 整单优惠超过明细合计：拒绝 */
ok('编辑优惠超过明细合计被拒', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvUpdate(data, Object.assign({}, BASE, { discount: 301 })),
    /整单优惠/
  );
});

/* 10) 编辑时新增原料（无 ing_id，仅 name）：按名自动建档并入库 */
ok('编辑新增原料自动建档：name 行无 ing_id → 档案 +1、库存入账', () => {
  const data = mkData();
  inv.applyRecvUpdate(data, Object.assign({}, BASE, {
    items: [{ name: '娃娃菜', unit: '斤', cat: '蔬菜', qty: 4, price: 2.5 }]
  }));
  const d = data.recv[0];
  assert.strictEqual(data.ings.length, 3, '自动建档后档案数 3');
  const ni = data.ings.find((g) => g.name === '娃娃菜');
  assert.ok(ni, '新原料应存在于档案');
  assert.strictEqual(ni.pending, true, '新原料应为待完善草稿');
  assert.strictEqual(d.lines[0].ing, ni.id);
  assert.strictEqual(ni.stock, 4, '库存按 rebuildStock 入账');
  assert.strictEqual(d.payable, 10);
});

/* 11) 事故回归：补付已结清后再编辑又全额填「实付」→ 实付+补付 合计超应付，必须拒绝
      （2026-10-27 JH20261027-01 实付累积翻倍 328.4→656.8 的根因） */
ok('编辑超付口径含补付：补付 300 结清后再编辑 paid=300 被拒', () => {
  const data = mkData();
  data.recv[0].payments = [
    { amount: 300, date: '2026-09-30', method: '挂账转销', source: 'admin-web/inventory/inbound', ts: '2026-09-30T10:00:00Z' }
  ];
  assert.throws(
    () => inv.applyRecvUpdate(data, Object.assign({}, BASE, { paid: 300 })),
    /已登记补付/,
    '错误信息应点明「已登记补付」'
  );
  const d = data.recv[0];
  assert.strictEqual(d.payments.length, 1, '拒绝后 payments 不得被改动');
  assert.strictEqual(d.payments[0].amount, 300);
});

/* 12) 边界：实付 + 补付 恰好等于应付 → 放行 */
ok('边界：paid 200 + 补付 100 = 应付 300 → 放行且 payments 合计 300', () => {
  const data = mkData();
  data.recv[0].payments.push({ amount: 100, date: '2026-09-30', method: '微信', source: 'admin-web/inventory/inbound', ts: '2026-09-30T10:00:00Z' });
  inv.applyRecvUpdate(data, Object.assign({}, BASE, { paid: 200, method: '现金/转账' }));
  const d = data.recv[0];
  const total = d.payments.reduce((s, p) => s + p.amount, 0);
  assert.strictEqual(d.payments.length, 2);
  assert.strictEqual(total, 300, '初始 200 + 补付 100');
});

/* 13) 实付填 0：初始付款清空、补付保留（对齐用户手工纠偏动作） */
ok('编辑 paid=0：初始清空、仅保留补付', () => {
  const data = mkData();
  inv.applyRecvUpdate(data, Object.assign({}, BASE, { paid: 0 }));
  const d = data.recv[0];
  assert.strictEqual(d.payments.length, 0);
});

console.log('[recv_update.test] PASS ' + pass + ' cases');
