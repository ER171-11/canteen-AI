'use strict';
/*
 * shared/recipe-cost/index.mjs — 配方成本口径「唯一事实来源」纯函数核心（前后端共用）
 * 前端（Vite+TS）与后端（Node）共用同一份克重解析 / 别名回退 / 行成本算法。
 * 以 ESM 形式承载逻辑（浏览器可直接执行）；Node 侧由 index.cjs 薄壳 require 转出。
 * 零第三方依赖、零 I/O、无 Node 专属 API。
 */
export const PORTION_PIECES = 15;

export const UNIT_TO_G = { g: 1, 克: 1, kg: 1000, 斤: 500, 两: 50, ml: 1, l: 1000, L: 1000, 升: 1000, '': 1 };

export const ASSUMED_SPEC_G = {
  '雪天精制盐': 500.0,
  '食用墨鱼汁': 90.0,
  '紫薯粉': 100.0,
  '东北酸菜(切丝)': 500.0
};

export const SKIP_NAMES = { 清水: 1, 料水: 1 };

// 通用别名回退（config.ing_alias 之外的硬编码兜底；键=BOM 名，值=ings 实名）
export const ING_ALIAS_FALLBACK = {
  荸荠: '去皮马蹄',
  '五得利雪花粉八星': '五得利雪花面粉'
};

const QTY_RE = /^(.+?)\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z一-鿿%]*)$/;
const PAREN_RE = /[（(][^）)]*[）)]/g;
const SPEC_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|L|升)/;
const SPEC_RE_G = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|L|升)/g;
const INNER_RE = /[（(]([^）)]*[0-9][^）)]*)[）)]/;

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function stripParens(s) { return String(s == null ? '' : s).replace(PAREN_RE, '').trim(); }

/** 去名称尾部规格（1.9L/900g/45g/500ml 等）用于匹配 */
export function stripSpec(name) {
  let s = String(name == null ? '' : name).replace(SPEC_RE_G, '');
  const chars = ' *xX/件瓶包桶罐盒支袋';
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

/** '猪前肩肉500g' → {name, qty, unit}；失败返回 name=原文、qty=0、unit='g' */
function parseQtyText(s) {
  const raw = String(s == null ? '' : s).trim();
  const m = QTY_RE.exec(raw);
  if (!m) return { name: raw, qty: 0, unit: 'g' };
  const qty = parseFloat(m[2]);
  return { name: m[1].trim(), qty: isNaN(qty) ? 0 : qty, unit: (m[3] || 'g').trim() || 'g' };
}

/** 一条 BOM 字符串 → [{name, qty_g, raw}]（料水复合行/顿号并列会展开多条） */
export function parseBomLine(line) {
  const out = [];
  const s = String(line == null ? '' : line).trim();
  if (!s) return out;
  const inner = INNER_RE.exec(s);
  const head = stripParens(s);
  if (inner && inner[1].indexOf('、') >= 0) {
    for (const seg of inner[1].split('、')) {
      const p = parseQtyText(seg);
      if (p.name && p.qty > 0) out.push({ name: p.name, qty_g: p.qty * (UNIT_TO_G[p.unit] != null ? UNIT_TO_G[p.unit] : 1), raw: s });
    }
    return out;
  }
  if (head.indexOf('、') >= 0) {
    const segs = head.split('、').map(parseQtyText);
    if (segs.every((p) => p.qty > 0)) {
      for (const p of segs) out.push({ name: p.name, qty_g: p.qty * (UNIT_TO_G[p.unit] != null ? UNIT_TO_G[p.unit] : 1), raw: s });
      return out;
    }
  }
  const p = parseQtyText(head);
  if (p.name && p.qty > 0) out.push({ name: p.name, qty_g: p.qty * (UNIT_TO_G[p.unit] != null ? UNIT_TO_G[p.unit] : 1), raw: s });
  return out;
}

/** 1 个 ing.unit = 多少克（avg 是 per-unit 价） */
export function gramsPerUnit(ing) {
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
  if (hasOwn(ASSUMED_SPEC_G, name)) return ASSUMED_SPEC_G[name];
  return null;
}

/**
 * 解析 BOM 原料名 → 命中的 ing 对象（未命中返回 null）。
 * 顺序：aliasMap[名] → aliasMap[去括号名] → ING_ALIAS_FALLBACK[名/去括号名] → byName 精确名。
 */
export function resolveIngName(name, aliasMap, byName) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return null;
  const sp = stripParens(n);
  const map = aliasMap && typeof aliasMap === 'object' ? aliasMap : {};
  const by = byName && typeof byName === 'object' ? byName : {};
  let real = null;
  if (hasOwn(map, n)) real = map[n];
  else if (hasOwn(map, sp)) real = map[sp];
  else if (hasOwn(ING_ALIAS_FALLBACK, n)) real = ING_ALIAS_FALLBACK[n];
  else if (hasOwn(ING_ALIAS_FALLBACK, sp)) real = ING_ALIAS_FALLBACK[sp];
  else if (hasOwn(by, n)) real = n;
  if (real != null && hasOwn(by, real)) return by[real];
  return null;
}

/**
 * 维度：重量 / 体积 / 计数。同一维度内可换算，跨维度（重量↔体积）不可自动换算。
 */
export const DIM_OF_UNIT = {
  g: 'weight', 克: 'weight', kg: 'weight', 公斤: 'weight', 斤: 'weight', 两: 'weight',
  ml: 'volume', l: 'volume', L: 'volume', 升: 'volume',
  个: 'count', 只: 'count', 把: 'count', 袋: 'count', 根: 'count', 片: 'count', 枚: 'count', 份: 'count',
};

/** base_unit 取值（g/ml/个）到维度的映射 */
const DIM_OF_BASE = { g: 'weight', ml: 'volume', 个: 'count' };

/** 各维度「1 个单位 = 多少基础单位」：重量以 g、体积以 ml、计数以 1 为基准 */
const UNIT_TO_BASE = {
  weight: { g: 1, 克: 1, kg: 1000, 公斤: 1000, 斤: 500, 两: 50 },
  volume: { ml: 1, l: 1000, L: 1000, 升: 1000 },
  count: { 个: 1, 只: 1, 把: 1, 袋: 1, 根: 1, 片: 1, 枚: 1, 份: 1 },
};

/** 返回「1 个该单位 = 多少基础单位」系数；未知单位返回 null */
export function unitToBase(dim, unit) {
  const t = UNIT_TO_BASE[dim];
  if (!t) return null;
  const v = t[String(unit == null ? '' : unit).trim()];
  return v == null ? null : v;
}

/**
 * 原料的「基础单位信息」：每 1 个库存单位含多少基础单位 + 维度。
 * 优先用结构化字段 pack_in_base（配合 base_unit）；缺失时回退旧 gramsPerUnit（重量口径）。
 * @returns {{dim:'weight'|'volume'|'count', amount:number}|null}
 */
export function ingBaseInfo(ing) {
  const name = String((ing && ing.name) || '');
  if (ing && typeof ing.pack_in_base === 'number' && ing.pack_in_base > 0) {
    let dim = ing.base_unit ? DIM_OF_BASE[ing.base_unit] : null;
    if (!dim) {
      const m = SPEC_RE.exec(name);
      dim = m && (m[2] === 'kg' || m[2] === 'g') ? 'weight' : 'volume';
    }
    return { dim, amount: ing.pack_in_base };
  }
  const g = gramsPerUnit(ing); // 旧逻辑：仅重量口径
  if (g != null) return { dim: 'weight', amount: g };
  return null;
}

/** 每 1 个库存单位含多少基础单位（数值）；无则 null。向后兼容别名。 */
export function packInBase(ing) {
  const info = ingBaseInfo(ing);
  return info ? info.amount : null;
}

/** 原料换算维度（weight/volume/count）；无法确定返回 null */
export function ingDim(ing) {
  const info = ingBaseInfo(ing);
  return info ? info.dim : null;
}

/**
 * 从原料名（SPEC_RE 抠 1.9L/500g）+ unit 推导结构化换算字段，用于旧数据兜底/一次性补全。
 * @returns {{base_unit?:'g'|'ml'|'个', pack_in_base?:number}}
 */
export function inferBaseUnit(ing) {
  const name = String((ing && ing.name) || '');
  const m = SPEC_RE.exec(name);
  if (m) {
    const v = parseFloat(m[1]);
    const u = m[2];
    if (u === 'kg' || u === 'L' || u === 'l' || u === '升') {
      return { base_unit: u === 'kg' ? 'g' : 'ml', pack_in_base: v * 1000 };
    }
    return { base_unit: u === 'g' ? 'g' : 'ml', pack_in_base: v };
  }
  return { base_unit: undefined, pack_in_base: undefined };
}

/**
 * 单行成本。
 * - 不传 unit：旧行为，qty 视为已按原料基础单位（克重口径）填写，{gross, lineCost}。
 * - 传 unit：维度感知路径，qty 按该菜谱单位折算成库存包数 × 均价 ÷ 出成率。
 *   维度不兼容（重量↔体积）或缺失换算系数时返回 {gross, lineCost:null, dimMismatch:true}。
 * @returns {{gross:number, lineCost:number|null, dimMismatch?:boolean}|null} qty≤0 或无 ing 返回 null。
 */
export function calcLineCost(qty, ing, unit) {
  const q = Number(qty);
  if (!(q > 0) || !ing) return null;
  const yld = parseFloat(ing.yld) > 0 ? parseFloat(ing.yld) : 1;
  const avg = parseFloat(ing.avg);
  const base = ingBaseInfo(ing);

  if (unit == null || String(unit).trim() === '') {
    // 旧行为：qty 已是基础单位量（克重口径）
    const gross = q / yld;
    const lineCost = base && base.amount > 0 && avg > 0 ? (gross / base.amount) * avg : null;
    return { gross, lineCost };
  }

  // 新行为：带菜谱单位，维度必须一致
  const u = String(unit).trim();
  const recipeDim = DIM_OF_UNIT[u];
  const dim = base ? base.dim : (ing.base_unit ? DIM_OF_BASE[ing.base_unit] : null);
  if (!recipeDim || !dim || recipeDim !== dim || !base || !(base.amount > 0)) {
    return { gross: q / yld, lineCost: null, dimMismatch: true };
  }
  const perUnit = unitToBase(recipeDim, u); // 1 个菜谱单位 = 多少基础单位
  if (perUnit == null) return { gross: q / yld, lineCost: null, dimMismatch: true };
  const recipeBase = q * perUnit;
  const gross = recipeBase / yld; // 出成率：毛料 = 净料 ÷ 出成率
  const numPacks = gross / base.amount; // 毛料基础量 ÷ 每包基础量 = 包数
  const lineCost = avg > 0 ? numPacks * avg : null;
  return { gross, lineCost, dimMismatch: lineCost == null };
}
