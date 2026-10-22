'use strict';
/*
 * seed_safety_points.js — 预置食安拍照上报点位（8 个，覆盖冷藏 / 清洗 / 备餐 / 垃圾区）
 *
 * 数据落点：快照 data.safety.points（见 docs/safety-schema.md §1）。
 * 幂等：按 id 合并——已存在的点位**原样保留**（不覆盖门店编辑过的 name/target/sort/enabled），
 *       只补缺失的内置点位；不影响 data 下任何其它字段（原料/菜品/进出货等）。
 * 图片：内置点位只给占位 URL（demo_image_url），**不预置任何真实照片**。
 *
 * 优先走店内 /api/sync（与常驻 store 一致）；失败回退写 sqlite。
 * 注意：与其它演示种子一致，须显式设置 CANTEEN_SEED_DEMO=1 才允许写入（ADR-001 真实数据基线）。
 *
 * 用法：
 *   node bff/store-node/seed/seed_safety_points.js
 *   node bff/store-node/seed/seed_safety_points.js --db <path> --store-url <url>
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { httpJson } = require('../common');
const { DEFAULT_POINTS } = require('../../lib/safety_plan');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DB = path.join(REPO_ROOT, 'store-inventory', 'data', '餐厅系统.db');
const STORE_URL = 'http://127.0.0.1:8765';

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

/** 内置点位（深拷贝，避免污染模块常量） */
function seedPoints() {
  return DEFAULT_POINTS.map((p) => Object.assign({}, p));
}

/**
 * 合并点位：以现有清单为准，只补内置缺失项（幂等）。
 * @returns {{points:object[], added:number, kept:number}}
 */
function mergePoints(existing) {
  const rows = Array.isArray(existing) ? existing.slice() : [];
  const known = new Set(rows.map((p) => str(p && p.id)).filter(Boolean));
  let added = 0;
  for (const d of seedPoints()) {
    if (known.has(d.id)) continue;
    rows.push(d);
    added += 1;
  }
  return { points: rows, added: added, kept: rows.length - added };
}

/** 应用到快照 data（原地改），返回 {added, kept, total} */
function applyToData(data) {
  const d = data && typeof data === 'object' ? data : {};
  if (!d.safety || typeof d.safety !== 'object' || Array.isArray(d.safety)) d.safety = {};
  const r = mergePoints(d.safety.points);
  d.safety.points = r.points;
  d.safety.ts = new Date().toISOString();
  return { added: r.added, kept: r.kept, total: r.points.length };
}

/** 走店内 HTTP（与常驻 store 一致） */
async function viaStore(storeUrl) {
  const base = String(storeUrl || STORE_URL).replace(/\/+$/, '');
  try {
    const got = await httpJson('GET', base + '/api/db');
    if (got.status >= 400) return { ok: false, msg: 'HTTP ' + got.status };
    const doc = got.body || {};
    const data = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? doc.data : {};
    const r = applyToData(data);
    const res = await httpJson('POST', base + '/api/sync', {
      baseRev: doc.rev,
      data: data,
      machine: 'SEED_SAFETY_POINTS'
    });
    const out = res.body || {};
    if (!out.ok) return { ok: false, msg: JSON.stringify(out) };
    return { ok: true, msg: 'store rev=' + out.rev + ' added=' + r.added + ' kept=' + r.kept + ' total=' + r.total };
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e) };
  }
}

/** 直写 sqlite（docs.data + snapshot_rev） */
function viaSqlite(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    const row = conn.prepare('SELECT data FROM docs WHERE id=1').get();
    if (!row) throw new Error('docs 空');
    const data = JSON.parse(row.data);
    const r = applyToData(data);
    conn.prepare('UPDATE docs SET data=? WHERE id=1').run(JSON.stringify(data));
    try {
      conn.exec('UPDATE snapshot_rev SET rev = rev + 1');
    } catch (e) {
      /* 无 snapshot_rev 表时忽略 */
    }
    return 'sqlite added=' + r.added + ' kept=' + r.kept + ' total=' + r.total;
  } finally {
    conn.close();
  }
}

function parseArgs(argv) {
  const out = { db: DEFAULT_DB, storeUrl: STORE_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--store-url') out.storeUrl = argv[++i];
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  const r = await viaStore(args.storeUrl);
  if (r.ok) {
    console.log('ok', r.msg);
    return 0;
  }
  console.log('store sync miss:', r.msg, '→ sqlite fallback');
  console.log('ok', viaSqlite(args.db));
  return 0;
}

/* 演示种子注入须显式开启（ADR-001 真实数据基线） */
if (require.main === module && process.env.CANTEEN_SEED_DEMO !== '1') {
  console.error('[停用] 演示种子注入默认关闭（ADR-001 真实数据基线）。如确需预置点位，请设置 CANTEEN_SEED_DEMO=1 后重试。');
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_DB,
  STORE_URL,
  seedPoints,
  mergePoints,
  applyToData,
  viaStore,
  viaSqlite,
  main,
  parseArgs
};
