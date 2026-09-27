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

const TYPE_META = [
  { k: '引流', name: '引流款', desc: '低价高频，降低进店门槛' },
  { k: '爆品', name: '爆品（核心）', desc: '招牌与高销，营收主力' },
  { k: '利润', name: '利润款', desc: '高毛利结构款' },
  { k: '形象', name: '形象款', desc: '高档硬菜，拉客单' },
  { k: '常规', name: '常规款', desc: '补齐菜单结构' }
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
 * 店级保本测算汇总（与 HTML calc() 同公式）
 */
function computeBaobenSummary(paramOverrides) {
  const doc = loadMenuBaoben();
  if (!doc || !Array.isArray(doc.items) || !doc.items.length) return null;
  const P = Object.assign({}, DEFAULT_PARAMS, paramOverrides || {});
  const act = doc.items;

  let revDish = 0, costDish = 0, qty = 0;
  for (const d of act) {
    const p = Number(d.price) || 0;
    const c = Number(d.cost) || 0;
    const q = Number(d.daily_qty) || 0;
    revDish += p * q;
    costDish += c * q;
    qty += q;
  }
  const crDish = revDish ? costDish / revDish : 0;
  const crAll = (1 - P.bevRatio) * crDish + P.bevRatio * P.bevCost;
  const varRate = crAll + P.pack + P.takeout * P.comm + P.mkt + P.utilVar + P.misc + P.fee;
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
  const types = TYPE_META.map((t) => {
    const ds = act.filter((d) => d.type === t.k);
    let rev = 0, cost = 0, q = 0;
    for (const d of ds) {
      rev += (Number(d.price) || 0) * (Number(d.daily_qty) || 0);
      cost += (Number(d.cost) || 0) * (Number(d.daily_qty) || 0);
      q += Number(d.daily_qty) || 0;
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
    brand: doc.brand || '熊猫五福餐厅',
    source: doc.source || '保本测算',
    count: act.length,
    params: {
      area: P.area, staff: P.staff, days: P.days, seats: P.seats,
      dish_per_guest: P.dishPerGuest
    },
    kpi: {
      day_rev: r2(revAllDay),
      day_dish_rev: r2(revDish),
      day_cost: r2(costDish),
      dish_cost_rate: r2(crDish * 100),
      all_cost_rate: r2(crAll * 100),
      var_rate: r2(varRate * 100),
      contribution_margin: r2(cm * 100),
      fixed_month: r2(fc),
      be_day: beDay != null ? r2(beDay) : null,
      be_guests: beGuests != null ? r2(beGuests) : null,
      guests: r2(guests),
      avg_ticket: r2(avgAll),
      month_rev: r2(monthRev),
      month_profit: monthProfit != null ? r2(monthProfit) : null,
      safety: safety != null ? r2(safety * 100) : null,
      rent: r2(rent),
      labor: r2(labor),
      amort: r2(amort)
    },
    types,
    scenes,
    advice
  };
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

module.exports = {
  loadMenuBaoben,
  absorbBaoben,
  findBaobenForRecipe,
  computeBaobenSummary,
  mergeDishesWithBaoben,
  DEFAULT_PARAMS
};
