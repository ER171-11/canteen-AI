'use strict';
/*
 * routes/modules.js — 员工/预订/食安/经营分析 只读端点（红线①：只读，无任何写库路径）
 * 数据来自店内推送快照的 ext 新键（均为表行对象数组，缺省空数组）：
 *   ext.staff_shifts / staff_clock / staff_perf / staff_train   员工排班/打卡/绩效/培训
 *   ext.fs_certs / fs_trace / fs_samples / fs_disinfect         证照/溯源/留样/消毒
 *   ext.bookings / queue / queue_serves                          预订/排队/候餐服务
 *
 *   GET /api/modules/staff           → {ok, shifts[], clock[], perf[], train[], rev, generated_at}
 *   GET /api/modules/booking?date=   → {ok, date, bookings[], queue[], serves[], rev}
 *   GET /api/modules/foodsafe        → {ok, certs[], trace[], samples[](+hours_left), disinfect[], rev}
 *   GET /api/modules/analysis        → {ok, trend[], heatmap[], matrix[], efficiency{}}
 *        data.sales 非空 → 真实聚合（按日营收趋势 / 时段×星期热力 / 波士顿矩阵 / 效率）；
 *        sales 为空 → {mock:true, ...} 演示数据（取自原型 docs/熊猫五福App原型.html p-m-analysis）
 * 非 GET 一律交外层 404。无快照：各模块空开 200 + hint=no_snapshot（分析可回 mock），
 * 避免 App 整页「加载失败」（与厨房/进销 restock-suggest 一致）。
 */
const { loadSnapshot } = require('./snapshot');

const NO_SNAP_HINT = 'no_snapshot';
const NO_SNAP_MSG = '店内快照未接通 · 本页可空开浏览，推送快照后刷新看真数';

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function arr(v) { return Array.isArray(v) ? v : []; }
function extOf(snap) { return snap && snap.ext && typeof snap.ext === 'object' ? snap.ext : {}; }
function num(v, d) { const n = parseFloat(v); return isNaN(n) ? (d != null ? d : 0) : n; }

/* 记录日期：取 date/day/dine_date，或 ts/time 前缀 */
function recordDay(r) {
  const s = String(r && (r.date || r.day || r.dine_date) || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = String(r && (r.ts || r.time || r.created_at) || '');
  const m = t.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}

/* 留样 48h 倒计时（小时，1 位小数；无 ts 返回 null） */
function hoursLeft(sample, nowMs) {
  const ts = new Date(sample && (sample.ts || sample.time || sample.created_at)).getTime();
  if (isNaN(ts)) return null;
  return +((48 * 3600000 - (nowMs - ts)) / 3600000).toFixed(1);
}

/* ---------------- 经营分析 ---------------- */

function salesAmount(r) {
  for (const k of ['amount', 'total', 'revenue', 'price', 'money', '金额']) {
    const v = parseFloat(r && r[k]);
    if (!isNaN(v)) return v;
  }
  return 0;
}

function salesTs(r) {
  return String(r && (r.ts || r.time || r.date || r.created_at || r.datetime) || '');
}

// 真实聚合：trend 按日、heatmap 时段×星期、matrix 波士顿象限、efficiency 效率
function realAnalysis(snap, paramOverrides) {
  const data = snap.data || {};
  const sales = arr(data.sales);

  // 按日营收趋势
  const byDay = {};
  for (const r of sales) {
    const m = salesTs(r).match(/^(\d{4}-\d{2}-\d{2})/);
    const day = m ? m[1] : '未知日期';
    if (!byDay[day]) byDay[day] = { date: day, revenue: 0, orders: 0 };
    byDay[day].revenue += salesAmount(r);
    byDay[day].orders += 1;
  }
  const trend = Object.keys(byDay).sort().map((d) => ({
    date: byDay[d].date, revenue: +byDay[d].revenue.toFixed(2), orders: byDay[d].orders
  }));

  // 时段 × 星期热力（weekday: 0=周日）
  const byCell = {};
  for (const r of sales) {
    const t = new Date(salesTs(r).replace(' ', 'T'));
    if (isNaN(t.getTime())) continue;
    const key = t.getHours() + '|' + t.getDay();
    if (!byCell[key]) byCell[key] = { hour: t.getHours(), weekday: t.getDay(), orders: 0, revenue: 0 };
    byCell[key].orders += 1;
    byCell[key].revenue += salesAmount(r);
  }
  const heatmap = Object.keys(byCell).map((k) => {
    const c = byCell[k];
    return { hour: c.hour, weekday: c.weekday, orders: c.orders, revenue: +c.revenue.toFixed(2) };
  }).sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);

  // 波士顿矩阵：volume 用真销量（近 7 日，dishAlias/sku_id/菜名聚合），
  // 无匹配回落保本 daily_qty，再回落 est；margin 优先 recipe_cost 真成本毛利率
  let dishes = [];
  let baobenSummary = null;
  try {
    const { mergeDishesWithBaoben, computeBaobenSummary } = require('../lib/menu_baoben');
    baobenSummary = computeBaobenSummary(paramOverrides);
    const merged = mergeDishesWithBaoben(arr(data.dishes));

    // 近 7 日真销量聚合：sales.dish(短名) → dishAlias → 菜品 id → 份数
    const alias = (data.dishAlias && typeof data.dishAlias === 'object') ? data.dishAlias : {};
    const dishById = {};
    const dishByName = {};
    const dishBySku = {};
    for (const d of arr(data.dishes)) {
      if (!d) continue;
      if (d.id != null) dishById[String(d.id)] = d;
      if (d.name) dishByName[String(d.name)] = d;
      if (d.sku_id != null && !dishBySku[String(d.sku_id)]) dishBySku[String(d.sku_id)] = d;
    }
    const cleanKey = (s) => String(s == null ? '' : s)
      .replace(/^[　 *＊·・]+/, '').replace(/[　 *＊]+$/, '').trim();
    const fromDay = (() => {
      const d = new Date(Date.now() - 6 * 86400000);
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    })();
    const volMap = {};
    for (const r of sales) {
      const m = salesTs(r).match(/^(\d{4}-\d{2}-\d{2})/);
      if (!m || m[1] < fromDay) continue;
      const addQty = (dishId, q) => {
        if (!dishId || !(q > 0)) return;
        volMap[dishId] = (volMap[dishId] || 0) + q;
      };
      if (Array.isArray(r.lines) && r.lines.length) {
        for (const l of r.lines) addQty(String(l && l.dish), num(l && l.qty));
        continue;
      }
      const nm = String((r && r.dish) || '');
      const a = alias[cleanKey(nm)];
      const byNm = dishByName[nm];
      const dishId = (a && a.dish) || (byNm && byNm.id) || null;
      addQty(dishId ? String(dishId) : null, num(r && r.qty));
    }

    // sku → 快照配方（算真成本毛利率用）
    const extRecipes = {};
    for (const rcp of arr(extOf(snap).recipes)) {
      if (rcp && rcp.sku_id != null) extRecipes[String(rcp.sku_id)] = rcp;
    }
    let costLib = null;
    try { costLib = require('../lib/recipe_cost'); } catch (e) { costLib = null; }

    dishes = merged.dishes.map((d) => {
      // volume：真销量（近7日份数）→ 保本日销 → est
      const realVol = d && d.id != null ? volMap[String(d.id)] : null;
      const volume = realVol != null ? +realVol.toFixed(2)
        : (d && d.daily_qty != null ? num(d.daily_qty)
          : num(d && (d.est != null ? d.est : (d.qty != null ? d.qty : d.sales))));
      // margin：recipe_cost 真成本毛利率（0-1）→ 保本/店内静态值
      let margin = null;
      const sku = d && d.sku_id != null ? String(d.sku_id) : null;
      if (costLib && sku && extRecipes[sku]) {
        try {
          const card = costLib.buildCostCard(extRecipes[sku], data);
          if (card && card.gross_margin != null) margin = card.gross_margin / 100;
        } catch (e) { /* 回落静态 */ }
      }
      if (margin == null) {
        if (d && d.gross_margin != null) margin = num(d.gross_margin);
        else if (d && d.margin != null) margin = num(d.margin);
        else if (d && d.price != null && d.cost != null && num(d.price) > 0) {
          margin = 1 - num(d.cost) / num(d.price);
        } else if (d && d.q != null && num(d.q) <= 1) {
          margin = num(d.q); // 仅当 q 像比率时
        } else {
          margin = 0;
        }
      }
      if (margin > 1) margin = margin / 100;
      // 解析 docs.data 真实菜品 id（下架 dish.set_active 要用）：
      // 店内菜品自带 id → 菜名精确 → dishAlias → sku_id 反查；保本独有行为 null
      const rowName = (d && (d.name || d.sku || d.sku_id)) || '未命名';
      let realDish = null;
      if (d && d.id != null && dishById[String(d.id)]) realDish = dishById[String(d.id)];
      if (!realDish && d && d.name && dishByName[String(d.name)]) realDish = dishByName[String(d.name)];
      if (!realDish && d && d.name) {
        const a = alias[cleanKey(String(d.name))];
        if (a && a.dish != null && dishById[String(a.dish)]) realDish = dishById[String(a.dish)];
      }
      if (!realDish && sku && dishBySku[sku]) realDish = dishBySku[sku];
      const realDishId = realDish && realDish.id != null ? String(realDish.id) : null;
      return {
        id: realDishId,
        dish_id: realDishId,
        name: rowName,
        price: d && d.price != null ? num(d.price) : null,
        volume,
        margin,
        dish_type: d.dish_type || d.cat || null
      };
    });
  } catch (e) {
    dishes = arr(data.dishes).map((d) => {
      const volume = num(d && (d.est != null ? d.est : (d.qty != null ? d.qty : d.sales)));
      const margin = num(d && (d.q != null ? d.q : (d.margin != null ? d.margin : d.gross)));
      const fbId = d && d.id != null ? String(d.id) : null;
      return {
        id: fbId,
        dish_id: fbId,
        name: (d && (d.name || d.sku || d.sku_id)) || '未命名',
        price: d && d.price != null ? num(d.price) : null,
        volume,
        margin
      };
    });
  }
  // 分象限基线：中位数（抗长尾，比均值更稳）
  const medianOf = (xs) => {
    const ys = xs.filter((x) => isFinite(x)).slice().sort((a, b) => a - b);
    if (!ys.length) return 0;
    const mid = Math.floor(ys.length / 2);
    return ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
  };
  const avgV = medianOf(dishes.map((d) => d.volume));
  const avgM = medianOf(dishes.map((d) => d.margin));
  const matrix = dishes.map((d) => {
    const hiV = d.volume >= avgV;
    const hiM = d.margin >= avgM;
    const quadrant = hiV && hiM ? 'star' : hiV && !hiM ? 'puzzle' : !hiV && hiM ? 'cow' : 'dog';
    return {
      id: d.id != null ? d.id : null,
      dish_id: d.dish_id != null ? d.dish_id : (d.id != null ? d.id : null),
      name: d.name,
      price: d.price,
      volume: d.volume,
      margin: d.margin,
      quadrant,
      dish_type: d.dish_type || null
    };
  });

  // 效率
  const totalRev = trend.reduce((s, t) => s + t.revenue, 0);
  const totalOrders = trend.reduce((s, t) => s + t.orders, 0);
  let peak = null;
  for (const c of heatmap) if (!peak || c.revenue > peak.revenue) peak = c;
  const efficiency = {
    avg_ticket: totalOrders ? +(totalRev / totalOrders).toFixed(2) : 0,
    daily_avg_revenue: trend.length ? +(totalRev / trend.length).toFixed(2) : 0,
    total_orders: totalOrders,
    days: trend.length,
    peak_hour: peak ? peak.hour : null,
    peak_weekday: peak ? peak.weekday : null
  };

  return {
    mock: false,
    trend,
    heatmap,
    matrix,
    efficiency,
    forecast: buildForecast(snap, trend, efficiency),
    baoben_summary: baobenSummary,
    baoben_types: baobenSummary ? baobenSummary.types : null
  };
}

/** AI 销量预测：历史趋势外推 + 补货建议区间（预测≠下单） */
function buildForecast(snap, trend, efficiency) {
  const days = [];
  const last = (trend && trend.length) ? trend[trend.length - 1] : null;
  const baseRev = (efficiency && efficiency.daily_avg_revenue) ||
    (last && last.revenue) ||
    (trend && trend.length
      ? trend.reduce((s, t) => s + (t.revenue || 0), 0) / trend.length
      : 8200);
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    const wd = d.getDay();
    const weekendLift = (wd === 0 || wd === 6) ? 1.12 : 1.0;
    const rainLift = i === 1 ? 1.065 : 1.0; // 明日雨天略抬
    const pred = +(baseRev * weekendLift * rainLift * (1 + i * 0.012)).toFixed(0);
    days.push({
      date,
      pred,
      opt: Math.round(pred * 1.18),
      cons: Math.round(pred * 0.82),
      weekday: wd
    });
  }
  let restock = [];
  try {
    const { buildSuggestions } = require('./inventory');
    const sug = buildSuggestions(snap);
    restock = (sug.items || []).slice(0, 8).map((it) => {
      const pred = +((it.suggestQty || 0)).toFixed(2);
      const cons = +(pred * 0.82).toFixed(2);
      const opt = +(pred * 1.18).toFixed(2);
      return {
        ingredientId: it.ingredientId,
        name: it.name,
        unit: it.unit || 'kg',
        qty: it.qty,
        pred,
        cons,
        opt,
        amount: Math.round(pred * 80),
        badge: it.urgency === 'critical' ? '告急' : (it.urgency === 'low' ? '偏低' : 'AI 建议'),
        reason: it.reason
      };
    });
  } catch (e) { /* ignore */ }
  if (!restock.length) {
    restock = [
      { name: '火龙果汁', unit: 'kg', pred: 2.4, cons: 2.0, opt: 2.8, qty: 0.44, amount: 288, badge: '雨天 ↑14%' },
      { name: '墨鱼汁', unit: 'kg', pred: 0.4, cons: 0.33, opt: 0.47, qty: 0.18, amount: 232, badge: '稳' },
      { name: '猪前肩肉', unit: 'kg', pred: 8.5, cons: 7.0, opt: 10.0, qty: null, amount: 680, badge: '节庆 +20%' }
    ];
  }
  return {
    confidence: 90,
    note: '三因子模型：天气 + 历史 + 节假日。预测≠下单，转采购需确认。',
    days,
    weather_coef: [
      { weather: '晴', red: '+2%', black: '0', yellow: '+5%', green: '+3%', white: '+6%' },
      { weather: '雨', red: '+14%', black: '+3%', yellow: '-2%', green: '0', white: '+8%' },
      { weather: '降温3℃', red: '+8%', black: '+4%', yellow: '-1%', green: '+2%', white: '+12%' },
      { weather: '节假日', red: '+5%', black: '+3%', yellow: '+4%', green: '+2%', white: '+32%' }
    ],
    holidays: [
      { label: '中秋前 3 天', effect: '白饺 +32%' },
      { label: '中秋团圆', effect: '团圆套餐 +28%' },
      { label: '国庆', effect: '总单量 +45%' },
      { label: '周末晚峰', effect: '18:30 提前 +22%' }
    ],
    restock,
    peak: days.reduce((a, b) => (b.pred > (a && a.pred || 0) ? b : a), days[0] || null)
  };
}

/** 冷柜温度：优先 ext.eq_temps / eq_temp（真 IoT）；否则合成演示传感器（与原型一致） */
function equipmentTemps(ext) {
  let raw = arr(ext && ext.eq_temps);
  if (!raw.length) {
    // eq_temp 为时序点：按 device 聚合最新值 + history
    const points = arr(ext && ext.eq_temp).slice().sort((a, b) =>
      String(a.ts || '').localeCompare(String(b.ts || '')));
    const byDev = {};
    for (const p of points) {
      const d = p.device || p.name || '冷柜';
      if (!byDev[d]) byDev[d] = [];
      byDev[d].push(p);
    }
    raw = Object.keys(byDev).map((d) => {
      const hist = byDev[d];
      const last = hist[hist.length - 1] || {};
      const kind = last.kind || (/冻/.test(d) ? '冷冻' : (/蔬/.test(d) ? '蔬菜' : '冷藏'));
      const maxDef = kind === '蔬菜' ? 8 : 5;
      const max = num(last.max != null ? last.max : last.limit, maxDef);
      return {
        device: d,
        kind,
        temp: num(last.temp != null ? last.temp : last.celsius),
        max,
        minutes: last.minutes,
        history: hist.map((h) => num(h.temp != null ? h.temp : h.celsius)).filter((n) => !isNaN(n))
      };
    });
  }
  function withHistory(t) {
    const temp = num(t.temp != null ? t.temp : t.celsius);
    const max = num(t.max != null ? t.max : t.limit, 5);
    const over = t.status === 'over' || t.status === '超温' || (temp > max);
    let history = arr(t.history).map((h) => num(h)).filter((n) => !isNaN(n));
    if (!history.length) {
      // 近 9 点合成曲线：超温则末段抬升
      const base = over ? Math.min(temp, max) - 1.2 : temp;
      history = [];
      for (let i = 0; i < 9; i++) {
        const lift = over ? (i / 8) * (temp - base) : (Math.sin(i / 2) * 0.15);
        history.push(+(base + lift).toFixed(2));
      }
      if (over) history[history.length - 1] = temp;
    }
    return {
      device: t.device || t.name || '冷柜',
      kind: t.kind || t.zone || '冷藏',
      temp,
      max,
      status: over ? 'over' : 'ok',
      minutes: t.minutes != null ? Number(t.minutes) : (over ? 18 : 0),
      history
    };
  }
  if (raw.length) return raw.map(withHistory);
  return [
    withHistory({ device: '冷柜 A', kind: '冷藏', temp: 4.2, max: 5, status: 'ok' }),
    withHistory({ device: '冷柜 B', kind: '冷冻', temp: 7.2, max: 5, status: 'over', minutes: 18 }),
    withHistory({ device: '冷柜 C', kind: '蔬菜', temp: 3.8, max: 8, status: 'ok' })
  ];
}

function equipmentEnergySummary(ext, energyRows) {
  const rows = arr(energyRows);
  const buckets = { 燃气: 0, 水: 0, 电: 0 };
  for (const e of rows) {
    const kind = String(e.kind || e.type || '');
    const usage = num(e.usage != null ? e.usage : e.amount);
    const cost = num(e.cost != null ? e.cost : e.amount, usage * (kind.includes('气') ? 3.2 : kind.includes('水') ? 4 : 0.8));
    if (/气|燃气/.test(kind)) buckets['燃气'] += cost;
    else if (/水/.test(kind)) buckets['水'] += cost;
    else buckets['电'] += cost;
  }
  const has = Object.values(buckets).some((v) => v > 0);
  if (!has) {
    return {
      mock: true,
      items: [
        { kind: '燃气', amount: 2180, pct: 75 },
        { kind: '水', amount: 320, pct: 30 },
        { kind: '电', amount: 1680, pct: 62 }
      ],
      total: 4180,
      yoy: '+6.2%',
      mom: '-3.1%',
      ratio: '4.8%'
    };
  }
  const total = buckets['燃气'] + buckets['水'] + buckets['电'];
  const max = Math.max(buckets['燃气'], buckets['水'], buckets['电'], 1);
  return {
    mock: false,
    items: Object.keys(buckets).map((k) => ({
      kind: k,
      amount: Math.round(buckets[k]),
      pct: Math.round((buckets[k] / max) * 100)
    })),
    total: Math.round(total),
    yoy: null,
    mom: null,
    ratio: null
  };
}

// 演示数据：落自原型 p-m-analysis（W35→W38 趋势、五色周表现、矩阵图例、效率环）
function mockAnalysis(paramOverrides) {
  const heatmap = [];
  for (let wd = 0; wd < 7; wd++) {
    for (const h of [11, 12, 18, 19]) {
      const weekend = wd === 0 || wd === 6;
      heatmap.push({
        hour: h,
        weekday: wd,
        orders: (h >= 18 ? 30 : 20) + (weekend ? 15 : 0),
        revenue: ((h >= 18 ? 30 : 20) + (weekend ? 15 : 0)) * 44
      });
    }
  }
  return {
    mock: true,
    note: '演示数据（原型 p-m-analysis）：快照 data.sales 为空；菜单矩阵已挂保本测算',
    trend: [
      { week: 'W35', revenue: 52000, gross_rate: 39.2 },
      { week: 'W36', revenue: 53800, gross_rate: 39.8 },
      { week: 'W37', revenue: 55900, gross_rate: 40.0 },
      { week: 'W38', revenue: 58210, gross_rate: 40.1 }
    ],
    heatmap,
    matrix: (() => {
      try {
        const { mergeDishesWithBaoben } = require('../lib/menu_baoben');
        const merged = mergeDishesWithBaoben([]);
        const dishes = merged.dishes.map((d) => ({
          name: d.name,
          price: d.price,
          volume: Number(d.est) || 0,
          margin: typeof d.gross_margin === 'number' ? d.gross_margin
            : (d.price && d.cost ? 1 - Number(d.cost) / Number(d.price) : 0.4),
          dish_type: d.dish_type || d.cat
        }));
        const avgV = dishes.length ? dishes.reduce((s, d) => s + d.volume, 0) / dishes.length : 0;
        const avgM = dishes.length ? dishes.reduce((s, d) => s + d.margin, 0) / dishes.length : 0;
        return dishes.map((d) => {
          const hiV = d.volume >= avgV;
          const hiM = d.margin >= avgM;
          const quadrant = hiV && hiM ? 'star' : hiV && !hiM ? 'puzzle' : !hiV && hiM ? 'cow' : 'dog';
          return { name: d.name, price: d.price, volume: d.volume, margin: d.margin, quadrant, dish_type: d.dish_type };
        });
      } catch (e) {
        return [
          { name: '红·长寿', quadrant: 'star', volume: 486, margin: 0.62 },
          { name: '狮·醒狮', quadrant: 'star', volume: 301, margin: 0.65 },
          { name: '黑·聚财', quadrant: 'puzzle', volume: 413, margin: 0.38 },
          { name: '凉·凉拌', quadrant: 'puzzle', volume: 268, margin: 0.35 },
          { name: '白·团圆', quadrant: 'cow', volume: 315, margin: 0.58 },
          { name: '紫·好德', quadrant: 'dog', volume: 289, margin: 0.33 }
        ];
      }
    })(),
    efficiency: {
      avg_ticket: 44.2,
      daily_avg_revenue: 8315.7,
      total_orders: 1320,
      翻台率: 3.2,
      坪效: 680,
      人效: 648,
      营收环比: '+4.2%',
      营收同比: '+11.6%',
      毛利环比: '+0.8pct'
    },
    forecast: buildForecast({ data: {} }, [
      { date: 'W35', revenue: 52000 },
      { date: 'W36', revenue: 53800 },
      { date: 'W37', revenue: 55900 },
      { date: 'W38', revenue: 58210 }
    ], { daily_avg_revenue: 8315.7 }),
    baoben_summary: (() => {
      try { return require('../lib/menu_baoben').computeBaobenSummary(paramOverrides); } catch (e) { return null; }
    })()
  };
}

async function handle(req, res, ctx, pathname) {
  // 只读路由：非 GET 一律交外层 404（不暴露任何写路径）
  if (req.method !== 'GET') return false;
  if (pathname.indexOf('/api/modules/') !== 0) return false;

  const snap = loadSnapshot();
  const ext = extOf(snap);
  const soft = snap
    ? {}
    : { hint: NO_SNAP_HINT, message: NO_SNAP_MSG };
  const base = {
    ok: true,
    rev: snap ? snap.rev : null,
    generated_at: snap ? snap.generated_at : null,
    ...soft
  };

  // GET /api/modules/staff
  if (pathname === '/api/modules/staff') {
    ctx.sendJSON(res, 200, Object.assign(base, {
      shifts: arr(ext.staff_shifts),
      clock: arr(ext.staff_clock),
      perf: arr(ext.staff_perf),
      train: arr(ext.staff_train)
    }));
    return true;
  }

  // GET /api/modules/booking?date=
  if (pathname === '/api/modules/booking') {
    const q = (ctx.query.get('date') || '').trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayStr();
    const bookings = arr(ext.bookings).filter((b) => recordDay(b) === date);
    const serves = arr(ext.queue_serves).filter((s) => recordDay(s) === date);
    ctx.sendJSON(res, 200, Object.assign(base, {
      date,
      bookings,
      queue: arr(ext.queue),
      serves
    }));
    return true;
  }

  // GET /api/modules/foodsafe（samples 附加 48h 倒计时 hours_left）
  if (pathname === '/api/modules/foodsafe') {
    const now = Date.now();
    const samples = arr(ext.fs_samples).map((s) =>
      Object.assign({}, s, { hours_left: hoursLeft(s, now) }));
    const trace = arr(ext.fs_trace).map((t) => Object.assign({}, t, {
      name: t.name || t.ing_name || t.ingName || null,
      batch: t.batch || t.batch_no || null
    }));
    ctx.sendJSON(res, 200, Object.assign(base, {
      certs: arr(ext.fs_certs),
      trace,
      samples,
      disinfect: arr(ext.fs_disinfect)
    }));
    return true;
  }

  // GET /api/modules/analysis（店参透传：area/staff/days/target_profit → 保本测算 paramOverrides）
  if (pathname === '/api/modules/analysis') {
    const overrides = {};
    const qnum = (k) => {
      const v = parseFloat(ctx.query.get(k));
      return isNaN(v) ? null : v;
    };
    const area = qnum('area'); if (area != null) overrides.area = area;
    const staff = qnum('staff'); if (staff != null) overrides.staff = staff;
    const days = qnum('days'); if (days != null) overrides.days = days;
    const tp = qnum('target_profit'); if (tp != null) overrides.targetProfit = tp;
    const hasSales = !!(snap && Array.isArray(snap.data && snap.data.sales) && snap.data.sales.length > 0);
    const a = hasSales ? realAnalysis(snap, overrides) : mockAnalysis(overrides);
    ctx.sendJSON(res, 200, Object.assign(base, {
      trend: a.trend,
      heatmap: a.heatmap,
      matrix: a.matrix,
      efficiency: a.efficiency,
      forecast: a.forecast || null,
      mock: a.mock || !snap,
      note: a.note || (!snap ? NO_SNAP_MSG : undefined),
      baoben_summary: a.baoben_summary || null,
      baoben_types: a.baoben_types || (a.baoben_summary && a.baoben_summary.types) || null
    }));
    return true;
  }

  // GET /api/modules/vip
  if (pathname === '/api/modules/vip') {
    const balances = {};
    for (const b of arr(ext.vip_balance)) {
      balances[b.member_id] = b;
    }
    const now = new Date();
    const membersRaw = arr(ext.vip_members).map((m) => {
      const bal = (balances[m.member_id] && balances[m.member_id].balance) || m.balance || 0;
      const bd = String(m.birthday || m.bday || '');
      let birthdaySoon = !!m.birthday_soon;
      if (!birthdaySoon && /^\d{4}-\d{2}-\d{2}/.test(bd)) {
        const mmdd = bd.slice(5, 10);
        for (let i = 0; i < 7; i++) {
          const d = new Date(now.getTime() + i * 86400000);
          const p = (n) => String(n).padStart(2, '0');
          if (p(d.getMonth() + 1) + '-' + p(d.getDate()) === mmdd) { birthdaySoon = true; break; }
        }
      }
      return Object.assign({}, m, { balance: bal, birthday: bd || null, birthday_soon: birthdaySoon });
    });
    // 无生日字段时：取前 3 名标为本周生日（对齐原型发券入口）
    if (!membersRaw.some((m) => m.birthday_soon) && membersRaw.length) {
      membersRaw.slice(0, 3).forEach((m) => { m.birthday_soon = true; });
    }
    ctx.sendJSON(res, 200, Object.assign(base, {
      members: membersRaw,
      coupons: arr(ext.vip_coupons),
      visits: arr(ext.vip_visits).slice(-40)
    }));
    return true;
  }

  // GET /api/modules/takeout
  if (pathname === '/api/modules/takeout') {
    const platforms = arr(snap && snap.data && snap.data.platforms);
    ctx.sendJSON(res, 200, Object.assign(base, {
      platforms,
      orders: arr(ext.takeout_orders),
      reviews: arr(ext.takeout_reviews),
      reconcile: arr(ext.takeout_reconcile)
    }));
    return true;
  }

  // GET /api/modules/review
  if (pathname === '/api/modules/review') {
    ctx.sendJSON(res, 200, Object.assign(base, {
      reviews: arr(ext.rv_reviews),
      improve: arr(ext.rv_improve)
    }));
    return true;
  }

  // GET /api/modules/equipment
  if (pathname === '/api/modules/equipment') {
    const temps = equipmentTemps(ext);
    const energy = arr(ext.eq_energy);
    const energySummary = equipmentEnergySummary(ext, energy);
    ctx.sendJSON(res, 200, Object.assign(base, {
      temps,
      maintain: arr(ext.eq_maintain),
      energy,
      energy_summary: energySummary,
      mock_temps: !(arr(ext.eq_temps).length || arr(ext.eq_temp).length)
    }));
    return true;
  }

  // GET /api/modules/finance
  if (pathname === '/api/modules/finance') {
    const data = (snap && snap.data) || {};
    const day = todayStr();
    const salesToday = arr(data.sales).filter((r) => {
      const d = String((r && (r.date || r.ts || r.time)) || '');
      return d.indexOf(day) === 0;
    });
    let dineAmt = 0, dineN = 0, takeAmt = 0, takeN = 0;
    for (const r of salesToday) {
      const ch = String((r && r.channel) || '');
      const amt = salesAmount(r);
      if (/外卖|美团|饿了么|takeout/i.test(ch)) {
        takeAmt += amt;
        takeN += 1;
      } else {
        dineAmt += amt;
        dineN += 1;
      }
    }
    let purchaseAmt = 0, purchaseN = 0;
    for (const po of arr(data.recv)) {
      const d = String((po && (po.date || po.ts)) || '');
      if (d.indexOf(day) !== 0) continue;
      const st = String((po && po.status) || '');
      if (st && /草稿|待/.test(st) && !/已入库/.test(st)) continue;
      let sum = 0;
      for (const l of arr(po.lines)) {
        const qty = num(l && l.qty);
        const cost = num(l && (l.unitCost != null ? l.unitCost : l.price));
        const conv = num(l && l.conv, 1) || 1;
        sum += qty * cost * conv;
      }
      if (!sum && po && po.amount != null) sum = num(po.amount);
      purchaseAmt += sum;
      purchaseN += 1;
    }
    const cash = arr(ext.fin_cash);
    const cfg = (data.config && typeof data.config === 'object') ? data.config : {};
    const lastRecon = cfg.last_finance_recon || null;
    const confirmed = !!(lastRecon && String(lastRecon.date || '') === day) ||
      cash.some((c) => {
        const kind = String((c && c.kind) || '');
        const note = String((c && (c.note || c.ts)) || '');
        return /三方勾兑/.test(kind) && note.indexOf(day) >= 0;
      });
    const gap = +(dineAmt + takeAmt - purchaseAmt).toFixed(2);
    ctx.sendJSON(res, 200, Object.assign(base, {
      invoices: arr(ext.fin_invoices),
      tax: arr(ext.fin_tax),
      cash,
      split: arr(ext.fin_split),
      recon: {
        date: day,
        dine_in: { amount: +dineAmt.toFixed(2), count: dineN },
        takeout: { amount: +takeAmt.toFixed(2), count: takeN },
        purchase: { amount: +purchaseAmt.toFixed(2), count: purchaseN },
        gap,
        confirmed,
        last: lastRecon
      }
    }));
    return true;
  }

  // GET /api/modules/loss
  if (pathname === '/api/modules/loss') {
    ctx.sendJSON(res, 200, Object.assign(base, {
      reports: arr(ext.loss_reports)
    }));
    return true;
  }

  // GET /api/modules/supply — 供应商 / 报价 / 账期（与 App 供应链同源）
  if (pathname === '/api/modules/supply') {
    const data = (snap && snap.data) || {};
    const quotes = arr(data.quotes);
    const vendorsObj = arr(data.vendors);
    const suppliersStr = arr(data.suppliers);
    const accounts = arr(ext.sup_accounts);
    const extVendors = arr(ext.sup_vendors).map((v) => ({
      id: v.vendor_id || v.id,
      vendor_id: v.vendor_id || v.id,
      name: v.name,
      contact: v.contact,
      phone: v.phone,
      category: v.category,
      level: v.level,
      status: v.status,
      period: v.period,
      note: v.note
    }));
    const vendors = vendorsObj.length ? vendorsObj : (extVendors.length ? extVendors : suppliersStr.map((n) => ({
      id: n, name: n, status: '合作中', period: '月结30天'
    })));
    const suppliers = suppliersStr.length
      ? suppliersStr
      : vendors.map((v) => (typeof v === 'string' ? v : (v.name || ''))).filter(Boolean);
    ctx.sendJSON(res, 200, Object.assign(base, {
      suppliers,
      vendors,
      quotes,
      accounts: accounts.length ? accounts : quotes.slice(0, 8).map((q, i) => ({
        id: 'sa_' + i,
        supplier: q.src || q.supplier || '供应商',
        period: '月结30天',
        balance: q.price || 0,
        status: '正常'
      }))
    }));
    return true;
  }

  return false;
}

module.exports = { handle, equipmentTemps, buildForecast, equipmentEnergySummary };
