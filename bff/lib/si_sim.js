'use strict';
/*
 * lib/si_sim.js — SI 数字孪生 / What-if 模拟
 *
 * 输入一个假设（某 SKU 做 N 份 / 调价 x% / 某原料涨跌 y%），确定性测算：
 *   单份成本、单份毛利、毛利率变化、该批次利润、所需原料。
 * 红线：只读配方与采购价，不落库；结果是决策参考，转采购/调价仍走确认台。
 */
const { buildCostCard, PORTION_PIECES } = require('./recipe_cost');

function num(v, d) { const n = parseFloat(v); return isNaN(n) ? (d || 0) : n; }

function findRecipe(snap, sku) {
  const recipes = Array.isArray(snap && snap.ext && snap.ext.recipes) ? snap.ext.recipes : [];
  const key = String(sku || '').trim();
  if (!key) return recipes[0] || null;
  return recipes.find((r) => r && (
    String(r.sku_id || '') === key ||
    String(r.id || '') === key ||
    String(r.name || '') === key ||
    String(r.name || '').indexOf(key) >= 0
  )) || null;
}

function nameHit(bomName, query) {
  const a = String(bomName || '');
  const b = String(query || '');
  if (!b) return false;
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

/**
 * @param {object} input {sku, portions, price_delta_pct, material_name, material_delta_pct}
 * @param {object} snap
 */
function simulate(input, snap) {
  const inp = input || {};
  const recipe = findRecipe(snap, inp.sku);
  if (!recipe) {
    return { ok: false, error: '未找到该菜品/配方', available: (snap && snap.ext && snap.ext.recipes || []).length };
  }
  const data = (snap && snap.data) || {};
  const card = buildCostCard(recipe, data, (snap && snap.ext && snap.ext.recipes) || []);
  if (!card) return { ok: false, error: '成本卡不可用（配方或采购价未齐）' };

  const batchPieces = num(card.batch_pieces, 67) || 67;
  const portions = Math.max(1, parseInt(inp.portions, 10) || 1);
  const priceDelta = num(inp.price_delta_pct, 0);
  const matName = String(inp.material_name || '').trim();
  const matDelta = num(inp.material_delta_pct, 0);

  // 基础
  const baseBatchCost = num(card.batch_cost, 0);
  const basePortionCost = num(card.portion_cost, baseBatchCost / batchPieces * card.portion_pieces);

  // 原料涨跌：对命中 BOM 行按比例调整
  let materialImpact = 0;
  const touched = [];
  if (matName && matDelta !== 0) {
    for (const line of (card.bom_lines || [])) {
      if (!line || !line.matched) continue;
      if (!nameHit(line.name, matName)) continue;
      const d = num(line.line_cost, 0) * (matDelta / 100);
      materialImpact += d;
      touched.push({ name: line.name, delta_cost: +d.toFixed(4) });
    }
  }
  const newBatchCost = baseBatchCost + materialImpact;
  const newPortionCost = +(newBatchCost / batchPieces * card.portion_pieces).toFixed(2);

  const basePrice = num(card.price, 0);
  const newPrice = +(basePrice * (1 + priceDelta / 100)).toFixed(2);
  const baseMargin = card.gross_margin;
  const newMargin = newPrice > 0 ? +(((newPrice - newPortionCost) / newPrice) * 100).toFixed(1) : null;

  const baseProfit = basePrice > 0 ? +((basePrice - basePortionCost) * portions).toFixed(2) : null;
  const newProfit = newPrice > 0 ? +((newPrice - newPortionCost) * portions).toFixed(2) : null;

  // 所需原料：BOM 每批用量 / 出成 × 份数
  const materials = [];
  for (const line of (card.bom_lines || [])) {
    if (!line || !line.matched) continue;
    const perBatchG = num(line.qty_g, 0);
    if (perBatchG <= 0) continue;
    const needG = perBatchG / batchPieces * card.portion_pieces * portions;
    materials.push({
      name: line.name,
      need_kg: +(needG / 1000).toFixed(3),
      unit_price: line.unit_price != null ? line.unit_price : null
    });
  }
  materials.sort((a, b) => b.need_kg - a.need_kg);

  return {
    ok: true,
    sku: recipe.sku_id || recipe.id || null,
    name: recipe.name || null,
    assumptions: {
      portions,
      price_delta_pct: priceDelta,
      material_name: matName || null,
      material_delta_pct: matDelta
    },
    base: {
      price: basePrice || null,
      portion_cost: basePortionCost,
      gross_margin: baseMargin,
      batch_cost: +baseBatchCost.toFixed(2),
      portion_pieces: card.portion_pieces || PORTION_PIECES
    },
    projected: {
      price: newPrice || null,
      portion_cost: newPortionCost,
      gross_margin: newMargin,
      batch_cost: +newBatchCost.toFixed(2)
    },
    delta: {
      margin_pct: (baseMargin != null && newMargin != null) ? +(newMargin - baseMargin).toFixed(1) : null,
      portion_cost: +(newPortionCost - basePortionCost).toFixed(2),
      profit: (baseProfit != null && newProfit != null) ? +(newProfit - baseProfit).toFixed(2) : null
    },
    scenario_profit: { base: baseProfit, projected: newProfit },
    material_impact: touched,
    materials: materials.slice(0, 12),
    note: '模拟仅供参考 · 转采购/调价仍须确认台 · 成本仅计已定价原料'
  };
}

module.exports = { simulate, findRecipe };
