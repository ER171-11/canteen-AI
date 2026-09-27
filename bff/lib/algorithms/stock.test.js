'use strict';
/*
 * 库存算法平价测试：Node rebuildStock 输出 vs Python queue_consumer.rebuild_stock 输出。
 * 同一 fixture 分别跑两端，深比较 data 结果。
 * 用法：node bff/lib/algorithms/stock.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { rebuildStock } = require('./stock');

const FIXTURE = {
  ings: [
    { id: 'I1', name: '面粉', unit: 'kg', initStock: 10, initAvg: 5, stock: 999, avg: 999, qty: 999 },
    { id: 'I2', name: '猪肉', unit: 'kg', initStock: 5, initAvg: 30, stock: 0, avg: 0 },
    { id: 'I3', name: '白菜', unit: 'kg', initStock: 0, initAvg: 0, stock: 0, avg: 0 }
  ],
  recv: [
    { no: 'PO-1', date: '2026-09-01', status: '已入库', lines: [
      { ing: 'I1', qty: 20, unitCost: 6, conv: 1 },
      { ing: 'I2', qty: 10, unitCost: 32, conv: 1 }
    ] },
    { no: 'PO-2', date: '2026-09-02', status: '草稿', lines: [
      { ing: 'I1', qty: 100, unitCost: 1 } // 草稿不进库存
    ] }
  ],
  logs: [
    { type: '手工调整', ing: 'I3', qty: 7, inCost: 3, date: '2026-09-03' },
    { type: '盘点调整', ing: 'I2', qty: -2, date: '2026-09-04' }
  ]
};

function runNode() {
  const data = JSON.parse(JSON.stringify(FIXTURE));
  const msg = rebuildStock(data);
  return { data, msg };
}

function runPython() {
  // 通过 python3 调用 queue_consumer.rebuild_stock，保持同一实现
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '../../../store-inventory'))})
import importlib.util
spec = importlib.util.spec_from_file_location("qc", ${JSON.stringify(path.join(__dirname, '../../../old/store-inventory-legacy/python-runtime/queue_consumer.py'))})
qc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qc)
data = json.loads(sys.stdin.read())
msg = qc.rebuild_stock(data)
print(json.dumps({"data": data, "msg": msg}))
`;
  const out = execFileSync('python3', ['-c', py], { input: JSON.stringify(FIXTURE), encoding: 'utf8' });
  return JSON.parse(out);
}

function stripVolatile(d) {
  // 去掉时间戳字段后比较（nowIso / today 会因运行时刻不同）
  const clone = JSON.parse(JSON.stringify(d));
  for (const g of clone.ings || []) delete g._u;
  return clone;
}

function main() {
  const n = runNode();
  const p = runPython();
  assert.strictEqual(n.msg, p.msg, 'summary mismatch: ' + n.msg + ' != ' + p.msg);
  assert.deepStrictEqual(stripVolatile(n.data), stripVolatile(p.data), 'data mismatch');
  console.log('[stock.test] PASS  ' + n.msg);
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[stock.test] FAIL:', e.message);
    process.exit(1);
  }
}
