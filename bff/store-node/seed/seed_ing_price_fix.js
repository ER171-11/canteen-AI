'use strict';
/*
 * seed_ing_price_fix.js — 原料占位价修复（幂等，可重复执行，--dry-run 预览）
 *
 * 针对「配方成本口径统一」计划中，BOM 别名回退后新增引用的 4 个原料补齐占位均价 + 纠正单位，
 * 使前后端成本卡能算出非 0 的行成本；每条 spec 追加「占位价·待核对」留痕，末尾打印待核对清单。
 *
 * 写库方式：走店内 HTTP API（GET /api/db → 改 → PUT /api/db，rev 乐观锁，409 自动重试）。
 *
 * 用法：
 *   node bff/store-node/seed/seed_ing_price_fix.js --dry-run
 *   node bff/store-node/seed/seed_ing_price_fix.js [--store-url URL]
 */
const { httpJson } = require('../common');

const DEFAULT_STORE = 'http://127.0.0.1:8765';
const SPEC_TAG = '占位价·待核对';

// name 精确匹配 ings.name；unit 为目标单位；avg 为目标占位均价（元/库存单位）
const FIXES = [
  { name: '去皮马蹄', unit: '斤', avg: 5 },
  { name: '香菇', unit: '斤', avg: 8 },          // 纠正 unit g→斤
  { name: '火龙果汁', unit: 'kg', avg: 8 },
  { name: '五得利雪花面粉', unit: '斤', avg: 2.5 }, // 纠正 unit 袋→斤
];

function appendSpec(g, tag) {
  const s = String(g.spec || '').trim();
  if (s.includes(tag)) return false;
  g.spec = (s ? s + ' ' : '') + tag;
  return true;
}

/** 幂等应用修正：就地改 data.ings，返回报告 */
function applyFixes(data) {
  const ings = Array.isArray(data && data.ings) ? data.ings : [];
  const byName = {};
  for (const g of ings) if (g && g.name) byName[String(g.name).trim()] = g;

  const report = [];
  for (const fix of FIXES) {
    const g = byName[fix.name];
    if (!g) {
      report.push({ name: fix.name, status: 'missing' });
      continue;
    }
    const changes = [];
    const oldUnit = String(g.unit || '');
    if (oldUnit !== fix.unit) {
      changes.push('unit ' + (oldUnit || '?') + '→' + fix.unit);
      g.unit = fix.unit;
    }
    const oldAvg = Number(g.avg) || 0;
    if (oldAvg !== fix.avg) {
      changes.push('avg ' + oldAvg + '→' + fix.avg);
      g.avg = fix.avg;
    }
    if (appendSpec(g, SPEC_TAG)) changes.push('spec+' + SPEC_TAG);
    report.push({
      name: fix.name,
      id: g.id || null,
      status: changes.length ? 'fixed' : 'noop',
      changes,
      unit: g.unit,
      avg: g.avg,
    });
  }
  return report;
}

function printReport(report) {
  console.log('\n== 待核对清单（占位价） ==');
  for (const r of report) {
    if (r.status === 'missing') {
      console.log('  [缺] ' + r.name + ' —— ings 中不存在该名称');
    } else if (r.status === 'fixed') {
      console.log('  [改] ' + r.name + ' (' + r.id + ') ' + r.changes.join('，') + ' → unit=' + r.unit + ' avg=' + r.avg);
    } else {
      console.log('  [·] ' + r.name + ' (' + r.id + ') 无变化');
    }
  }
}

async function getDb(baseUrl) {
  const res = await httpJson('GET', baseUrl.replace(/\/+$/, '') + '/api/db');
  if (res.status >= 400) throw new Error('HTTP ' + res.status);
  return res.body;
}

function parseArgs(argv) {
  const out = { storeUrl: DEFAULT_STORE, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store-url') out.storeUrl = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error('未知参数: ' + a);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  const cur = await getDb(args.storeUrl);
  console.log('[i] 店内库 rev=' + cur.rev + ' ings=' + ((cur.data.ings || []).length));

  const report = applyFixes(cur.data);
  printReport(report);

  if (args.dryRun) {
    console.log('\n[dry-run] 不写库。');
    return 0;
  }

  // ---------- 应用 + PUT（rev 乐观锁，409 重试） ----------
  const base = args.storeUrl.replace(/\/+$/, '');
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur2 = await getDb(args.storeUrl);
    applyFixes(cur2.data);
    const res = await httpJson('PUT', base + '/api/db', { rev: cur2.rev, data: cur2.data, machine: 'SEED' });
    if (res.status === 409 && attempt < 2) {
      console.log('[warn] rev 冲突，重试 ' + (attempt + 1));
      continue;
    }
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    console.log('\n[ok] 已写库 rev ' + cur2.rev + ' → ' + ((res.body || {}).rev));
    break;
  }

  // ---------- 断言 ----------
  const fin = await getDb(args.storeUrl);
  const fd = fin.data;
  const byName = {};
  for (const g of (fd.ings || [])) if (g && g.name) byName[String(g.name).trim()] = g;
  let ok = true;
  for (const fix of FIXES) {
    const g = byName[fix.name];
    const pass = g && String(g.unit || '') === fix.unit && Number(g.avg) === fix.avg;
    if (!pass) ok = false;
    console.log('  ' + fix.name + ' → ' + (g ? ('unit=' + g.unit + ' avg=' + g.avg) : '缺失') + (pass ? ' OK' : ' FAIL'));
  }
  console.log('\n' + (ok ? '全部断言通过' : '存在未过断言，请检查上面 FAIL 项'));
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code || 0),
    (e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exit(1);
    }
  );
}

module.exports = { FIXES, SPEC_TAG, applyFixes };
