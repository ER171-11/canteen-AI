'use strict';
/*
 * seed_today_workorders.js — 今日后厨工单：按金丰一批≈67 个、午市备货节奏重种（幂等清 demo 日单）
 *
 * 逐行移植 store-inventory/seed_today_workorders.py。
 * 对齐单店日售 ~150 份：红 70 / 黑 60 / 黄 50 / 绿 45 / 白西葫芦 40
 * 状态：早市已完成一批红、一批黑制作中、其余待开始；剔除非法 SKU WF-01。
 *
 * 用法：
 *   node bff/store-node/seed/seed_today_workorders.js [--db PATH]
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { todayLocal } = require('./util');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DB = path.join(REPO_ROOT, 'store-inventory', 'data', '餐厅系统.db');

// (sku_id, qty, planned_start_hhmm, status)
const TODAY_PLAN = [
  ['SKU-WF-HONG', 70, '08:30', '已完成'],
  ['SKU-WF-HEI', 60, '09:30', '制作中'],
  ['SKU-WF-HUANG', 50, '10:30', '待开始'],
  ['SKU-WF-LV', 45, '11:00', '待开始'],
  ['SKU-WF-BAI-XIHULU', 40, '14:00', '待开始'],
];

function run(dbPath) {
  const today = todayLocal();
  const conn = new DatabaseSync(dbPath);
  try {
    // 清掉今日全部 + 历史非法 SKU
    conn.prepare("DELETE FROM sop_workorders WHERE date=? OR sku_id LIKE 'WF-%'").run(today);
    const ins = conn.prepare(
      'INSERT INTO sop_workorders (date, sku_id, qty, planned_start, status, qc_records)' +
        ' VALUES (?,?,?,?,?,?)'
    );
    for (const [sku, qty, hhmm, status] of TODAY_PLAN) {
      ins.run(today, sku, qty, today + 'T' + hhmm, status, '[]');
    }
    const rows = conn
      .prepare(
        'SELECT id, sku_id, qty, status, planned_start FROM sop_workorders WHERE date=? ORDER BY planned_start'
      )
      .all(today);
    // 对齐 Python 输出：rows 为值数组
    const out = { ok: true, date: today, workorders: rows.map((r) => [r.id, r.sku_id, r.qty, r.status, r.planned_start]) };
    console.log(JSON.stringify(out));
    return out;
  } finally {
    conn.close();
  }
}

function parseArgs(argv) {
  const out = { db: DEFAULT_DB };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') out.db = argv[++i];
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  run(args.db);
  return 0;
}

/* 演示种子注入已停用（ADR-001 真实数据基线）；确需演示请显式设置 CANTEEN_SEED_DEMO=1 */
if (require.main === module && process.env.CANTEEN_SEED_DEMO !== '1') {
  console.error('[停用] 演示种子注入已停用（ADR-001 真实数据基线）。如确需演示，请设置 CANTEEN_SEED_DEMO=1 后重试。');
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
}

module.exports = { DEFAULT_DB, TODAY_PLAN, run, main, parseArgs };
