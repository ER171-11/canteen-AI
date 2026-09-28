'use strict';
/*
 * seed_today_workorders.test.js — 差分测试
 * 用两份临时 sqlite（从真实库复制），分别跑 Python 原实现与 Node 移植，
 * 比较 sop_workorders 全表（含 id）与今日行。
 * 用法：node bff/store-node/seed/seed_today_workorders.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runPythonArgv: execPyArgv } = require('../../lib/_python');
const { DatabaseSync } = require('node:sqlite');
const lib = require('./testlib');
const node = require('./seed_today_workorders');

const PY_SCRIPT = path.join(lib.REPO_ROOT, 'old', 'store-inventory-legacy', 'python-seed', 'seed_today_workorders.py');

function allRows(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    return conn
      .prepare(
        'SELECT id, date, sku_id, qty, status, planned_start, qc_records FROM sop_workorders ORDER BY id'
      )
      .all()
      .map((r) => ({
        id: r.id,
        date: r.date,
        sku_id: r.sku_id,
        qty: r.qty === null ? null : Number(r.qty),
        status: r.status,
        planned_start: r.planned_start,
        qc_records: r.qc_records,
      }));
  } finally {
    conn.close();
  }
}

function main() {
  const tmp = lib.tmpdir('workorders-test-');
  const pyDb = lib.copyDb(path.join(tmp, 'py', '餐厅系统.db'));
  const nodeDb = lib.copyDb(path.join(tmp, 'node', '餐厅系统.db'));

  execPyArgv([PY_SCRIPT, '--db', pyDb]);
  const out = node.run(nodeDb);

  const n = allRows(nodeDb);
  const p = allRows(pyDb);
  try {
    assert.deepStrictEqual(n, p);
  } catch (e) {
    console.error('Node  :', JSON.stringify(n));
    console.error('Python:', JSON.stringify(p));
    throw e;
  }

  assert.strictEqual(out.workorders.length, 5, '今日应 5 条工单');
  assert.strictEqual(out.workorders[0][1], 'SKU-WF-HONG');
  assert.strictEqual(Number(out.workorders[0][2]), 70);
  assert.ok(!n.some((r) => String(r.sku_id || '').startsWith('WF-')), '非法 WF-* 应清空');
  assert.strictEqual(
    out.workorders.map((r) => r[1]).join(','),
    'SKU-WF-HONG,SKU-WF-HEI,SKU-WF-HUANG,SKU-WF-LV,SKU-WF-BAI-XIHULU'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('[seed_today_workorders.test] PASS  rows=' + n.length + ' date=' + out.date);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[seed_today_workorders.test] FAIL:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
}
