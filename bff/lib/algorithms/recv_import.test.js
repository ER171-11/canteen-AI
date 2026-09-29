'use strict';
/*
 * recv.import（批量导入进货单）行为契约测试。
 *
 * 为什么是「行为」而非「平价」用例：
 *   旧版批量导入是浏览器 JS（commitRecvImport HTML:3650-3671），Python queue_consumer.py
 *   **没有** recv.import 这个分支，因此无 Python 侧可对拍；这里用断言把 Node 侧语义锁死。
 *
 * 本门禁守的六件事（对应 ADR-004 §2.4 / §4）：
 *   ① 单号口径与 recv.inbound 完全一致（JH+日期-序号同日自增）
 *   ② 应付 = Σ(qty×price)；markPaid → payments=[{amount:应付}]，否则 []（默认挂账）
 *   ③ **批末只 rebuildStock 一次**（N 张单据也是一次，防止 O(N×库存行数)）
 *   ④ 明细非法（数量≤0 / 单价非数字 / 缺原料名）整体拒绝，**绝不静默跳过**（红线⑥）
 *   ⑤ 不代建原料（与单张录入同口径），供应商名单去重并入 data.suppliers
 *   ⑥ 空批次直接拒绝，且**不改动账面**
 *
 * 用法：node bff/lib/algorithms/recv_import.test.js
 */
const assert = require('assert');
const inv = require('./inventory');

function mkData() {
  return {
    ings: [
      { id: 'i1', name: '五花肉', unit: '斤', buy: '斤', stock: 0, avg: 0 },
      { id: 'i2', name: '青菜', unit: '斤', buy: '斤', stock: 0, avg: 0 }
    ],
    recv: [],
    moves: []
  };
}

/** 统计 msg 里 rebuild_stock 的调用次数 */
function countRebuild(msg) {
  return String(msg).split('rebuild_stock').length - 1;
}

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  PASS ' + name);
}

/* ① 单张导入：单号口径、应付、 payments 默认挂账 */
ok('单张导入：JH20260929-01、应付 300、未勾全额付款则 payments 为空', () => {
  const data = mkData();
  const msg = inv.applyRecvImport(data, {
    docs: [{
      supplier: '海南菜篮子',
      date: '2026-09-29',
      note: '',
      lines: [{ ingId: 'i1', name: '五花肉', qty: 10, price: 30, unit: '斤' }]
    }],
    source: 'admin-web/inventory/inbound'
  });
  assert.strictEqual(data.recv.length, 1);
  const d = data.recv[0];
  assert.strictEqual(d.no, 'JH20260929-01');
  assert.strictEqual(d.date, '2026-09-29');
  assert.strictEqual(d.supplier, '海南菜篮子');
  assert.strictEqual(d.payable, 300);
  assert.strictEqual(d.status, '已入库');
  assert.deepStrictEqual(d.payments, []);
  assert.strictEqual(d.method, '现金/转账');
  assert.strictEqual(d.lines[0].ing, 'i1');
  assert.strictEqual(d.lines[0].amount, 300);
  assert.strictEqual(d.lines[0].conv, 1);
  /* 无备注 → 留「批量导入」痕迹，便于日后区分手工单与导入单 */
  assert.strictEqual(d.note, '【批量导入】');
  assert.strictEqual(data.ings[0].stock, 10);
  assert.strictEqual(data.ings[0].avg, 30);
  assert.ok(/recv\.import 导入 1 张/.test(msg), msg);
});

/* ② markPaid：按应付全额登记付款（旧版 #recvPaidFlag 语义） */
ok('markPaid=true：payments=[{amount:应付,date,method}]（挂账则不写 payments）', () => {
  const data = mkData();
  inv.applyRecvImport(data, {
    docs: [{
      supplier: '海南菜篮子',
      date: '2026-09-29',
      lines: [{ ingId: 'i2', name: '青菜', qty: 3, price: 4.5 }]
    }],
    markPaid: true
  });
  const d = data.recv[0];
  assert.strictEqual(d.payable, 13.5);
  assert.strictEqual(d.payments.length, 1);
  assert.strictEqual(d.payments[0].amount, 13.5);
  assert.strictEqual(d.payments[0].date, '2026-09-29');
  assert.strictEqual(d.payments[0].method, '现金/转账');
});

/* ③ 批末只重算一次台账 */
ok('3 张单据一批：只调 rebuildStock 一次（msg 内 rebuild_stock 出现 1 次）', () => {
  const data = mkData();
  const msg = inv.applyRecvImport(data, {
    docs: [
      { supplier: '甲', date: '2026-09-29', lines: [{ ingId: 'i1', name: '五花肉', qty: 1, price: 10 }] },
      { supplier: '乙', date: '2026-09-29', lines: [{ ingId: 'i2', name: '青菜', qty: 2, price: 5 }] },
      { supplier: '甲', date: '2026-09-30', lines: [{ ingId: 'i1', name: '五花肉', qty: 4, price: 20 }] }
    ]
  });
  assert.strictEqual(data.recv.length, 3);
  assert.strictEqual(countRebuild(msg), 1, msg);
  /* 同一天两张 → 序号自增；跨天重新计数 */
  assert.strictEqual(data.recv[0].no, 'JH20260929-01');
  assert.strictEqual(data.recv[1].no, 'JH20260929-02');
  assert.strictEqual(data.recv[2].no, 'JH20260930-01');
  /* 库存是三张合并后的结果（1 + 4 = 5），均价 (1×10+4×20)/5 = 18 */
  assert.strictEqual(data.ings[0].stock, 5);
  assert.strictEqual(data.ings[0].avg, 18);
});

/* ④ 非法明细整体拒绝，不静默跳过 */
ok('明细数量 ≤0：整批拒绝，且账面（recv/库存）零改动', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvImport(data, {
      docs: [{ supplier: '甲', date: '2026-09-29', lines: [{ ingId: 'i1', name: '五花肉', qty: 0, price: 10 }] }]
    }),
    /数量需 > 0/
  );
  assert.throws(
    () => inv.applyRecvImport(data, {
      docs: [{ supplier: '甲', date: '2026-09-29', lines: [{ ingId: 'i1', name: '五花肉', qty: 1, price: -3 }] }]
    }),
    /单价非法/
  );
  assert.throws(
    () => inv.applyRecvImport(data, {
      docs: [{ supplier: '甲', date: '2026-09-29', lines: [{ ingId: 'i1', qty: 1, price: 3 }] }]
    }),
    /缺原料名/
  );
  assert.strictEqual(data.recv.length, 0);
  assert.strictEqual(data.ings[0].stock, 0);
});

/* ⑤ 缺 docs / 空批次：拒绝且不改账面 */
ok('空批次（docs=[] / 单据无明细行）：拒绝，recv 与库存零改动', () => {
  const data = mkData();
  assert.throws(() => inv.applyRecvImport(data, { docs: [] }), /缺 docs/);
  assert.throws(
    () => inv.applyRecvImport(data, { docs: [{ supplier: '甲', date: '2026-09-29', lines: [] }] }),
    /无有效明细行/
  );
  assert.strictEqual(data.recv.length, 0);
  assert.strictEqual(data.ings[0].stock, 0);
});

/* ⑥ 供应商补齐 + 兜底名称 + 实收量只登记 */
ok('供应商缺失 → 未指定供应商；并入 data.suppliers（去重）；recvQty 只登记不计价', () => {
  const data = mkData();
  data.suppliers = ['海南菜篮子'];
  inv.applyRecvImport(data, {
    docs: [
      { supplier: '', date: '2026-09-29', lines: [{ ingId: 'i1', name: '五花肉', qty: 2, price: 10, recvQty: 1.5 }] },
      { supplier: '海南菜篮子', date: '2026-09-29', lines: [{ ingId: 'i2', name: '青菜', qty: 1, price: 2 }] },
      { supplier: '海南菜篮子', date: '2026-09-29', lines: [{ ingId: 'i2', name: '青菜', qty: 1, price: 2 }] }
    ]
  });
  assert.strictEqual(data.recv[0].supplier, '未指定供应商');
  assert.deepStrictEqual(data.suppliers, ['海南菜篮子', '未指定供应商']);
  /* 实收量只登记：库存与应付仍按订购量 2 计 */
  assert.strictEqual(data.recv[0].lines[0].recvQty, 1.5);
  assert.strictEqual(data.recv[0].payable, 20);
  assert.strictEqual(data.ings[0].stock, 2);
});

/* ⑦ 与手工录入同源：同一天的手工单与导入单序号连续 */
ok('手工单与导入单同日序号连续（无一单号重复）', () => {
  const data = mkData();
  inv.applyRecvInbound(data, {
    supplier: '甲',
    date: '2026-09-29',
    items: [{ ing_id: 'i1', name: '五花肉', qty: 1, price: 10 }]
  });
  inv.applyRecvImport(data, {
    docs: [{ supplier: '乙', date: '2026-09-29', lines: [{ ingId: 'i2', name: '青菜', qty: 1, price: 2 }] }]
  });
  assert.strictEqual(data.recv[0].no, 'JH20260929-01');
  assert.strictEqual(data.recv[1].no, 'JH20260929-02');
});

console.log('\n== recv.import 行为用例: ' + pass + '/' + pass + ' 通过 ==');
