'use strict';
/*
 * db.test.js — db.js 与 db.py 的平价（差分）测试。
 * 用临时 sqlite，分别跑 Node 与 Python 的同一串操作，
 * 比较 get/put/snapshot/rollback 的 rev 与 data（忽略时间戳等易变字段）。
 * 用法：node bff/store-node/db.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPython: execPy } = require('../lib/_python');
const { Store } = require('./db');

const PY_DB = path.resolve(__dirname, '..', '..', 'old', 'store-inventory-legacy', 'python-runtime', 'db.py');

const OPS = [
  { op: 'get' },
  { op: 'put', rev: 0, data: { ings: [{ id: 'I1', name: '面粉', qty: 10 }], seq: 1 }, machine: 'SHOP', note: 'first' },
  { op: 'get' },
  { op: 'put', rev: 1, data: { ings: [{ id: 'I1', name: '面粉', qty: 20 }], seq: 2 }, machine: 'SHOP' },
  { op: 'put', rev: 0, data: { bad: true }, machine: 'SHOP' }, // 冲突
  { op: 'get' },
  { op: 'snapshot', machine: 'SHOP', note: 'manual' },
  { op: 'get_snapshot', rev: 2 },
  { op: 'get_snapshot', rev: 1 },
  { op: 'get_snapshot', rev: 99 },
  { op: 'list_snapshots' },
  { op: 'rollback', rev: 1, machine: 'SHOP' },
  { op: 'get' },
  { op: 'list_snapshots' },
  { op: 'size' },
  { op: 'cold_backup', tag: 'test' },
];

// 去掉时间戳 / 体积等易变字段后比较
const VOLATILE = new Set(['updated_at', 'ts', 'size']);
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (VOLATILE.has(k)) continue;
      out[k] = normalize(v[k]);
    }
    return out;
  }
  return v;
}

function runNode(dbPath, backupDir) {
  const store = new Store(dbPath, backupDir, 30, 200);
  const results = [];
  for (const o of OPS) {
    let r;
    try {
      if (o.op === 'get') r = store.get();
      else if (o.op === 'put') r = store.put(o.rev, o.data, o.machine, o.note || '', !!o.force);
      else if (o.op === 'snapshot') r = store.snapshot(o.machine, o.note || 'manual');
      else if (o.op === 'get_snapshot') r = store.get_snapshot(o.rev);
      else if (o.op === 'list_snapshots') r = store.list_snapshots();
      else if (o.op === 'rollback') r = store.rollback(o.rev, o.machine);
      else if (o.op === 'size') r = store.size() > 0;
      else if (o.op === 'cold_backup') r = !!store.cold_backup(o.tag || 'boot');
    } catch (e) {
      if (e && e.name === 'Conflict') {
        r = { conflict: true, rev: e.rev, machine: e.machine };
      } else {
        throw e;
      }
    }
    results.push(r);
  }
  return normalize(results);
}

function runPython(dbPath, backupDir) {
  const py = [
    'import json, sys, importlib.util',
    'spec = importlib.util.spec_from_file_location("dbpy", ' + JSON.stringify(PY_DB) + ')',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'p = json.loads(sys.stdin.read())',
    'store = m.Store(p["db"], p["backup"], 30, 200)',
    'results = []',
    'for o in p["ops"]:',
    '    try:',
    '        if o["op"] == "get": r = store.get()',
    '        elif o["op"] == "put": r = store.put(o.get("rev"), o.get("data"), o.get("machine"), o.get("note") or "", bool(o.get("force")))',
    '        elif o["op"] == "snapshot": r = store.snapshot(o.get("machine"), o.get("note") or "manual")',
    '        elif o["op"] == "get_snapshot": r = store.get_snapshot(o.get("rev"))',
    '        elif o["op"] == "list_snapshots": r = store.list_snapshots()',
    '        elif o["op"] == "rollback": r = store.rollback(o.get("rev"), o.get("machine"))',
    '        elif o["op"] == "size": r = store.size() > 0',
    '        elif o["op"] == "cold_backup": r = bool(store.cold_backup(o.get("tag") or "boot"))',
    '    except m.Conflict as cf:',
    '        r = {"conflict": True, "rev": cf.rev, "machine": cf.machine}',
    '    results.append(r)',
    'sys.stdout.write(json.dumps(results))',
  ].join('\n');
  const res = execPy(py, JSON.stringify({ db: dbPath, backup: backupDir, ops: OPS }));
  return normalize(JSON.parse(res));
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-node-db-'));
  const nodeDb = path.join(dir, 'node', '餐厅系统.db');
  const nodeBk = path.join(dir, 'node', 'backups');
  const pyDb = path.join(dir, 'py', '餐厅系统.db');
  const pyBk = path.join(dir, 'py', 'backups');

  const n = runNode(nodeDb, nodeBk);
  const p = runPython(pyDb, pyBk);
  try {
    assert.deepStrictEqual(n, p);
  } catch (e) {
    console.error('Node  : ' + JSON.stringify(n, null, 2));
    console.error('Python: ' + JSON.stringify(p, null, 2));
    throw e;
  }

  // 冷备份确实产出文件
  const nBkCount = fs.readdirSync(nodeBk).filter((f) => f.endsWith('.db')).length;
  const pBkCount = fs.readdirSync(pyBk).filter((f) => f.endsWith('.db')).length;
  assert.strictEqual(nBkCount, pBkCount, '备份文件数不一致');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('[db.test] PASS  ' + OPS.length + ' 步操作 rev/data 与 Python 一致');
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[db.test] FAIL:', e.message);
    process.exit(1);
  }
}
