'use strict';
/*
 * recv.pay（进货单补付 / 欠款清收）行为测试。
 *
 * 为什么不做「平价测试」：
 *   旧系统在浏览器 JS 里直接 payments.push（旧 HTML:2076），Python queue_consumer.py
 *   没有对应实现，因此**没有可对拍的 Python 侧**。这里改为锁定行为契约。
 *   若日后 Python 侧补上 apply_recv_pay，须把用例并入 inventory.test.js 做差分。
 *
 * 用法：node bff/lib/algorithms/recv_pay.test.js
 */
const assert = require('assert');
const inv = require('./inventory');

function mkDoc(over) {
  return Object.assign(
    {
      id: 'R1',
      no: 'JH20260912-01',
      date: '2026-09-12',
      supplier: '海南菜篮子',
      payable: 1000,
      payments: [],
      lines: [{ ing: 'i1', qty: 10, price: 100, amount: 1000 }]
    },
    over || {}
  );
}

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  PASS ' + name);
}

/* 1) 首次补付：欠款应减少，payable 与 lines 保持不动 */
ok('首次补付 400 → 剩余欠款 600，且不改 payable/lines', () => {
  const data = { recv: [mkDoc()] };
  const msg = inv.applyRecvPay(data, { recv_id: 'R1', amount: 400, method: '微信' });
  const d = data.recv[0];
  assert.strictEqual(d.payments.length, 1);
  assert.strictEqual(d.payments[0].amount, 400);
  assert.strictEqual(d.payments[0].method, '微信');
  assert.strictEqual(d.payable, 1000, 'payable 不得被改动');
  assert.deepStrictEqual(d.lines, mkDoc().lines, 'lines 不得被改动');
  assert.ok(/剩余欠款 600/.test(msg), 'msg 应含剩余欠款，实际：' + msg);
});

/* 2) 分次补付：补到 0 */
ok('分次补付至结清', () => {
  const data = { recv: [mkDoc()] };
  inv.applyRecvPay(data, { recv_id: 'R1', amount: 400 });
  const msg = inv.applyRecvPay(data, { recv_id: 'R1', amount: 600, method: '银行转账' });
  assert.strictEqual(data.recv[0].payments.length, 2);
  assert.ok(/剩余欠款 0/.test(msg), msg);
});

/* 3) 超过欠款必须拒绝（旧版 :2075 同口径 0 < amt <= debt+0.01） */
ok('超过欠款被拒', () => {
  const data = { recv: [mkDoc()] };
  assert.throws(
    () => inv.applyRecvPay(data, { recv_id: 'R1', amount: 1000.5 }),
    /超过欠款/
  );
  assert.strictEqual(data.recv[0].payments.length, 0, '被拒时不得留下半条记录');
});

/* 4) 幂等：同一笔重复执行，第二次因超欠款被拒 —— 不重复记账 */
ok('幂等：重复执行同一笔不重复记账', () => {
  const data = { recv: [mkDoc()] };
  inv.applyRecvPay(data, { recv_id: 'R1', amount: 1000 });
  assert.throws(() => inv.applyRecvPay(data, { recv_id: 'R1', amount: 1000 }), /超过欠款/);
  assert.strictEqual(data.recv[0].payments.length, 1);
});

/* 5) 金额合法性 */
ok('金额为 0 / 负数被拒', () => {
  assert.throws(() => inv.applyRecvPay({ recv: [mkDoc()] }, { recv_id: 'R1', amount: 0 }), /必须大于 0/);
  assert.throws(() => inv.applyRecvPay({ recv: [mkDoc()] }, { recv_id: 'R1', amount: -5 }), /必须大于 0/);
});

/* 6) 定位与缺参 */
ok('缺 recv_id 被拒', () => {
  assert.throws(() => inv.applyRecvPay({ recv: [mkDoc()] }, { amount: 10 }), /缺 recv_id/);
});
ok('找不到进货单被拒', () => {
  assert.throws(() => inv.applyRecvPay({ recv: [mkDoc()] }, { recv_id: 'NOPE', amount: 10 }), /未找到进货单/);
});
ok('可用单号 no 定位（不只认 id）', () => {
  const data = { recv: [mkDoc()] };
  const msg = inv.applyRecvPay(data, { recv_id: 'JH20260912-01', amount: 100 });
  assert.ok(/剩余欠款 900/.test(msg), msg);
});

/* 7) payments 缺失时自动建数组 */
ok('payments 字段缺失时自动初始化', () => {
  const data = { recv: [mkDoc({ payments: undefined })] };
  inv.applyRecvPay(data, { recv_id: 'R1', amount: 50 });
  assert.ok(Array.isArray(data.recv[0].payments));
  assert.strictEqual(data.recv[0].payments.length, 1);
});

/* 8) 浮点：0.1+0.2 类金额不留尾差 */
ok('浮点金额按 r2 归整', () => {
  const data = { recv: [mkDoc({ payable: 0.3 })] };
  inv.applyRecvPay(data, { recv_id: 'R1', amount: 0.1 });
  inv.applyRecvPay(data, { recv_id: 'R1', amount: 0.2 });
  assert.strictEqual(data.recv[0].payments[0].amount, 0.1);
  const left = 0.3 - 0.1 - 0.2;
  assert.ok(Math.abs(left) < 1e-9, '剩余欠款应归零，实际 ' + left);
});

console.log('[recv_pay.test] PASS ' + pass + ' cases');
