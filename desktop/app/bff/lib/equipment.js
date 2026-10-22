'use strict';
/*
 * lib/equipment.js — 设备温度 / 维保 / 能耗 纯逻辑（M8-T2/T4/T5）
 *
 * 纯函数，无 IO：便于单测与路由复用。数据源为快照
 *   ext.eq_temps | ext.eq_temp（冷柜温度）/ ext.eq_maintain（维保）/ ext.eq_energy（能耗）+ data.sales（营收）
 *
 * 监管/运营口径：
 *   温度（M8-T2）：分品类上限——冷冻 ≤ -15℃ / 蔬菜 ≤ 8℃ / 其余冷藏 ≤ 5℃；
 *     超限 over（距上限 warn_margin 内记「临界」）；超温持续 ≥ over_alert_min 分钟升级「严重 critical」。
 *   维保（M8-T5）：按设备取最近一次维保，next_due = 显式 next_due 或 上次 ts + 周期；
 *     分级 overdue（逾期）/ due_soon（临期）/ ok / unknown。
 *   能耗（M8-T4）：燃气/水/电成本汇总 + 占总营收比 + 月度预算超支告警。
 *   阈值全部可配（BFF 本地 equipment_config.json）。
 */

const DAY_MS = 86400000;

const TEMP_LIMITS = { 冷冻: -15, 蔬菜: 8, 冷藏: 5 };
const TEMP_WARN_MARGIN = 0.5;   // 距上限 0.5℃ 内记「临界」
const OVER_ALERT_MIN = 15;      // 超温持续 ≥15 分钟升级「严重」

const DEFAULT_CONFIG = {
  temps: { 冷藏: 5, 冷冻: -15, 蔬菜: 8 },
  warn_margin: TEMP_WARN_MARGIN,
  over_alert_min: OVER_ALERT_MIN,
  maintain_interval_d: 30,      // 维保周期（天）
  maintain_due_soon_d: 7,       // 维保临期窗口（天）
  energy_budget: 5000           // 月度能耗预算（元），用于超支告警
};

function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return v == null ? '' : String(v).trim(); }
function num(v, d) { const x = parseFloat(v); return Number.isNaN(x) ? (d === undefined ? 0 : d) : x; }
function r1(v) { return v == null ? v : Math.round(v * 10) / 10; }
function r2(v) { return v == null ? v : Math.round(v * 100) / 100; }

/** 生效配置：cfg.equipment > cfg > 默认（深合并 temps） */
function configOf(cfg) {
  const c = (cfg && cfg.equipment) || cfg || {};
  const temps = Object.assign({}, DEFAULT_CONFIG.temps, (c && c.temps) || {});
  return {
    temps,
    warn_margin: c.warn_margin == null ? DEFAULT_CONFIG.warn_margin : num(c.warn_margin, DEFAULT_CONFIG.warn_margin),
    over_alert_min: c.over_alert_min == null ? DEFAULT_CONFIG.over_alert_min : num(c.over_alert_min, DEFAULT_CONFIG.over_alert_min),
    maintain_interval_d: c.maintain_interval_d == null ? DEFAULT_CONFIG.maintain_interval_d : num(c.maintain_interval_d, DEFAULT_CONFIG.maintain_interval_d),
    maintain_due_soon_d: c.maintain_due_soon_d == null ? DEFAULT_CONFIG.maintain_due_soon_d : num(c.maintain_due_soon_d, DEFAULT_CONFIG.maintain_due_soon_d),
    energy_budget: c.energy_budget == null ? DEFAULT_CONFIG.energy_budget : num(c.energy_budget, DEFAULT_CONFIG.energy_budget)
  };
}

/** 品类温度上限：配置优先，其次按关键词归类 */
function limitOf(kind, conf) {
  const lim = (conf && conf.temps) || TEMP_LIMITS;
  const k = str(kind);
  if (lim[k] != null) return num(lim[k]);
  if (/冷冻|冻/.test(k)) return num(lim['冷冻'], TEMP_LIMITS['冷冻']);
  if (/蔬菜|菜/.test(k)) return num(lim['蔬菜'], TEMP_LIMITS['蔬菜']);
  return num(lim['冷藏'], TEMP_LIMITS['冷藏']);
}

/* ---------------- 温度 ---------------- */

/** 单设备温度评级：统一「temp > max 即超温」（冷冻 max=-15，故高于 -15 为超温） */
function tempLevel(temp, max, minutes, conf) {
  const margin = (conf && conf.warn_margin != null) ? conf.warn_margin : TEMP_WARN_MARGIN;
  const alertMin = (conf && conf.over_alert_min != null) ? conf.over_alert_min : OVER_ALERT_MIN;
  if (temp == null || Number.isNaN(temp)) return { level: 'unknown', over: false };
  if (temp > max) {
    const critical = num(minutes, 0) >= alertMin;
    return { level: critical ? 'critical' : 'over', over: true };
  }
  if (temp > max - margin) return { level: 'warn', over: false };
  return { level: 'ok', over: false };
}

/** 归一化设备温度行（兼容 eq_temps 表行 与 eq_temp 时序点按设备聚合） */
function normTemps(ext) {
  const tableRows = arr(ext && ext.eq_temps);
  if (tableRows.length) {
    return tableRows.map((t) => ({
      device: str(t.device || t.name) || '冷柜',
      kind: str(t.kind || t.zone) || '冷藏',
      temp: t.temp != null ? num(t.temp) : (t.celsius != null ? num(t.celsius) : null),
      max: t.max != null ? num(t.max) : (t.limit != null ? num(t.limit) : null),
      minutes: t.minutes != null ? num(t.minutes) : 0,
      history: arr(t.history).map((h) => num(h)).filter((n) => !Number.isNaN(n))
    }));
  }
  const points = arr(ext && ext.eq_temp).slice().sort((a, b) => str(a.ts).localeCompare(str(b.ts)));
  const byDev = {};
  for (const p of points) {
    const d = str(p.device || p.name) || '冷柜';
    (byDev[d] = byDev[d] || []).push(p);
  }
  return Object.keys(byDev).map((d) => {
    const hist = byDev[d];
    const last = hist[hist.length - 1] || {};
    return {
      device: d,
      kind: str(last.kind || last.zone) || '冷藏',
      temp: last.temp != null ? num(last.temp) : (last.celsius != null ? num(last.celsius) : null),
      max: last.max != null ? num(last.max) : null,
      minutes: last.minutes != null ? num(last.minutes) : 0,
      history: hist.map((h) => num(h.temp != null ? h.temp : h.celsius)).filter((n) => !Number.isNaN(n))
    };
  });
}

/** 温度台账 + 超温告警（M8-T2） */
function tempsReport(ext, cfg) {
  const conf = configOf(cfg);
  const rows = normTemps(ext).map((d) => {
    const max = d.max != null ? d.max : limitOf(d.kind, conf);
    const g = tempLevel(d.temp, max, d.minutes, conf);
    return {
      device: d.device,
      kind: d.kind,
      temp: d.temp,
      max,
      minutes: d.minutes,
      history: d.history,
      margin: d.temp == null ? null : r1(max - d.temp),
      level: g.level,
      // 兼容旧读层：status over / ok
      status: g.over ? 'over' : 'ok',
      over: g.over
    };
  });
  rows.sort((a, b) => (b.over ? 1 : 0) - (a.over ? 1 : 0) ||
    String(a.device).localeCompare(String(b.device)));

  const counts = { critical: 0, over: 0, warn: 0, ok: 0, unknown: 0 };
  rows.forEach((x) => { counts[x.level] = (counts[x.level] || 0) + 1; });

  const overs = rows.filter((x) => x.over);
  const alerts = overs.map((x) => ({
    device: x.device,
    kind: x.kind,
    level: x.level === 'critical' ? 'red' : 'orange',
    text: `${x.device}（${x.kind}）${x.temp}℃ 超上限 ${x.max}℃${x.minutes ? '，已持续 ' + x.minutes + ' 分钟' : ''}`
  }));

  const advice = [];
  if (overs.length) advice.push(`冷柜超温 ${overs.length} 台：${overs.map((x) => x.device).join('、')}`);
  if (counts.warn) advice.push(`${counts.warn} 台接近上限，建议关注`);
  if (!advice.length) advice.push('全部冷柜温度正常');

  return { rows, counts, over: overs.length, alerts, advice, limits: conf.temps, mock: !normTemps(ext).length };
}

/* ---------------- 维保 ---------------- */

function normMaintain(ext) {
  return arr(ext && ext.eq_maintain).map((m) => ({
    id: m && m.id != null ? m.id : null,
    device: str(m && m.device) || '-',
    kind: str(m && m.kind) || '保养',
    ts: str(m && m.ts) || null,
    operator: str(m && (m.operator || m.by)) || null,
    cost: m && m.cost != null ? num(m.cost) : null,
    next_due: str(m && m.next_due) || null,
    note: str(m && m.note) || null
  }));
}

function tsMs(v) {
  const t = new Date(str(v)).getTime();
  return Number.isNaN(t) ? null : t;
}

/** 维保计划：按设备取最近一次维保 → next_due → 分级 overdue/due_soon/ok/unknown */
function maintainReport(ext, cfg, now) {
  const conf = configOf(cfg);
  const at = now == null ? Date.now() : now;
  const rows = normMaintain(ext);
  const byDev = {};
  rows.forEach((m) => { (byDev[m.device] = byDev[m.device] || []).push(m); });

  const devices = Object.keys(byDev).map((dev) => {
    const list = byDev[dev].slice().sort((a, b) => str(b.ts).localeCompare(str(a.ts)));
    const last = list[0] || {};
    let due = tsMs(last.next_due);
    if (due == null) {
      const t = tsMs(last.ts);
      if (t != null) due = t + conf.maintain_interval_d * DAY_MS;
    }
    const days = due == null ? null : Math.ceil((due - at) / DAY_MS);
    let level = 'unknown';
    if (days != null) level = days < 0 ? 'overdue' : (days <= conf.maintain_due_soon_d ? 'due_soon' : 'ok');
    return {
      device: dev,
      kind: last.kind,
      last_ts: last.ts,
      operator: last.operator,
      next_due: due == null ? null : new Date(due).toISOString(),
      days_left: days,
      level,
      count: list.length,
      total_cost: r2(list.reduce((s, m) => s + num(m.cost, 0), 0))
    };
  });
  devices.sort((a, b) => {
    const da = a.days_left == null ? 1e9 : a.days_left;
    const db = b.days_left == null ? 1e9 : b.days_left;
    return da - db || String(a.device).localeCompare(String(b.device));
  });

  const counts = { overdue: 0, due_soon: 0, ok: 0, unknown: 0 };
  devices.forEach((d) => { counts[d.level] = (counts[d.level] || 0) + 1; });

  const advice = [];
  const overdue = devices.filter((d) => d.level === 'overdue').map((d) => d.device);
  const soon = devices.filter((d) => d.level === 'due_soon').map((d) => d.device);
  if (overdue.length) advice.push(`维保逾期：${overdue.join('、')}`);
  if (soon.length) advice.push(`维保 ${conf.maintain_due_soon_d} 天内到期：${soon.join('、')}`);
  if (!advice.length) advice.push('维保计划正常');

  return {
    rows,
    devices,
    counts,
    interval_d: conf.maintain_interval_d,
    due_soon_d: conf.maintain_due_soon_d,
    advice
  };
}

/* ---------------- 能耗 ---------------- */

function salesAmount(row) {
  for (const k of ['amount', 'total', 'revenue', 'price', 'money', '金额']) {
    const v = parseFloat(row && row[k]);
    if (!Number.isNaN(v)) return v;
  }
  return 0;
}

function normEnergy(ext) {
  return arr(ext && ext.eq_energy).map((e) => ({
    id: e && e.id != null ? e.id : null,
    date: str(e && e.date) || null,
    device: str(e && e.device) || '-',
    kind: str(e && (e.kind || e.type)) || '-',
    reading: e && e.reading != null ? num(e.reading) : null,
    usage: e && e.usage != null ? num(e.usage) : (e && e.amount != null ? num(e.amount) : null)
  }));
}

function bucketOf(kind) {
  const k = str(kind);
  if (/气|燃气/.test(k)) return '燃气';
  if (/水/.test(k)) return '水';
  return '电';
}

/** 能耗汇总：燃气/水/电成本 + 占总营收比 + 预算超支告警（M8-T4） */
function energyReport(ext, data, cfg) {
  const conf = configOf(cfg);
  const rows = normEnergy(ext);
  const buckets = { 燃气: 0, 水: 0, 电: 0 };
  rows.forEach((e) => {
    const usage = num(e.usage, 0);
    const cost = usage * (e.kind.includes('气') ? 3.2 : e.kind.includes('水') ? 4 : 0.8);
    buckets[bucketOf(e.kind)] += usage > 0 ? cost : 0;
  });
  const total = r2(buckets['燃气'] + buckets['水'] + buckets['电']);
  const revenue = r2(arr(data && data.sales).reduce((s, r) => s + salesAmount(r), 0));
  const max = Math.max(buckets['燃气'], buckets['水'], buckets['电'], 1);
  const items = Object.keys(buckets).map((k) => ({
    kind: k,
    amount: Math.round(buckets[k]),
    pct: Math.round((buckets[k] / max) * 100)
  }));
  const budget = conf.energy_budget;
  const overBudget = budget > 0 && total > budget;

  const advice = [];
  if (total <= 0) advice.push('暂无能耗抄表数据');
  else if (overBudget) advice.push(`能耗 ${total} 元已超月度预算 ${budget} 元`);
  else advice.push(`能耗 ${total} 元，预算内（${budget} 元）`);

  return {
    rows,
    items,
    total,
    revenue,
    ratio: revenue > 0 ? r1((total / revenue) * 100) : null,
    budget,
    over_budget: overBudget,
    mock: total <= 0,
    advice
  };
}

/* ---------------- 汇总 ---------------- */

function overviewReport(ext, data, cfg, now) {
  const temps = tempsReport(ext, cfg);
  const maintain = maintainReport(ext, cfg, now);
  const energy = energyReport(ext, data, cfg);
  const alerts = [];
  temps.alerts.forEach((a) => alerts.push({ level: a.level, text: a.text }));
  maintain.devices.filter((d) => d.level === 'overdue').forEach((d) => alerts.push({ level: 'red', text: `${d.device} 维保逾期 ${Math.abs(d.days_left)} 天` }));
  maintain.devices.filter((d) => d.level === 'due_soon').forEach((d) => alerts.push({ level: 'yellow', text: `${d.device} 维保 ${d.days_left} 天内到期` }));
  if (energy.over_budget) alerts.push({ level: 'orange', text: `能耗超预算：${energy.total} / ${energy.budget} 元` });
  return {
    temps: { total: temps.rows.length, over: temps.over, counts: temps.counts },
    maintain: { counts: maintain.counts, interval_d: maintain.interval_d },
    energy: { total: energy.total, budget: energy.budget, ratio: energy.ratio, over_budget: energy.over_budget, mock: energy.mock },
    alerts,
    advice: [].concat(temps.advice, maintain.advice, energy.advice)
  };
}

module.exports = {
  DAY_MS,
  TEMP_LIMITS,
  TEMP_WARN_MARGIN,
  OVER_ALERT_MIN,
  DEFAULT_CONFIG,
  configOf,
  limitOf,
  tempLevel,
  normTemps,
  tempsReport,
  normMaintain,
  maintainReport,
  salesAmount,
  normEnergy,
  energyReport,
  overviewReport
};
