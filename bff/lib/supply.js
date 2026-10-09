'use strict';
/*
 * lib/supply.js — 供应商档案 / 比价 / 往来账龄 纯逻辑（M10-T2/T4/T5）
 *
 * 纯函数，无 IO。数据源为快照
 *   data.vendors | ext.sup_vendors（档案）/ data.quotes | ext.sup_prices（报价）/ ext.sup_accounts（往来账）
 *
 * 运营口径：
 *   档案（M10-T2）：按品类/状态/账期归集；评级 < low_level 记「低评级」，建议考察替代。
 *   比价（M10-T4）：同原料多供应商报价 → 价差（最高 vs 最低）；价差 > spread_warn_pct 告警；最低价为最优候选（AI 仅建议）。
 *   账龄（M10-T4）：应付余额按 0-30 / 31-60 / >60 / 逾期 分桶；>60 与逾期并入「需结算」。
 *   阈值一律可配（BFF 本地 supply_config.json）。
 */

const DAY_MS = 86400000;
const SPREAD_WARN_PCT = 10;
const AGING_OVER30_D = 30;
const AGING_OVER60_D = 60;
const LOW_LEVEL = 3;

const DEFAULT_CONFIG = {
  spread_warn_pct: SPREAD_WARN_PCT,
  aging_over30_d: AGING_OVER30_D,
  aging_over60_d: AGING_OVER60_D,
  low_level: LOW_LEVEL
};

function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return v == null ? '' : String(v).trim(); }
function num(v, d) { const x = parseFloat(v); return Number.isNaN(x) ? (d === undefined ? 0 : d) : x; }
function r2(v) { return v == null ? v : Math.round(v * 100) / 100; }
function dayStr(d) { return new Date(d).toISOString().slice(0, 10); }

function configOf(cfg) {
  const c = (cfg && cfg.supply) || cfg || {};
  return {
    spread_warn_pct: c.spread_warn_pct == null ? DEFAULT_CONFIG.spread_warn_pct : num(c.spread_warn_pct, DEFAULT_CONFIG.spread_warn_pct),
    aging_over30_d: c.aging_over30_d == null ? DEFAULT_CONFIG.aging_over30_d : num(c.aging_over30_d, DEFAULT_CONFIG.aging_over30_d),
    aging_over60_d: c.aging_over60_d == null ? DEFAULT_CONFIG.aging_over60_d : num(c.aging_over60_d, DEFAULT_CONFIG.aging_over60_d),
    low_level: c.low_level == null ? DEFAULT_CONFIG.low_level : num(c.low_level, DEFAULT_CONFIG.low_level)
  };
}

/* ---------------- 供应商档案 ---------------- */

function normVendor(v) {
  if (typeof v === 'string') return { id: null, name: v, category: '未分类', status: '合作中', period: '未标', level: null, contact: null, phone: null };
  return {
    id: (v && (v.vendor_id || v.id)) || null,
    name: str(v && v.name) || String(v || ''),
    category: str(v && v.category) || '未分类',
    status: str(v && v.status) || '合作中',
    period: str(v && (v.period || v.settle)) || '未标',
    level: v && (v.level != null || v.rating != null) ? num(v.level != null ? v.level : v.rating) : null,
    contact: str(v && v.contact) || null,
    phone: str(v && v.phone) || null
  };
}

/** 供应商档案：按品类/状态/账期归集 + 低评级清单 */
function vendorsReport(ext, data, cfg) {
  const conf = configOf(cfg);
  const raw = arr(data && data.vendors).length ? arr(data.vendors) : arr(ext && ext.sup_vendors);
  const byCategory = {};
  const byStatus = {};
  const byPeriod = {};
  const rows = raw.map(normVendor);
  rows.forEach((v) => {
    byCategory[v.category] = (byCategory[v.category] || 0) + 1;
    byStatus[v.status] = (byStatus[v.status] || 0) + 1;
    byPeriod[v.period] = (byPeriod[v.period] || 0) + 1;
  });
  const lowRated = rows.filter((v) => v.level != null && v.level > 0 && v.level < conf.low_level);

  const advice = [];
  if (lowRated.length) advice.push(`供应商低于 ${conf.low_level} 星 ${lowRated.length} 家，建议考察替代`);
  if (!rows.length) advice.push('暂无供应商档案');
  if (!advice.length) advice.push('供应商档案正常');

  return {
    rows,
    count: rows.length,
    by_category: byCategory,
    by_status: byStatus,
    by_period: byPeriod,
    low_rated: lowRated.map((v) => v.name),
    advice
  };
}

/* ---------------- 比价 ---------------- */

function normQuote(q, vendorName) {
  const ing = str(q && (q.name || q.ing_name || q.ing));
  const src = str(q && (q.src || q.supplier)) || vendorName || '供应商';
  return { ing, src, price: num(q && q.price, 0), unit: str(q && q.unit) || null, date: str(q && (q.date || q.quoted_at)) || null };
}

/** 同原料多供应商比价：最低为最优候选，价差 = (最高-最低)/最低 */
function compareReport(ext, data, cfg) {
  const conf = configOf(cfg);
  const raw = arr(data && data.quotes).length ? arr(data.quotes) : arr(ext && ext.sup_prices);
  const byIng = {};
  raw.forEach((q) => {
    const n = normQuote(q);
    if (!n.ing || n.price <= 0) return;
    (byIng[n.ing] = byIng[n.ing] || []).push(n);
  });
  const comparisons = Object.keys(byIng).map((nm) => {
    const list = byIng[nm].slice().sort((a, b) => a.price - b.price);
    const min = list[0];
    const max = list[list.length - 1];
    const spread = min.price > 0 ? Math.round(((max.price - min.price) / min.price) * 1000) / 10 : null;
    return {
      name: nm,
      candidates: list.length,
      best: { src: min.src, price: min.price },
      worst: { src: max.src, price: max.price },
      spread_pct: spread,
      quotes: list
    };
  }).sort((a, b) => (b.spread_pct || 0) - (a.spread_pct || 0));

  const top = comparisons[0];
  const advice = [];
  if (!comparisons.length) advice.push('比价样本不足：推送 data.quotes 后可做三选一');
  else if (top && top.spread_pct != null && top.spread_pct > conf.spread_warn_pct) {
    advice.push(`${top.name} 价差 ${top.spread_pct}%（${top.best.src} 最低），建议比价`);
  }
  if (!advice.length) advice.push('比价平稳');

  return {
    available: comparisons.length,
    rows: comparisons,
    spread_top: comparisons.slice(0, 6),
    warn_pct: conf.spread_warn_pct,
    advice
  };
}

/* ---------------- 往来账龄 ---------------- */

function normAccount(a) {
  return {
    id: a && a.id != null ? a.id : null,
    supplier: str(a && (a.supplier || a.vendor_id || a.name)) || '未标',
    balance: num(a && (a.balance != null ? a.balance : a.amount), 0),
    kind: str(a && a.kind) || '应付',
    due: str(a && (a.due || a.due_date)) || null,
    status: str(a && a.status) || ''
  };
}

/** 应付账龄：0-30 / 31-60 / >60 / 逾期 分桶 */
function accountsReport(ext, cfg, now) {
  const conf = configOf(cfg);
  const at = now == null ? Date.now() : now;
  const today = dayStr(at);
  const rows = arr(ext && ext.sup_accounts).map(normAccount);
  const aging = { current: 0, over30: 0, over60: 0, overdue: 0 };
  let payable = 0;
  const overdueList = [];
  rows.forEach((a) => {
    payable += a.balance;
    const due = a.due;
    const overdueByStatus = /逾期/.test(a.status);
    let bucket = 'current';
    if (overdueByStatus) bucket = 'overdue';
    else if (due && due < today) {
      const days = Math.floor((new Date(today + 'T00:00:00Z').getTime() - new Date(due + 'T00:00:00Z').getTime()) / DAY_MS);
      if (days > conf.aging_over60_d) bucket = 'over60';
      else if (days > conf.aging_over30_d) bucket = 'over30';
    }
    aging[bucket] += a.balance;
    if (bucket === 'over60' || bucket === 'overdue') overdueList.push({ supplier: a.supplier, balance: a.balance, due, status: a.status, bucket });
  });
  ['current', 'over30', 'over60', 'overdue'].forEach((k) => { aging[k] = r2(aging[k]); });

  const needSettle = r2(aging.over60 + aging.overdue);
  const advice = [];
  if (needSettle > 0) advice.push(`应付账龄逾期 ¥${needSettle.toFixed(0)}，需安排结算`);
  if (!rows.length) advice.push('暂无供应商往来账');
  if (!advice.length) advice.push('往来账龄正常');

  return {
    rows,
    count: rows.length,
    payable: r2(payable),
    aging,
    need_settle: needSettle,
    overdue_list: overdueList.slice(0, 8),
    over30_d: conf.aging_over30_d,
    over60_d: conf.aging_over60_d,
    advice
  };
}

/* ---------------- 汇总 ---------------- */

function overviewReport(ext, data, cfg, now) {
  const vendors = vendorsReport(ext, data, cfg);
  const compare = compareReport(ext, data, cfg);
  const accounts = accountsReport(ext, cfg, now);
  const alerts = [];
  const top = compare.rows[0];
  if (top && top.spread_pct != null && top.spread_pct > compare.warn_pct) {
    alerts.push({ level: 'orange', text: `${top.name} 价差 ${top.spread_pct}%（${top.best.src} 最低）` });
  }
  if (accounts.aging.overdue > 0) alerts.push({ level: 'red', text: `供应商逾期应付 ¥${accounts.aging.overdue.toFixed(0)}` });
  if (accounts.aging.over60 > 0) alerts.push({ level: 'orange', text: `应付超 60 天 ¥${accounts.aging.over60.toFixed(0)}` });
  if (vendors.low_rated.length) alerts.push({ level: 'yellow', text: `低评级供应商 ${vendors.low_rated.length} 家` });
  return {
    vendors: { count: vendors.count, by_category: vendors.by_category, low_rated: vendors.low_rated.length },
    compare: { available: compare.available, top: top ? { name: top.name, spread_pct: top.spread_pct, best: top.best } : null },
    accounts: { count: accounts.count, payable: accounts.payable, aging: accounts.aging, need_settle: accounts.need_settle },
    alerts,
    advice: [].concat(vendors.advice, compare.advice, accounts.advice)
  };
}

module.exports = {
  DAY_MS,
  SPREAD_WARN_PCT,
  AGING_OVER30_D,
  AGING_OVER60_D,
  LOW_LEVEL,
  DEFAULT_CONFIG,
  configOf,
  normVendor,
  vendorsReport,
  normQuote,
  compareReport,
  normAccount,
  accountsReport,
  overviewReport
};
