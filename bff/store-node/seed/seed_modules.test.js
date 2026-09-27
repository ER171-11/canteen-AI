'use strict';
/*
 * seed_modules.test.js — seed_modules.js ↔ seed_modules.py 平价测试
 *
 * 1) 差分：同一基线库分别跑 Node / Python 的 build_rows()+seed()，比较 10 张表；
 * 2) 幂等：连续跑两次 Node，结果稳定（DELETE source='demo_proto' 后重插）；
 * 3) dry-run：只打印摘要、不落库，库内容不变。
 *
 * 用法：node bff/store-node/seed/seed_modules.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('./testutil');
const seed = require('./seed_modules');

const TABLES = [
  'staff_shifts', 'staff_clock', 'staff_perf', 'staff_train',
  'fs_certs', 'fs_trace', 'fs_samples', 'fs_disinfect',
  'bookings', 'queue',
];
// 每表固定种子行数（source='demo_proto'）
const EXPECT = {
  staff_shifts: 42, staff_clock: 4, staff_perf: 5, staff_train: 7,
  fs_certs: 7, fs_trace: 3, fs_samples: 3, fs_disinfect: 4,
  bookings: 12, queue: 5,
};

function main() {
  const dir = util.tmpDir('seed-modules-');
  try {
    /* ---------- 1) 差分 ---------- */
    const nodeDb = path.join(dir, 'node', '餐厅系统.db');
    const pyDb = path.join(dir, 'py', '餐厅系统.db');
    util.copyBaseDb(nodeDb);
    util.copyBaseDb(pyDb);

    seed.seed(nodeDb, seed.buildRows(), false);
    const pyCode = util.loadPyModule('m', util.PY_MODULES)
      + '\nm.seed(sys.argv[1], m.build_rows(), False)';
    util.runPython(pyCode, [pyDb]);
    util.assertTablesEqual(nodeDb, pyDb, TABLES);
    console.log('  PASS 差分: ' + TABLES.length + ' 张表与 Python 一致');

    // 种子行数正确
    for (const t of TABLES) {
      const n = util.countWhere(nodeDb, t, "source='demo_proto'");
      assert.strictEqual(n, EXPECT[t], t + ' demo_proto 行数应为 ' + EXPECT[t] + '，实际 ' + n);
    }
    console.log('  PASS 行数: 各表 source=demo_proto 精确');

    /* ---------- 2) 幂等 ---------- */
    const snap1 = {};
    for (const t of TABLES) snap1[t] = util.tableSnapshot(nodeDb, t);
    seed.seed(nodeDb, seed.buildRows(), false);
    for (const t of TABLES) {
      assert.deepStrictEqual(util.tableSnapshot(nodeDb, t), snap1[t], t + ' 第二次执行结果不稳定');
      const n = util.countWhere(nodeDb, t, "source='demo_proto'");
      assert.strictEqual(n, EXPECT[t], t + ' 第二次执行后行数漂移');
    }
    console.log('  PASS 幂等: 连续两次结果稳定，无重复');

    /* ---------- 3) dry-run 不落库 ---------- */
    const dryDb = path.join(dir, 'dry', '餐厅系统.db');
    util.copyBaseDb(dryDb);
    const dryBefore = util.tableSnapshot(dryDb, 'bookings');
    const dryCount = util.countWhere(dryDb, 'bookings');
    seed.seed(dryDb, seed.buildRows(), true);
    assert.strictEqual(util.countWhere(dryDb, 'bookings'), dryCount, 'dry-run 不应改库');
    assert.deepStrictEqual(util.tableSnapshot(dryDb, 'bookings'), dryBefore, 'dry-run 不应改库');
    console.log('  PASS dry-run: 仅打印摘要，未落库');

    console.log('[seed_modules.test] PASS');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[seed_modules.test] FAIL:', e && e.stack ? e.stack : e); process.exit(1); }
}
