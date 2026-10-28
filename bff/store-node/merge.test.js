'use strict';
/*
 * merge.test.js — merge.js 与 merge.py 的平价（差分）测试。
 * 同一组 base/mine/theirs fixture，分别跑 Node 与 Python，深比较 merged 与 conflicts。
 * 覆盖：单端改/双端改/删除/新增/rec 表/时间戳冲突/seq/suppliers/platforms/logs/orders/recv。
 * 用法：node bff/store-node/merge.test.js
 */
const assert = require('assert');
const path = require('path');
const { runPython: execPy } = require('../lib/_python');
const M = require('./merge');

const PY_MERGE = path.resolve(__dirname, '..', '..', 'old', 'store-inventory-legacy', 'python-runtime', 'merge.py');

// ---------- fixture ----------
const CASES = [
  {
    name: '单端改-本机改',
    base: { ings: [{ id: 'A', name: '面粉', qty: 1, _u: '2026-01-01T00:00:00' }] },
    mine: { ings: [{ id: 'A', name: '面粉', qty: 2, _u: '2026-01-02T00:00:00' }] },
    theirs: { ings: [{ id: 'A', name: '面粉', qty: 1, _u: '2026-01-01T00:00:00' }] },
  },
  {
    name: '单端改-对端改',
    base: { ings: [{ id: 'A', qty: 1, _u: 't1' }] },
    mine: { ings: [{ id: 'A', qty: 1, _u: 't1' }] },
    theirs: { ings: [{ id: 'A', qty: 9, _u: 't2' }] },
  },
  {
    name: '双端改-本机更新',
    base: { ings: [{ id: 'A', qty: 1, _u: 't1' }] },
    mine: { ings: [{ id: 'A', qty: 5, _u: 't3' }] },
    theirs: { ings: [{ id: 'A', qty: 9, _u: 't2' }] },
  },
  {
    name: '双端改-对端更新',
    base: { ings: [{ id: 'A', qty: 1, _u: 't1' }] },
    mine: { ings: [{ id: 'A', qty: 5, _u: 't2' }] },
    theirs: { ings: [{ id: 'A', qty: 9, _u: 't3' }] },
  },
  {
    name: '时间戳冲突-取服务端',
    base: { ings: [{ id: 'A', qty: 1, _u: 't1' }] },
    mine: { ings: [{ id: 'A', qty: 5, _u: 't9' }] },
    theirs: { ings: [{ id: 'A', qty: 9, _u: 't9' }] },
  },
  {
    name: '删除-对端删本机没改',
    base: { ings: [{ id: 'A', qty: 1, _u: 't1' }, { id: 'B', qty: 2, _u: 't1' }] },
    mine: { ings: [{ id: 'B', qty: 2, _u: 't1' }] },
    theirs: { ings: [{ id: 'A', qty: 1, _u: 't1' }] },
  },
  {
    name: '删除-对端删本机改过',
    base: { ings: [{ id: 'A', qty: 1, _u: 't1' }] },
    mine: { ings: [{ id: 'A', qty: 7, _u: 't2' }] },
    theirs: { ings: [] },
  },
  {
    name: '删除-本机删对端改过',
    base: { ings: [{ id: 'A', qty: 1, _u: 't1' }] },
    mine: { ings: [] },
    theirs: { ings: [{ id: 'A', qty: 8, _u: 't2' }] },
  },
  {
    name: '新增-两端各自新增',
    base: { ings: [] },
    mine: { ings: [{ id: 'M1', name: '本机新', _u: 'tm' }] },
    theirs: { ings: [{ id: 'T1', name: '对端新', _u: 'tt' }, { id: 'A', name: '保留顺序', _u: 't0' }] },
  },
  {
    name: 'logs按seq',
    base: { logs: [{ seq: 1, type: 'x', _u: 't1' }, { seq: 2, type: 'y', _u: 't1' }] },
    mine: { logs: [{ seq: 1, type: 'x', _u: 't1' }, { seq: 2, type: 'y2', _u: 't2' }] },
    theirs: { logs: [{ seq: 1, type: 'x', _u: 't1' }, { seq: 3, type: 'z', _u: 't3' }] },
  },
  {
    name: 'orders-rec',
    base: {
      orders: [{ id: 'O1', qty: 1, _u: 't1' }],
      recv: [{ id: 'R1', qty: 1, _u: 't1' }],
    },
    mine: {
      orders: [{ id: 'O1', qty: 2, _u: 't2' }],
      recv: [{ id: 'R1', qty: 1, _u: 't1' }],
    },
    theirs: {
      orders: [{ id: 'O1', qty: 1, _u: 't1' }, { id: 'O2', qty: 5, _u: 't3' }],
      recv: [{ id: 'R1', qty: 9, _u: 't2' }],
    },
  },
  {
    name: 'rec表-双端改',
    base: { rec: { D1: { ings: [{ id: 'I1', qty: 1 }] } }, _recU: { D1: 't1' } },
    mine: { rec: { D1: { ings: [{ id: 'I1', qty: 2 }] } }, _recU: { D1: 't2' } },
    theirs: { rec: { D1: { ings: [{ id: 'I1', qty: 3 }] } }, _recU: { D1: 't3' } },
  },
  {
    name: 'rec表-同时间戳冲突',
    base: { rec: { D1: { ings: [] } }, _recU: { D1: 't1' } },
    mine: { rec: { D1: { ings: [{ id: 'I1', qty: 2 }] } }, _recU: { D1: 't9' } },
    theirs: { rec: { D1: { ings: [{ id: 'I1', qty: 3 }] } }, _recU: { D1: 't9' } },
  },
  {
    name: 'rec表-一端删除',
    base: { rec: { D1: { ings: [] } }, _recU: { D1: 't1' } },
    mine: { rec: {} },
    theirs: { rec: { D1: { ings: [{ id: 'I1', qty: 3 }] } }, _recU: { D1: 't3' } },
  },
  {
    name: 'suppliers并集与platforms按name',
    base: { suppliers: ['甲', '乙'], platforms: [{ name: '美团', fee: 1 }] },
    mine: { suppliers: ['乙', '丙'], platforms: [{ name: '美团', fee: 2 }, { name: '饿了么', fee: 3 }] },
    theirs: { suppliers: ['丁'], platforms: [{ name: '抖音', fee: 4 }] },
  },
  {
    name: '标量-seq-v-rest-meta',
    base: { seq: 10, v: 3, rest: { x: 1 }, _meta: { a: 1, b: 1 } },
    mine: { seq: 12, v: 5, _meta: { b: 2, c: 3 } },
    theirs: { seq: 11, v: 4, rest: { x: 9 }, _meta: { a: 9 } },
  },
  {
    name: '空库首次写入',
    base: {},
    mine: { ings: [{ id: 'A', qty: 1 }], seq: 1 },
    theirs: {},
  },
  {
    name: 'ing_terms-本机新增词条',
    base: { ing_terms: [{ id: 'T001', name: '面粉', status: 'active', _u: 't1' }] },
    mine: { ing_terms: [{ id: 'T001', name: '面粉', status: 'active', _u: 't1' }, { id: 'T016', name: '云南', status: 'pending', _u: 't2' }] },
    theirs: { ing_terms: [{ id: 'T001', name: '面粉', status: 'active', _u: 't1' }] },
  },
  {
    name: 'ing_terms-本机改状态对端未改',
    base: { ing_terms: [{ id: 'T016', name: '云南', status: 'pending', _u: 't1' }] },
    mine: { ing_terms: [{ id: 'T016', name: '云南', status: 'active', _u: 't2' }] },
    theirs: { ing_terms: [{ id: 'T016', name: '云南', status: 'pending', _u: 't1' }] },
  },
  {
    name: 'ing_terms-两端各自新增',
    base: { ing_terms: [{ id: 'T001', name: '面粉', status: 'active', _u: 't1' }] },
    mine: { ing_terms: [{ id: 'T001', name: '面粉', status: 'active', _u: 't1' }, { id: 'T016', name: '云南', status: 'pending', _u: 't2' }] },
    theirs: { ing_terms: [{ id: 'T001', name: '面粉', status: 'active', _u: 't1' }, { id: 'T017', name: '北京', status: 'pending', _u: 't3' }] },
  },
  {
    name: 'vendor_terms-本机新增词条',
    base: { vendor_terms: [{ id: 'S001', name: '食材', status: 'active', _u: 't1' }] },
    mine: { vendor_terms: [{ id: 'S001', name: '食材', status: 'active', _u: 't1' }, { id: 'S6', name: '半成品', status: 'pending', _u: 't2' }] },
    theirs: { vendor_terms: [{ id: 'S001', name: '食材', status: 'active', _u: 't1' }] },
  },
  {
    name: 'vendor_terms-本机改状态对端未改',
    base: { vendor_terms: [{ id: 'S6', name: '半成品', status: 'pending', _u: 't1' }] },
    mine: { vendor_terms: [{ id: 'S6', name: '半成品', status: 'active', _u: 't2' }] },
    theirs: { vendor_terms: [{ id: 'S6', name: '半成品', status: 'pending', _u: 't1' }] },
  },
  {
    name: 'vendor_terms-两端各自新增',
    base: { vendor_terms: [{ id: 'S001', name: '食材', status: 'active', _u: 't1' }] },
    mine: { vendor_terms: [{ id: 'S001', name: '食材', status: 'active', _u: 't1' }, { id: 'S6', name: '半成品', status: 'pending', _u: 't2' }] },
    theirs: { vendor_terms: [{ id: 'S001', name: '食材', status: 'active', _u: 't1' }, { id: 'S7', name: '饮品原料', status: 'pending', _u: 't3' }] },
  },
];

// ---------- Python 参考实现 ----------
function runPython(cases) {
  const py = [
    'import json, sys, importlib.util',
    'spec = importlib.util.spec_from_file_location("mergepy", ' + JSON.stringify(PY_MERGE) + ')',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'cases = json.loads(sys.stdin.read())',
    'out = []',
    'for c in cases:',
    '    merged, conflicts = m.merge(c.get("base"), c.get("mine"), c.get("theirs"))',
    '    out.append({"merged": merged, "conflicts": conflicts})',
    'sys.stdout.write(json.dumps(out))',
  ].join('\n');
  const res = execPy(py, JSON.stringify(cases));
  return JSON.parse(res);
}

// conflicts 顺序取决于 Python set 迭代顺序，比较前按内容排序归一
function sortConflicts(list) {
  return (list || []).slice().sort((a, b) =>
    JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0
  );
}

function jsonRoundTrip(v) {
  return JSON.parse(JSON.stringify(v));
}

// recHash 必须与 Python 完全一致
function testRecHashParity() {
  const records = [
    { id: 'A', name: '面粉', qty: 1, _u: 't1', _d: true },
    { id: 'B', name: '猪肉', tags: ['a', 'b'], nested: { x: 1, y: null } },
    { foo: 'bar', n: 1.5, m: 0.1, ok: true, no: false, nil: null },
    { arr: [1, '二', { k: '值' }], empty: {}, emptyArr: [] },
    { '引号"': '反斜杠\\', 换行: 'a\nb', tab: 'a\tb' },
  ];
  const py = [
    'import json, sys, importlib.util',
    'spec = importlib.util.spec_from_file_location("mergepy", ' + JSON.stringify(PY_MERGE) + ')',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'recs = json.loads(sys.stdin.read())',
    'sys.stdout.write(json.dumps([m.rec_hash(r) for r in recs]))',
  ].join('\n');
  const res = JSON.parse(execPy(py, JSON.stringify(records)));
  const mine = records.map((r) => M.recHash(r));
  assert.deepStrictEqual(mine, res, 'recHash mismatch');
  console.log('[merge.test] recHash 与 Python 一致（' + records.length + ' 条）');
}

function main() {
  testRecHashParity();

  const pyth = runPython(CASES);
  assert.strictEqual(pyth.length, CASES.length);
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const [merged, conflicts] = M.merge(c.base, c.mine, c.theirs);
    const n = { merged: jsonRoundTrip(merged), conflicts: sortConflicts(jsonRoundTrip(conflicts)) };
    const p = { merged: pyth[i].merged, conflicts: sortConflicts(pyth[i].conflicts) };
    try {
      assert.deepStrictEqual(n, p);
    } catch (e) {
      console.error('[merge.test] 用例失败: ' + c.name);
      console.error('  Node  : ' + JSON.stringify(n));
      console.error('  Python: ' + JSON.stringify(p));
      throw e;
    }
  }
  console.log('[merge.test] PASS  ' + CASES.length + ' 个用例全部与 Python 一致');
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[merge.test] FAIL:', e.message);
    process.exit(1);
  }
}
