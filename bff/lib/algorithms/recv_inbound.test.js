'use strict';
/*
 * recv.inbound（新建进货单）行为测试。
 *
 * 为什么同时有「平价」和「行为」两类用例：
 *   · inventory.test.js 走 Python 差分，锁的是与 queue_consumer.py **完全相同**的那部分行为；
 *   · 本文件锁的是 Node **超集**（阶段 2 / FP-RECV-01 新增）：实付 payments、付款方式 method、
 *     关联采购单 po、行内实收量 line.recvQty —— 旧版这三项只在浏览器 JS 的 openRecv 里
 *     （旧 HTML:1636-1654），Python queue_consumer.py **没有对应实现**，无 Python 侧可对拍。
 * 约束：超集字段**全部可选**，不传时输出必须与 Python 版逐字节一致（第 7 例专门守这条）。
 *
 * 用法：node bff/lib/algorithms/recv_inbound.test.js
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
    logs: []
  };
}

const BASE = {
  supplier: '海南菜篮子',
  date: '2026-09-29',
  source: 'admin-web/inventory/inbound'
};

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  PASS ' + name);
}

/* 1) 基本新建：单号口径 JH+日期-序号、payable=Σ(qty×price)、库存按 rebuildStock 重算 */
ok('新建进货单：单号 JH20260929-01、应付 300、库存入账 10', () => {
  const data = mkData();
  const msg = inv.applyRecvInbound(data, Object.assign({}, BASE, {
    items: [{ ing_id: 'i1', name: '五花肉', qty: 10, price: 30 }]
  }));
  const d = data.recv[0];
  assert.strictEqual(data.recv.length, 1);
  assert.strictEqual(d.no, 'JH20260929-01');
  assert.strictEqual(d.date, '2026-09-29');
  assert.strictEqual(d.supplier, '海南菜篮子');
  assert.strictEqual(d.payable, 300);
  assert.strictEqual(d.status, '已入库');
  assert.strictEqual(d.lines[0].ing, 'i1');
  assert.strictEqual(d.lines[0].amount, 300);
  assert.strictEqual(d.lines[0].conv, 1);
  assert.strictEqual(d.lines[0].unitCost, 30);
  /* rebuildStock 口径：stock=qty×conv、avg=加权均价 */
  assert.strictEqual(data.ings[0].stock, 10);
  assert.strictEqual(data.ings[0].qty, 10);
  assert.strictEqual(data.ings[0].avg, 30);
  assert.ok(/rebuild_stock 完成/.test(msg), 'msg 应含重建摘要，实际：' + msg);
});

/* 2) 同一天第二张：序号自增（与 Python same_day 口径一致） */
ok('同日第二张：单号 -02', () => {
  const data = mkData();
  const p = Object.assign({}, BASE, { items: [{ ing_id: 'i1', qty: 1, price: 10 }] });
  inv.applyRecvInbound(data, p);
  inv.applyRecvInbound(data, p);
  assert.strictEqual(data.recv[1].no, 'JH20260929-02');
});

/* 3) 实付：写一条 payments，method 生效，付款日期取单据日期（旧 HTML:1643 同口径） */
ok('实付 200 + 微信：payments 记一条，欠款 = 应付 − 实付', () => {
  const data = mkData();
  inv.applyRecvInbound(data, Object.assign({}, BASE, {
    method: '微信',
    paid: 200,
    items: [{ ing_id: 'i1', qty: 10, price: 30 }]
  }));
  const d = data.recv[0];
  assert.strictEqual(d.payments.length, 1);
  assert.deepStrictEqual(d.payments[0], { amount: 200, date: '2026-09-29', method: '微信' });
  assert.strictEqual(d.method, '微信');
  assert.strictEqual(d.payable, 300, 'payable 不得被实付改写');
  assert.strictEqual(d.payable - d.payments[0].amount, 100, '欠款应为 100');
});

/* 4) 超付：拒绝而非静默截断（与旧版 Math.min(paid,payable) 的**有意差异**，红线⑥） */
ok('超付被拒，且不留下半张单据', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvInbound(data, Object.assign({}, BASE, {
      paid: 300.5,
      items: [{ ing_id: 'i1', qty: 10, price: 30 }]
    })),
    /超过应付/
  );
  assert.strictEqual(data.recv.length, 0, '被拒时不得 push 半张单据');
});

/* 5) 负数实付：拒绝 */
ok('实付为负被拒', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvInbound(data, Object.assign({}, BASE, {
      paid: -1,
      items: [{ ing_id: 'i1', qty: 1, price: 10 }]
    })),
    /不能为负数/
  );
});

/* 6) 实收量：只登记（line.recvQty），不参与库存计价（仍按 qty）—— 界面已明示该口径 */
ok('实收量仅登记：recvQty=8 不影响应付与库存（仍按订购量 10）', () => {
  const data = mkData();
  inv.applyRecvInbound(data, Object.assign({}, BASE, {
    items: [{ ing_id: 'i1', qty: 10, recvQty: 8, price: 30 }]
  }));
  const d = data.recv[0];
  assert.strictEqual(d.lines[0].recvQty, 8);
  assert.strictEqual(d.lines[0].qty, 10);
  assert.strictEqual(d.payable, 300);
  assert.strictEqual(data.ings[0].stock, 10);
});

/* 7) 向后兼容：不传超集字段时，输出与 Python 版一致（payments=[] / method 默认 / 无 po） */
ok('不传超集字段：payments=[]、method=现金/转账、无 po 键（与 Python 逐字段一致）', () => {
  const data = mkData();
  inv.applyRecvInbound(data, Object.assign({}, BASE, {
    items: [{ ing_id: 'i1', name: '五花肉', qty: 2, price: 5.5 }]
  }));
  const d = data.recv[0];
  assert.deepStrictEqual(d.payments, []);
  assert.strictEqual(d.method, '现金/转账');
  assert.strictEqual(d.note, '【云端入库】');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(d, 'po'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(d.lines[0], 'recvQty'), false);
  assert.strictEqual(d.payable, 11);
});

/* 8) 关联采购单：单向登记到 recv.po（不触碰 data.orders） */
ok('关联采购单：写入 recv.po，且不动 orders（回写属采购管理页欠账）', () => {
  const data = mkData();
  data.orders = [{ id: 'CG1', no: 'CG20260929-01', status: 'normal', lines: [] }];
  inv.applyRecvInbound(data, Object.assign({}, BASE, {
    po: 'CG1',
    items: [{ ing_id: 'i1', qty: 1, price: 10 }]
  }));
  assert.strictEqual(data.recv[0].po, 'CG1');
  assert.strictEqual(data.orders[0].status, 'normal', 'orders 不得被本次入库改写');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(data.orders[0].lines[0] || {}, 'recvQty'), false);
});

/* 9) 空明细仍然拒绝（既有行为不回归） */
ok('items 全为 0 数量 → 拒绝空入库', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvInbound(data, Object.assign({}, BASE, { items: [{ ing_id: 'i1', qty: 0, price: 3 }] })),
    /无有效数量行/
  );
  assert.throws(() => inv.applyRecvInbound(mkData(), Object.assign({}, BASE, { items: [] })), /空入库已拒绝/);
});

/* 10) 浮点：金额按 r2 归整，不留 0.30000000000000004 */
ok('浮点金额 r2 归整（3 × 0.1 = 0.3）', () => {
  const data = mkData();
  inv.applyRecvInbound(data, Object.assign({}, BASE, {
    items: [{ ing_id: 'i1', qty: 3, price: 0.1 }]
  }));
  assert.strictEqual(data.recv[0].payable, 0.3);
  assert.strictEqual(data.recv[0].lines[0].amount, 0.3);
});

/* 11) ing.upsert 不在本用例范围：仅确认 items 里的 ing_id 原样落库（供 rebuildStock 匹配） */
ok('多行明细：ing_id 原样落库并按行汇总应付', () => {
  const data = mkData();
  inv.applyRecvInbound(data, Object.assign({}, BASE, {
    items: [
      { ing_id: 'i1', name: '五花肉', qty: 10, price: 30 },
      { ing_id: 'i2', name: '青菜', qty: 20, price: 2.5 }
    ]
  }));
  const d = data.recv[0];
  assert.strictEqual(d.lines.length, 2);
  assert.strictEqual(d.lines[1].ing, 'i2');
  assert.strictEqual(d.payable, 350);
  assert.strictEqual(data.ings[1].stock, 20);
});

console.log('[recv_inbound.test] PASS ' + pass + ' cases');
