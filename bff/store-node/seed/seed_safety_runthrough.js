'use strict';
/*
 * seed_safety_runthrough.js — 按饺子店真实日耗固化原料安全线（对齐《熊猫五福App原型》量级）
 *
 * 逐行移植 store-inventory/seed_safety_runthrough.py。
 * 口径（单店 · 日售约 150–160 份五色饺）：
 *   - 火龙果汁：现 0.44kg / 安全 2kg · 告急（红饺色源）
 *   - 墨鱼汁：现约够 1 天 · 告急（黑饺色源）
 *   - 面粉：25kg/袋，日耗约 0.5 袋
 *   - 猪肉前肩：日耗约 6 斤；蛋约 1.2 板/日
 *   - 非主链：灌到安全线以上，避免假告急刷屏
 *
 * 优先走店内 /api/sync（与常驻 store 一致）；失败回退写 sqlite。
 *
 * 用法：
 *   node bff/store-node/seed/seed_safety_runthrough.js
 *   node bff/store-node/seed/seed_safety_runthrough.js --db <path> --store-url <url>
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { httpJson } = require('../common');
const { pyRound, toNum, utcNowIsoMicros } = require('./util');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DB = path.join(REPO_ROOT, 'store-inventory', 'data', '餐厅系统.db');
const STORE_URL = 'http://127.0.0.1:8765';

const RULES = [
  ['exact', '火龙果汁', 0.44, 2.0, 0.22, 'kg'],
  ['contains', '墨鱼汁', 0.35, 2.0, 0.25, '瓶'],
  ['contains', '紫薯粉', 0.8, 2.5, 0.35, '瓶'],
  ['contains', '菠菜', 2.5, 4.0, 1.5, '斤'],
  ['contains', '南瓜', 3.5, 6.0, 2.0, '斤'],
  ['contains', '雪花面粉', 3.0, 6.0, 0.5, '袋'],
  ['contains', '雪花粉', 3.0, 6.0, 0.5, '袋'],
  ['exact', '黑猪前肩肉', 8.0, 15.0, 6.0, '斤'],
  ['exact', '黑猪前腿', 5.0, 10.0, 3.0, '斤'],
  ['exact', '黑猪五花肉', 12.0, 20.0, 5.0, '斤'],
  ['exact', '大白菜', 6.0, 12.0, 4.0, '斤'],
  ['exact', '圆白菜', 4.0, 8.0, 2.5, '斤'],
  ['exact', '【GY】红洋葱', 3.0, 6.0, 2.0, '斤'],
  ['exact', '【GV】红洋葱', 3.0, 6.0, 2.0, '斤'],
  ['contains', '鸡蛋30枚', 4.0, 8.0, 1.2, '板'],
  ['contains', '芝麻香油', 1.5, 3.0, 0.4, '瓶'],
  ['contains', '雪天精制盐', 20.0, 30.0, 1.5, '包'],
  ['contains', '虾仁', 4.0, 8.0, 2.5, '斤'],
];

/** 对齐 Python _apply_rule：把规则值写进 ing 行。 */
function applyRule(ing, qty, safe, est, unit, now) {
  ing.qty = qty;
  ing.stock = qty;
  ing.safe = safe;
  ing.safety = safe;
  ing.est = est;
  if (unit) ing.unit = unit;
  ing._u = now;
}

/** 对齐 Python _ensure_dragonfruit：缺火龙果色源时补一条，返回是否新增。 */
function ensureDragonfruit(ings, now) {
  for (const ing of ings) {
    if (String(ing.name || '').includes('火龙')) return false;
  }
  ings.push({
    id: 'I-HLG',
    name: '火龙果汁',
    unit: 'kg',
    qty: 0.44,
    stock: 0.44,
    safe: 2.0,
    safety: 2.0,
    est: 0.22,
    cat: '色源',
    note: '红饺面皮色源 · seed_safety',
    _u: now,
  });
  return true;
}

/** 对齐 Python _mutate：返回 {touched, rules, added}（rules=命中原料数）。 */
function mutate(ings, now) {
  const added = ensureDragonfruit(ings, now);
  let touched = added ? 1 : 0;
  const hitIds = new Set();
  for (const [match, key, qty, safe, est, unit] of RULES) {
    for (const ing of ings) {
      const name = String(ing.name || '');
      const iid = String(ing.id || '');
      if (hitIds.has(iid)) continue;
      const ok = match === 'exact' ? name === key : name.includes(key);
      if (!ok) continue;
      applyRule(ing, qty, safe, est, unit, now);
      hitIds.add(iid);
      touched += 1;
    }
  }
  for (const ing of ings) {
    const iid = String(ing.id || '');
    if (hitIds.has(iid)) continue;
    const q = toNum(ing.qty !== null && ing.qty !== undefined ? ing.qty : (ing.stock || 0));
    let safe = toNum(ing.safe || ing.safety || 0);
    if (safe <= 0) {
      const unit = String(ing.unit || '');
      if (unit === '袋' || unit === '箱' || unit === '件') safe = Math.max(q, 2.0);
      else if (unit === '板') safe = Math.max(q, 4.0);
      else safe = q <= 0 ? 1.0 : Math.max(q * 1.2, 1.0);
      ing.safe = pyRound(safe, 2);
      ing.safety = pyRound(safe, 2);
      ing.est = pyRound(safe / 4, 2);
    }
    const fill = toNum(ing.safe) * 1.25;
    ing.qty = pyRound(fill, 2);
    ing.stock = pyRound(fill, 2);
    ing._u = now;
    touched += 1;
  }
  return { touched, rules: hitIds.size, added };
}

/** 对齐 Python _via_store：走店内 HTTP，返回 {ok, msg}。 */
async function viaStore(storeUrl) {
  const base = String(storeUrl || STORE_URL).replace(/\/+$/, '');
  try {
    const got = await httpJson('GET', base + '/api/db');
    if (got.status >= 400) return { ok: false, msg: 'HTTP ' + got.status };
    const doc = got.body || {};
    const data = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? doc.data : {};
    const ings = Array.isArray(data.ings) ? data.ings : [];
    const now = utcNowIsoMicros();
    const r = mutate(ings, now);
    data.ings = ings;
    const res = await httpJson('POST', base + '/api/sync', {
      baseRev: doc.rev,
      data: data,
      machine: 'SEED_SAFETY',
    });
    const out = res.body || {};
    if (!out.ok) return { ok: false, msg: JSON.stringify(out) };
    return {
      ok: true,
      msg: 'store rev=' + out.rev + ' touched=' + r.touched + ' rules=' + r.rules + ' hlg=' + r.added,
    };
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e) };
  }
}

/** 对齐 Python _via_sqlite：直写 sqlite（docs.data + snapshot_rev）。 */
function viaSqlite(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    const row = conn.prepare('SELECT data FROM docs WHERE id=1').get();
    if (!row) throw new Error('docs 空');
    const data = JSON.parse(row.data);
    const ings = data.ings || [];
    const now = utcNowIsoMicros();
    const r = mutate(ings, now);
    data.ings = ings;
    conn.prepare('UPDATE docs SET data=? WHERE id=1').run(JSON.stringify(data));
    try {
      conn.exec('UPDATE snapshot_rev SET rev = rev + 1');
    } catch (e) {
      /* 无 snapshot_rev 表时忽略，对齐 Python except sqlite3.Error */
    }
    return 'sqlite touched=' + r.touched + ' rules=' + r.rules + ' hlg=' + r.added;
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

/* 演示种子注入已停用（ADR-001 真实数据基线）；确需演示请显式设置 CANTEEN_SEED_DEMO=1 */
if (require.main === module && process.env.CANTEEN_SEED_DEMO !== '1') {
  console.error('[停用] 演示种子注入已停用（ADR-001 真实数据基线）。如确需演示，请设置 CANTEEN_SEED_DEMO=1 后重试。');
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
  RULES,
  applyRule,
  ensureDragonfruit,
  mutate,
  viaStore,
  viaSqlite,
  main,
  parseArgs,
};
