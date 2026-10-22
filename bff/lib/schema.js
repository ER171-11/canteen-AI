'use strict';
/*
 * lib/schema.js — 数据 schema 版本化 + 启动自动迁移（「数据继承」地基）
 *
 * 背景：系统每次发新版新增字段（如 ings[].type / tags / qc_report_url / sup_vendors[].certs）
 *       时，老版本的历史快照不会自动补齐，导致「升级后老数据读不到新字段 / 老数据不兼容」。
 *       本模块把快照数据里的 data.v（schema 版本号）正式化为「数据继承」的唯一依据：
 *       启动时若 data.v < SCHEMA_VERSION，就按注册表逐级迁移到最新，迁移前自动冷备份。
 *
 * 红线：
 *   · 只做「结构补齐 / 字段归一」，不产生业务语义写；**不改 rev**（rev 是乐观锁，只在业务写时递增）。
 *   · 迁移前把原 snapshot.json 复制到 data/backups/，失败可回滚；迁移失败保持数据原样、只打日志。
 *   · 迁移函数必须幂等（可安全重跑），且不原地改入参（返回新副本）。
 *
 * 使用约定（每次发版动数据结构时）：
 *   1. SCHEMA_VERSION +1；
 *   2. 在 MIGRATIONS 里补一条 [旧版] -> [新版] 的迁移函数；
 *   3. 补 schema.test.js 用例（旧数据 → 迁移后字段齐全）。
 *
 * 零第三方依赖：仅 Node 内置 fs/path + 复用 lib/store.js 的 DATA_DIR。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

/**
 * 当前 schema 版本：必须与 data.seed/snapshot.json 的 data.v 保持一致。
 * 历史口径对齐 store-node/seed/migrate_from_zip.js：v3=旧 zip（pos），v4=当前（recv）。
 */
const SCHEMA_VERSION = 4;

/**
 * 迁移注册表：MIGRATIONS[from] = (data) => data，把 data 从「from」升到「from+1」。
 * 当前无待迁移版本（v=4 已是最新），表留空作为地基。未来发版示例：
 *
 *   4: (data) => {
 *     const d = deepCopy(data);
 *     for (const ing of (d.ings || [])) if (ing.type == null) ing.type = 'food';
 *     return d;
 *   },
 */
const MIGRATIONS = {};

function toInt(v, d) {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function deepCopy(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

/** 读某份数据的 schema 版本（缺 v 视为 0，即「未版本化」） */
function versionOf(data) {
  return toInt(data && data.v, 0);
}

/**
 * 纯迁移：把 data 从当前版本逐级升到 targetVersion（默认 SCHEMA_VERSION）。
 * @returns {{data:object, steps:Array<{from:number,to:number}>}}
 * @throws 缺少某一步迁移函数时抛错 —— 绝不静默跳版本，逼开发者补登记。
 */
function migrateData(data, targetVersion) {
  const target = toInt(targetVersion, SCHEMA_VERSION);
  let cur = deepCopy(data) || {};
  cur.v = toInt(cur.v, 0);
  const steps = [];
  while (toInt(cur.v, 0) < target) {
    const from = toInt(cur.v, 0);
    const next = from + 1;
    const fn = MIGRATIONS[from];
    if (typeof fn !== 'function') {
      throw new Error(
        '[schema] 缺少 v' + from + ' → v' + next + ' 的迁移函数（SCHEMA_VERSION=' + SCHEMA_VERSION
        + '），请在 MIGRATIONS 补登记，避免老数据静默漏迁移'
      );
    }
    cur = deepCopy(fn(cur));
    cur.v = next;
    steps.push({ from, to: next });
  }
  if (toInt(cur.v, target) !== target) cur.v = target;
  return { data: cur, steps };
}

/** 迁移前冷备份：把 snapshot.json 复制到 data/backups/，返回备份路径（失败返回 null） */
function backupSnapshot(from) {
  const src = path.join(store.DATA_DIR, 'snapshot.json');
  if (!fs.existsSync(src)) return null;
  const dir = path.join(store.DATA_DIR, 'backups');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(dir, 'snapshot_pre_migrate_v' + from + '_' + stamp + '.json');
  try {
    fs.copyFileSync(src, bak);
    return bak;
  } catch (e) {
    return null;
  }
}

/**
 * 启动时迁移：读 snapshot.json → 落后则备份 + 迁移 + 写回（rev 不变）。
 * 永不抛错，返回结构化结果，调用方据此打日志。
 * @returns {{migrated:boolean, from?:number, to?:number, steps?:Array, backup?:string, error?:string, reason?:string}}
 */
function migrateOnBoot() {
  const snap = store.readJSON('snapshot.json', null);
  if (!snap || typeof snap !== 'object' || !snap.data || typeof snap.data !== 'object') {
    return { migrated: false, reason: 'no-snapshot' };
  }
  const from = versionOf(snap.data);
  if (from >= SCHEMA_VERSION) {
    return { migrated: false, from, to: from, reason: 'up-to-date' };
  }
  const backup = backupSnapshot(from);
  try {
    const { data, steps } = migrateData(snap.data);
    snap.data = data;
    store.writeJSON('snapshot.json', snap);
    return { migrated: true, from, to: SCHEMA_VERSION, steps, backup };
  } catch (e) {
    return { migrated: false, from, to: SCHEMA_VERSION, error: (e && e.message) || String(e), backup };
  }
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, toInt, deepCopy, versionOf, migrateData, migrateOnBoot };
