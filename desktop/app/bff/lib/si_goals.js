'use strict';
/*
 * lib/si_goals.js — SI 经营目标引擎
 *
 * 老板设目标（毛利率/损耗/保本达成/客单价/日均营收），SI 用只读快照持续评估：
 *   current / target / status(on_track|at_risk|off_track) / gap / advice / route
 * 红线：只读聚合，不写业务数据；目标值本身存 si_goals.json。
 */
const store = require('./store');

const FILE = 'si_goals.json';

const DEFAULT_GOALS = [
  { id: 'gross_margin', label: '综合毛利率', metric: 'gross_margin_pct', target: 31, unit: '%', dir: 'gte', route: 'm/analysis' },
  { id: 'loss_rate', label: '损耗率', metric: 'loss_rate_pct', target: 1.0, unit: '%', dir: 'lte', route: 'm/loss' },
  { id: 'breakeven', label: '保本达成', metric: 'breakeven_attain_pct', target: 100, unit: '%', dir: 'gte', route: 'm/analysis' },
  { id: 'avg_ticket', label: '客单价', metric: 'avg_ticket', target: 120, unit: '元', dir: 'gte', route: 'm/vip' },
  { id: 'daily_revenue', label: '日均营收', metric: 'daily_avg_revenue', target: 10000, unit: '元', dir: 'gte', route: 'm/analysis' }
];

function loadGoals() {
  const g = store.readJSON(FILE, null);
  if (!Array.isArray(g) || !g.length) return JSON.parse(JSON.stringify(DEFAULT_GOALS));
  // 合并默认项：允许只覆盖 target
  const byId = {};
  for (const x of g) if (x && x.id) byId[x.id] = x;
  return DEFAULT_GOALS.map((d) => Object.assign({}, d, byId[d.id] || {}));
}

function saveGoals(list) {
  store.writeJSON(FILE, list);
  return loadGoals();
}

function upsertGoal(patch) {
  const list = loadGoals();
  const idx = list.findIndex((g) => g.id === patch.id);
  if (idx >= 0) list[idx] = Object.assign({}, list[idx], patch);
  else list.push(Object.assign({ id: 'goal_' + Date.now().toString(36) }, patch));
  return saveGoals(list);
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

/** 从快照推导 5 个指标（确定性） */
function computeMetrics(snap) {
  const data = (snap && snap.data) || {};
  const ext = (snap && snap.ext && typeof snap.ext === 'object') ? snap.ext : {};
  const sales = Array.isArray(data.sales) ? data.sales : [];

  const amountOf = (r) => {
    for (const k of ['amount', 'total', 'revenue', 'price', 'money']) {
      const v = parseFloat(r && r[k]);
      if (!isNaN(v)) return v;
    }
    return 0;
  };
  const dayOf = (r) => String(r && (r.date || r.ts || r.time || r.created_at) || '').slice(0, 10);

  const byDay = {};
  let totalRev = 0;
  for (const r of sales) {
    const v = amountOf(r);
    totalRev += v;
    const d = dayOf(r);
    if (d) byDay[d] = (byDay[d] || 0) + v;
  }
  const days = Object.keys(byDay).length || 0;
  const dailyAvg = days ? totalRev / days : 0;

  const today = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  })();
  const todayRows = sales.filter((r) => dayOf(r) === today);
  const todayRev = todayRows.reduce((s, r) => s + amountOf(r), 0);
  const todayOrders = todayRows.length;

  // 毛利率（菜品口径）：100 - 菜品成本率
  let grossMargin = null;
  let beDay = null;
  try {
    const { computeBaobenSummary } = require('./menu_baoben');
    const s = computeBaobenSummary();
    if (s && s.kpi) {
      if (s.kpi.dish_cost_rate != null) grossMargin = +(100 - s.kpi.dish_cost_rate).toFixed(1);
      if (s.kpi.be_day != null) beDay = s.kpi.be_day;
    }
  } catch (e) { /* 价盘缺失 */ }

  const breakevenAttain = (beDay && beDay > 0) ? +((todayRev / beDay) * 100).toFixed(1) : null;

  // 损耗率：近 30 日报损 / 同期营收
  const lossReports = Array.isArray(ext.loss_reports) ? ext.loss_reports : [];
  const lossTotal = lossReports.reduce((s, r) => {
    const v = parseFloat(r && (r.amount != null ? r.amount : r.total));
    return s + (isNaN(v) ? 0 : v);
  }, 0);
  const lossRate = totalRev > 0 ? +((lossTotal / totalRev) * 100).toFixed(2) : null;

  return {
    gross_margin_pct: grossMargin,
    loss_rate_pct: lossRate,
    breakeven_attain_pct: breakevenAttain,
    avg_ticket: todayOrders ? +(todayRev / todayOrders).toFixed(2) : (days ? +(totalRev / sales.length).toFixed(2) : null),
    daily_avg_revenue: dailyAvg ? +dailyAvg.toFixed(2) : null,
    _today_revenue: +todayRev.toFixed(2),
    _breakeven_day: beDay
  };
}

function statusOf(value, target, dir) {
  if (value == null) return 'unknown';
  if (dir === 'lte') {
    if (value <= target) return 'on_track';
    if (value <= target * 1.1) return 'at_risk';
    return 'off_track';
  }
  if (value >= target) return 'on_track';
  if (value >= target * 0.9) return 'at_risk';
  return 'off_track';
}

function adviceOf(goal, value, snap) {
  if (value == null) return { text: '数据不足（暂无销售/成本样本），先补齐快照', route: goal.route };
  switch (goal.metric) {
    case 'gross_margin_pct':
      return { text: '低于目标：查毛利最低的菜，考虑调价或换辅料（须确认台）', route: 'm/analysis' };
    case 'loss_rate_pct':
      return { text: '损耗偏高：收紧报损审批、盘一次库看差异', route: 'm/loss' };
    case 'breakeven_attain_pct':
      return { text: '未达保本：晚峰加推套餐/爆品，盯时段热力低谷', route: 'm/analysis' };
    case 'avg_ticket':
      return { text: '客单偏低：上会员券/加购推荐，拉高组合客单', route: 'm/vip' };
    case 'daily_revenue':
      return { text: '日均偏低：看波士顿矩阵，砍瘦狗、强明星', route: 'm/analysis' };
    default:
      return { text: '继续跟踪', route: goal.route };
  }
}

/** 评估全部目标 */
function evaluate(snap) {
  const goals = loadGoals();
  const m = computeMetrics(snap);
  const items = goals.map((g) => {
    const value = m[g.metric];
    const status = statusOf(value, g.target, g.dir);
    const gap = (value == null) ? null
      : (g.dir === 'lte' ? +(value - g.target).toFixed(2) : +(g.target - value).toFixed(2));
    const adv = (status === 'on_track') ? { text: '达标，保持', route: g.route } : adviceOf(g, value, snap);
    return {
      id: g.id, label: g.label, metric: g.metric,
      target: g.target, unit: g.unit, dir: g.dir,
      current: value, status, gap,
      advice: adv.text, route: adv.route
    };
  });
  const onTrack = items.filter((i) => i.status === 'on_track').length;
  return {
    ok: true,
    metrics: m,
    items,
    score: items.length ? Math.round((onTrack / items.length) * 100) : 0,
    updated_at: new Date().toISOString(),
    rev: snap ? snap.rev : null
  };
}

module.exports = { loadGoals, saveGoals, upsertGoal, evaluate, computeMetrics, DEFAULT_GOALS, FILE };
