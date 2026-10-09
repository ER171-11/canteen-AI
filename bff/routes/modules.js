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
 *   GET /api/modules/inspection?date=&board=&operator=&node_id=
 *                                  → {ok, date, summary, boards[], nodes[], records[], every30}
 *        闭店巡检统筹看板（C/D 块）：从 ext.inspection_records / inspection_assignments 聚合。
 *        巡检照片只存手机本地，故此处**不含任何图片字段**，只有「有没有拍、谁拍的、几点拍的」。
 * 非 GET 一律交外层 404。无快照：各模块空开 200 + hint=no_snapshot（分析可回 mock），
 * 避免 App 整页「加载失败」（与厨房/进销 restock-suggest 一致）。
 */
const { loadSnapshot } = require('./snapshot');
const { buildBoard } = require('../lib/inspection_board');

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
/**
 * 留样 48h 倒计时（小时，1 位小数）。
 * 取样时间字段兼容 kept_at / keptAt / ts / time / created_at（店内表用 kept_at）。
 * - 已清样（cleared_at 有值）：不再倒计时，返回 null（App 显示「已清样」）
 * - 无有效取样时间：null（App 显示「—」，不误导为已到期）
 * - 超 48h：返回负数（App 显示「已过期」）
 */
function hoursLeft(sample, nowMs) {
  if (!sample) return null;
  if (sample.cleared_at || sample.clearedAt) return null;
  const raw = sample.kept_at || sample.keptAt || sample.ts || sample.time || sample.created_at;
  const ts = new Date(raw).getTime();
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
  // 逐菜结构表行（旧版 SD，只读；见基线 FP-CALC-09/10）
  let calcRows = [];
  try {
    const { mergeDishesWithBaoben, computeBaobenSummary, toCalcRows } = require('../lib/menu_baoben');
    baobenSummary = computeBaobenSummary(paramOverrides);
    const merged = mergeDishesWithBaoben(arr(data.dishes));
    // 行集对齐旧版 syncCalc()：仅店内菜品主数据（保本价盘独有项不进食结构表）
    const shopNames = new Set();
    for (const d of arr(data.dishes)) {
      if (d && d.name != null) shopNames.add(String(d.name));
    }
    calcRows = merged.dishes.filter((d) => d && shopNames.has(String(d.name || '')));

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
    // 逐菜结构表口径：默认照抄旧版 `SC_QMODE='real30'`，取数口径同下方近 7 日真销量聚合（见 ADR-007）
    calcRows = toCalcRows(calcRows, { sales, alias, byName: dishByName });
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
  const bbParams = (baobenSummary && baobenSummary.params) || {};
  const area = num(bbParams.area) || 0;
  const staff = num(bbParams.staff) || 0;
  const seats = num(bbParams.seats) || 0;
  const tables = arr((snap.ext && snap.ext.pos_tables) || []).length;
  const daysN = trend.length || 0;
  const dailyAvg = daysN ? +(totalRev / daysN).toFixed(2) : 0;
  // 翻台率 = 期间订单数 / 桌位容量 / 天数（无桌位用座位÷4 估）
  const capacity = tables > 0 ? tables : (seats > 0 ? Math.max(1, Math.round(seats / 4)) : 0);
  const turnover = (capacity > 0 && daysN > 0) ? +(totalOrders / capacity / daysN).toFixed(2) : null;
  const efficiency = {
    avg_ticket: totalOrders ? +(totalRev / totalOrders).toFixed(2) : 0,
    daily_avg_revenue: dailyAvg,
    total_orders: totalOrders,
    days: daysN,
    peak_hour: peak ? peak.hour : null,
    peak_weekday: peak ? peak.weekday : null,
    // 效率三率（真实：翻台/坪效/人效）
    turnover,
    revenue_per_sqm: area > 0 ? +(dailyAvg / area).toFixed(1) : null,
    revenue_per_staff: staff > 0 ? +(dailyAvg / staff).toFixed(1) : null,
    area: area || null,
    staff: staff || null,
    seats: seats || null,
    tables: tables || null
  };

  // 同环比：周环比 / 月环比 / 同比（样本不足则 null，UI 不编造）
  const revs = trend.map((t) => t.revenue);
  const sumRange = (a) => a.reduce((s, x) => s + x, 0);
  const last7 = revs.slice(-7), prev7 = revs.slice(-14, -7);
  const last30 = revs.slice(-30), prev30 = revs.slice(-60, -30);
  const pct = (cur, prev) => (prev > 0 ? +(((cur - prev) / prev) * 100).toFixed(1) : null);
  let yoy = null;
  if (revs.length >= 360) {
    const y = revs.slice(-390, -360);
    yoy = pct(sumRange(last30), sumRange(y));
  }
  const compare = {
    days: revs.length,
    wow_rev_pct: (prev7.length && last7.length) ? pct(sumRange(last7), sumRange(prev7)) : null,
    mom_rev_pct: (prev30.length && last30.length) ? pct(sumRange(last30), sumRange(prev30)) : null,
    yoy_rev_pct: yoy,
    last7_rev: +sumRange(last7).toFixed(0),
    prev7_rev: +sumRange(prev7).toFixed(0)
  };

  return {
    mock: false,
    trend,
    heatmap,
    matrix,
    efficiency,
    compare,
    forecast: buildForecast(snap, trend, efficiency),
    baoben_summary: baobenSummary,
    baoben_types: baobenSummary ? baobenSummary.types : null,
    calc_dishes: calcRows
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
      // 阈值按品类：冷冻需 ≤ -15℃（不是 5℃），蔬菜 ≤8℃，其余冷藏 ≤5℃
      const maxDef = kind === '冷冻' ? -15 : (kind === '蔬菜' ? 8 : 5);
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
  /* 无 IoT 温度数据即空态，不再合成演示曲线 */
  return [];
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
    return { mock: true, items: [], total: 0, yoy: null, mom: null, ratio: null };
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

// 无销售流水时的分析空态：不编造流水/趋势/效率，仅保留基于保本价盘的真实算法结果
function mockAnalysis(paramOverrides) {
  return {
    mock: true,
    note: '暂无销售流水，未生成分析；菜单矩阵仍按保本价盘展示',
    trend: [],
    heatmap: [],
    calc_dishes: (() => {
      try {
        const { mergeDishesWithBaoben, toCalcRows } = require('../lib/menu_baoben');
        return toCalcRows(mergeDishesWithBaoben([]).dishes);
      } catch (e) {
        return [];
      }
    })(),
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
        return [];
      }
    })(),
    efficiency: {},
    forecast: null,
    baoben_summary: (() => {
      try { return require('../lib/menu_baoben').computeBaobenSummary(paramOverrides); } catch (e) { return null; }
    })()
  };
}

/**
 * 预订排队洞察：真实翻台预估 + 后厨备料联动 + 员工加排建议。
 * 全部由 ext.bookings / ext.queue / ext.pos_tables(或 data.pos) 推得，不编造。
 */
function bookingInsight(ext, data, date) {
  const bookings = arr(ext.bookings).filter((b) => recordDay(b) === date);
  const queue = arr(ext.queue);
  const tables = arr(ext.pos_tables);
  const posTables = arr(data && data.pos);
  const allTables = tables.length ? tables : posTables;
  const totalTables = allTables.length;
  const stateOf = (t) => String((t && (t.status != null ? t.status : t.state)) || '');
  const occ = allTables.filter((t) => /就餐|用餐|busy|占用/.test(stateOf(t))).length;
  const occupancy = totalTables > 0 ? Math.round((occ / totalTables) * 100) : null;

  const isWaiting = (q) => !/已入座|流失|取消|cancel|seated/i.test(String((q && q.status) || ''));
  const waiting = queue.filter(isWaiting);
  const waitingGuests = waiting.reduce((s, q) => s + (parseInt(q.party_size || q.partySize, 10) || 0), 0);

  const byStatus = {};
  for (const b of bookings) {
    const st = String((b && b.status) || '待确认');
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  const guests = bookings.reduce((s, b) => s + (parseInt(b.party_size || b.partySize, 10) || 0), 0);

  const slotOf = (t) => {
    const m = String(t || '').match(/^(\d{1,2})/);
    if (!m) return '未定';
    return parseInt(m[1], 10) < 15 ? '午市' : '晚市';
  };
  const bySlot = {};
  for (const b of bookings) {
    const k = slotOf(b.time);
    bySlot[k] = (bySlot[k] || 0) + 1;
  }

  // 翻台预估：按桌型（餐时段 + 清台）估算
  const diningMin = (cap) => (cap <= 2 ? 45 : cap <= 4 ? 60 : cap <= 6 ? 75 : 90);
  const cleanupMin = (cap) => (cap <= 4 ? 8 : cap > 6 ? 15 : 12);
  const byCapacity = {};
  for (const t of allTables) {
    const cap = parseInt(t.capacity || t.seats, 10) || 4;
    const k = cap <= 4 ? '小桌' : cap <= 8 ? '大桌' : '包间';
    if (!byCapacity[k]) byCapacity[k] = { count: 0, turn_min: diningMin(cap) + cleanupMin(cap) };
    byCapacity[k].count += 1;
  }

  // 后厨备料联动：客人 × 人均份数
  let dishPerGuest = null;
  try {
    const { computeBaobenSummary } = require('../lib/menu_baoben');
    const s = computeBaobenSummary();
    dishPerGuest = (s && s.params && s.params.dish_per_guest) || null;
  } catch (e) { /* ignore */ }
  const expectedPortions = dishPerGuest ? Math.round(guests * dishPerGuest) : null;

  // 员工加排：占用率高 / 等位多 / 预订客流相对桌位过载
  const overload = totalTables > 0 && guests >= totalTables * 3;
  const suggestAdd = (occupancy != null && occupancy >= 90) || waiting.length >= 5 || overload;
  const staffText = !suggestAdd
    ? '人力与客流匹配'
    : (occupancy != null && occupancy >= 90)
      ? `桌位占用 ${occupancy}%，建议晚峰加排 1 人服务`
      : (waiting.length >= 5)
        ? `等位 ${waiting.length} 桌（${waitingGuests} 人），建议加排 1 人`
        : `今日预订 ${guests} 人 / ${totalTables} 桌，客流偏满，建议加排 1 人`;

  return {
    summary: { bookings: bookings.length, guests, by_status: byStatus, by_slot: bySlot },
    queue: {
      waiting: waiting.length,
      waiting_guests: waitingGuests,
      next_no: (waiting[0] && waiting[0].queue_no) || null,
      serving: queue.filter((q) => /叫号|就座/.test(String((q && q.status) || ''))).length
    },
    tables: { total: totalTables, occupied: occ, occupancy_pct: occupancy },
    turn: { by_capacity: byCapacity, note: '按桌型(餐时段+清台)估算，用于预估空台' },
    kitchen: { expected_guests: guests, expected_portions: expectedPortions, dish_per_guest: dishPerGuest },
    staffing: {
      occupancy_pct: occupancy,
      suggest_add: !!suggestAdd,
      text: staffText
    }
  };
}

/**
 * 外卖洞察：渠道概览 + T+1 对账差异闭环 + 差评归因（可联动菜品矩阵）。
 * 全部由 ext.takeout_* 与 data.platforms 推得。
 */
function takeoutInsight(ext, data) {
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  const orders = arr(ext.takeout_orders);
  const reviews = arr(ext.takeout_reviews);
  const recs = arr(ext.takeout_reconcile);

  const gross = orders.reduce((s, o) => s + n(o && o.amount), 0);
  const commission = orders.reduce((s, o) => s + n(o && o.commission), 0);
  const settle = orders.reduce((s, o) => s + n(o && o.settle), 0);
  const openOrders = orders.filter((o) => !/已完成|已送达|已取消|closed|done|cancel/i.test(String((o && o.status) || '')));
  const byPlatform = {};
  for (const o of orders) {
    const p = String((o && o.platform) || '未知');
    if (!byPlatform[p]) byPlatform[p] = { orders: 0, amount: 0, commission: 0 };
    byPlatform[p].orders += 1;
    byPlatform[p].amount += n(o && o.amount);
    byPlatform[p].commission += n(o && o.commission);
  }

  const rByStatus = {};
  let diffSum = 0;
  const rPending = [];
  for (const r of recs) {
    const st = String((r && r.status) || '待核对');
    rByStatus[st] = (rByStatus[st] || 0) + 1;
    diffSum += n(r && r.diff);
    if (!/一致|已处理|已入账/.test(st)) {
      rPending.push({
        platform: (r && r.platform) || '-',
        period: (r && r.period) || '-',
        diff: n(r && r.diff),
        status: st
      });
    }
  }
  const reconcileClean = recs.length > 0 &&
    Object.keys(rByStatus).every((k) => /一致|已处理|已入账/.test(k));

  const KW = ['慢', '咸', '冷', '少', '破', '凉', '腻', '糊'];
  const contentOf = (r) => String((r && (r.content || r.text || r.comment)) || '');
  const ratingOf = (r) => n(r && (r.rating != null ? r.rating : r.score));
  const bad = reviews.filter((r) => {
    const rt = ratingOf(r);
    const c = contentOf(r);
    return (rt > 0 && rt <= 3) || (!rt && KW.some((k) => c.indexOf(k) >= 0));
  });
  const reasons = {};
  for (const r of reviews) {
    const c = contentOf(r);
    for (const k of KW) if (c.indexOf(k) >= 0) reasons[k] = (reasons[k] || 0) + 1;
  }
  // 差评归因到菜品：优先 review.dishes/dish，其次按菜名匹配评论内容
  const dishNames = arr(data && data.dishes).map((d) => d && d.name).filter(Boolean);
  const dishFlags = {};
  for (const r of bad) {
    const content = contentOf(r);
    let names = arr(r && (r.dishes || (r.dish ? [r.dish] : []))).map((x) => (typeof x === 'string' ? x : (x && x.name)));
    if (!names.length && dishNames.length) names = dishNames.filter((nm) => content.indexOf(nm) >= 0);
    for (const nm of names) if (nm) dishFlags[nm] = (dishFlags[nm] || 0) + 1;
  }
  const replyPending = bad.filter((r) => {
    const st = String((r && (r.reply_status || r.status)) || '');
    return !/已回复|replied|已处理/i.test(st) && !contentOf(r).includes('回复：');
  }).length;

  const advice = [];
  if (openOrders.length) advice.push(`外卖在途 ${openOrders.length} 单，注意出餐协同与超时`);
  if (rPending.length) advice.push(`对账差异 ${rPending.length} 笔（合计 ¥${diffSum.toFixed(0)}），需人工核对`);
  if (bad.length) {
    const topDish = Object.keys(dishFlags).sort((a, b) => dishFlags[b] - dishFlags[a]).slice(0, 3);
    advice.push(`差评 ${bad.length} 条待回访` + (topDish.length ? `，涉及：${topDish.join('、')}` : ''));
  }
  if (!advice.length) advice.push('外卖渠道平稳');

  return {
    overview: {
      orders: orders.length,
      gross: +gross.toFixed(2),
      commission: +commission.toFixed(2),
      settle: +settle.toFixed(2),
      avg_order: orders.length ? +(gross / orders.length).toFixed(2) : 0,
      open: openOrders.length,
      fee_rate: gross > 0 ? +((commission / gross) * 100).toFixed(1) : null,
      by_platform: byPlatform
    },
    reconcile: {
      total: recs.length,
      by_status: rByStatus,
      diff_sum: +diffSum.toFixed(2),
      pending: rPending.slice(0, 8),
      clean: reconcileClean
    },
    reviews: {
      total: reviews.length,
      bad: bad.length,
      reasons,
      reply_pending: replyPending,
      dish_flags: dishFlags
    },
    advice
  };
}

/**
 * 会员洞察：资产总览 + 券核销状态机 + 生日 + 到店，联动 POS 储值扣减与券核销。
 */
function vipInsight(ext, data) {
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  const members = arr(ext.vip_members);
  const balances = arr(ext.vip_balance);
  const coupons = arr(ext.vip_coupons);
  const recharges = arr(ext.vip_recharge);
  const visits = arr(ext.vip_visits);
  const now = Date.now();
  const monthPrefix = new Date().toISOString().slice(0, 7);

  const byLevel = {};
  let newThisMonth = 0;
  for (const m of members) {
    const lvl = String((m && m.level) || '普通');
    byLevel[lvl] = (byLevel[lvl] || 0) + 1;
    if (String((m && m.joined_at) || '').indexOf(monthPrefix) === 0) newThisMonth += 1;
  }
  const storedTotal = balances.reduce((s, b) => s + n(b && b.balance), 0);
  const withBalance = balances.filter((b) => n(b && b.balance) > 0).length;

  const rechargeTotal = recharges.reduce((s, r) => s + n(r && (r.amount != null ? r.amount : r.value)), 0);
  const bigRecharge = recharges.filter((r) => n(r && (r.amount != null ? r.amount : r.value)) >= 1000).length;

  const cByStatus = {};
  let liability = 0, usedValue = 0, expiring = 0, expired = 0;
  for (const c of coupons) {
    const st = String((c && c.status) || '未使用');
    cByStatus[st] = (cByStatus[st] || 0) + 1;
    const v = n(c && c.value);
    if (!/已核销|已使用|已作废/.test(st)) {
      liability += v;
      const vt = c && c.valid_to ? new Date(c.valid_to).getTime() : NaN;
      if (!isNaN(vt)) {
        if (vt < now) expired += 1;
        else if (vt - now <= 7 * 86400000) expiring += 1;
      }
    }
    if (/已核销|已使用/.test(st)) usedValue += v;
  }

  const bdayNames = [];
  const nowD = new Date();
  for (const m of members) {
    const bd = String((m && (m.birthday || m.bday)) || '');
    if (!/^\d{4}-\d{2}-\d{2}/.test(bd)) continue;
    const mmdd = bd.slice(5, 10);
    for (let i = 0; i < 7; i++) {
      const d = new Date(nowD.getTime() + i * 86400000);
      const p = (x) => String(x).padStart(2, '0');
      if (p(d.getMonth() + 1) + '-' + p(d.getDate()) === mmdd) {
        bdayNames.push(m.name || m.member_id);
        break;
      }
    }
  }
  // 无生日字段时对齐 handler：取前 3 名作为本周生日待发券
  if (!bdayNames.length && members.length) {
    members.slice(0, 3).forEach((m) => bdayNames.push(m.name || m.member_id));
  }
  const uniqueVisit = new Set(visits.map((v) => v && v.member_id)).size;

  const advice = [];
  if (expiring) advice.push(`券临期 ${expiring} 张（7 天内），提醒核销`);
  if (expired) advice.push(`券过期 ${expired} 张，已不可核销`);
  if (bigRecharge) advice.push(`大额储值 ${bigRecharge} 笔（≥¥1000），需店长复核`);
  if (bdayNames.length) advice.push(`生日券建议待确认：${bdayNames.slice(0, 3).join('、')}`);
  if (!advice.length) advice.push('会员资产平稳');

  return {
    assets: {
      members: members.length,
      new_this_month: newThisMonth,
      by_level: byLevel,
      stored_total: +storedTotal.toFixed(2),
      with_balance: withBalance
    },
    recharge: { count: recharges.length, total: +rechargeTotal.toFixed(2), big_count: bigRecharge },
    coupons: {
      total: coupons.length,
      by_status: cByStatus,
      liability: +liability.toFixed(2),
      used_value: +usedValue.toFixed(2),
      expiring_7d: expiring,
      expired
    },
    birthday: { soon: bdayNames.length, names: bdayNames.slice(0, 5) },
    visits: { count: visits.length, unique_members: uniqueVisit },
    advice
  };
}

/**
 * 排班洞察：今日班表 + 打卡异常 + 健康证禁岗联动 + 峰谷加排建议（接销售时段）。
 */
function staffInsight(ext, data) {
  const shifts = arr(ext.staff_shifts);
  const clocks = arr(ext.staff_clock);
  const trains = arr(ext.staff_train);
  const certs = arr(ext.fs_certs);
  const today = todayStr();

  const dates = shifts.map((s) => String((s && s.date) || '')).filter(Boolean).sort();
  const target = shifts.some((s) => String(s && s.date) === today)
    ? today
    : (dates[dates.length - 1] || today);
  const dayShifts = shifts.filter((s) => String(s && s.date) === target);
  const isRest = (s) => /休息|请假|休班/.test(String((s && (s.shift || s.role)) || ''));
  const dayWork = dayShifts.filter((s) => !isRest(s));

  const byShift = {};
  const staffNames = new Set();
  const idToName = {};
  for (const s of dayShifts) {
    const k = String((s && (s.shift || s.role)) || '班');
    byShift[k] = (byShift[k] || 0) + 1;
    if (s && !isRest(s) && s.staff_name) staffNames.add(s.staff_name);
    if (s && s.staff_id) idToName[s.staff_id] = s.staff_name || s.staff_id;
  }

  const dayClocks = clocks.filter((c) => {
    const ts = String((c && c.ts) || '');
    const k = String((c && c.kind) || '');
    return ts.slice(0, 10) === target && /上班|到岗|上班卡/.test(k);
  });
  const clockedIds = new Set(dayClocks.map((c) => c && c.staff_id));
  const late = dayClocks.filter((c) => /迟到/.test(String((c && c.status) || ''))).length;
  const makeup = dayClocks.filter((c) => /补录/.test(String((c && c.status) || ''))).length;
  const absent = [];
  for (const s of dayWork) {
    if (s && s.staff_id && !clockedIds.has(s.staff_id)) {
      const nm = s.staff_name || s.staff_id;
      if (absent.indexOf(nm) < 0) absent.push(nm);
    }
  }

  // 健康证禁岗联动（按 holder 名匹配排班 staff_name）
  const daysLeft = (s) => {
    const t = new Date(String(s || '')).getTime();
    if (isNaN(t)) return null;
    return Math.ceil((t - Date.now()) / 86400000);
  };
  const certByHolder = {};
  for (const c of certs) {
    if (!/健康证/.test(String((c && (c.cert_type || c.type)) || ''))) continue;
    const holder = String((c && (c.holder || c.name)) || '').trim();
    if (!holder) continue;
    certByHolder[holder] = daysLeft(c.expire_at || c.expire || c.valid_until);
  }
  const blocked = [];
  const expiring = [];
  for (const holder of Object.keys(certByHolder)) {
    const d = certByHolder[holder];
    if (d != null && d < 7) blocked.push({ holder, days: d });
    else if (d != null && d < 30) expiring.push({ holder, days: d });
  }
  // 排班中命中禁岗的人
  const blockedScheduled = Array.from(staffNames).filter((nm) =>
    blocked.some((b) => b.holder === nm)
  );

  const pendingTrain = trains.filter((t) => !t.passed || /进行中|未通过|未完成/.test(String((t && t.remark) || '')));

  // 峰谷：从销售流水取单量最高小时，看排班覆盖
  const byHour = {};
  for (const r of arr(data && data.sales)) {
    let h = (r && r.hour != null) ? parseInt(r.hour, 10) : NaN;
    if (isNaN(h)) {
      const m = String((r && (r.date || r.ts || r.time)) || '').match(/[T\s](\d{2}):/);
      if (m) h = parseInt(m[1], 10);
    }
    if (!isNaN(h)) byHour[h] = (byHour[h] || 0) + 1;
  }
  const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
  const peakHour = hours.length ? hours.reduce((a, b) => (byHour[b] > byHour[a] ? b : a), hours[0]) : null;
  const covering = peakHour == null ? 0 : dayWork.filter((s) => {
    const st = parseInt(String((s && s.start_time) || '').slice(0, 2), 10);
    const en = parseInt(String((s && s.end_time) || '').slice(0, 2), 10);
    return !isNaN(st) && !isNaN(en) && peakHour >= st && peakHour < en;
  }).length;
  const suggestAdd = peakHour != null && covering > 0 && covering <= 1;

  const advice = [];
  if (blockedScheduled.length) advice.push(`禁岗：${blockedScheduled.join('、')} 健康证<7天，禁止排班`);
  if (absent.length) advice.push(`缺勤 ${absent.length} 人：${absent.slice(0, 3).join('、')}`);
  if (late) advice.push(`迟到 ${late} 人，注意考勤`);
  if (pendingTrain.length) advice.push(`培训未过 ${pendingTrain.length} 项，通过前勿排对应工艺岗`);
  if (suggestAdd) advice.push(`峰值 ${peakHour}:00 仅 ${covering} 人在岗，建议加排 1 人`);
  if (!advice.length) advice.push('今日排班与考勤正常');

  return {
    today: { date: target, shifts: dayWork.length, staff: staffNames.size, by_shift: byShift },
    clock: { expected: dayWork.length, clocked: dayClocks.length, late, makeup, absent: absent.slice(0, 8) },
    certs: {
      blocked: blocked.slice(0, 8),
      expiring: expiring.slice(0, 8),
      blocked_scheduled: blockedScheduled
    },
    training: { total: trains.length, pending: pendingTrain.length },
    peak: {
      hour: peakHour,
      scheduled: covering,
      suggest_add: suggestAdd,
      text: peakHour == null ? '暂无销售时段样本' : `峰值 ${peakHour}:00 · 在岗 ${covering} 人`
    },
    advice
  };
}

/**
 * 食安洞察：证照临期/停业风险 + 留样 48h 闭环 + 消毒漏做 + 溯源待补。
 * 与排班共享 fs_certs 健康证数据源（禁止上岗）。
 */
function foodsafeInsight(ext) {
  const now = Date.now();
  const today = todayStr();
  const certs = arr(ext.fs_certs);
  const samples = arr(ext.fs_samples);
  const disinfect = arr(ext.fs_disinfect);
  const trace = arr(ext.fs_trace);

  const daysLeft = (s) => {
    const t = new Date(String(s || '')).getTime();
    return isNaN(t) ? null : Math.ceil((t - now) / 86400000);
  };

  const byType = {};
  const certRows = certs.map((c) => {
    const type = String((c && (c.cert_type || c.type)) || '证照');
    const holder = String((c && (c.holder || c.name)) || '');
    const d = daysLeft(c.expire_at || c.expire || c.valid_until);
    byType[type] = (byType[type] || 0) + 1;
    const level = d == null ? 'unknown'
      : d < 0 ? 'expired'
        : d < 7 ? 'red'
          : d < 14 ? 'orange'
            : d < 30 ? 'yellow' : 'green';
    return { type, holder, days: d, level };
  });
  const healthBlocked = certRows
    .filter((r) => /健康证/.test(r.type) && r.level && (r.level === 'red' || r.level === 'expired'))
    .map((r) => r.holder || r.type);
  const storeRisks = certRows
    .filter((r) => !/健康证/.test(r.type) && r.level === 'expired')
    .map((r) => r.type || r.holder);
  const certWarnings = certRows.filter((r) => r.level && r.level !== 'green' && r.level !== 'unknown');

  // 留样（未清样才是待处理）
  let pendingSamples = 0, dueSoon = 0, sampleExpired = 0, underWeight = 0;
  for (const s of samples) {
    if (s && (s.cleared_at || s.clearedAt)) continue;
    pendingSamples += 1;
    const h = hoursLeft(s, now);
    if (h != null) {
      if (h <= 0) sampleExpired += 1;
      else if (h <= 2) dueSoon += 1;
    }
    const w = num(s && (s.weight_g != null ? s.weight_g : s.weight), 0);
    const need = /饺/.test(String((s && s.dish) || '')) ? 125 : 200;
    if (w > 0 && w < need) underWeight += 1;
  }

  // 消毒：按区域看最近执行日，早于今天视为漏做
  const areaLatest = {};
  for (const d of disinfect) {
    const area = String((d && d.area) || '未分区');
    const day = recordDay(d);
    if (day && (!areaLatest[area] || day > areaLatest[area])) areaLatest[area] = day;
  }
  const todayDisinfect = disinfect.filter((d) => recordDay(d) === today).length;
  const missedAreas = Object.keys(areaLatest).filter((a) => areaLatest[a] < today);
  const disinfectAreas = Object.keys(areaLatest).length;

  // 溯源：批次缺检验报告
  const batches = trace.length;
  const missingCert = trace.filter((t) => !(t && (t.cert_no || t.check_result))).length;

  const advice = [];
  if (storeRisks.length) advice.push(`停业风险：${storeRisks.join('、')} 已过期`);
  if (healthBlocked.length) advice.push(`健康证禁岗：${healthBlocked.join('、')}`);
  if (sampleExpired) advice.push(`留样超 48h 未销毁 ${sampleExpired} 份`);
  if (dueSoon) advice.push(`留样 2h 内到期 ${dueSoon} 份，尽快销毁登记`);
  if (underWeight) advice.push(`留样克重不足 ${underWeight} 份（饺≥125g/热菜≥200g）`);
  if (missedAreas.length) advice.push(`消毒漏做：${missedAreas.slice(0, 4).join('、')}`);
  if (missingCert) advice.push(`溯源批次待补检验报告 ${missingCert} 个`);
  if (!advice.length) advice.push('食安台账正常');

  return {
    certs: {
      by_type: byType,
      warnings: certWarnings.slice(0, 10),
      health_blocked: healthBlocked.slice(0, 8),
      store_risks: storeRisks
    },
    samples: {
      pending: pendingSamples,
      due_soon: dueSoon,
      expired: sampleExpired,
      under_weight: underWeight
    },
    disinfect: {
      areas: disinfectAreas,
      today_done: todayDisinfect,
      missed: missedAreas.slice(0, 8)
    },
    trace: { batches, missing_cert: missingCert },
    advice
  };
}

/**
 * 财务洞察：发票额度 + 税务待申报 + 现金流 + 股东分账冻结。
 * 只读聚合；开票/分账解冻仍走确认台。
 */
function financeInsight(ext, data) {
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  const cfg = (data && data.config && typeof data.config === 'object') ? data.config : {};
  const month = new Date().toISOString().slice(0, 7);

  const invoices = arr(ext.fin_invoices);
  const byDirection = {};
  const byKind = {};
  let issuedThisMonth = 0;
  for (const inv of invoices) {
    const dir = String((inv && inv.direction) || '未标');
    const kind = String((inv && inv.kind) || '未标');
    byDirection[dir] = (byDirection[dir] || 0) + n(inv && inv.amount);
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (dir.indexOf('销') >= 0 && String((inv && inv.ts) || '').indexOf(month) === 0) {
      issuedThisMonth += n(inv && inv.amount);
    }
  }
  const quota = num(cfg.invoice_quota_monthly, 50000) || 50000;
  const remaining = +(quota - issuedThisMonth).toFixed(2);
  const usagePct = quota > 0 ? +((issuedThisMonth / quota) * 100).toFixed(1) : null;

  const tax = arr(ext.fin_tax);
  let taxPayable = 0;
  const taxByKind = {};
  const taxPending = [];
  for (const t of tax) {
    const st = String((t && t.status) || '');
    const amt = n(t && t.amount);
    taxByKind[String((t && t.kind) || '税')] = +((taxByKind[String((t && t.kind) || '税')] || 0) + amt).toFixed(2);
    if (!/已申报|已缴|已完/i.test(st)) {
      taxPayable += amt;
      taxPending.push({ kind: t && t.kind, amount: amt, period: t && t.period, status: st || '待申报' });
    }
  }

  const cash = arr(ext.fin_cash);
  let income = 0, expense = 0;
  const byAccount = {};
  for (const c of cash) {
    const k = String((c && c.kind) || '');
    const amt = n(c && c.amount);
    if (/收入|收|入账/.test(k)) income += amt;
    else expense += amt;
    const acc = String((c && c.account) || '未标');
    if (!byAccount[acc]) byAccount[acc] = { income: 0, expense: 0 };
    if (/收入|收|入账/.test(k)) byAccount[acc].income += amt;
    else byAccount[acc].expense += amt;
  }
  const net = +(income - expense).toFixed(2);

  const split = arr(ext.fin_split);
  const frozen = split.filter((s) => /冻结/.test(String((s && s.status) || '')));
  const frozenAmount = +frozen.reduce((acc, s) => acc + n(s && s.amount), 0).toFixed(2);
  const frozenUntil = frozen
    .map((s) => String((s && s.frozen_until) || ''))
    .filter(Boolean)
    .sort()
    .pop() || null;

  const advice = [];
  if (usagePct != null && remaining < 0) advice.push(`发票额度已超支 ¥${Math.abs(remaining).toFixed(0)}`);
  else if (usagePct != null && usagePct >= 80) advice.push(`发票额度剩余 ${remaining.toFixed(0)}（已用 ${usagePct}%）`);
  if (taxPending.length) advice.push(`待申报税种 ${taxPending.length} 项 · 合计 ¥${taxPayable.toFixed(0)}`);
  if (net < 0) advice.push(`现金流为负 ¥${Math.abs(net).toFixed(0)}，注意支出节奏`);
  if (frozen.length) advice.push(`分账冻结 ¥${frozenAmount.toFixed(0)}${frozenUntil ? ' 至 ' + frozenUntil : ''}`);
  if (!advice.length) advice.push('财务台账平稳');

  return {
    invoices: {
      count: invoices.length,
      by_direction: byDirection,
      by_kind: byKind,
      issued_this_month: +issuedThisMonth.toFixed(2),
      quota,
      remaining,
      usage_pct: usagePct
    },
    tax: { pending_count: taxPending.length, payable: +taxPayable.toFixed(2), by_kind: taxByKind, pending: taxPending.slice(0, 6) },
    cashflow: { income: +income.toFixed(2), expense: +expense.toFixed(2), net, by_account: byAccount },
    split: { count: split.length, frozen_count: frozen.length, frozen_amount: frozenAmount, frozen_until: frozenUntil },
    advice
  };
}

/**
 * 损耗洞察：损耗率 + 原因/原料归因 + 报损审批 + 盘点差异。
 * 金额以 data.logs(kind=loss).amount 为准，审批状态以 ext.loss_reports 为准。
 */
function lossInsight(ext, data) {
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  const reports = arr(ext.loss_reports);
  const logs = arr(data && data.logs).filter((l) => l && l.kind === 'loss');
  const revenue = arr(data && data.sales).reduce((s, r) => s + salesAmount(r), 0);

  const totalAmount = logs.reduce((s, l) => s + n(l.amount), 0);
  const totalQty = logs.reduce((s, l) => s + n(l.qty), 0) +
    reports.reduce((s, r) => s + n(r.qty), 0);
  const lossRate = revenue > 0 ? +((totalAmount / revenue) * 100).toFixed(2) : null;

  const amountByReason = {};
  for (const l of logs) {
    const k = String((l && l.reason) || '未分类');
    amountByReason[k] = +(((amountByReason[k] || 0) + n(l && l.amount)).toFixed(2));
  }
  const qtyByReason = {};
  for (const r of reports) {
    const k = String((r && r.reason) || '未分类');
    qtyByReason[k] = +(((qtyByReason[k] || 0) + n(r && r.qty)).toFixed(2));
  }

  const byIng = {};
  for (const l of logs) {
    const nm = String((l && (l.name || l.ing_name)) || '未标');
    byIng[nm] = +(((byIng[nm] || 0) + n(l && l.amount)).toFixed(2));
  }
  const topIngredients = Object.keys(byIng)
    .map((name) => ({ name, amount: byIng[name] }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);
  const top = topIngredients[0];
  const topShare = (top && totalAmount > 0) ? +((top.amount / totalAmount) * 100).toFixed(1) : null;

  const isPending = (st) => !/已审|已通过|已批|驳回|作废/.test(String(st || ''));
  const pending = reports.filter((r) => isPending(r && r.status));
  const approved = reports.filter((r) => /已审|已通过|已批/.test(String((r && r.status) || ''))).length;
  const rejected = reports.filter((r) => /驳回/.test(String((r && r.status) || ''))).length;
  const bigPending = pending.filter((r) => n(r && r.amount) >= 500).length;

  const diffs = arr(ext.loss_inventory_diff);
  let lossQty = 0, overQty = 0;
  for (const d of diffs) {
    const v = n(d && (d.diff != null ? d.diff : d.qty));
    if (v < 0) lossQty += -v;
    else overQty += v;
  }

  const advice = [];
  if (lossRate != null && lossRate > 1.5) advice.push(`损耗率 ${lossRate}% 超红线 1.5%，立即复盘`);
  else if (lossRate != null && lossRate > 1) advice.push(`损耗率 ${lossRate}% 高于 1%，注意压降`);
  if (pending.length) advice.push(`报损单 ${pending.length} 张待审批`);
  if (bigPending) advice.push(`报损金额 ≥¥500 共 ${bigPending} 张，需老板二次确认`);
  if (topShare != null && topShare > 30) advice.push(`${top.name} 占损耗 ${topShare}%，重点关注`);
  if (diffs.length) advice.push(`盘点差异 ${diffs.length} 项（盘亏 ${lossQty.toFixed(1)} / 盘盈 ${overQty.toFixed(1)}）`);
  if (!advice.length) advice.push('损耗与盘点平稳');

  return {
    total_amount: +totalAmount.toFixed(2),
    total_qty: +totalQty.toFixed(2),
    records: logs.length + reports.length,
    loss_rate_pct: lossRate,
    by_reason_amount: amountByReason,
    by_reason_qty: qtyByReason,
    top_ingredients: topIngredients,
    top_share_pct: topShare,
    approvals: { pending: pending.length, approved, rejected, big_pending: bigPending },
    inventory: { diff_count: diffs.length, loss_qty: +lossQty.toFixed(2), over_qty: +overQty.toFixed(2) },
    advice
  };
}

/**
 * 口碑洞察：多平台评分聚合 + 差评归因改进闭环 + 好评素材。
 * 只读聚合；改进措施若涉配方变更仍走确认台版本化。
 */
function reviewInsight(ext, data) {
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  const reviews = arr(ext.rv_reviews);
  const improve = arr(ext.rv_improve);
  const quotes = arr(ext.rv_good_quotes);
  const platforms = arr(data && data.platforms);

  const contentOf = (r) => String((r && (r.content || r.text || r.comment)) || '');
  const ratingOf = (r) => n(r && (r.rating != null ? r.rating : r.score));

  // 平台评分：加权平均（按订单数）
  let wSum = 0, w = 0;
  const byPlatform = platforms.map((p) => {
    const rt = n(p && (p.rating != null ? p.rating : p.score));
    const orders = n(p && p.orders);
    if (rt > 0) { wSum += rt * (orders || 1); w += (orders || 1); }
    return { name: (p && p.name) || '平台', rating: rt || null, orders: orders || null };
  });
  const overallRating = w > 0 ? +(wSum / w).toFixed(2) : null;
  const localAvg = reviews.length
    ? +(reviews.reduce((s, r) => s + ratingOf(r), 0) / reviews.length).toFixed(2)
    : null;

  const KW = ['慢', '久', '等', '咸', '冷', '凉', '少', '破', '洒', '腻', '糊', '态度', '脏'];
  const bad = reviews.filter((r) => ratingOf(r) > 0 && ratingOf(r) <= 3);
  const reasons = {};
  for (const r of reviews) {
    const c = contentOf(r);
    for (const k of KW) if (c.indexOf(k) >= 0) reasons[k] = (reasons[k] || 0) + 1;
  }
  const dishNames = arr(data && data.dishes).map((d) => d && d.name).filter(Boolean);
  const dishFlags = {};
  for (const r of bad) {
    const c = contentOf(r);
    let names = arr(r && (r.dishes || (r.dish ? [r.dish] : []))).map((x) => (typeof x === 'string' ? x : (x && x.name)));
    if (!names.length && dishNames.length) names = dishNames.filter((nm) => c.indexOf(nm) >= 0);
    for (const nm of names) if (nm) dishFlags[nm] = (dishFlags[nm] || 0) + 1;
  }

  const isClosed = (st) => /已闭环|已完成|已关闭|closed|done/i.test(String(st || ''));
  const improveByStatus = {};
  const overdue = [];
  const today = todayStr();
  for (const it of improve) {
    const st = String((it && it.status) || '待处理');
    improveByStatus[st] = (improveByStatus[st] || 0) + 1;
    const due = String((it && it.due) || '');
    if (!isClosed(st) && due && due < today) overdue.push({ action: it && it.action, owner: it && it.owner, due });
  }
  const openImprove = improve.filter((it) => !isClosed(it && it.status)).length;

  const good = reviews.filter((r) => ratingOf(r) >= 4);
  const goodApproved = quotes.filter((q) => /通过|已审/.test(String((q && q.status) || ''))).length;

  const advice = [];
  if (overallRating != null && overallRating < 4.3) advice.push(`平台综合评分 ${overallRating}，需提升`);
  if (bad.length) advice.push(`差评 ${bad.length} 条待回访`);
  const topDish = Object.keys(dishFlags).sort((a, b) => dishFlags[b] - dishFlags[a]).slice(0, 3);
  if (topDish.length) advice.push(`差评涉及菜品：${topDish.join('、')}（对照菜品矩阵）`);
  if (openImprove) advice.push(`改进任务未闭环 ${openImprove} 项` + (overdue.length ? `，逾期 ${overdue.length}` : ''));
  if (good.length && quotes.length === 0) advice.push(`好评 ${good.length} 条可入库为营销素材（需审核）`);
  if (!advice.length) advice.push('口碑平稳');

  return {
    scores: { overall: overallRating, local_avg: localAvg, by_platform: byPlatform },
    bad: {
      count: bad.length,
      reasons,
      dish_flags: dishFlags,
      items: bad.slice(0, 8).map((r) => ({ source: r && r.source, rating: ratingOf(r), content: contentOf(r), ts: r && r.ts }))
    },
    improve: { total: improve.length, by_status: improveByStatus, open: openImprove, overdue: overdue.slice(0, 6) },
    good: { count: good.length, quotes_total: quotes.length, quotes_approved: goodApproved },
    advice
  };
}

/**
 * 供应链洞察：供应商档案 + 比价（价差/三选一）+ 账期账龄。
 * 只读聚合；切换供应商/更新评级走确认台。
 */
function supplyInsight(ext, data) {
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  const vendorsRaw = arr(data && data.vendors).length ? arr(data.vendors) : arr(ext.sup_vendors);
  const quotes = arr(data && data.quotes);
  const accounts = arr(ext.sup_accounts);
  const today = todayStr();

  const byCategory = {}, byStatus = {}, byPeriod = {};
  const vendors = vendorsRaw.map((v) => {
    const cat = String((v && v.category) || '未分类');
    const st = String((v && v.status) || '合作中');
    const period = String((v && v.period) || '未标');
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    byStatus[st] = (byStatus[st] || 0) + 1;
    byPeriod[period] = (byPeriod[period] || 0) + 1;
    return {
      id: (v && (v.vendor_id || v.id)) || null,
      name: (v && v.name) || String(v || ''),
      category: cat, status: st, period,
      level: (v && v.level) != null ? n(v.level) : null
    };
  });

  // 比价：按原料聚合多供应商报价，算价差与最优
  const byIng = {};
  for (const q of quotes) {
    const nm = String((q && (q.name || q.ing_name || q.ing)) || '');
    if (!nm) continue;
    if (!byIng[nm]) byIng[nm] = [];
    byIng[nm].push({ src: String((q && (q.src || q.supplier)) || '供应商'), price: n(q && q.price) });
  }
  const comparisons = Object.keys(byIng).map((nm) => {
    const list = byIng[nm].filter((x) => x.price > 0).sort((a, b) => a.price - b.price);
    if (!list.length) return null;
    const min = list[0], max = list[list.length - 1];
    const spread = min.price > 0 ? +(((max.price - min.price) / min.price) * 100).toFixed(1) : null;
    return {
      name: nm,
      candidates: list.length,
      best: { src: min.src, price: min.price },
      worst: { src: max.src, price: max.price },
      spread_pct: spread
    };
  }).filter(Boolean).sort((a, b) => (b.spread_pct || 0) - (a.spread_pct || 0));

  // 账龄：0-30 / 31-60 / 逾期
  const aging = { current: 0, over30: 0, over60: 0, overdue: 0 };
  let payable = 0;
  const overdueList = [];
  for (const a of accounts) {
    const bal = n(a && a.balance);
    payable += bal;
    const st = String((a && a.status) || '');
    const due = String((a && (a.due || a.due_date)) || '');
    if (/逾期/.test(st)) { aging.overdue += bal; overdueList.push(a && a.supplier); continue; }
    if (due && due < today) {
      const days = Math.floor((new Date(today).getTime() - new Date(due).getTime()) / 86400000);
      if (days > 60) { aging.over60 += bal; overdueList.push(a && a.supplier); }
      else if (days > 30) aging.over30 += bal;
      else aging.current += bal;
    } else {
      aging.current += bal;
    }
  }

  const advice = [];
  if (!quotes.length) advice.push('比价样本不足：推送 data.quotes 后可做三选一');
  else if (comparisons[0] && comparisons[0].spread_pct != null && comparisons[0].spread_pct > 10) {
    advice.push(`${comparisons[0].name} 价差 ${comparisons[0].spread_pct}%（${comparisons[0].best.src} 最低），建议比价`);
  }
  if (aging.overdue > 0 || aging.over60 > 0) advice.push(`应付账龄逾期 ¥${(aging.overdue + aging.over60).toFixed(0)}，需安排结算`);
  const lowRated = vendors.filter((v) => v.level != null && v.level > 0 && v.level < 3);
  if (lowRated.length) advice.push(`供应商低于 3 星 ${lowRated.length} 家，建议考察替代`);
  if (!advice.length) advice.push('供应链平稳');

  return {
    vendors: { count: vendors.length, by_category: byCategory, by_status: byStatus, by_period: byPeriod, list: vendors.slice(0, 12) },
    compare: {
      available: comparisons.length,
      spread_top: comparisons.slice(0, 6),
      note: comparisons.length ? '按报价最低为最优候选；AI 仅建议，切换需确认' : '暂无多供应商报价样本'
    },
    accounts: { count: accounts.length, payable: +payable.toFixed(2), aging, overdue_list: overdueList.slice(0, 6) },
    advice
  };
}

/**
 * 堂食收银洞察：桌台四态 + 今日实收/支付方式 + 桌均/翻台。
 * 只读聚合；改桌态/结账走确认台（pos.table_state / pos.pay）。
 */
function posInsight(ext, data) {
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  const today = todayStr();
  const raw = arr(data && data.pos).length
    ? arr(data.pos)
    : arr(ext.pos_tables).map((t) => ({ id: t.table_id, name: t.name, seats: t.capacity, state: t.status }));
  const byState = { free: 0, busy: 0, clean: 0, rsv: 0 };
  let occupied = 0, vipTables = 0;
  for (const t of raw) {
    const s = String((t && (t.state || t.status)) || 'free');
    const key = /busy|就餐|用餐|占用/.test(s) ? 'busy'
      : /clean|待清|清台/.test(s) ? 'clean'
        : /rsv|预订|预定/.test(s) ? 'rsv' : 'free';
    byState[key] += 1;
    if (key === 'busy' || key === 'rsv') occupied += 1;
    if (t && (t.vip_member_id || t.vip_name)) vipTables += 1;
  }
  const total = raw.length;
  const occupancy = total > 0 ? Math.round((occupied / total) * 100) : null;

  const pays = arr(data && data.logs).filter((l) => l && l.kind === 'pos_pay' && String(l.ts || '').slice(0, 10) === today);
  const payAmount = pays.reduce((s, p) => s + n(p && p.amount), 0);
  const byMethod = {};
  for (const p of pays) {
    const m = String((p && p.method) || '未标');
    byMethod[m] = +(((byMethod[m] || 0) + n(p && p.amount)).toFixed(2));
  }
  const dineToday = arr(data && data.sales)
    .filter((r) => String((r && (r.date || r.ts || r.time)) || '').indexOf(today) === 0 &&
      !/外卖|美团|饿了么|takeout/i.test(String((r && r.channel) || '')))
    .reduce((s, r) => s + salesAmount(r), 0);

  const advice = [];
  if (byState.clean > 0) advice.push(`待清 ${byState.clean} 桌，尽快清台翻台`);
  if (occupancy != null && occupancy >= 90) advice.push(`桌位占用 ${occupancy}%，晚峰已满，优先清台/加排`);
  if (pays.length === 0 && dineToday > 0) advice.push('今日有堂食销售但未登记结账，注意实收');
  if (!advice.length) advice.push('堂食运行平稳');

  return {
    tables: { total, by_state: byState, occupancy_pct: occupancy, vip_tables: vipTables },
    payments: {
      count: pays.length,
      amount: +payAmount.toFixed(2),
      by_method: byMethod,
      avg: pays.length ? +(payAmount / pays.length).toFixed(2) : 0
    },
    revenue: { dine_today: +dineToday.toFixed(2) },
    advice
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
      train: arr(ext.staff_train),
      insight: staffInsight(ext, snap ? snap.data : {})
    }));
    return true;
  }

  // GET /api/modules/pos — 堂食收银：桌台 + 今日实收 + 洞察
  if (pathname === '/api/modules/pos') {
    const data = (snap && snap.data) || {};
    const tables = arr(data.pos).length ? arr(data.pos) : arr(ext.pos_tables);
    const payments = arr(data.logs).filter((l) => l && l.kind === 'pos_pay');
    ctx.sendJSON(res, 200, Object.assign(base, {
      tables,
      payments,
      insight: posInsight(ext, data)
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
      serves,
      insight: bookingInsight(ext, snap ? snap.data : {}, date)
    }));
    return true;
  }

  // GET /api/modules/inspection?date=&board=&operator=&node_id=
  // 闭店巡检统筹看板（C/D 块）：板块完成率 + 漏项清单 + 历史台账 + 30 分钟轮次缺口
  if (pathname === '/api/modules/inspection') {
    const q = (ctx.query.get('date') || '').trim();
    ctx.sendJSON(res, 200, Object.assign(base, buildBoard(ext, {
      date: /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayStr(),
      board: (ctx.query.get('board') || '').trim(),
      operator: (ctx.query.get('operator') || '').trim(),
      node_id: (ctx.query.get('node_id') || '').trim(),
      limit: ctx.query.get('limit')
    })));
    return true;
  }

  // GET /api/modules/foodsafe（samples 附加 48h 倒计时 hours_left）
  if (pathname === '/api/modules/foodsafe') {
    const now = Date.now();
    const samples = arr(ext.fs_samples).map((s) =>
      Object.assign({}, s, {
        hours_left: hoursLeft(s, now),
        cleared: !!(s && (s.cleared_at || s.clearedAt)),
        expired: (() => {
          const h = hoursLeft(s, now);
          return h != null && h <= 0;
        })()
      }));
    const trace = arr(ext.fs_trace).map((t) => Object.assign({}, t, {
      name: t.name || t.ing_name || t.ingName || null,
      batch: t.batch || t.batch_no || null
    }));
    ctx.sendJSON(res, 200, Object.assign(base, {
      certs: arr(ext.fs_certs),
      trace,
      samples,
      disinfect: arr(ext.fs_disinfect),
      insight: foodsafeInsight(ext)
    }));
    return true;
  }

  // GET /api/modules/analysis（店参透传：PARAM_QUERY_MAP 全量 → 保本测算 paramOverrides）
  // 只读模拟层：仅覆盖本次请求的测算入参，不落库、不影响配方/库存/菜品主数据
  if (pathname === '/api/modules/analysis') {
    const overrides = {};
    const qnum = (k) => {
      const raw = ctx.query.get(k);
      if (raw == null || raw === '') return null;
      const v = parseFloat(raw);
      return isNaN(v) ? null : v;
    };
    let queryMap = {};
    try { queryMap = require('../lib/menu_baoben').PARAM_QUERY_MAP || {}; } catch (e) { queryMap = {}; }
    for (const q of Object.keys(queryMap)) {
      const v = qnum(q);
      if (v != null) overrides[queryMap[q]] = v;
    }
    const hasSales = !!(snap && Array.isArray(snap.data && snap.data.sales) && snap.data.sales.length > 0);
    const a = hasSales ? realAnalysis(snap, overrides) : mockAnalysis(overrides);
    ctx.sendJSON(res, 200, Object.assign(base, {
      trend: a.trend,
      heatmap: a.heatmap,
      matrix: a.matrix,
      efficiency: a.efficiency,
      compare: a.compare || null,
      forecast: a.forecast || null,
      mock: a.mock || !snap,
      note: a.note || (!snap ? NO_SNAP_MSG : undefined),
      baoben_summary: a.baoben_summary || null,
      baoben_types: a.baoben_types || (a.baoben_summary && a.baoben_summary.types) || null,
      calc_dishes: a.calc_dishes || []
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
      visits: arr(ext.vip_visits).slice(-40),
      insight: vipInsight(ext, snap ? snap.data : {})
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
      reconcile: arr(ext.takeout_reconcile),
      insight: takeoutInsight(ext, snap ? snap.data : {})
    }));
    return true;
  }

  // GET /api/modules/review
  if (pathname === '/api/modules/review') {
    ctx.sendJSON(res, 200, Object.assign(base, {
      reviews: arr(ext.rv_reviews),
      improve: arr(ext.rv_improve),
      insight: reviewInsight(ext, snap ? snap.data : {})
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
    // 归一化：last_finance_recon 存的是扁平金额（dine_in:6890），
    // 统一成 {amount,count} 通道对象，与今日 recon 同形，App DTO 才能解析（否则 last 被强制 null）
    const normChannel = (v, cntV) => (v && typeof v === 'object')
      ? { amount: num(v.amount, 0), count: num(v.count, 0) }
      : { amount: num(v, 0), count: num(cntV, 0) };
    const lastNorm = lastRecon ? {
      date: lastRecon.date || null,
      dine_in: normChannel(lastRecon.dine_in, lastRecon.dine_in_count),
      takeout: normChannel(lastRecon.takeout, lastRecon.takeout_count),
      purchase: normChannel(lastRecon.purchase, lastRecon.purchase_count),
      gap: num(lastRecon.gap, 0),
      ts: lastRecon.ts || null,
      note: lastRecon.note || null,
      confirmed: true
    } : null;
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
        last: lastNorm
      },
      insight: financeInsight(ext, data)
    }));
    return true;
  }

  // GET /api/modules/loss
  if (pathname === '/api/modules/loss') {
    ctx.sendJSON(res, 200, Object.assign(base, {
      reports: arr(ext.loss_reports),
      insight: lossInsight(ext, snap ? snap.data : {})
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
      })),
      insight: supplyInsight(ext, snap ? snap.data : {})
    }));
    return true;
  }

  return false;
}

module.exports = { handle, equipmentTemps, buildForecast, equipmentEnergySummary, bookingInsight, takeoutInsight, vipInsight, staffInsight, foodsafeInsight, financeInsight, lossInsight, reviewInsight, supplyInsight, posInsight, realAnalysis, mockAnalysis };
