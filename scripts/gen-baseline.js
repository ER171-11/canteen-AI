#!/usr/bin/env node
'use strict';
/*
 * scripts/gen-baseline.js —— W4-02「真实数据基线」制品生成（ADR-013 D4-4）。
 *
 * 背景：产品内此前**没有**可用基线（`bff/data.seed/snapshot.json` 是空快照 rev 1 / 0 条），
 *       真实基线只躺在开发机的遗留库 `store-inventory/data/餐厅系统.db`（不随包）。
 * 决策（D4-4 选 A）：从遗留库导出**一次**，产物随包发布，带 `baseline_version` + 校验和。
 *
 * 用法：
 *   node scripts/gen-baseline.js                          # 默认 v1 → bff/baselines/baseline-v1.json
 *   node scripts/gen-baseline.js --version=v2 --force     # 新版本（旧版本一经发布不可改）
 *   node scripts/gen-baseline.js --db=store-inventory/data/餐厅系统_演练.db --dry-run
 *   node scripts/gen-baseline.js --from=data/snapshot.json   # 用某份快照 JSON 当源（无遗留库时）
 *
 * 基线口径（ADR-001 / D4-4）：**原料目录 + 进货/采购单 + 菜品（保本菜单）**为主数据；
 *   **销售 / 报价 / 库存流水 / 配方（rec + ext）为空属正常**。
 *   保留键用白名单表达：新增主数据键必须补进 KEEP_DATA，否则基线与「重置」语义会漂移。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const baselineStore = require(path.join(ROOT, 'bff', 'lib', 'baseline_store'));
const { SCHEMA_VERSION } = require(path.join(ROOT, 'bff', 'lib', 'schema'));

const argv = process.argv.slice(2);
function argOf(name, def) {
  const hit = argv.find((a) => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : def;
}
const DB = argOf('db', path.join(ROOT, 'store-inventory', 'data', '餐厅系统.db'));
const FROM = argOf('from', '');
const OUT_DIR = argOf('out', path.join(ROOT, 'bff', 'baselines'));
const VERSION = argOf('version', 'v1');
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry-run');

/* 基线只保留这些顶层 data 键（主数据 + 单据）；其余（sales/quotes/logs/rec/…）一律置空 */
const KEEP_DATA = [
  'seq', 'rest', 'config', 'platforms', 'suppliers', 'vendors', 'pos',
  'ings', 'dishes', 'recv', 'orders',
];

function die(msg) { console.error('[gen-baseline] ' + msg); process.exit(1); }

/** 从遗留库 docs 表读「当前业务数据快照」（store-inventory 的权威形态） */
function readFromDb(dbPath) {
  if (!fs.existsSync(dbPath)) die('遗留库不存在：' + dbPath);
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) { die('当前 Node 不支持 node:sqlite（需 ≥ 22.5）：' + e.message); }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT id, rev, updated_at, machine, data FROM docs ORDER BY id LIMIT 1').get();
    if (!row || !row.data) die('遗留库 docs 表为空，无法导出基线');
    return {
      data: JSON.parse(row.data),
      rev: row.rev == null ? null : row.rev,
      updated_at: row.updated_at || null,
      source: path.relative(ROOT, dbPath).split(path.sep).join('/') + '#rev' + (row.rev == null ? '?' : row.rev),
    };
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

/** 从快照 JSON 文件读（导出备份 / data/snapshot.json 均可） */
function readFromFile(p) {
  if (!fs.existsSync(p)) die('源文件不存在：' + p);
  let snap;
  try { snap = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die('源文件不是合法 JSON：' + e.message); }
  const data = snap && snap.data ? snap.data : snap;
  if (!data || typeof data !== 'object') die('源文件缺少 data 对象');
  return {
    data,
    rev: snap && Number.isFinite(snap.rev) ? snap.rev : null,
    updated_at: (snap && snap.generated_at) || null,
    source: path.relative(ROOT, p).split(path.sep).join('/'),
  };
}

function countRows(v) { return Array.isArray(v) ? v.length : 0; }

function main() {
  const src = FROM ? readFromFile(path.resolve(ROOT, FROM)) : readFromDb(DB);
  const srcData = src.data || {};

  const data = {};
  const kept = [];
  const dropped = [];
  for (const k of Object.keys(srcData)) {
    if (KEEP_DATA.indexOf(k) >= 0) { data[k] = srcData[k]; kept.push(k); }
  }
  for (const k of Object.keys(srcData)) {
    if (kept.indexOf(k) < 0 && k !== 'v') dropped.push(k);   // v 由本脚本重写，不算丢
  }
  data.v = SCHEMA_VERSION;                 // 基线始终对齐当前 schema（ADR-011）

  const ext = {};                          // 配方等 ext 业务表：基线里为空（D4-4）

  const counts = {
    ings: countRows(data.ings),
    dishes: countRows(data.dishes),
    recv: countRows(data.recv),
    orders: countRows(data.orders),
    sales: countRows(data.sales),
    quotes: countRows(data.quotes),
    logs: countRows(data.logs),
    ext_tables: 0,
  };
  const checksum = baselineStore.checksumOf(data, ext);

  const artifact = {
    baseline_version: VERSION,
    generated_at: new Date().toISOString(),
    source: src.source + (src.updated_at ? ' （' + src.updated_at + '）' : ''),
    schema_version: SCHEMA_VERSION,
    note: '真实数据基线（ADR-001 / ADR-013 D4-4）：原料目录 + 进货/采购单 + 菜品；销售/报价/流水/配方为空属正常',
    checksum,
    counts,
    data,
    ext,
  };

  const outFile = path.join(OUT_DIR, 'baseline-' + VERSION + '.json');
  const text = JSON.stringify(artifact, null, 1);

  console.log('[gen-baseline] 源：' + artifact.source);
  console.log('[gen-baseline] 保留键：' + kept.join(', '));
  console.log('[gen-baseline] 置空键：' + dropped.join(', '));
  console.log('[gen-baseline] 规模：原料 ' + counts.ings + ' / 菜品 ' + counts.dishes
    + ' / 进货单 ' + counts.recv + ' / 采购单 ' + counts.orders
    + ' / 销售 ' + counts.sales + ' / 报价 ' + counts.quotes + ' / 流水 ' + counts.logs);
  console.log('[gen-baseline] 校验和：' + checksum + '（' + Buffer.byteLength(text) + ' 字节）');

  if (fs.existsSync(outFile) && !FORCE) {
    die('基线 ' + VERSION + ' 已存在且基线一经发布不可变（ADR-013 §9）：'
      + '请用 --version=<新版本> 新增，或显式 --force 覆盖（会改变同版本内容，慎用）');
  }
  if (DRY) {
    console.log('[gen-baseline] --dry-run：未写盘（目标 ' + path.relative(ROOT, outFile) + '）');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, text);
  console.log('[gen-baseline] 已写入 ' + path.relative(ROOT, outFile));
  console.log('[gen-baseline] 提示：该制品随包发布（bff/ → desktop/app/bff/ 由 sync-assets 同步），'
    + '发布后视为不可变；如需变更请新增版本号。');
}

main();
