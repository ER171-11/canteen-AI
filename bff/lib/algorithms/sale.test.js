'use strict';
/*
 * sale.create / sale.pay / sale.void（销售收银写侧执行器）行为契约测试。
 *
 * 为什么不做「平价测试」：
 *   旧系统在浏览器 JS 里直接改 DB.sales（旧 HTML renderSale/openGet），
 *   店内 `queue_consumer.py` 侧没有对应实现，**没有可对拍的 Python 侧**。
 *   故与 recv_pay.test.js 同样锁定行为契约；若日后 Python 侧补上 apply_sale_*，
 *   须把用例并入 inventory.test.js 做差分。
 *
 * 锁定口径（ADR-008 / ADR-009）：
 *   · 欠款 = receivable − Σ payments.amount，是**派生值，不得落库**
 *   · 实收按收款日期（payments[].date）；应收按单日期（date）
 *   · 作废只留痕不物理删除；已作废单不可收款
 *   · 收款只追加 payments，不动 receivable
 *
 * 用法：node bff/lib/algorithms/sale.test.js
 */
const assert = require('assert');
const sale = require('./sale');
const model = require('../sales_model');

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  PASS ' + name);
}

function mkData(over) {
  return Object.assign({ sales: [] }, over || {});
}

/* ---------------- sale.create ---------------- */

ok('新建销售单：售价合计/折扣/应收/首付/欠款 逐项正确', () => {
  const data = mkData();
  sale.applySaleCreate(data, {
    date: '2026-10-13',
    channel: '堂食',
    items: [
      { name: '五福饺子', qty: 2, price: 30 },
      { name: '御膳汤', qty: 1, price: 40, amount: 40 },
    ],
    discount: 0,
    paid: 60,
    method: '微信',
    note: '堂食 3 号桌',
  });
  const s = data.sales[0];
  assert.strictEqual(data.sales.length, 1);
  assert.strictEqual(s.date, '2026-10-13');
  assert.strictEqual(s.amount, 100, 'amount 语义 = 售价合计');
  assert.strictEqual(s.receivable, 100);
  assert.strictEqual(s.discount, 0);
  assert.strictEqual(s.payments.length, 1);
  assert.strictEqual(s.payments[0].amount, 60);
  assert.strictEqual(s.lines.length, 2);
  assert.strictEqual(s.status, undefined, 'status 不得落库（派生结论由 sales_model.statusOf 给）');
  assert.ok(!('debt' in s), '欠款是派生值，不得写入快照');
  assert.strictEqual(model.debtOf(s), 40, '欠款应实时派生为 40');
  assert.strictEqual(model.statusOf(s), '有欠款');
});

ok('单号生成：同日前缀 + 3 位流水递增', () => {
  const data = mkData();
  sale.applySaleCreate(data, { date: '2026-10-13', amount: 10, paid: 10 });
  sale.applySaleCreate(data, { date: '2026-10-13', amount: 10, paid: 10 });
  sale.applySaleCreate(data, { date: '2026-10-14', amount: 10, paid: 10 });
  assert.strictEqual(data.sales[0].no, 'XS20261013001');
  assert.strictEqual(data.sales[1].no, 'XS20261013002');
  assert.strictEqual(data.sales[2].no, 'XS20261014001');
});

ok('折扣：应收 = 售价合计 − 折扣；折扣为 0 时应收=售价合计', () => {
  const data = mkData();
  sale.applySaleCreate(data, { date: '2026-10-13', amount: 100, discount: 12.5, paid: 0 });
  assert.strictEqual(data.sales[0].amount, 100);
  assert.strictEqual(data.sales[0].discount, 12.5);
  assert.strictEqual(data.sales[0].receivable, 87.5);
  assert.strictEqual(data.sales[0].payments.length, 0, '未收款不造空 payment 记录');
  assert.strictEqual(model.debtOf(data.sales[0]), 87.5);
});

ok('校验：售价合计必须 > 0', () => {
  assert.throws(() => sale.applySaleCreate(mkData(), { date: '2026-10-13', amount: 0 }), /售价合计必须大于 0/);
});

ok('校验：日期非法被拒', () => {
  assert.throws(() => sale.applySaleCreate(mkData(), { date: '2026/10/13', amount: 10 }), /单日期非法/);
});

ok('校验：折扣超过售价合计被拒', () => {
  assert.throws(
    () => sale.applySaleCreate(mkData(), { date: '2026-10-13', amount: 100, discount: 120 }),
    /折扣超过售价合计/
  );
});

ok('校验：首付超过应收被拒', () => {
  assert.throws(
    () => sale.applySaleCreate(mkData(), { date: '2026-10-13', amount: 100, paid: 100.5 }),
    /首付超过应收/
  );
});

ok('校验：应收显式传入时不得超过「售价合计 − 折扣」', () => {
  assert.throws(
    () => sale.applySaleCreate(mkData(), { date: '2026-10-13', amount: 100, discount: 10, receivable: 95 }),
    /应收不得超过/
  );
});

ok('data.sales 缺失时自动建数组', () => {
  const data = { sales: undefined };
  sale.applySaleCreate(data, { date: '2026-10-13', amount: 10, paid: 10 });
  assert.ok(Array.isArray(data.sales));
  assert.strictEqual(data.sales.length, 1);
});

/* ---------------- sale.pay（分次收款 FP-SALE-11） ---------------- */

function mkSale(over) {
  return Object.assign({
    id: 'S1',
    no: 'XS20261013001',
    date: '2026-10-12',
    amount: 100,
    receivable: 100,
    discount: 0,
    payments: [],
  }, over || {});
}

ok('首次收款：payments +1、欠款实时下降、receivable 不变', () => {
  const data = { sales: [mkSale()] };
  const msg = sale.applySalePay(data, { sale_id: 'S1', amount: 40, method: '微信', date: '2026-10-13' });
  const s = data.sales[0];
  assert.strictEqual(s.receivable, 100, 'receivable 不得被改动');
  assert.strictEqual(s.amount, 100, 'amount 不得被改动');
  assert.strictEqual(s.payments.length, 1);
  assert.strictEqual(s.payments[0].amount, 40);
  assert.strictEqual(s.payments[0].date, '2026-10-13');
  assert.strictEqual(model.debtOf(s), 60);
  assert.ok(/剩余欠款 60/.test(msg), msg);
});

ok('分次收款至结清：跨日期两条 payments，实收按收款日期分别归属', () => {
  const data = { sales: [mkSale()] };
  sale.applySalePay(data, { sale_id: 'S1', amount: 40, date: '2026-10-13' });
  sale.applySalePay(data, { sale_id: 'S1', amount: 60, date: '2026-10-20' });
  const s = data.sales[0];
  assert.strictEqual(s.payments.length, 2);
  assert.strictEqual(model.debtOf(s), 0);
  assert.strictEqual(model.statusOf(s), '已结清');
  assert.strictEqual(model.receivedInRange(s, '2026-10-13', '2026-10-13'), 40);
  assert.strictEqual(model.receivedInRange(s, '2026-10-20', '2026-10-20'), 60);
  assert.strictEqual(model.receivedInRange(s, '2026-10-13', '2026-10-20'), 100);
});

ok('收款超过欠款被拒，且不留下半条记录', () => {
  const data = { sales: [mkSale()] };
  assert.throws(() => sale.applySalePay(data, { sale_id: 'S1', amount: 100.5 }), /超过欠款/);
  assert.strictEqual(data.sales[0].payments.length, 0);
});

ok('幂等：同一笔重复提交第二次被拒（不重复记账）', () => {
  const data = { sales: [mkSale()] };
  sale.applySalePay(data, { sale_id: 'S1', amount: 100 });
  assert.throws(() => sale.applySalePay(data, { sale_id: 'S1', amount: 100 }), /超过欠款/);
  assert.strictEqual(data.sales[0].payments.length, 1);
});

ok('金额为 0 / 负数被拒', () => {
  assert.throws(() => sale.applySalePay({ sales: [mkSale()] }, { sale_id: 'S1', amount: 0 }), /必须大于 0/);
  assert.throws(() => sale.applySalePay({ sales: [mkSale()] }, { sale_id: 'S1', amount: -1 }), /必须大于 0/);
});

ok('缺 sale_id / 找不到单 被拒；可用单号 no 定位', () => {
  assert.throws(() => sale.applySalePay({ sales: [mkSale()] }, { amount: 10 }), /缺 sale_id/);
  assert.throws(() => sale.applySalePay({ sales: [mkSale()] }, { sale_id: 'NOPE', amount: 10 }), /未找到销售单/);
  const data = { sales: [mkSale()] };
  const msg = sale.applySalePay(data, { sale_id: 'XS20261013001', amount: 10 });
  assert.ok(/剩余欠款 90/.test(msg), msg);
});

ok('payments 字段缺失的历史行视为「全额即收」→ 收款被拒（不凭空记收款）', () => {
  const data = { sales: [mkSale({ payments: undefined })] };
  assert.throws(() => sale.applySalePay(data, { sale_id: 'S1', amount: 50 }), /超过欠款/);
});

ok('payments 非数组（null）且仍有欠款时，执行器自动建数组', () => {
  const data = { sales: [mkSale({ amount: 100, receivable: 150, payments: null })] };
  sale.applySalePay(data, { sale_id: 'S1', amount: 50 });
  assert.ok(Array.isArray(data.sales[0].payments));
  assert.strictEqual(data.sales[0].payments.length, 1);
  /* 一旦 payments 变成显式数组，就不再走「全额即收」回退：欠款 = 150 − 50 = 100 */
  assert.strictEqual(model.debtOf(data.sales[0]), 100);
});

ok('浮点：0.1 + 0.2 类金额不留尾差', () => {
  const data = { sales: [mkSale({ amount: 0.3, receivable: 0.3 })] };
  sale.applySalePay(data, { sale_id: 'S1', amount: 0.1 });
  sale.applySalePay(data, { sale_id: 'S1', amount: 0.2 });
  assert.strictEqual(data.sales[0].payments.length, 2);
  assert.strictEqual(model.debtOf(data.sales[0]), 0);
});

/* ---------------- sale.void（作废留痕） ---------------- */

ok('作废：留痕不物理删除，原单仍在（含明细与收款）', () => {
  const data = { sales: [mkSale({ payments: [{ date: '2026-10-12', amount: 30 }], lines: [{ dish: 'd1', qty: 1, amount: 100 }] })] };
  const msg = sale.applySaleVoid(data, { id: 'S1', operator: '店长', reason: '客人退单' }, { rev: 42, traceId: 'T-1', now: '2026-10-13T10:00:00.000Z' });
  const s = data.sales[0];
  assert.strictEqual(data.sales.length, 1, '不得物理删除');
  assert.strictEqual(s.status, '已作废');
  assert.strictEqual(s.void_operator, '店长');
  assert.strictEqual(s.void_at, '2026-10-13T10:00:00.000Z', '作废时刻取队列 ctx.now');
  assert.strictEqual(s.void_rev, 42);
  assert.strictEqual(s.void_trace, 'T-1');
  assert.strictEqual(s.void_reason, '客人退单');
  assert.strictEqual(s.lines.length, 1, '明细保留可查');
  assert.strictEqual(s.payments.length, 1, '收款记录保留可查');
  assert.ok(/已作废·店长/.test(s.note), s.note);
  assert.ok(/原单保留可查/.test(msg), msg);
});

ok('作废幂等：已作废单直接跳过，不重复改写', () => {
  const data = { sales: [mkSale({ status: '已作废', void_operator: '原操作人' })] };
  const msg = sale.applySaleVoid(data, { id: 'S1', operator: '另一个操作人' });
  assert.strictEqual(data.sales[0].void_operator, '原操作人', '不得覆盖首次作废留痕');
  assert.ok(/已作废（跳过）/.test(msg), msg);
});

ok('已作废单不可收款', () => {
  const data = { sales: [mkSale({ status: '已作废' })] };
  assert.throws(() => sale.applySalePay(data, { sale_id: 'S1', amount: 10 }), /已作废销售单不可收款/);
});

ok('作废单不计入应收/实收/欠款聚合（口径走 sales_model.summarize）', () => {
  const data = {
    sales: [
      mkSale({ id: 'S1', receivable: 100, payments: [] }),
      mkSale({ id: 'S2', status: '已作废', receivable: 500, payments: [] }),
    ],
  };
  const agg = model.summarize(data.sales, {});
  assert.strictEqual(agg.receivable, 100, '作废单的应收不得计入');
  assert.strictEqual(agg.debt, 100, '作废单的欠款不得计入');
});

ok('缺 id / 找不到单 被拒', () => {
  assert.throws(() => sale.applySaleVoid({ sales: [mkSale()] }, {}), /缺 id/);
  assert.throws(() => sale.applySaleVoid({ sales: [mkSale()] }, { id: 'NOPE' }), /未找到销售单/);
});

console.log('[sale.test] PASS ' + pass + ' cases');
