'use strict';
/*
 * routes/sales_import.js — 平台销售数据导入：预览 + 批次列表 + 菜名映射（全部只读）
 *   POST /api/sales/import/preview   导入预览（FP-SALE-03/05/06）
 *   GET  /api/sales/import/batches   外部销售批次列表（FP-SALE-04 撤回入口的数据源）
 *   GET  /api/sales/import/alias     菜名映射列表（FP-SALE-06 配置页数据源，附带在售菜品下拉）
 *
 * 红线：这三个端点全部**只读**。写（导入/撤回/重算/映射增删）统一走 /api/actions
 *   （sale.import / sale.batch_void / sale.amt_recalc / sale.alias_set / sale.alias_delete），
 *   与 recv.import 同型（预览纯计算零写，提交整批一个动作）。
 */
const { loadSnapshot } = require('./snapshot');
const { previewSaleImport, saleSrcName, SALE_SRC, SALE_AMT_MODES } = require('../lib/sales_import');
const { isVoided } = require('../lib/sales_model');

const MAX_UPLOAD = 8 * 1024 * 1024;

function num(v, d) { const n = parseFloat(v); return isNaN(n) ? (d == null ? 0 : d) : n; }
function r2(n) { return Math.round(num(n, 0) * 100) / 100; }

/* ---------- POST /api/sales/import/preview ---------- */
async function handlePreview(req, res, ctx) {
  if (req.method !== 'POST') { ctx.sendJSON(res, 405, { ok: false, error: 'method not allowed' }); return true; }
  const { buf, tooLarge } = await ctx.readBody(req, MAX_UPLOAD);
  if (tooLarge) { ctx.sendJSON(res, 413, { ok: false, error: '文件过大：上限 8MB，请拆分后再导入' }); return true; }
  let body = null;
  try { body = JSON.parse(String(buf || '').toString('utf8')); } catch (e) { body = null; }
  if (!body || typeof body !== 'object' || (!body.contentBase64 && !body.text)) {
    ctx.sendJSON(res, 400, { ok: false, error: '缺少 contentBase64（文件内容）' });
    return true;
  }
  const snap = loadSnapshot();
  const data = (snap && snap.data) || {};
  const dishes = Array.isArray(data.dishes) ? data.dishes : [];
  const dishAlias = (data.dishAlias && typeof data.dishAlias === 'object' && !Array.isArray(data.dishAlias)) ? data.dishAlias : {};
  const input = {
    fileName: String(body.fileName || 'import.csv'),
    contentBase64: body.contentBase64,
    bytes: body.text ? Buffer.from(String(body.text), 'utf8') : null,
  };
  const out = previewSaleImport(input, dishes, dishAlias);
  ctx.sendJSON(res, out.ok ? 200 : 400, out);
  return true;
}

/* ---------- GET /api/sales/import/batches ---------- */
function buildBatches(sales) {
  const map = new Map();
  for (const s of (sales || [])) {
    if (!s || !s.batch) continue;
    if (!map.has(s.batch)) {
      map.set(s.batch, { batch: s.batch, src: s.src || '', srcName: saleSrcName(s.src), count: 0, receivable: 0, voided: 0, settled: false, dates: new Set(), ts: s.ts || '' });
    }
    const b = map.get(s.batch);
    b.count++;
    b.receivable += num(s.receivable, 0);
    if (isVoided(s)) b.voided++;
    if (s.settled) b.settled = true;
    if (s.date) b.dates.add(String(s.date).slice(0, 10));
    if (s.ts && s.ts > b.ts) b.ts = s.ts;
  }
  const out = [];
  map.forEach((b) => {
    const ds = Array.from(b.dates).sort();
    out.push({
      batch: b.batch, src: b.src, srcName: b.srcName, count: b.count,
      receivable: r2(b.receivable), voided: b.voided, settled: b.settled,
      dateMin: ds[0] || '', dateMax: ds[ds.length - 1] || '', ts: b.ts,
    });
  });
  out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return out;
}

/* ---------- GET /api/sales/import/alias ---------- */
function buildAliasList(dishes, dishAlias) {
  const out = [];
  for (const name of Object.keys(dishAlias || {})) {
    const a = dishAlias[name] || {};
    const d = (dishes || []).find((x) => x && String(x.id) === String(a.dish));
    out.push({ name: name, dish: a.dish || '', dishName: d ? d.name : (a.dish || '未匹配'), mul: num(a.mul, 1) });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

async function handle(req, res, ctx, pathname) {
  if (pathname === '/api/sales/import/preview') return handlePreview(req, res, ctx);

  if (req.method !== 'GET') return false;
  const snap = loadSnapshot();
  const data = (snap && snap.data) || {};

  if (pathname === '/api/sales/import/batches') {
    const batches = buildBatches(data.sales);
    ctx.sendJSON(res, 200, { ok: true, count: batches.length, batches });
    return true;
  }

  if (pathname === '/api/sales/import/alias') {
    const dishes = Array.isArray(data.dishes) ? data.dishes : [];
    const dishAlias = (data.dishAlias && typeof data.dishAlias === 'object' && !Array.isArray(data.dishAlias)) ? data.dishAlias : {};
    const aliases = buildAliasList(dishes, dishAlias);
    const onDishes = dishes.filter((d) => d && d.on).map((d) => ({ id: d.id, name: d.name }));
    ctx.sendJSON(res, 200, { ok: true, count: aliases.length, aliases, onDishes, srcs: SALE_SRC, amtModes: SALE_AMT_MODES });
    return true;
  }

  return false;
}

module.exports = { handle };
