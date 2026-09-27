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
 * 无快照：菜谱用 menu-wufu 兜底 200；工单/看板/品控/需求回空列表 200 + hint=no_snapshot
 * （与进销 restock-suggest 一致：空开优于硬 404，避免 App 整页「加载失败」）。
 * date 缺省今天。
 */
const { loadSnapshot } = require('./snapshot');
const { mergeRecipesWithMenu, findMergedRecipe } = require('../lib/menu_wufu');

const NO_SNAP_HINT = 'no_snapshot';
const NO_SNAP_MSG = '店内快照未接通 · 菜谱已用标准菜单，工单/出品需推送快照后刷新';

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

function isOpenTakeout(o) {
  const st = String((o && (o.status || o.state)) || '').trim();
  if (!st) return true;
  return !/完成|已送达|已取消|closed|done|cancel/i.test(st);
}

function isDoneWo(st) {
  return st === '已完成' || st === 'done' || st === '完成' || st === '已传' || st === 'passed';
}

function isDoingWo(st) {
  return st === '制作中' || st === '进行中' || st === 'doing' || st === 'in_progress';
}

function isReadyWo(st) {
  return st === '待传' || st === 'ready' || st === 'pass_ready' || st === '齐';
}

/** 本餐需求：预订人数启发 + 未完结外卖粗估 + 已建工单对照 */
function buildDemand(ext, rmap, date) {
  const bookings = arr(ext.bookings).filter((b) => {
    const d = String((b && (b.date || b.ts || b.time || b.created_at)) || '');
    return d.indexOf(date) === 0 || String(b.date || '') === date;
  });
  const heads = bookings.reduce((s, b) => s + (parseInt(b.party_size || b.partySize || b.people || 0, 10) || 0), 0);
  const takeoutAll = arr(ext.takeout_orders);
  const takeoutOpen = takeoutAll.filter(isOpenTakeout);
  // 糙算法：预订按 1.2 份/人；外卖未完结按 2 份/单（多 SKU 店可后续接明细）
  const fromBooking = Math.ceil(heads * 1.2);
  const fromTakeout = takeoutOpen.length * 2;
  const suggestPortions = Math.max(fromBooking, fromTakeout, 0);

  const wosToday = arr(ext.sop_workorders).filter((w) => w && String(w.date || '') === date);
  const planned = wosToday.reduce((s, w) => s + (Number(w.qty) || 0), 0);
  const gap = Math.max(0, suggestPortions - planned);

  const recipes = arr(ext.recipes);
  const top = recipes[0] || null;
  const suggest = [];
  if (gap > 0 && top) {
    suggest.push({
      sku_id: top.sku_id,
      name: top.name || top.sku_id,
      color: top.color || null,
      qty: gap,
      reason: '本餐缺口约 ' + gap + ' 份（预订启发 ' + fromBooking + ' + 外卖粗估 ' + fromTakeout + ' − 已建工单 ' + planned + '）'
    });
  }

  return {
    date,
    booking_tables: bookings.length,
    booking_heads: heads,
    takeout_open: takeoutOpen.length,
    suggest_portions: suggestPortions,
    workorder_planned: planned,
    gap,
    suggest_workorders: suggest,
    takeout_orders: takeoutOpen.slice(0, 20).map((o) => ({
      id: o.id,
      platform: o.platform,
      platform_no: o.platform_no || o.platformNo,
      amount: o.amount,
      status: o.status,
      ts: o.ts
    }))
  };
}

function parseStepsState(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (e) {
      return {};
    }
  }
  return {};
}

function enrichWorkorder(w, rmap, ext) {
  const r = rmap[String(w.sku_id)] || null;
  const steps = stepsFor(ext, w.sku_id);
  const stepsState = parseStepsState(w.steps_state);
  const actualYield = w.actual_yield != null ? Number(w.actual_yield) : null;
  return {
    id: String(w.id),
    sku_id: w.sku_id,
    name: (r && (r.name || r.sku_id)) || String(w.sku_id || ''),
    color: r ? r.color || null : null,
    qty: w.qty,
    planned_start: w.planned_start,
    status: w.status || '待开始',
    table_id: w.table_id || null,
    table_no: w.table_no || null,
    steps,
    steps_state: stepsState,
    actual_yield: Number.isFinite(actualYield) ? actualYield : null,
    sop_total: steps.length
  };
}

/** 出成偏差告警：已完成且 |actual - qty| / qty > 8% */
function buildYieldAlerts(ext, rmap, date) {
  const alerts = [];
  for (const w of arr(ext.sop_workorders)) {
    if (!w || String(w.date || '') !== date) continue;
    if (!isDoneWo(w.status)) continue;
    const expected = Number(w.qty) || 0;
    const actual = w.actual_yield != null ? Number(w.actual_yield) : null;
    if (!Number.isFinite(actual) || expected <= 0) continue;
    const deviation = (actual - expected) / expected;
    if (Math.abs(deviation) < 0.08) continue;
    const r = rmap[String(w.sku_id)] || null;
    alerts.push({
      workorder_id: String(w.id),
      id: String(w.id),
      sku_id: w.sku_id,
      name: (r && (r.name || r.sku_id)) || String(w.sku_id || ''),
      color: r ? r.color || null : null,
      expected_yield: expected,
      actual_yield: actual,
      deviation_pct: Math.round(deviation * 1000) / 10,
      note: deviation > 0 ? '出成偏高' : '出成偏低'
    });
  }
  return alerts;
}

async function handle(req, res, ctx, pathname) {
  // 只读路由：非 GET 一律交外层 404（不暴露任何写路径）
  if (req.method !== 'GET') return false;

  const isWorkorder = pathname === '/api/sop/workorder' || pathname === '/api/kitchen/workorders';
  const isRecipes = pathname === '/api/kitchen/recipes';
  const mRecipe = pathname.match(/^\/api\/kitchen\/recipes\/([^/]+)$/);
  const isQc = pathname === '/api/kitchen/qc';
  const isBoard = pathname === '/api/kitchen/board';
  const isDemand = pathname === '/api/kitchen/demand';
  if (!isWorkorder && !isRecipes && !mRecipe && !isQc && !isBoard && !isDemand) return false;

  const snap = loadSnapshot();
  const ext = extOf(snap);
  const rmap = recipeMap(ext);
  const date = pickDate(ctx);
  const rev = snap ? snap.rev : null;
  const soft = snap
    ? {}
    : { hint: NO_SNAP_HINT, message: NO_SNAP_MSG };

  // GET /api/sop/workorder?date=
  if (isWorkorder) {
    const workorders = arr(ext.sop_workorders)
      .filter((w) => w && String(w.date || '') === date)
      .map((w) => enrichWorkorder(w, rmap, ext));
    ctx.sendJSON(res, 200, {
      ok: true,
      date,
      rev,
      count: workorders.length,
      workorders,
      ...soft
    });
    return true;
  }

  // GET /api/kitchen/recipes — 快照配方 ∪ menu-wufu ∪ 保本测算（无快照仍可用菜单）
  if (isRecipes) {
    const merged = mergeRecipesWithMenu(arr(ext.recipes));
    let baobenSummary = null;
    try {
      baobenSummary = require('../lib/menu_baoben').computeBaobenSummary();
    } catch (e) { /* optional */ }
    ctx.sendJSON(res, 200, {
      ok: true,
      rev,
      count: merged.items.length,
      items: merged.items,
      menu: merged.menu,
      baoben: merged.baoben || null,
      baoben_summary: baobenSummary,
      source: merged.source,
      ...soft
    });
    return true;
  }

  // GET /api/kitchen/recipes/{sku_id}
  if (mRecipe) {
    let sku = mRecipe[1];
    try { sku = decodeURIComponent(sku); } catch (e) {}
    const found = findMergedRecipe(arr(ext.recipes), sku);
    if (!found.item) {
      ctx.sendJSON(res, 404, {
        ok: false,
        error: 'recipe not found',
        sku_id: sku,
        rev,
        ...soft
      });
      return true;
    }
    const stepsSku = found.item.sku_id;
    // BOM 成本卡（只读）：ings.avg × config.ing_alias，口径见 lib/recipe_cost.js
    let costCard = null;
    try {
      const { buildCostCard } = require('../lib/recipe_cost');
      costCard = buildCostCard(found.item, (snap && snap.data) || {});
    } catch (e) { costCard = null; }
    ctx.sendJSON(res, 200, {
      ok: true,
      rev,
      item: found.item,
      cost_card: costCard,
      steps: stepsFor(ext, stepsSku),
      source: found.item.source || found.meta.source,
      ...soft
    });
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
    ctx.sendJSON(res, 200, {
      ok: true,
      date,
      rev,
      count: items.length,
      items,
      ...soft
    });
    return true;
  }

  // GET /api/kitchen/board?date=
  if (isBoard) {
    const groups = {};
    const grp = (color) => {
      if (!groups[color]) groups[color] = { color, planned: 0, done: 0, doing: 0, _qcPass: 0, _qcTotal: 0 };
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
      if (isDoneWo(w.status)) g.done += qty;
      else if (isDoingWo(w.status)) g.doing += qty;
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
        doing: g.doing,
        qc_pass_rate: g._qcTotal ? +(g._qcPass / g._qcTotal).toFixed(4) : null,
        qc_total: g._qcTotal
      };
    });
    // 传菜对桌：未完成工单按 table_id 聚合
    const tableMap = {};
    for (const w of arr(ext.sop_workorders)) {
      if (!w || String(w.date || '') !== date) continue;
      if (isDoneWo(w.status)) continue;
      const tid = String(w.table_id || '').trim();
      if (!tid) continue;
      const r = rmap[String(w.sku_id)] || null;
      if (!tableMap[tid]) {
        tableMap[tid] = {
          table_id: tid,
          table_no: w.table_no || tid,
          pending: 0,
          doing: 0,
          ready: 0,
          colors: {},
          items: []
        };
      }
      const row = tableMap[tid];
      const qty = Number(w.qty) || 0;
      row.pending += qty;
      if (isDoingWo(w.status)) row.doing += qty;
      if (isReadyWo(w.status)) row.ready += qty;
      const color = (r && r.color) || '未关联';
      row.colors[color] = (row.colors[color] || 0) + qty;
      row.items.push({
        id: String(w.id),
        sku_id: w.sku_id,
        name: (r && (r.name || r.sku_id)) || String(w.sku_id || ''),
        color,
        qty,
        status: w.status || '待开始'
      });
    }
    const tables = Object.keys(tableMap).sort().map((tid) => {
      const row = tableMap[tid];
      return {
        table_id: row.table_id,
        table_no: row.table_no,
        pending: row.pending,
        doing: row.doing,
        ready: row.ready,
        colors: Object.keys(row.colors).map((c) => ({ color: c, qty: row.colors[c] })),
        items: row.items
      };
    });
    const demand = buildDemand(ext, rmap, date);
    const yieldAlerts = buildYieldAlerts(ext, rmap, date);
    ctx.sendJSON(res, 200, {
      ok: true,
      date,
      rev,
      board,
      items: board,
      tables,
      demand,
      takeout_open: demand.takeout_orders,
      yield_alerts: yieldAlerts,
      ...soft
    });
    return true;
  }

  // GET /api/kitchen/demand?date=
  if (isDemand) {
    const demand = buildDemand(ext, rmap, date);
    ctx.sendJSON(res, 200, { ok: true, rev, ...demand, ...soft });
    return true;
  }

  return false;
}

module.exports = { handle, buildDemand, buildYieldAlerts, enrichWorkorder };
