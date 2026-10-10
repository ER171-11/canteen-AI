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
 *   { bom_lines: [{name, qty_text, qty_g, ing, unit_price, line_cost, matched}],
 *     batch_cost, batch_pieces, unit_cost, portion_pieces, portion_cost,
 *     price, gross_margin, missing_ings[], baoben{} }
 * unit_price 为 元/克；line_cost 为该行「每批」成本（元）。
 */

// 与 seed_recipe_links.py 对齐：规格不明的按市售常见规格假定
const ASSUMED_SPEC_G = {
  '雪天精制盐': 500.0,
  '食用墨鱼汁': 90.0,
  '紫薯粉': 100.0,
  '东北酸菜(切丝)': 500.0
};

const SKIP_NAMES = { 清水: 1, 料水: 1 };
const PORTION_PIECES = 15;

const UNIT_TO_G = {
  g: 1, 克: 1, kg: 1000, 斤: 500, 两: 50,
  ml: 1, l: 1000, L: 1000, 升: 1000, '': 1
};

const QTY_RE = /^(.+?)\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z一-鿿%]*)$/;
const PAREN_RE = /[（(][^）)]*[）)]/g;
const SPEC_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|L|升)/;

function stripParens(s) {
  return String(s || '').replace(PAREN_RE, '').trim();
}

function parseQtyText(s) {
  const m = QTY_RE.exec(String(s || '').trim());
  if (!m) return { name: String(s || '').trim(), qty: 0, unit: 'g' };
  const qty = parseFloat(m[2]);
  return {
    name: m[1].trim(),
    qty: isNaN(qty) ? 0 : qty,
    unit: (m[3] || 'g').trim() || 'g'
  };
}

/** 一条 BOM 字符串 → [{name, qty_g, raw}]（料水复合行/顿号并列会展开多条） */
function parseBomLine(line) {
  const out = [];
  const s = String(line || '').trim();
  if (!s) return out;
  const inner = /[（(]([^）)]*[0-9][^）)]*)[）)]/.exec(s);
  const head = stripParens(s);
  if (inner && inner[1].indexOf('、') >= 0) {
    for (const seg of inner[1].split('、')) {
      const p = parseQtyText(seg);
      if (p.name && p.qty > 0) {
        out.push({ name: p.name, qty_g: p.qty * (UNIT_TO_G[p.unit] != null ? UNIT_TO_G[p.unit] : 1), raw: s });
      }
    }
    return out;
  }
  if (head.indexOf('、') >= 0) {
    const segs = head.split('、').map(parseQtyText);
    if (segs.every((p) => p.qty > 0)) {
      for (const p of segs) {
        out.push({ name: p.name, qty_g: p.qty * (UNIT_TO_G[p.unit] != null ? UNIT_TO_G[p.unit] : 1), raw: s });
      }
      return out;
    }
  }
  const p = parseQtyText(head);
  if (p.name && p.qty > 0) {
    out.push({ name: p.name, qty_g: p.qty * (UNIT_TO_G[p.unit] != null ? UNIT_TO_G[p.unit] : 1), raw: s });
  }
  return out;
}

/** 1 个 ing.unit = 多少克（avg 是 per-unit 价） */
function gramsPerUnit(ing) {
  const unit = String((ing && ing.unit) || '').trim();
  const name = String((ing && ing.name) || '');
  if (unit === '斤') return 500;
  if (unit === 'kg' || unit === '公斤') return 1000;
  if (unit === 'g' || unit === '克') return 1;
  const m = SPEC_RE.exec(name);
  if (m) {
    const v = parseFloat(m[1]);
    const u = m[2];
    return v * ((u === 'kg' || u === 'L' || u === 'l' || u === '升') ? 1000 : 1);
  }
  if (ASSUMED_SPEC_G[name] != null) return ASSUMED_SPEC_G[name];
  return null;
}

function r4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * 生成单个配方（快照 ext.recipes 行）的成本卡。
 * @param recipe  ext.recipes 行（main/aux/seasoning 已是数组，params 是对象）
 * @param data    快照 data（用 ings / config.ing_alias）
 */
function buildCostCard(recipe, data) {
  const ings = Array.isArray(data && data.ings) ? data.ings : [];
  const alias = (data && data.config && typeof data.config === 'object' && data.config.ing_alias) || {};
  const byName = {};
  for (const g of ings) {
    if (g && g.name) byName[String(g.name).trim()] = g;
  }
  const resolve = (bomName) => {
    const real = alias[bomName] || alias[stripParens(bomName)] || bomName;
    return { real, ing: byName[String(real).trim()] || null };
  };

  const bomLines = [];
  const missing = [];
  let batchCost = 0;
  const cols = [
    ['face_main', '面皮'], ['main', '主料'], ['aux', '辅料'], ['seasoning', '调味']
  ];
  for (const [col, part] of cols) {
    const v = recipe ? recipe[col] : null;
    const lines = Array.isArray(v) ? v : (v ? [v] : []);
    for (const line of lines) {
      for (const e of parseBomLine(line)) {
        if (SKIP_NAMES[e.name]) continue;
        const { real, ing } = resolve(e.name);
        const gpu = ing ? gramsPerUnit(ing) : null;
        const avg = ing ? (parseFloat(ing.avg) || 0) : 0;
        const last = ing ? (parseFloat(ing.last) || 0) : 0;
        const perUnit = avg > 0 ? avg : last; // 均价优先，最近采购价兜底
        const unitPrice = gpu ? perUnit / gpu : null; // 元/克
        // 出成率还原：净料用量 / 出成率 = 毛料消耗（对齐旧版 dishRecipeCost 的 qty/yld）
        const yld = ing && parseFloat(ing.yld) > 0 ? parseFloat(ing.yld) : 1;
        const lineCost = unitPrice != null ? r4((e.qty_g * unitPrice) / yld) : null;
        const matched = !!(ing && unitPrice != null && perUnit > 0);
        if (matched) batchCost += lineCost;
        else if (missing.indexOf(e.name) < 0) missing.push(e.name);
        bomLines.push({
          name: e.name,
          part,
          qty_text: e.raw,
          qty_g: r4(e.qty_g),
          ing: ing ? String(ing.id) : null,
          ing_name: ing ? String(ing.name) : (alias[e.name] || null),
          unit_price: unitPrice != null ? r4(unitPrice * 1000) / 1000 : null, // 元/克，3 位
          line_cost: lineCost,
          matched
        });
      }
    }
  }

  const params = (recipe && recipe.params && typeof recipe.params === 'object') ? recipe.params : {};
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

module.exports = { buildCostCard, parseBomLine, gramsPerUnit, PORTION_PIECES };
