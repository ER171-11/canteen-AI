'use strict';
/*
 * routes/kitchen.js — 厨房/SOP 只读端点（红线①：只读，无任何写库路径；写操作一律走 /api/actions）
 * 数据来自店内推送快照的 ext 模块：
 *   ext.recipes        [{sku_id,name,color,filling,...,version,updated_at}]
 *   ext.sop_steps      [{sku_id,step_no,stage,duration_min,tools,inputs,key_points,qc_point,risk,params}]
 *   ext.sop_workorders [{id,date,sku_id,qty,planned_start,status,qc_records}]
 *   ext.qc_records     [{id,workorder_id,sku_id,sample_weight,pass,ts,source}]
 *
 *   GET /api/sop/workorder?date=   工单 + 关联配方 name/color + 该 sku 的 sop_steps（step_no 升序）
 *   GET /api/kitchen/recipes       配方全量
 *   GET /api/kitchen/recipes/{sku} 单条配方 + 其 sop_steps
 *   GET /api/kitchen/qc?date=      品控记录（关联 workorder/sku）
 *   GET /api/kitchen/board?date=   出品看板：按 color 聚合 planned/done/qc_pass_rate
 * 无快照一律 404 {ok:false,error:"no snapshot"}；date 缺省今天。
 */
const { loadSnapshot } = require('./snapshot');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function pickDate(ctx) {
  const q = (ctx.query.get('date') || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayStr();
}

function extOf(snap) {
  return snap && snap.ext && typeof snap.ext === 'object' ? snap.ext : {};
}

function arr(v) { return Array.isArray(v) ? v : []; }

function recipeMap(ext) {
  const m = {};
  for (const r of arr(ext.recipes)) {
    if (r && r.sku_id != null) m[String(r.sku_id)] = r;
  }
  return m;
}

function stepsFor(ext, skuId) {
  return arr(ext.sop_steps)
    .filter((s) => s && String(s.sku_id) === String(skuId))
    .sort((a, b) => (Number(a.step_no) || 0) - (Number(b.step_no) || 0));
}

function truthyPass(v) { return v === true || v === 1 || v === 'true' || v === 'pass'; }

async function handle(req, res, ctx, pathname) {
  // 只读路由：非 GET 一律交外层 404（不暴露任何写路径）
  if (req.method !== 'GET') return false;

  const isWorkorder = pathname === '/api/sop/workorder';
  const isRecipes = pathname === '/api/kitchen/recipes';
  const mRecipe = pathname.match(/^\/api\/kitchen\/recipes\/([^/]+)$/);
  const isQc = pathname === '/api/kitchen/qc';
  const isBoard = pathname === '/api/kitchen/board';
  if (!isWorkorder && !isRecipes && !mRecipe && !isQc && !isBoard) return false;

  const snap = loadSnapshot();
  if (!snap) {
    ctx.sendJSON(res, 404, { ok: false, error: 'no snapshot' });
    return true;
  }
  const ext = extOf(snap);
  const rmap = recipeMap(ext);
  const date = pickDate(ctx);

  // GET /api/sop/workorder?date=
  if (isWorkorder) {
    const workorders = arr(ext.sop_workorders)
      .filter((w) => w && String(w.date || '') === date)
      .map((w) => {
        const r = rmap[String(w.sku_id)] || null;
        return {
          id: w.id,
          sku_id: w.sku_id,
          name: r ? r.name || null : null,
          color: r ? r.color || null : null,
          qty: w.qty,
          planned_start: w.planned_start,
          status: w.status,
          steps: stepsFor(ext, w.sku_id)
        };
      });
    ctx.sendJSON(res, 200, { ok: true, date, rev: snap.rev, count: workorders.length, workorders });
    return true;
  }

  // GET /api/kitchen/recipes
  if (isRecipes) {
    const items = arr(ext.recipes);
    ctx.sendJSON(res, 200, { ok: true, rev: snap.rev, count: items.length, items });
    return true;
  }

  // GET /api/kitchen/recipes/{sku_id}
  if (mRecipe) {
    let sku = mRecipe[1];
    try { sku = decodeURIComponent(sku); } catch (e) {}
    const r = rmap[sku];
    if (!r) {
      ctx.sendJSON(res, 404, { ok: false, error: 'recipe not found', sku_id: sku, rev: snap.rev });
      return true;
    }
    ctx.sendJSON(res, 200, { ok: true, rev: snap.rev, item: r, steps: stepsFor(ext, sku) });
    return true;
  }

  // GET /api/kitchen/qc?date=
  if (isQc) {
    const wos = {};
    for (const w of arr(ext.sop_workorders)) {
      if (w && w.id != null) wos[String(w.id)] = w;
    }
    const items = arr(ext.qc_records)
      .filter((q) => {
        if (!q) return false;
        if (String(q.ts || '').indexOf(date) === 0) return true;
        const w = wos[String(q.workorder_id)];
        return !!(w && String(w.date || '') === date);
      })
      .map((q) => {
        const w = wos[String(q.workorder_id)] || null;
        const sku = q.sku_id != null ? q.sku_id : (w ? w.sku_id : null);
        const r = sku != null ? rmap[String(sku)] || null : null;
        return Object.assign({}, q, {
          sku_id: sku,
          name: r ? r.name || null : null,
          color: r ? r.color || null : null,
          workorder_status: w ? w.status || null : null
        });
      });
    ctx.sendJSON(res, 200, { ok: true, date, rev: snap.rev, count: items.length, items });
    return true;
  }

  // GET /api/kitchen/board?date=
  if (isBoard) {
    const groups = {};
    const grp = (color) => {
      if (!groups[color]) groups[color] = { color, planned: 0, done: 0, _qcPass: 0, _qcTotal: 0 };
      return groups[color];
    };
    const wos = {};
    for (const w of arr(ext.sop_workorders)) {
      if (w && w.id != null) wos[String(w.id)] = w;
      if (!w || String(w.date || '') !== date) continue;
      const r = rmap[String(w.sku_id)] || null;
      const g = grp((r && r.color) || '未关联');
      const qty = Number(w.qty) || 0;
      g.planned += qty;
      if (w.status === '已完成') g.done += qty;
    }
    for (const q of arr(ext.qc_records)) {
      if (!q) continue;
      const w = wos[String(q.workorder_id)] || null;
      const inDate = String(q.ts || '').indexOf(date) === 0 || !!(w && String(w.date || '') === date);
      if (!inDate) continue;
      const sku = q.sku_id != null ? q.sku_id : (w ? w.sku_id : null);
      const r = sku != null ? rmap[String(sku)] || null : null;
      const g = grp((r && r.color) || '未关联');
      g._qcTotal += 1;
      if (truthyPass(q.pass)) g._qcPass += 1;
    }
    const board = Object.keys(groups).sort().map((color) => {
      const g = groups[color];
      return {
        color: g.color,
        planned: g.planned,
        done: g.done,
        qc_pass_rate: g._qcTotal ? +(g._qcPass / g._qcTotal).toFixed(4) : null,
        qc_total: g._qcTotal
      };
    });
    ctx.sendJSON(res, 200, { ok: true, date, rev: snap.rev, board });
    return true;
  }

  return false;
}

module.exports = { handle };
