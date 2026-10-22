'use strict';
/*
 * 熊猫五福餐厅菜品保本测算 → 结构化 JSON
 * 来源：熊猫五福餐厅菜品保本测算(3).html  RAW = [类型,名称,食材成本,售价,日销量]
 */
const fs = require('fs');
const path = require('path');

const PATHS = [
  path.join(__dirname, '../data/menu-baoben.json'),
  path.join(__dirname, '../../old/apps/boss-app/public/menu-baoben.json')
];

let _cache = null;
let _mtime = 0;

function loadMenuBaoben() {
  for (const p of PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (_cache && st.mtimeMs === _mtime && _cache.__path === p) return _cache;
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      _cache = doc;
      _cache.__path = p;
      _mtime = st.mtimeMs;
      return _cache;
    } catch (e) { /* next */ }
  }
  return null;
}

/** 金丰配方名 / sku → 保本测算菜名 */
const RECIPE_TO_BAOBEN = [
  { test: (r) => ['红', '黄', '绿', '紫', '黑'].indexOf(String(r.color || '')) >= 0, name: '五福饺子' },
  { test: (r) => String(r.color) === '白' || String(r.menu_cat) === 'jiao_white', name: '全家福水饺' },
  { test: (r) => String(r.menu_cat) === 'jian' || String(r.name || '').indexOf('煎饺') >= 0, name: '冰花煎饺' },
  { test: (r) => String(r.menu_cat) === 'zheng' || String(r.name || '').indexOf('蒸饺') >= 0, name: '海胆蒸饺' },
  { test: (r) => String(r.name || '').indexOf('墨') >= 0, name: '墨云水饺' }
];

function baobenByName(doc) {
  const m = {};
  for (const it of (doc && doc.items) || []) {
    if (it && it.name) m[it.name] = it;
  }
  return m;
}

function findBaobenForRecipe(r, byName) {
  for (const rule of RECIPE_TO_BAOBEN) {
    if (rule.test(r) && byName[rule.name]) return byName[rule.name];
  }
  const n = String(r.name || '');
  if (byName[n]) return byName[n];
  // 模糊：保本名出现在配方名中
  for (const [bn, it] of Object.entries(byName)) {
    if (n.indexOf(bn) >= 0 || bn.indexOf(n.replace(/御字牌|五福饺子|[（(].*[）)]/g, '')) >= 0) {
      return it;
    }
  }
  return null;
}

function attachBaobenFields(target, bb) {
  if (!bb) return target;
  const params = Object.assign({}, target.params || {});
  params['保本_食材成本'] = bb.cost;
  params['保本_售价'] = bb.price;
  params['保本_日销量'] = bb.daily_qty;
  params['保本_成本率'] = bb.cost_rate;
  params['保本_毛利率'] = bb.gross_margin;
  params['保本_类型'] = bb.type;
  return Object.assign({}, target, {
    cost: bb.cost,
    price: bb.price,
    cost_rate: bb.cost_rate,
    gross_margin: bb.gross_margin,
    daily_qty: bb.daily_qty,
    dish_type: bb.type,
    baoben_id: bb.id,
    params,
    subtitle: target.subtitle ||
      (`${bb.type} · 成本¥${bb.cost} · 售¥${bb.price} · 毛利${bb.gross_margin}%`)
  });
}

/**
 * 把保本测算并入厨房菜单列表：
 * 1) 已有金丰配方 → 挂上成本/售价/毛利
 * 2) 保本表其余菜品 → 作为后厨菜单项（可看成本结构，无 BOM 则提示）
 */
function absorbBaoben(recipeItems) {
  const doc = loadMenuBaoben();
  if (!doc || !Array.isArray(doc.items) || !doc.items.length) {
    return {
      items: recipeItems || [],
      baoben: null,
      source: 'no-baoben'
    };
  }
  const byName = baobenByName(doc);
  const used = new Set();
  const out = [];

  for (const r of recipeItems || []) {
    if (!r) continue;
    const bb = findBaobenForRecipe(r, byName);
    if (bb) used.add(bb.name);
    out.push(attachBaobenFields(r, bb));
  }

  for (const bb of doc.items) {
    if (!bb || used.has(bb.name)) continue;
    // 已作为金丰细项吸收的「五福饺子」本身不再重复一条（细项已挂价）
    // 但「全家福水饺」等独立品名仍可出现；若仅被映射占用则 skip
    out.push({
      sku_id: bb.id,
      name: bb.name,
      color: bb.type,
      filling: null,
      face_main: null,
      main: [],
      aux: [],
      seasoning: [],
      steps: [],
      params: {
        保本_食材成本: bb.cost,
        保本_售价: bb.price,
        保本_日销量: bb.daily_qty,
        保本_成本率: bb.cost_rate,
        保本_毛利率: bb.gross_margin,
        保本_类型: bb.type,
        标准: '保本测算'
      },
      blessing: null,
      diet_tags: [bb.type],
      menu_cat: bb.type, // 引流/爆品/利润/形象/常规
      menu_id: bb.id,
      subtitle: `${bb.type} · 成本¥${bb.cost} · 售¥${bb.price} · 毛利${bb.gross_margin}%`,
      face_detail: null,
      brief: `保本测算：日销约 ${bb.daily_qty} · 日毛利 ¥${bb.daily_gross}`,
      cost: bb.cost,
      price: bb.price,
      cost_rate: bb.cost_rate,
      gross_margin: bb.gross_margin,
      daily_qty: bb.daily_qty,
      dish_type: bb.type,
      baoben_id: bb.id,
      version: 'baoben',
      source: 'baoben'
    });
  }

  return {
    items: out,
    baoben: { brand: doc.brand, count: doc.count, types: doc.types, source: doc.source },
    source: 'baoben'
  };
}

/** 默认店参：对齐保本测算 HTML PFIX/PVAR/POP */
const DEFAULT_PARAMS = {
  area: 400, rentPsm: 75, propFee: 4,
  staff: 20, laborPer: 6355,
  fit: 800000, fitM: 60, eq: 500000, eqM: 60,
  utilFix: 6000, other: 6500,
  bevRatio: 0.15, bevCost: 0.40,
  pack: 0.012, takeout: 0.15, comm: 0.21, mkt: 0.025,
  utilVar: 0.015, misc: 0.01, fee: 0.006,
  dishPerGuest: 1.65, days: 30, seats: 120, targetProfit: 80000
};

/**
 * query 参数名 → DEFAULT_PARAMS 键（单一事实来源：
 * `/api/modules/analysis` 的店参透传与 `echoParams()` 回显共用同一张表，
 * 避免「能传不能看」或「能看不能传」的两头对不上）
 */
const PARAM_QUERY_MAP = {
  area: 'area', rent_psm: 'rentPsm', prop_fee: 'propFee',
  staff: 'staff', labor_per: 'laborPer',
  fit: 'fit', fit_m: 'fitM', eq: 'eq', eq_m: 'eqM',
  util_fix: 'utilFix', other: 'other',
  bev_ratio: 'bevRatio', bev_cost: 'bevCost',
  pack: 'pack', takeout: 'takeout', comm: 'comm', mkt: 'mkt',
  util_var: 'utilVar', misc: 'misc', fee: 'fee',
  dish_per_guest: 'dishPerGuest', days: 'days', seats: 'seats',
  target_profit: 'targetProfit'
};

/** 生效店参回显：键名与 query 同名，前端可直接回填表单 */
function echoParams(P) {
  const out = {};
  for (const q of Object.keys(PARAM_QUERY_MAP)) out[q] = P[PARAM_QUERY_MAP[q]];
  return out;
}

/** 五类角色：键/名/描述逐字照抄旧版 `CT`（HTML:3810-3816），供「五类角色卡片」展示（FP-CALC-14） */
const TYPE_META = [
  { k: '引流', name: '引流款', desc: '低价高频，降低进店门槛、提升点单率，毛利中等但拉客流' },
  { k: '爆品', name: '爆品（核心）', desc: '招牌与高销菜品，营收主力，决定翻台与复购' },
  { k: '利润', name: '利润款', desc: '高毛利菜品，靠结构与出品溢价贡献利润' },
  { k: '形象', name: '形象款', desc: '高档硬菜，树品牌与拉高客单，销量低但拉高客单价' },
  { k: '常规', name: '常规款', desc: '补齐菜单结构，满足多样化点单需求' }
];

const SCENES = [
  { n: '爬坡期(1-3月)', k: 0.55 },
  { n: '培育期(4-6月)', k: 0.75 },
  { n: '当前设定', k: 1.00 },
  { n: '稳定期(7-12月)', k: 1.15 },
  { n: '成熟期(次年起)', k: 1.30 }
];

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * 量本利核心（与旧版 `calcModel()` HTML:3923 同公式）
 *
 * 单一事实来源：基线汇总 `computeBaobenSummary()` 与只读推演 `simulateBaoben()` 共用，
 * 避免出现「前端第二份公式」的漂移（见 ADR-007 §2.3）。
 * @param {Array<{price:number,cost:number,qty:number,type:string}>} act 参与测算的行（调用方负责滤掉未上架）
 * @param {Object} P 生效店参
 */
function computeModel(act, P) {
  const rows = Array.isArray(act) ? act : [];
  let revDish = 0, costDish = 0, qty = 0;
  for (const d of rows) {
    const p = Number(d.price) || 0;
    const c = Number(d.cost) || 0;
    const q = Number(d.qty) || 0;
    revDish += p * q;
    costDish += c * q;
    qty += q;
  }
  const crDish = revDish ? costDish / revDish : 0;
  const crAll = (1 - P.bevRatio) * crDish + P.bevRatio * P.bevCost;
  const varRate = crAll + P.pack + P.takeout * P.comm + P.mkt + P.utilVar + P.misc + P.fee;
  const varOtherRate = varRate - crAll;
  const cm = 1 - varRate;
  const rent = P.area * P.rentPsm;
  const prop = P.area * P.propFee;
  const labor = P.staff * P.laborPer;
  const amort = P.fit / P.fitM + P.eq / P.eqM;
  const fc = rent + prop + labor + amort + P.utilFix + P.other;
  const beDay = cm > 0 ? fc / cm / P.days : null;
  const guests = P.dishPerGuest ? qty / P.dishPerGuest : 0;
  const avgDish = guests ? revDish / guests : 0;
  const avgAll = avgDish * (1 + P.bevRatio);
  const revAllDay = revDish * (1 + P.bevRatio);
  const monthRev = revAllDay * P.days;
  const monthProfit = beDay != null ? (monthRev - beDay * P.days) * cm : null;
  const beGuests = avgAll && beDay != null ? beDay / avgAll : null;
  const safety = revAllDay && beDay != null ? (revAllDay - beDay) / revAllDay : null;

  const totRev = revDish || 1;
  const totGp = Math.max(revDish - costDish, 1);
  // 五类角色卡片「销量占比」分母：参与测算的日销量合计（旧版 `renderCalcTypes` 的 totQ，HTML:3981）
  const totQ = qty || 1;
  const types = TYPE_META.map((t) => {
    const ds = rows.filter((d) => d.type === t.k);
    let rev = 0, cost = 0, q = 0;
    for (const d of ds) {
      rev += (Number(d.price) || 0) * (Number(d.qty) || 0);
      cost += (Number(d.cost) || 0) * (Number(d.qty) || 0);
      q += Number(d.qty) || 0;
    }
    const gp = rev - cost;
    return {
      k: t.k,
      name: t.name,
      desc: t.desc,
      n: ds.length,
      qty: r2(q),
      rev: r2(rev),
      cost: r2(cost),
      gp: r2(gp),
      cost_rate: rev ? r2((cost / rev) * 100) : 0,
      qty_share: r2((q / totQ) * 100),
      rev_share: r2((rev / totRev) * 100),
      gp_share: r2((gp / totGp) * 100)
    };
  });

  const scenes = SCENES.map((s) => {
    const dayRev = revAllDay * s.k;
    const profit = beDay != null ? (dayRev - beDay) * cm * P.days : null;
    return {
      name: s.n,
      k: s.k,
      day_rev: r2(dayRev),
      // 与旧版分情景表同列（HTML:4153-4157）：日客流 = 基准客流 × 系数，月营收 = 日营收 × 月营业天数
      guests: r2(guests * s.k),
      month_rev: r2(dayRev * P.days),
      month_profit: profit != null ? r2(profit) : null,
      above_be: beDay != null ? dayRev >= beDay : null
    };
  });

  const advice = [];
  if (beDay != null) {
    advice.push(
      monthProfit != null && monthProfit >= 0
        ? `日保本 ¥${Math.round(beDay)}，当前设定月利润约 ¥${Math.round(monthProfit)}`
        : `日保本 ¥${Math.round(beDay)}，当前设定下月亏约 ¥${Math.round(Math.abs(monthProfit || 0))}，需提价/提量或压固定成本`
    );
  }
  const star = types.find((t) => t.k === '爆品');
  if (star) {
    advice.push(`爆品 ${star.n} 道贡献营收 ${star.rev_share}%、毛利 ${star.gp_share}%，是保本主力`);
  }

  return {
    act: rows,
    revDish, costDish, qty, crDish, crAll, varRate, varOtherRate, cm,
    rent, prop, labor, amort, fc, beDay, guests, avgDish, avgAll,
    revAllDay, monthRev, monthProfit, beGuests, safety,
    types, scenes, advice
  };
}

/** KPI 子对象（基线与推演同形；逐字段沿用阶段 8/9 已验收输出，不得增删） */
function kpiOf(M, P) {
  return {
    day_rev: r2(M.revAllDay),
    day_dish_rev: r2(M.revDish),
    day_cost: r2(M.costDish),
    dish_cost_rate: r2(M.crDish * 100),
    all_cost_rate: r2(M.crAll * 100),
    var_rate: r2(M.varRate * 100),
    contribution_margin: r2(M.cm * 100),
    fixed_month: r2(M.fc),
    be_day: M.beDay != null ? r2(M.beDay) : null,
    be_guests: M.beGuests != null ? r2(M.beGuests) : null,
    guests: r2(M.guests),
    avg_ticket: r2(M.avgAll),
    month_rev: r2(M.monthRev),
    month_profit: M.monthProfit != null ? r2(M.monthProfit) : null,
    safety: M.safety != null ? r2(M.safety * 100) : null,
    rent: r2(M.rent),
    labor: r2(M.labor),
    amort: r2(M.amort),
    // 以下为成本结构图（旧版 #costChart :4118-4122）所需明细，均为既有公式的月额，无新增算法
    prop: r2(M.prop),
    util_fix: r2(P.utilFix),
    other: r2(P.other),
    /** 食材+酒水成本（月） */
    cost_bev_month: r2(M.crAll * M.monthRev),
    /** 其他变动成本（月）= 月营收 ×（变动成本率 − 综合食材成本率） */
    var_other_month: r2(M.monthRev * M.varOtherRate),
    /** 日均点菜份数（旧版 #vQty :3970） */
    dish_qty: r2(M.qty)
  };
}

/**
 * 店级保本测算汇总（与 HTML calc() 同公式）
 * 基线口径 = **保本价盘整表**（`menu-baoben.json` items）；模拟态改用逐菜表行集，见 ADR-007 §2.4
 */
function computeBaobenSummary(paramOverrides) {
  const doc = loadMenuBaoben();
  if (!doc || !Array.isArray(doc.items) || !doc.items.length) return null;
  const P = Object.assign({}, DEFAULT_PARAMS, paramOverrides || {});
  const act = doc.items.map((d) => ({
    price: d.price,
    cost: d.cost,
    qty: d.daily_qty,
    type: d.type
  }));
  const M = computeModel(act, P);

  return {
    brand: doc.brand || '熊猫五福餐厅',
    source: doc.source || '保本测算',
    count: act.length,
    // 全量生效店参回显（键名同 query，前端可回填表单；旧版此处只回显 5 项 → 见基线 FP-CALC-04/06）
    params: echoParams(P),
    kpi: kpiOf(M, P),
    types: M.types,
    scenes: M.scenes,
    advice: M.advice
  };
}

/* ---- P2-13 日销量口径（只读，只影响测算行，绝不写回菜品主数据 daily_qty）---- */

/** 口径枚举与标签，逐字照抄旧版 `SC_QMODES`（HTML:3852） */
const QMODE_LABELS = {
  est: '估算 q（菜品主数据）',
  real30: '近30天真实（日均）',
  real7: '近7天真实（日均）'
};
/** 默认口径：照抄旧版 `SC_QMODE='real30'`（HTML:3853）；无销量是否回落估算：照抄 `SC_QFALLBACK=true` */
const DEFAULT_QMODE = 'real30';
const DEFAULT_QFALLBACK = true;

/** 口径天数（旧版 `scQDays()` HTML:3854） */
function scQDays(qmode) {
  return qmode === 'real7' ? 7 : 30;
}

/** 归一化口径名（非法值回默认，不抛错） */
function normQmode(qmode) {
  return Object.prototype.hasOwnProperty.call(QMODE_LABELS, qmode) ? qmode : DEFAULT_QMODE;
}

/** 本地时区「今天 - k 天」= YYYY-MM-DD（旧版 `daysAgo()`） */
function daysAgo(k) {
  const d = new Date(Date.now() - k * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 销售记录日期串（与 modules.js `salesTs()` 同序：ts → time → date → …） */
function salesDate(r) {
  return String((r && (r.ts || r.time || r.date || r.created_at || r.datetime)) || '');
}

/**
 * 近 N 天逐菜真实销量总份数（口径同菜品配方页/经营分析 `realAnalysis` 的近 7 日聚合，见旧版
 * `dishRealQty()` HTML:3856 注释「取数同菜品配方页」）：
 * 1) 优先 `lines[].dish`（已是菜品 id）；
 * 2) 无 lines 时用 `r.dish`（短名）经 `dishAlias` / 菜名精确匹配回菜品 id。
 * @returns {Object} dishId -> 份数
 */
function dishRealQty(sales, daysN, opt) {
  const o = opt || {};
  const alias = (o.alias && typeof o.alias === 'object') ? o.alias : {};
  const byName = o.byName || {};
  const from = daysAgo(Math.max(1, daysN) - 1);
  const cleanKey = (s) => String(s == null ? '' : s)
    .replace(/^[　 *＊·・]+/, '').replace(/[　 *＊]+$/, '').trim();
  const m = Object.create(null);
  for (const r of sales || []) {
    if (!r) continue;
    const dt = salesDate(r).match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dt || dt[1] < from) continue;
    const add = (dishId, q) => {
      if (!dishId || !(q > 0)) return;
      m[dishId] = (m[dishId] || 0) + q;
    };
    if (Array.isArray(r.lines) && r.lines.length) {
      for (const l of r.lines) add(String(l && l.dish), Number(l && l.qty) || 0);
      continue;
    }
    const nm = String(r.dish || '');
    const a = alias[cleanKey(nm)];
    const byNm = byName[nm];
    const dishId = (a && a.dish) || (byNm && byNm.id) || null;
    add(dishId ? String(dishId) : null, Number(r.qty) || 0);
  }
  return m;
}

/**
 * 取某菜日销量（旧版 `calcQtyOf()` HTML:3863）：
 * 估算口径 = 原值；真实口径 = 近 N 天总份数 ÷ N；真实口径下无销量时按兜底回落估算值或按 0 计。
 * @returns {{qty:number, src:'est'|'real'}}
 */
function calcQtyOf(est, sq, qmode, qfallback, daysN) {
  const e = r2(Number(est) || 0);
  if (qmode === 'est') return { qty: e, src: 'est' };
  const tot = Number(sq) || 0;
  if (tot > 0) return { qty: r2(tot / daysN), src: 'real' };
  return { qty: qfallback ? e : 0, src: 'est' };
}

/**
 * 逐菜结构表行（对齐旧版 `syncCalc()` HTML:3870：由菜品主数据 `filter(d=>d.on)` 派生，只读、绝不写回）
 * 成本/售价沿用合并口径（店内为准，缺失回落保本价盘）
 * 「日销量」按旧版 P2-13 口径三选一（估算 / 近30天真实日均 / 近7天真实日均），默认 `real30`
 * @param {Array} mergedDishes mergeDishesWithBaoben(...).dishes
 * @param {{qmode?:string, qfallback?:boolean, sales?:Array, alias?:Object, byName?:Object}} [opts]
 */
function toCalcRows(mergedDishes, opts) {
  const o = opts || {};
  const qmode = normQmode(o.qmode);
  const qfallback = o.qfallback !== false;
  const daysN = scQDays(qmode);
  const vol = qmode === 'est' ? null
    : dishRealQty(o.sales, daysN, { alias: o.alias, byName: o.byName });
  const out = [];
  for (const d of mergedDishes || []) {
    if (!d || d.on === false) continue;
    const nm = String(d.name == null ? '' : d.name).trim();
    if (!nm) continue;
    const estRaw = d.daily_qty != null ? Number(d.daily_qty) : (d.q != null ? Number(d.q) : 0);
    const est = isFinite(estRaw) ? estRaw : 0;
    const sq = vol ? (vol[String(d.id)] || 0) : 0;
    const pick = calcQtyOf(est, sq, qmode, qfallback, daysN);
    const cost = d.cost != null && isFinite(Number(d.cost)) ? Number(d.cost) : null;
    const price = d.price != null && isFinite(Number(d.price)) ? Number(d.price) : null;
    out.push({
      // 菜品 id：下架建议按 id 定位（旧版 `d.id`）；无 id 时回落菜名，保证行唯一
      id: d.id != null ? String(d.id) : nm,
      name: nm,
      // 类型取价盘类型 `dish_type` 优先（旧版用 `d.cat`；本店 9 个 SKU-WF-* 占位菜 `cat` 存的是饺子皮颜色）
      cat: d.dish_type || d.cat || '常规',
      cost: cost != null ? r2(cost) : null,
      price: price != null ? r2(price) : null,
      qty: pick.qty,
      // est：菜品主数据估算日销（旧版 `est`）；sq：近 N 天真实总份数（旧版 `sq`，估算口径恒 0）
      est: r2(est),
      sq: r2(sq),
      src: pick.src,
      on: true
    });
  }
  return out;
}

/** 快照 dishes 与保本价盘合并：有同名则挂 cat/price/cost；无 dishes 则整表生成 */
function mergeDishesWithBaoben(dishes) {
  const doc = loadMenuBaoben();
  if (!doc || !doc.items || !doc.items.length) {
    return { dishes: Array.isArray(dishes) ? dishes : [], source: 'no-baoben' };
  }
  const byName = baobenByName(doc);
  const used = new Set();
  const out = [];

  for (const d of dishes || []) {
    if (!d) continue;
    const name = String(d.name || '');
    let bb = byName[name] || null;
    if (!bb) {
      for (const [bn, it] of Object.entries(byName)) {
        if (name.indexOf(bn) >= 0 || bn.indexOf(name) >= 0) { bb = it; break; }
      }
    }
    if (bb) used.add(bb.name);
    const gm = bb
      ? (Number(bb.gross_margin) || 0) / 100
      : (typeof d.gross_margin === 'number' ? d.gross_margin : null);
    out.push(Object.assign({}, d, {
      id: d.id || (bb && bb.id) || name,
      name: d.name || (bb && bb.name),
      // 分类可挂保本类型；售价/成本以店内为准（调价落库后不被价盘盖掉）
      // price=0 视为占位未定价（如 SKU-WF-* 占位菜品），回落保本价
      cat: d.cat || (bb && bb.type) || '常规',
      price: (d.price != null && Number(d.price) > 0) ? d.price : (bb ? bb.price : null),
      cost: d.cost != null ? d.cost : (bb ? bb.cost : null),
      // est：店内成本估优先；勿用保本日销量覆盖
      est: d.est != null ? d.est : (bb ? bb.cost : null),
      daily_qty: (bb && bb.daily_qty) != null ? bb.daily_qty : d.daily_qty,
      baoben_price: bb ? bb.price : d.baoben_price,
      gross_margin: gm,
      margin: gm,
      on: d.on !== false,
      dish_type: d.dish_type || (bb && bb.type) || null,
      baoben_id: bb ? bb.id : d.baoben_id
    }));
  }

  for (const bb of doc.items) {
    if (!bb || used.has(bb.name)) continue;
    const gm = (Number(bb.gross_margin) || 0) / 100;
    out.push({
      id: bb.id,
      name: bb.name,
      cat: bb.type,
      price: bb.price,
      cost: bb.cost,
      est: bb.daily_qty,
      q: 0,
      gross_margin: gm,
      margin: gm,
      on: true,
      dish_type: bb.type,
      baoben_id: bb.id
    });
  }

  return { dishes: out, source: 'baoben', count: out.length };
}

/**
 * 应用「模拟态」行覆盖；一律生成**新对象**，绝不 mutate 传入行（ADR-007 §2.2）
 * @param {Array} rows `toCalcRows()` 产出的基线行
 * @param {Object} ov `{ 菜名|菜品id: {c?, p?, q?, on?} }`
 */
function applyRowOverrides(rows, ov) {
  const list = Array.isArray(rows) ? rows : [];
  if (!ov || typeof ov !== 'object') return list.map((r) => Object.assign({}, r));
  return list.map((r) => {
    const x = (r.name != null && ov[r.name]) || (r.id != null && ov[r.id]) || null;
    const out = Object.assign({}, r);
    if (!x || typeof x !== 'object') return out;
    if (x.c != null && isFinite(Number(x.c))) out.cost = r2(Number(x.c));
    if (x.p != null && isFinite(Number(x.p))) out.price = r2(Number(x.p));
    if (x.q != null && isFinite(Number(x.q))) out.qty = r2(Number(x.q));
    if (typeof x.on === 'boolean') out.on = x.on;
    return out;
  });
}

/**
 * 结构测算「模拟态」只读推演（见 ADR-007）
 *
 * 零写库：只读快照数据 + 纯计算，不 `saveDB` / 不写 `data/*.json` / 不 `postAction` / 不入 `actions_queue.json`。
 * 基准行集 = **逐菜表行集**（本店在售菜品），忠实旧版 `calcModel()` 的 `SD` 口径（ADR-007 §2.4）。
 * @param {{dishes?:Array, sales?:Array, alias?:Object, params?:Object, rows?:Object,
 *          qmode?:string, qfallback?:boolean, rev?:string}} opts
 */
function simulateBaoben(opts) {
  const o = opts || {};
  const P = Object.assign({}, DEFAULT_PARAMS, o.params || {});
  const qmode = normQmode(o.qmode);
  const qfallback = o.qfallback !== false;
  const daysN = scQDays(qmode);
  const sales = Array.isArray(o.sales) ? o.sales : [];
  // 行集对齐旧版 syncCalc()：仅店内菜品主数据（保本价盘独有项不进食结构表）
  const shopNames = new Set();
  const byName = {};
  for (const d of o.dishes || []) {
    if (!d || d.name == null) continue;
    shopNames.add(String(d.name));
    if (byName[String(d.name)] == null) byName[String(d.name)] = d;
  }
  const merged = mergeDishesWithBaoben(o.dishes);
  const base = toCalcRows(
    merged.dishes.filter((d) => d && shopNames.has(String(d.name || ''))),
    { qmode, qfallback, sales, alias: o.alias, byName }
  );
  const rows = applyRowOverrides(base, o.rows);
  const act = rows
    .filter((r) => r.on !== false)
    .map((r) => ({ price: r.price, cost: r.cost, qty: r.qty, type: r.cat }));
  const M = computeModel(act, P);

  let nReal = 0;
  for (const r of rows) if (r.src === 'real') nReal += 1;

  return {
    rev: o.rev != null ? String(o.rev) : null,
    /** 基准行集标识：本店在售菜品（旧版 `SD` 口径；基线汇总走保本价盘，见 ADR-007 §2.4） */
    basis: 'shop_dishes',
    qmode,
    qfallback,
    qdays: daysN,
    params: echoParams(P),
    kpi: kpiOf(M, P),
    types: M.types,
    scenes: M.scenes,
    advice: M.advice,
    calc_dishes: rows,
    /** 口径提示用计数（旧版 `calcStatText()` HTML:3879） */
    qstat: {
      n_total: rows.length,
      n_active: act.length,
      n_real: nReal,
      n_fallback: rows.length - nReal
    }
  };
}

module.exports = {
  loadMenuBaoben,
  absorbBaoben,
  findBaobenForRecipe,
  computeBaobenSummary,
  computeModel,
  kpiOf,
  mergeDishesWithBaoben,
  toCalcRows,
  applyRowOverrides,
  simulateBaoben,
  dishRealQty,
  calcQtyOf,
  scQDays,
  daysAgo,
  salesDate,
  QMODE_LABELS,
  DEFAULT_QMODE,
  DEFAULT_QFALLBACK,
  DEFAULT_PARAMS,
  PARAM_QUERY_MAP
};
