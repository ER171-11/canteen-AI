'use strict';
/*
 * lib/workbench.js — 岗位工作台（把"关键工作 + 标准"直接摆给岗位）
 *
 *   采购工作台：按「今日需求(工单/建议缺口) × 菜谱BOM」算原料需求 → 对比库存 → 采购缺口；
 *              并给验收标准清单（验货按标准）。
 *   厨师工作台：今日工单 + 每 SKU 菜谱标准(工序/关键参数) + 品控记录。
 * 全部只读；下单/入库/工单/品控写操作仍走确认台。
 */
const { buildCostCard, gramsPerUnit } = require('./recipe_cost');
const { buildDemand } = require('../routes/kitchen');

function arr(v) { return Array.isArray(v) ? v : []; }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ------------------------------------------------------------------ */
/* 采购工作台                                                          */
/* ------------------------------------------------------------------ */
function procurement(ext, data, date) {
  const day = date || today();
  const recipes = arr(ext.recipes);
  const bySku = {};
  for (const r of recipes) if (r && (r.sku_id || r.id)) bySku[String(r.sku_id || r.id)] = r;

  // 需求份数：今日工单 + 建议缺口（合并到缺口 SKU）
  const demandPortions = {};
  for (const w of arr(ext.sop_workorders)) {
    if (!w || String(w.date || '') !== day) continue;
    const k = String(w.sku_id || w.skuId || '');
    if (k) demandPortions[k] = (demandPortions[k] || 0) + num(w.qty);
  }
  let demand = null;
  try { demand = buildDemand(ext, {}, day); } catch (e) { demand = null; }
  if (demand && demand.gap > 0 && demand.suggest_workorders && demand.suggest_workorders[0]) {
    const s = demand.suggest_workorders[0];
    const k = String(s.sku_id || '');
    if (k) demandPortions[k] = (demandPortions[k] || 0) + num(s.qty);
  }

  // 按菜谱 BOM 展开原料需求（克 → 采购单位）
  const need = {}; // name -> { grams, units, unit, hasStock }
  const ingByName = {};
  for (const g of arr(data && data.ings)) if (g && g.name) ingByName[String(g.name).trim()] = g;
  const alias = (data && data.config && data.config.ing_alias) || {};

  for (const sku of Object.keys(demandPortions)) {
    const recipe = bySku[sku];
    if (!recipe) continue;
    const portions = demandPortions[sku];
    const card = buildCostCard(recipe, data || {});
    if (!card) continue;
    const batchPieces = num(card.batch_pieces) || 67;
    const portionPieces = num(card.portion_pieces) || 15;
    for (const line of arr(card.bom_lines)) {
      if (!line || !line.matched) continue;
      const perPortionG = num(line.qty_g) / batchPieces * portionPieces;
      const needG = perPortionG * portions;
      const realName = alias[line.name] || line.name;
      const ing = ingByName[String(realName).trim()] || ingByName[String(line.name).trim()];
      const gpu = ing ? gramsPerUnit(ing) : null;
      if (!need[realName]) {
        need[realName] = {
          name: realName, grams: 0, units: 0,
          unit: ing ? (ing.buy || ing.unit || '斤') : '斤',
          have: ing ? num(ing.qty) : null,
          safe: ing ? num(ing.safe != null ? ing.safe : ing.safety) : null,
          price: ing ? (num(ing.avg) || num(ing.last) || num(ing.price)) : 0,
          gpu: gpu || null
        };
      }
      need[realName].grams += needG;
      if (gpu) need[realName].units += needG / gpu;
    }
  }

  const lines = Object.values(need).map((x) => {
    const needUnits = x.gpu ? x.units : (x.grams / 500); // 无换算按 500g/斤 估
    const haveUnits = x.have == null ? 0 : x.have;
    const gapUnits = +(needUnits - haveUnits).toFixed(2);
    return {
      name: x.name,
      unit: x.unit,
      need: +needUnits.toFixed(2),
      have: +haveUnits.toFixed(2),
      safe: x.safe,
      gap: gapUnits > 0 ? gapUnits : 0,
      grams: Math.round(x.grams),
      price: x.price,
      estimated: +(Math.max(0, gapUnits) * x.price).toFixed(2)
    };
  }).filter((x) => x.need > 0).sort((a, b) => b.gap - a.gap);

  const toBuy = lines.filter((x) => x.gap > 0);
  const estTotal = +toBuy.reduce((s, x) => s + x.estimated, 0).toFixed(2);

  return {
    ok: true,
    date: day,
    demand_portions: demandPortions,
    demand_total: Object.values(demandPortions).reduce((s, v) => s + v, 0),
    need_lines: lines.slice(0, 40),
    to_buy: toBuy.slice(0, 20),
    missing: lines.filter((x) => x.have == null).map((x) => x.name),
    est_total: estTotal,
    // 一键转采购意向的 payload（老板/采购在确认台点头）
    restock_payload: {
      supplier: '按菜谱需求采购',
      note: `按 ${day} 需求×菜谱BOM 计算`,
      items: toBuy.slice(0, 20).map((x) => ({
        name: x.name, qty: x.gap, unit: x.unit, price: x.price
      }))
    }
  };
}

/* ------------------------------------------------------------------ */
/* 厨师工作台                                                          */
/* ------------------------------------------------------------------ */
function kitchenWorkbench(ext, data, date) {
  const day = date || today();
  const recipes = arr(ext.recipes);
  const bySku = {};
  for (const r of recipes) if (r && (r.sku_id || r.id)) bySku[String(r.sku_id || r.id)] = r;
  const qc = arr(ext.qc_records);
  const steps = arr(ext.sop_steps);

  const wos = arr(ext.sop_workorders).filter((w) => w && String(w.date || '') === day);
  const items = wos.map((w) => {
    const sku = String(w.sku_id || w.skuId || '');
    const recipe = bySku[sku] || null;
    const recipeSteps = recipe ? steps.filter((s) => String(s.sku_id) === String(recipe.sku_id || recipe.id)) : [];
    const params = (recipe && recipe.params) || {};
    const wqc = qc.filter((q) => String(q.workorder_id || '') === String(w.id) || String(q.sku_id || '') === sku);
    const pass = wqc.filter((q) => q.pass === 1 || q.pass === true).length;
    return {
      id: w.id,
      sku_id: sku,
      name: (recipe && recipe.name) || w.name || sku,
      qty: num(w.qty),
      status: w.status || '待开始',
      // 菜谱标准
      steps: recipeSteps.length || (recipe && arr(recipe.steps).length) || 0,
      params: {
        醒发: params['醒发_分钟'] != null ? String(params['醒发_分钟']) : (params['醒发'] != null ? String(params['醒发']) : null),
        剂子: params['剂子_g'] != null ? String(params['剂子_g']) : '10-11g',
        成品: params['成品_g'] != null ? String(params['成品_g']) : '25-27g',
        点凉水: params['点凉水_次'] != null ? String(params['点凉水_次']) : '分三次'
      },
      qc_total: wqc.length,
      qc_pass: pass,
      qc_rate: wqc.length ? Math.round((pass / wqc.length) * 100) : null
    };
  });

  const pendingQc = items.reduce((s, x) => s + Math.max(0, x.qty && x.qc_total === 0 ? 1 : 0), 0);

  return {
    ok: true,
    date: day,
    workorders: items,
    planned: items.reduce((s, x) => s + x.qty, 0),
    standards: {
      recipes: recipes.length,
      sop_steps: steps.length,
      note: '按菜谱标准制作：工序以菜谱为准，关键参数见各工单'
    },
    qc_pending: items.filter((x) => x.qc_total === 0).length,
    advice: items.length ? [] : ['今日暂无工单 · 按缺口建单后此处显示制作标准']
  };
}

/* ------------------------------------------------------------------ */
/* 到货验收工作台                                                      */
/* ------------------------------------------------------------------ */
function recvWorkbench(ext, data, date) {
  const day = date || today();
  const recv = arr(data && data.recv).filter((r) => r && !/已入库|取消/.test(String(r.status || '')));
  let standards = 0;
  let specReqFor = () => undefined;
  try {
    const lib = require('./accept_standards');
    specReqFor = (n) => lib.specReqFor(n, { ext: ext || {} });
    standards = arr(lib.listStandards({ ext: ext || {} })).length;
  } catch (e) { /* ignore */ }

  const ingById = {};
  for (const g of arr(data && data.ings)) if (g && g.id != null) ingById[String(g.id)] = g.name;
  const orders = recv.map((r) => {
    const lines = arr(r.lines).map((l) => {
      const raw = l && (l.name || l.ing) || '原料';
      const name = ingById[String(raw)] || (l && l.ing != null ? (ingById[String(l.ing)] || l.ing) : raw) || raw;
      return {
        name: String(name),
        qty: num(l && l.qty),
        unit: (l && l.unit) || '',
        spec_req: specReqFor(name) || null
      };
    });
    return {
      id: r.id,
      no: r.no,
      supplier: r.supplier || '',
      date: r.date || '',
      status: r.status || '待入库',
      lines
    };
  });

  return {
    ok: true,
    date: day,
    orders: orders.slice(0, 20),
    standards,
    note: orders.length ? '按验收标准逐项核对（数量/规格/鲜度/批次）后入库' : '暂无待到货单'
  };
}

module.exports = { procurement, kitchenWorkbench, recvWorkbench };
