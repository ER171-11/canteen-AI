'use strict';
/*
 * migrate_from_zip.js — 把「餐厅系统.zip」里的真实进销存库灌入本仓
 *
 * 逐行移植 store-inventory/migrate_from_zip.py。
 * 规则（对齐 migrateV4）：
 *   - zip.v3 的 DB.pos（实收配送单）→ DB.recv，单号 CG→JH
 *   - 保留 zip 的 logs / ings.stock|avg|last / quotes / suppliers / platforms / sales
 *   - 保留本仓 v4 扩展：orders / plans / restock / dishAlias / config
 *   - 不碰 recipes 等 ext 增量表（只改 docs JSON）
 *   - 禁止写入虚构演示数据
 *
 * ZIP 读取复用 seed/zipread.js（纯 Node 内置，zlib.inflateRawSync）。
 *
 * 用法：
 *   node bff/store-node/seed/migrate_from_zip.js [--zip PATH] [--db PATH] [--dry-run]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../db');
const { openZip } = require('./zipread');
const { pyRound, toNum, toInt, nowTag, deepCopy } = require('./util');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ZIP_CANDIDATES = [
  path.join(REPO_ROOT, '餐厅系统.zip'),
  path.join(REPO_ROOT, 'old', 'root-assets', '餐厅系统.zip'),
];
const DEFAULT_ZIP = ZIP_CANDIDATES.find((p) => fs.existsSync(p)) || ZIP_CANDIDATES[0];
const DEFAULT_DB = path.join(REPO_ROOT, 'store-inventory', 'data', '餐厅系统.db');
const ZIP_DB_MEMBER = '餐厅系统/data/餐厅系统.db';

function loadDoc(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    const row = conn.prepare('SELECT data FROM docs WHERE id=1').get();
    if (!row) throw new Error('空库: ' + dbPath);
    return JSON.parse(row.data);
  } finally {
    conn.close();
  }
}

/** 从 zip 提取内嵌 sqlite 到 destDir，返回文件路径（对齐 Python extract_zip_db）。 */
function extractZipDb(zipPath, destDir) {
  const out = path.join(destDir, '餐厅系统.db');
  const zf = openZip(zipPath);
  if (!zf.has(ZIP_DB_MEMBER)) throw new Error('zip 内找不到 ' + ZIP_DB_MEMBER);
  fs.writeFileSync(out, zf.read(ZIP_DB_MEMBER));
  return out;
}

function restockDef() {
  return { days: 30, lead: 1, gap: 1, useOnway: 1 };
}

/** 对 zip 文档做 v3→v4 字段迁移，返回可合并进当前库的业务块。 */
function migrateV4FromZip(zipData) {
  const data = deepCopy(zipData);
  if (data.pos && !data.recv) {
    data.recv = data.pos;
    delete data.pos;
  }
  if (!Array.isArray(data.recv)) data.recv = [];
  if (!Array.isArray(data.orders)) data.orders = [];
  for (const r of data.recv) {
    const no = r.no || '';
    if (no.startsWith('CG')) r.no = 'JH' + no.slice(2);
  }
  data.v = Math.max(toInt(data.v || 0, 0), 4);
  delete data.pos;
  return data;
}

/** 以当前库为壳，用 zip 真实经营数据覆盖库存相关集合。 */
function merge(current, migrated) {
  const out = deepCopy(current);

  // 真实经营数据：优先 zip（已迁 v4）
  for (const key of ['ings', 'dishes', 'recv', 'logs', 'quotes', 'suppliers', 'platforms', 'sales', 'seq', 'rest']) {
    if (Object.prototype.hasOwnProperty.call(migrated, key)) out[key] = migrated[key];
  }

  // v4 壳字段：本仓已有则保留，缺则补齐
  if (!Array.isArray(out.orders)) out.orders = migrated.orders || [];
  if (!Array.isArray(out.plans)) out.plans = [];
  if (!out.dishAlias || typeof out.dishAlias !== 'object' || Array.isArray(out.dishAlias)) out.dishAlias = {};
  if (!out.restock || typeof out.restock !== 'object' || Array.isArray(out.restock)) out.restock = restockDef();
  if (!out.config || typeof out.config !== 'object' || Array.isArray(out.config)) out.config = current.config || {};

  out.pos = [];
  out.v = 4;
  out._recU = out._recU && typeof out._recU === 'object' && !Array.isArray(out._recU) ? out._recU : {};
  return out;
}

/** 用 Python 正确的半偶舍入格式化两位小数（对齐 f"{x:.2f}"）。 */
function fmt2(x) {
  return pyRound(toNum(x, 0), 2).toFixed(2);
}

function summarize(data) {
  const ings = data.ings || [];
  const stockN = ings.filter((i) => toNum(i.stock, 0) > 0).length;
  const stockAmt = ings.reduce((acc, i) => acc + toNum(i.stock, 0) * toNum(i.avg, 0), 0);
  const recv = data.recv || [];
  const payable = recv.reduce((acc, r) => acc + toNum(r.payable, 0), 0);
  return (
    'ings=' + ings.length + ' stock>0=' + stockN + ' stock¥=' + fmt2(stockAmt) +
    ' recv=' + recv.length + ' payable¥=' + fmt2(payable) +
    ' logs=' + (data.logs || []).length + ' quotes=' + (data.quotes || []).length +
    ' dishes=' + (data.dishes || []).length + ' seq=' + data.seq + ' v=' + data.v
  );
}

function parseArgs(argv) {
  const out = { zip: DEFAULT_ZIP, db: DEFAULT_DB, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--zip') out.zip = argv[++i];
    else if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  if (!fs.existsSync(args.zip)) throw new Error('找不到 zip: ' + args.zip);
  if (!fs.existsSync(args.db)) throw new Error('找不到目标库: ' + args.db);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canteen_zip_'));
  try {
    const zipDb = extractZipDb(args.zip, tmp);
    const zipRaw = loadDoc(zipDb);
    const cur = loadDoc(args.db);

    console.log('[zip ]', summarize(zipRaw), 'pos=' + (zipRaw.pos || []).length);
    console.log('[cur ]', summarize(cur), 'recv=' + (cur.recv || []).length);

    const migrated = migrateV4FromZip(zipRaw);
    const merged = merge(cur, migrated);
    console.log('[merge]', summarize(merged));

    if (args.dryRun) {
      console.log('dry-run：未写库');
      return 0;
    }

    // 冷备份
    const bakDir = path.join(path.dirname(args.db), 'backups');
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, '餐厅系统_' + nowTag() + '_pre_zip_migrate.db');
    fs.copyFileSync(args.db, bak);
    console.log('[bak ]', bak);

    const store = new Store(args.db, bakDir);
    const curMeta = store.get();
    const newRevInfo = store.put(
      curMeta.rev,
      merged,
      'ZIP-MIGRATE',
      'migrate_from_zip: pos→recv + logs/stock from 餐厅系统.zip',
      false
    );
    console.log('[ok  ] wrote rev=' + newRevInfo.rev + ' ' + summarize(merged));
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const code = main();
    process.exit(code || 0);
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
}

module.exports = {
  REPO_ROOT,
  DEFAULT_ZIP,
  DEFAULT_DB,
  ZIP_DB_MEMBER,
  loadDoc,
  extractZipDb,
  restockDef,
  migrateV4FromZip,
  merge,
  summarize,
  parseArgs,
  main,
};
