'use strict';
/*
 * recv.void（作废进货单）行为测试。
 *
 * 红线：只改 status='已作废' 并记操作人/时间，**绝不 DELETE**（旧版 delRecv 物理删除不得照搬）。
 * 作废单由 stock.js 的重建过滤规则跳过 → 库存/均价按剩余单据自动回退（等价旧版「删除后重建台账」且不丢审计）。
 * 幂等：已作废再作废直接跳过。
 *
 * 用法：node bff/lib/algorithms/recv_void.test.js
 */
const assert = require('assert');
const inv = require('./inventory');

function mkData() {
  return {
    ings: [
      { id: 'i1', name: '五花肉', unit: '斤', buy: '斤', stock: 10, avg: 30 },
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

const BASE = { id: 'R1', operator: 'boss', reason: '录错' };

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  PASS ' + name);
}

/* 1) 作废：status=已作废、记操作人、原单仍在、库存按剩余单据回退（五花肉 stock 归 0） */
ok('作废：标记已作废 + 记操作人，库存自动回退（stock 10→0）', () => {
  const data = mkData();
  const msg = inv.applyRecvVoid(data, Object.assign({}, BASE));
  const d = data.recv[0];
  assert.strictEqual(d.status, '已作废');
  assert.strictEqual(d.void_operator, 'boss');
  assert.ok(d.void_at, '应记录作废时间');
  assert.strictEqual(d.void_reason, '录错');
  assert.strictEqual(data.recv.length, 1, '原单不得被物理删除');
  assert.strictEqual(data.ings[0].stock, 0, '作废后库存应回退（rebuildStock 跳过作废单）');
  assert.ok(/已作废/.test(msg));
});

/* 2) 作废不碰 payments（欠款留痕可查） */
ok('作废：payments 保留（欠款审计不丢）', () => {
  const data = mkData();
  inv.applyRecvVoid(data, Object.assign({}, BASE));
  assert.strictEqual(data.recv[0].payments.length, 1);
  assert.strictEqual(data.recv[0].payments[0].amount, 100);
});

/* 3) 幂等：已作废再作废返回跳过，不报错 */
ok('幂等：已作废单再作废直接跳过', () => {
  const data = mkData();
  data.recv[0].status = '已作废';
  const msg = inv.applyRecvVoid(data, Object.assign({}, BASE));
  assert.ok(/跳过/.test(msg));
  assert.strictEqual(data.recv[0].status, '已作废');
});

/* 4) 找不到单被拒 */
ok('找不到进货单被拒', () => {
  const data = mkData();
  assert.throws(
    () => inv.applyRecvVoid(data, { id: 'NOPE', operator: 'boss' }),
    /未找到进货单/
  );
});

/* 5) void 后 edit 应被拒（交叉校验：作废态不可再编辑） */
ok('作废态不可编辑（与 applyRecvUpdate 交叉校验）', () => {
  const data = mkData();
  inv.applyRecvVoid(data, Object.assign({}, BASE));
  assert.throws(
    () => inv.applyRecvUpdate(data, { id: 'R1', items: [{ ing_id: 'i1', qty: 1, price: 1 }] }),
    /已作废/
  );
});

console.log('[recv_void.test] PASS ' + pass + ' cases');
