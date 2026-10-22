'use strict';
/*
 * seed/backfill_ing_type.js — W4 存量回灌：把待治理 CSV 的 type/cat/buy/conv/safe 写回主库 ings
 *
 * 口径源：`../../lib/ing_type.js` 的 normalizeType（'耗材'→consumable / '食材'→food）+ resolveIngType（用途空时兜底）。
 * 匹配键：name（cleanName 归一后精确匹配，对齐 import_orders_excel.js findIng；历史数据无稳定 id 映射，name 是唯一可依赖键）。
 *
 * 行为：
 *   - CSV 每行若主库已存在同名原料 → 回灌 type（cat/buy/conv/safe 仅当 CSV 填了非空才一并写）；
 *   - 不存在 → 预建主数据骨架（对齐 createIng 字段）：type 按用途，cat 耗材默认「耗材包材」/ 食材默认「其他」，
 *     buy=采购单位、conv=1、safe=0、stock/avg=0（库存由后续 rebuildStock 重算，不在此预置）。
 *   - 幂等：同一条目重复跑只更新差异；写库走 rev 乐观锁 + 写前冷备份。
 *
 * 用法:
 *   node backfill_ing_type.js --dry-run
 *   node backfill_ing_type.js [--csv docs/待治理-新增原料清单.csv] [--db store-inventory/data/餐厅系统.db]
 *   node backfill_ing_type.js --normalize-history            # 批量把缺失 type 的历史行规范为 food（resolveIngType 兜底），幂等
 *
 * 零第三方依赖：node:fs / node:path + 项目内 Store（node:sqlite）。
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../db');
const { normalizeType, resolveIngType } = require('../../lib/ing_type');

const BASE = __dirname;
const DEFAULT_CSV = path.resolve(BASE, '..', '..', '..', 'docs', '待治理-新增原料清单.csv');
const DEFAULT_DB = path.resolve(BASE, '..', '..', '..', 'store-inventory', 'data', '餐厅系统.db');

// 对齐 import_orders_excel.js cleanName（去首部空白/全角空格/*＊·・，再 trim）
function cleanName(s) {
  return String(s == null ? '' : s).replace(/^[\s\u3000*＊·・]+/, '').trim();
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function numOf(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* 对齐 import_orders_excel.js findIng：精确 + 去【前缀】后再比一次 */
function findIng(db, name) {
  name = cleanName(name);
  for (const g of db.ings) if (g.name === name) return g;
  const bare = name.replace(/^【[^】]+】/, '').trim();
  if (bare !== name) {
    for (const g of db.ings) if (g.name === bare || g.name.replace(/^【[^】]+】/, '').trim() === bare) return g;
  }
  return null;
}

/* 对齐 import_orders_excel.js createIng 字段结构；cat 由 CSV 或 type 推导 */
function createIng(db, row, type) {
  const seq = parseInt(db.seq || 0, 10) + 1;
  db.seq = seq;
  const u = row.unit || '斤';
  const g = {
    id: 'I' + seq,
    name: cleanName(row.name),
    cat: row.cat || (type === 'consumable' ? '耗材包材' : '其他'),
    type,
    unit: u,
    buy: row.buy || u,
    conv: numOf(row.conv) != null ? numOf(row.conv) : 1,
    spec: '',
    stock: 0,
    avg: 0,
    initStock: 0,
    initAvg: 0,
    initDate: todayStr(),
    last: null,
    safe: numOf(row.safe) != null ? numOf(row.safe) : 0,
    yld: 1,
    on: true,
    _u: Date.now(),
  };
  db.ings.push(g);
  return g;
}

/* 解析 CSV：UTF-8 BOM 兼容、字段无引号包裹（本项目 CSV 均为简单值） */
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const c = l.split(',');
    rows.push({
      name: (c[0] || '').trim(),
      unit: (c[1] || '').trim(),
      use: (c[2] || '').trim(),   // 用途(食材/耗材)
      cat: (c[3] || '').trim(),
      buy: (c[4] || '').trim(),
      conv: (c[5] || '').trim(),
      safe: (c[6] || '').trim(),
    });
  }
  return rows;
}

function applyRow(db, row) {
  const type = row.use ? normalizeType(row.use) : resolveIngType(row.name);
  const g = findIng(db, row.name);
  if (g) {
    const changed = [];
    if (g.type !== type) { g.type = type; changed.push('type→' + type); }
    if (row.cat && g.cat !== row.cat) { g.cat = row.cat; changed.push('cat→' + row.cat); }
    if (row.buy && g.buy !== row.buy) { g.buy = row.buy; changed.push('buy→' + row.buy); }
    if (numOf(row.conv) != null && g.conv !== numOf(row.conv)) { g.conv = numOf(row.conv); changed.push('conv→' + g.conv); }
    if (numOf(row.safe) != null && g.safe !== numOf(row.safe)) { g.safe = numOf(row.safe); changed.push('safe→' + g.safe); }
    return { action: changed.length ? 'update' : 'none', name: g.name, type, changed };
  }
  const ng = createIng(db, row, type);
  return { action: 'create', name: ng.name, type, changed: ['cat=' + ng.cat] };
}

function parseArgs(argv) {
  const out = { csv: DEFAULT_CSV, db: DEFAULT_DB, dryRun: false, normalizeHistory: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') out.csv = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--normalize-history') out.normalizeHistory = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数: ' + a);
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('参数解析失败: ' + e.message);
    return 2;
  }
  if (args.help) {
    console.log('用法: node backfill_ing_type.js [--csv 清单.csv] [--db 主库.db] [--dry-run] [--normalize-history]');
    console.log('默认 csv: ' + DEFAULT_CSV);
    console.log('默认 db : ' + DEFAULT_DB);
    return 0;
  }
  if (!fs.existsSync(args.csv)) throw new Error('找不到 CSV: ' + args.csv);
  if (!fs.existsSync(args.db)) throw new Error('找不到库: ' + args.db);

  const rows = parseCsv(fs.readFileSync(args.csv, 'utf8'));
  if (!rows.length) throw new Error('CSV 无数据行');

  const store = new Store(args.db, path.join(path.dirname(args.db), 'backups'));
  const meta = store.get();
  if (meta.empty) throw new Error('目标库为空');
  const db = JSON.parse(JSON.stringify(meta.data));

  const stat = { create: 0, update: 0, none: 0, created: [], updated: [], skipped: [] };
  for (const row of rows) {
    const r = applyRow(db, row);
    if (r.action === 'create') { stat.create++; stat.created.push(r.name + ' · ' + r.type); }
    else if (r.action === 'update') { stat.update++; stat.updated.push(r.name + ' ' + r.changed.join(',')); }
    else { stat.none++; stat.skipped.push(r.name); }
  }

  // W4 待办 D：把缺失 type 的历史行显式规范为 food（resolveIngType 兜底，命中的耗材标 consumable）
  let histNorm = 0;
  if (args.normalizeHistory) {
    for (const g of (db.ings || [])) {
      if (g && !g.type) { g.type = resolveIngType(g.name); histNorm++; }
    }
  }

  console.log('[csv  ] ' + rows.length + ' 行');
  console.log('[ings ] 回灌前 ' + meta.rev + ' rev · ' + (meta.data.ings || []).length + ' 项原料');
  console.log('[stat ] 新建 ' + stat.create + ' · 更新 ' + stat.update + ' · 无变化 ' + stat.none);
  if (args.normalizeHistory) console.log('[hist ] 历史行 type 规范化 ' + histNorm + ' 项');

  if (stat.created.length) {
    console.log('[new  ] ' + stat.created.length + ' 项预建：');
    for (const n of stat.created) console.log('  · ' + n);
  }
  if (stat.updated.length) {
    console.log('[upd  ] ' + stat.updated.length + ' 项回灌：');
    for (const n of stat.updated) console.log('  · ' + n);
  }
  if (stat.skipped.length) {
    console.log('[skip ] 已存在且无差异：' + stat.skipped.join('、'));
  }

  if (args.dryRun) {
    console.log('dry-run：未写库');
    return 0;
  }
  if (!stat.create && !stat.update && !histNorm) {
    console.log('无变更，跳过写库');
    return 0;
  }

  const bak = path.join(path.dirname(args.db), 'backups',
    '餐厅系统_' + todayStr().replace(/-/g, '') + '_pre_backfill.db');
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.copyFileSync(args.db, bak);
  console.log('[bak  ] ' + bak);

  const info = store.put(meta.rev, db, 'BACKFILL-ING-TYPE',
    'backfill_ing_type: +' + stat.create + ' ings, ~' + stat.update + ' type/cat, ~' + histNorm + ' hist-type');
  console.log('[ok   ] wrote rev=' + info.rev + ' · 回灌后 ' + db.ings.length + ' 项原料');
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('[error] ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
}
