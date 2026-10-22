'use strict';
/*
 * lib/recipe_cost.js — SKU → BOM 成本卡（只读，无写路径）
 *
 * 与 store-inventory/seed_recipe_links.py 同口径（批0 数据缝合的镜像实现）：
 *   BOM 克重解析：去括号 / 料水复合行展开（花椒10g、大料5g…）/ 顿号并列拆分
 *   原料定价：config.ing_alias（BOM 名 → ings 实名）+ 精确名 → ings.avg（per unit 价）
 *   规格换算：斤=500g；名称内 kg/g/ml/L/升 解析；ASSUMED_SPEC_G 规格假定
 *   份 = PORTION_PIECES(15) 只；批 = params.一批出成_个（缺省 67）
 *
 * buildCostCard(recipe, data) →
 *   { bom_lines: [{name, part, qty_text, qty_g, gross_g, unit, yld, waste_pct,
 *                  price_per_unit, ing, ing_name, unit_price, line_cost, matched}],
 *     batch_cost, batch_pieces, unit_cost, portion_pieces, portion_cost,
 *     price, gross_margin, missing_ings[], baoben{} }
 * unit_price 为 元/克；line_cost 为该行「每批」成本（元）。
 *
 * 标准配方卡口径（对齐《金丰菜品标准卡》表格）：
 *   part        配料类别（面主料 / 主料 / 辅料 / 调料）
 *   qty_g       配料净重（每批克重，取自 docx/DB 原文，不折算）
 *   gross_g     配料毛重 = 净重 ÷ 出成率
 *   waste_pct   损耗率 % = (1 − 出成率) × 100
 *   price_per_unit 原料价格（元/库存单位；unit 为库存单位）
 *   line_cost   共计（该行每批成本，元）
 * 面皮组取 params.面主料（含面粉/色源/食盐），缺省回落到 face_main。
 */

const { isConsumable } = require('./ing_type'); // W4：耗材不进菜品成本口径
const {
  parseBomLine,
  gramsPerUnit,
  resolveIngName,
  PORTION_PIECES,
  SKIP_NAMES
} = require('../../shared/recipe-cost/index.cjs');

/* ---------------- W6：中间材料（半成品） ---------------- */

/** 判定 recipe 行是否为中间材料（半成品）：type/kind === 'semi' */
function isSemi(r) {
  return !!(r && (r.type === 'semi' || r.kind === 'semi'));
}

/**
 * 从 recipe 数组（ext.recipes 全量）建「中间材料名 → recipe」索引。
 * 只收 type='semi' 的行；同名后写覆盖先写（与 ext 数组顺序一致）。
 */
function collectSemiIndex(recipeLib) {
  const idx = {};
  const lib = Array.isArray(recipeLib) ? recipeLib : [];
  for (const r of lib) {
    if (!isSemi(r)) continue;
    const name = String((r && r.name) || '').trim();
    if (name) idx[name] = r;
  }
  return idx;
}

/** 中间材料四个配料列（与 buildCostCard 同口径：面主料优先 params['面主料']） */
function semiCols(rec) {
  const rp = (rec && rec.params && typeof rec.params === 'object') ? rec.params : {};
  const faceRaw = (Array.isArray(rp['面主料']) && rp['面主料'].length)
    ? rp['面主料']
    : (rec ? rec.face_main : null);
  return [
    [faceRaw, '面主料'],
    [rec ? rec.main : null, '主料'],
    [rec ? rec.aux : null, '辅料'],
    [rec ? rec.seasoning : null, '调料']
  ];
}

/**
 * 中间材料「一批」基准克重（决定引用量的缩放因子）：
 *   ① 优先 params['一批出成_g']（如料水一批熬煮出成 200g，BOM 香料 23g）；
 *   ② 退化：BOM 条目克重合计（此时「引用量 = BOM 合计」等价 scale=1，逐克对应）。
 * 返回 null 表示该中间材料无有效克重（展开将按 scale=1 兜底）。
 */
function semiBaseGrams(rec) {
  const rp = (rec && rec.params && typeof rec.params === 'object') ? rec.params : {};
  const batchG = parseFloat(rp['一批出成_g']);
  if (batchG > 0) return batchG;
  let sum = 0;
  for (const [v] of semiCols(rec)) {
    const lines = Array.isArray(v) ? v : (v ? [v] : []);
    for (const line of lines) {
      for (const e of parseBomLine(line)) sum += e.qty_g;
    }
  }
  return sum > 0 ? sum : null;
}

function r4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * 生成单个配方（快照 ext.recipes 行）的成本卡。
 * @param recipe   ext.recipes 行（main/aux/seasoning 已是数组，params 是对象）
 * @param data     快照 data（用 ings / config.ing_alias）
 * @param semiLib  中间材料库（ext.recipes 全量，type='semi' 行会被索引）；缺省时回退 data.semi_recipes
 *
 * W6：BOM 由「配方 → 原料」升级为「配方 →（中间材料 →）原料」递归展开：
 *   - 命中中间材料库（type='semi'）的同名条目 → 按「引用量 / 中间材料一批基准克重」缩放后递归展开；
 *   - 防环：用祖先链（recipe name/sku_id）去重，命中即跳过，不报 missing；
 *   - SKIP_NAMES（料水/清水）仅在「未定义中间材料」时跳过（可选中间材料语义）。
 */
function buildCostCard(recipe, data, semiLib) {
  const ings = Array.isArray(data && data.ings) ? data.ings : [];
  const alias = (data && data.config && typeof data.config === 'object' && data.config.ing_alias) || {};
  const byName = {};
  for (const g of ings) {
    if (g && g.name) byName[String(g.name).trim()] = g;
  }
  const resolve = (bomName) => {
    // 别名回退统一走共享核心 resolveIngName：aliasMap[名] → 去括号名 → ING_ALIAS_FALLBACK → byName 精确名
    return { ing: resolveIngName(bomName, alias, byName) || null };
  };

  const semiIndex = collectSemiIndex(semiLib != null ? semiLib : (data && data.semi_recipes));
  const params = (recipe && recipe.params && typeof recipe.params === 'object') ? recipe.params : {};

  const bomLines = [];
  const missing = [];
  let batchCost = 0;

  /** 递归展开一个 recipe（或中间材料）的 BOM，把原料行累计进 bomLines/batchCost */
  function expand(rec, scale, stack) {
    const key = rec ? String(rec.name || rec.sku_id || '').trim() : '';
    if (key && stack.has(key)) return;   // 防环：该配方已在祖先链上
    if (key) stack.add(key);

    for (const [v, part] of semiCols(rec)) {
      const lines = Array.isArray(v) ? v : (v ? [v] : []);
      for (const line of lines) {
        for (const e of parseBomLine(line)) {
          const qtyScaled = e.qty_g * scale;
          // ① 中间材料引用：优先于 SKIP_NAMES 展开（料水/清水 → 可选中间材料）
          const semi = semiIndex[e.name];
          if (semi) {
            const base = semiBaseGrams(semi);
            const childScale = base > 0 ? qtyScaled / base : 1;
            expand(semi, childScale, stack);
            continue;
          }
          // ② 无中间材料定义 → 沿用旧口径跳过料水/清水
          if (SKIP_NAMES[e.name]) continue;
          const { ing } = resolve(e.name);
          // W4：耗材（type='consumable'）不进菜品成本——误配进 BOM 也不计价、不报 missing
          if (ing && isConsumable(ing)) continue;
          const gpu = ing ? gramsPerUnit(ing) : null;
          const avg = ing ? (parseFloat(ing.avg) || 0) : 0;
          const last = ing ? (parseFloat(ing.last) || 0) : 0;
          const perUnit = avg > 0 ? avg : last; // 均价优先，最近采购价兜底
          const unitPrice = gpu ? perUnit / gpu : null; // 元/克
          // 出成率还原：净料用量 / 出成率 = 毛料消耗（对齐旧版 dishRecipeCost 的 qty/yld）
          const yld = ing && parseFloat(ing.yld) > 0 ? parseFloat(ing.yld) : 1;
          const lineCost = unitPrice != null ? r4((qtyScaled * unitPrice) / yld) : null;
          const matched = !!(ing && unitPrice != null && perUnit > 0);
          if (matched) batchCost += lineCost;
          else if (missing.indexOf(e.name) < 0) missing.push(e.name);
          bomLines.push({
            name: e.name,
            part,
            qty_text: e.raw,
            qty_g: r4(qtyScaled),                  // 配料净重（每批 g，中间材料已按引用量缩放）
            gross_g: r4(qtyScaled / yld),          // 配料毛重 = 净重 ÷ 出成率
            unit: ing && ing.unit ? String(ing.unit) : 'g',
            yld,                                   // 出成率
            waste_pct: r2((1 - yld) * 100),        // 损耗率 %
            price_per_unit: perUnit > 0 ? perUnit : null, // 原料价格（元/库存单位）
            ing: ing ? String(ing.id) : null,
            ing_name: ing ? String(ing.name) : (alias[e.name] || null),
            unit_price: unitPrice != null ? r4(unitPrice * 1000) / 1000 : null, // 元/克，3 位
            line_cost: lineCost,
            matched
          });
        }
      }
    }

    if (key) stack.delete(key);
  }

  expand(recipe, 1, new Set());

  let batchPieces = parseInt(params['一批出成_个'], 10);
  if (!(batchPieces > 0)) batchPieces = 67;
  const unitCost = r4(batchCost / batchPieces);           // 每只
  const portionCost = r2(unitCost * PORTION_PIECES);       // 每份（15 只）

  // 售价：保本价盘（五福饺子/全家福水饺…）
  let bb = null;
  let price = null;
  try {
    const { loadMenuBaoben, findBaobenForRecipe } = require('./menu_baoben');
    const doc = loadMenuBaoben();
    const byBaoben = {};
    for (const it of (doc && doc.items) || []) if (it && it.name) byBaoben[it.name] = it;
    bb = recipe ? findBaobenForRecipe(recipe, byBaoben) : null;
    if (bb && Number(bb.price) > 0) price = Number(bb.price);
  } catch (e) { /* 价盘缺失时 price=null */ }

  const grossMargin = (price != null && price > 0)
    ? Math.round(((price - portionCost) / price) * 1000) / 10
    : null;

  return {
    sku_id: recipe ? recipe.sku_id : null,
    name: recipe ? recipe.name : null,
    bom_lines: bomLines,
    batch_cost: r2(batchCost),
    batch_pieces: batchPieces,
    unit_cost: unitCost,
    portion_pieces: PORTION_PIECES,
    portion_cost: portionCost,
    price,
    gross_margin: grossMargin,
    missing_ings: missing,
    baoben: bb ? {
      name: bb.name, cost: bb.cost, price: bb.price, gross_margin: bb.gross_margin
    } : null,
    note: '份=' + PORTION_PIECES + '只；成本仅计已定价原料（missing_ings 未计）'
  };
}

module.exports = {
  buildCostCard,
  parseBomLine,
  gramsPerUnit,
  isSemi,
  collectSemiIndex,
  semiBaseGrams,
  PORTION_PIECES
};
