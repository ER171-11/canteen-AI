'use strict';
/*
 * seed_finance_extra.test.js — seed_finance_extra.js ↔ seed_finance_extra.py 平价测试
 *
 * 1) 差分：清空财务/能耗表后分别跑 Node / Python，比较受影响表内容；
 * 2) 幂等：连续跑两次 Node，第二次因「表非空则跳过」而完全稳定；
 * 3) 缺表容错：eq_temp 表缺失时跳过（打印 eq_temp skip）而不抛错，与原脚本一致。
 *
 * 用法：node bff/store-node/seed/seed_finance_extra.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('./testutil');
const finance = require('./seed_finance_extra');

const TABLES = ['fin_invoices', 'fin_tax', 'fin_cash', 'eq_energy', 'eq_temp', 'loss_reports'];
const EXPECT = { fin_invoices: 3, fin_tax: 3, fin_cash: 3, eq_energy: 3, eq_temp: 27, loss_reports: 1 };

function main() {
  const dir = util.tmpDir('seed-finance-');
  try {
    /* ---------- 1) 差分 ---------- */
    const nodeDb = path.join(dir, 'node', '餐厅系统.db');
    const pyDb = path.join(dir, 'py', '餐厅系统.db');
    util.copyBaseDb(nodeDb);
    util.copyBaseDb(pyDb);
    util.clearTables(nodeDb, TABLES);
    util.clearTables(pyDb, TABLES);

    finance.main(nodeDb);
    const pyCode = util.loadPyModule('f', util.PY_FINANCE)
      + '\nf.DB = sys.argv[1]'
      + '\nf.main()';
    util.runPython(pyCode, [pyDb]);
    util.assertTablesEqual(nodeDb, pyDb, TABLES);
    console.log('  PASS 差分: ' + TABLES.length + ' 张表与 Python 一致');

    for (const t of TABLES) {
      assert.strictEqual(util.countWhere(nodeDb, t), EXPECT[t], t + ' 行数应为 ' + EXPECT[t]);
    }
    console.log('  PASS 行数: 各表种子条数精确');

    /* ---------- 2) 幂等（表非空则跳过） ---------- */
    const snap1 = {};
    for (const t of TABLES) snap1[t] = util.tableSnapshot(nodeDb, t);
    finance.main(nodeDb);
    for (const t of TABLES) {
      assert.deepStrictEqual(util.tableSnapshot(nodeDb, t), snap1[t], t + ' 第二次执行结果不稳定');
      assert.strictEqual(util.countWhere(nodeDb, t), EXPECT[t], t + ' 第二次执行后行数漂移');
    }
    console.log('  PASS 幂等: 第二次全部跳过，结果稳定');

    /* ---------- 3) eq_temp 缺表容错 ---------- */
    const noTempDb = path.join(dir, 'notemp', '餐厅系统.db');
    util.copyBaseDb(noTempDb);
    const db = util.openDb(noTempDb);
    try { db.exec('DROP TABLE eq_temp'); } finally { db.close(); }
    finance.main(noTempDb); // 不应抛错
    const check = util.openDb(noTempDb);
    let exists;
    try {
      exists = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='eq_temp'").get();
    } finally {
      check.close();
    }
    assert.strictEqual(exists, undefined, 'eq_temp 应保持缺失（跳过）');
    console.log('  PASS 容错: eq_temp 缺失时跳过不抛错');

    console.log('[seed_finance_extra.test] PASS');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[seed_finance_extra.test] FAIL:', e && e.stack ? e.stack : e); process.exit(1); }
}
