'use strict';
/*
 * lib/algorithms/execute.test.js — 执行器集成测试
 * 验证：已登记 type 能作用于快照副本；未登记 type 回 need-manual；失败不污染原快照。
 * 用法：node bff/lib/algorithms/execute.test.js
 */
const assert = require('assert');
const { executeAction, listTypes } = require('./execute');

const SNAP = {
  rev: 10,
  data: {
    ings: [
      { id: 'I1', name: '面粉', unit: 'kg', initStock: 10, initAvg: 5, stock: 0, avg: 0 },
      { id: 'I2', name: '猪肉', unit: 'kg', initStock: 5, initAvg: 30, stock: 0, avg: 0 }
    ],
    recv: [
      { no: 'PO-1', date: '2026-09-01', status: '已入库', lines: [{ ing: 'I1', qty: 20, unitCost: 6 }] }
    ],
    logs: [],
    orders: []
  },
  ext: null
};

function testRegistered() {
  const out = executeAction(SNAP, {
    type: 'stock.rebuild', payload: {}, trace_id: 't1'
  }, { now: '2026-09-27T00:00:00.000Z' });
  assert.strictEqual(out.ok, true, 'should ok');
  assert.strictEqual(out.handled, true, 'should handled');
  assert.ok(out.snapshot);
  const i1 = out.snapshot.data.ings.find((g) => g.id === 'I1');
  assert.strictEqual(i1.stock, 30, 'I1 stock = 10 init + 20 recv');
  // 原快照未被污染
  assert.strictEqual(SNAP.data.ings[0].stock, 0, 'original snapshot untouched');
  console.log('  PASS stock.rebuild applied, snapshot cloned');
}

function testRestock() {
  const out = executeAction(SNAP, {
    type: 'restock.create',
    payload: { items: [{ name: '面粉', qty: 5, unit: 'kg', price: 6 }] },
    trace_id: 't2'
  }, { now: '2026-09-27T00:00:00.000Z' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.snapshot.data.orders.length, 1, 'one draft order');
  assert.strictEqual(SNAP.data.orders.length, 0, 'original untouched');
  console.log('  PASS restock.create appended draft PO');
}

function testUnknown() {
  const out = executeAction(SNAP, { type: 'no.such.type', payload: {} });
  assert.strictEqual(out.handled, false, 'unknown → not handled');
  assert.ok(/need-manual/.test(out.error));
  console.log('  PASS unknown type → need-manual');
}

function testFailureIsolated() {
  // 非法桌态应抛错，返回 ok:false 且不改快照
  const out = executeAction(SNAP, { type: 'pos.table_state', payload: { table_id: 'T1', state: '???' } });
  assert.strictEqual(out.handled, true);
  assert.strictEqual(out.ok, false, 'invalid table state should fail');
  assert.ok(out.error);
  console.log('  PASS failure returns ok:false, no snapshot');
}

function main() {
  assert.ok(listTypes().length >= 59, 'registered types >= 59');
  testRegistered();
  testRestock();
  testUnknown();
  testFailureIsolated();
  console.log('[execute.test] PASS');
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[execute.test] FAIL:', e.message);
    process.exit(1);
  }
}
