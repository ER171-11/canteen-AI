#!/usr/bin/env node
'use strict';
/*
 * scripts/sandbox-db.js — 演练库（沙箱库）管理
 *
 * 目的：测试系统功能时不污染真实主库。
 *   主库   store-inventory/data/餐厅系统.db        （真实数据，只读保护）
 *   演练库 store-inventory/data/餐厅系统_演练.db    （测试随便写，随时重建）
 *
 * 一致性：优先用 SQLite `VACUUM INTO` 生成副本（原子、页级一致），
 *        失败时回退整文件复制（此时建议主库无进程在写）。
 *
 * 用法：
 *   node scripts/sandbox-db.js --init [--force]   从主库生成演练库（已存在则拒绝，--force 覆盖）
 *   node scripts/sandbox-db.js --reset            删除演练库并按主库重建（测试跑脏了就重置）
 *   node scripts/sandbox-db.js --drop             仅删除演练库
 *   node scripts/sandbox-db.js --status           打印两库路径 / 大小 / rev / 单据计数
 *   node scripts/sandbox-db.js --print-path       仅输出演练库绝对路径（供 .cmd 捕获）
 *
 * 配套环境变量（由启动脚本设置）：
 *   CANTEEN_ENV=sandbox  STORE_DB=<演练库路径>
 *
 * 零第三方依赖：node:sqlite / fs / path。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'store-inventory', 'data');
const MAIN_DB = path.join(DATA_DIR, '餐厅系统.db');
const SANDBOX_DB = path.join(DATA_DIR, '餐厅系统_演练.db');
const SANDBOX_BACKUP_DIR = path.join(DATA_DIR, 'backups_sandbox');

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.indexOf(f) >= 0;

const pad2 = (n) => String(n).padStart(2, '0');
function mb(bytes) {
  if (!bytes) return '0 MB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 读库摘要：rev / updated_at / 主数据计数 / 快照数 */
function statOf(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const out = { path: dbPath, size: fs.statSync(dbPath).size, rev: null, updated: null, counts: null, snaps: null };
  let conn;
  try {
    conn = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    try { conn = new DatabaseSync(dbPath); } catch (e2) { return out; }
  }
  try {
    const row = conn.prepare('SELECT rev, updated_at, data FROM docs WHERE id=1').get();
    if (row) {
      out.rev = row.rev;
      out.updated = row.updated_at;
      try {
        const d = JSON.parse(row.data) || {};
        out.counts = {
          dishes: (d.dishes || []).length,
          ings: (d.ings || []).length,
          orders: (d.orders || []).length,
          recv: (d.recv || []).length,
          logs: (d.logs || []).length,
          quotes: (d.quotes || []).length,
        };
      } catch (e) { /* 非 JSON，忽略 */ }
    }
  } catch (e) { /* 无 docs 表 */ }
  try { out.snaps = conn.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n; } catch (e) { /* ignore */ }
  try { conn.close(); } catch (e) { /* ignore */ }
  return out;
}

function printStat(label, s) {
  if (!s) {
    console.log('  ' + label + '：不存在');
    return;
  }
  console.log('  ' + label + '：' + s.path);
  console.log('    ' + mb(s.size) + ' · rev ' + (s.rev == null ? '-' : s.rev)
    + ' · updated ' + (s.updated || '-') + ' · snapshots ' + (s.snaps == null ? '-' : s.snaps));
  if (s.counts) {
    console.log('    单据：采购 ' + s.counts.orders + ' / 入库 ' + s.counts.recv
      + ' / 流水 ' + s.counts.logs + ' / 报价 ' + s.counts.quotes
      + ' · 主数据：菜品 ' + s.counts.dishes + ' / 原料 ' + s.counts.ings);
  }
}

/** 生成演练库副本：VACUUM INTO 优先，回退整文件复制 */
function cloneMainToSandbox() {
  if (!fs.existsSync(MAIN_DB)) {
    throw new Error('主库不存在，无法生成演练库：' + MAIN_DB);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SANDBOX_DB)) fs.unlinkSync(SANDBOX_DB);

  let how = 'vacuum';
  try {
    const conn = new DatabaseSync(MAIN_DB);
    try {
      conn.exec("VACUUM INTO '" + SANDBOX_DB.replace(/'/g, "''") + "'");
    } finally {
      conn.close();
    }
  } catch (e) {
    how = 'copy（VACUUM 失败回退：' + (e && e.message) + '）';
    fs.copyFileSync(MAIN_DB, SANDBOX_DB);
  }

  /* 演练库不需要主库的历史快照，清空以免体积膨胀与误导回滚 */
  try {
    const conn = new DatabaseSync(SANDBOX_DB);
    try { conn.exec('DELETE FROM snapshots'); } catch (e) { /* 无该表则忽略 */ }
    conn.close();
  } catch (e) { /* ignore */ }

  fs.mkdirSync(SANDBOX_BACKUP_DIR, { recursive: true });
  return how;
}

function nowStamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function main() {
  if (has('--print-path')) {
    console.log(SANDBOX_DB);
    return 0;
  }

  if (has('--status') || ARGV.length === 0) {
    console.log('== 演练环境库状态（' + nowStamp() + '）==');
    printStat('主库  ', statOf(MAIN_DB));
    printStat('演练库', statOf(SANDBOX_DB));
    if (ARGV.length === 0) {
      console.log('\n用法：--init [--force] | --reset | --drop | --status | --print-path');
    }
    return 0;
  }

  if (has('--drop')) {
    if (!fs.existsSync(SANDBOX_DB)) {
      console.log('演练库不存在，无需删除。');
      return 0;
    }
    fs.unlinkSync(SANDBOX_DB);
    console.log('已删除演练库：' + SANDBOX_DB);
    return 0;
  }

  if (has('--init') || has('--reset')) {
    const exists = fs.existsSync(SANDBOX_DB);
    if (exists && has('--init') && !has('--force')) {
      console.error('演练库已存在，未覆盖：' + SANDBOX_DB);
      console.error('如需重建请用 --reset，或 --init --force。');
      return 1;
    }
    if (exists) fs.unlinkSync(SANDBOX_DB);
    const how = cloneMainToSandbox();
    console.log('已' + (exists ? '重建' : '生成') + '演练库（' + how + '）');
    printStat('演练库', statOf(SANDBOX_DB));
    console.log('\n下一步：双击 启动演练.cmd，或设置环境变量后启动：');
    console.log('  set CANTEEN_ENV=sandbox');
    console.log('  set STORE_DB=' + SANDBOX_DB);
    return 0;
  }

  console.error('未知参数：' + ARGV.join(' '));
  console.error('用法：--init [--force] | --reset | --drop | --status | --print-path');
  return 2;
}

if (require.main === module) {
  let code = 2;
  try {
    code = main();
  } catch (e) {
    console.error('[sandbox-db] ' + (e && e.stack ? e.stack : e));
    code = 1;
  }
  process.exit(code || 0);
}

module.exports = { MAIN_DB, SANDBOX_DB, SANDBOX_BACKUP_DIR, statOf, cloneMainToSandbox };
