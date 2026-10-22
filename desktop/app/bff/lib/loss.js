'use strict';
/*
 * lib/loss.js — 损耗率 / 报损审批 / 盘点差异 纯逻辑（M12-T2/T4/T5）
 *
 * 纯函数，无 IO。数据源为快照
 *   data.logs(kind=loss)（损耗流水）/ ext.loss_reports（报损单）/ ext.loss_inventory_diff（盘点差异）+ data.sales
 *
 * 监管/运营口径：
 *   损耗率（M12-T2）：损耗金额 / 营收；> redline(1.5%) 复盘，> warn(1.0%) 压降。
 *   报损审批（M12-T5）：status 待审核 → 已审批（扣库存）/ 已驳回（不扣）；金额 ≥ big_amount 需老板二次确认。
 *   盘点差异（M12-T4）：diff<0 记盘亏、>0 记盘盈；本表仅登记，不改库存（红线：库存以重放为准）。
 *   阈值一律可配（BFF 本地 loss_config.json）。
 */

const LOSS_RATE_WARN = 1.0;
const LOSS_RATE_REDLINE = 1.5;
const BIG_AMOUNT = 500;
const TOP_SHARE_WARN = 30;

const DEFAULT_CONFIG = {
  loss_rate_warn: LOSS_RATE_WARN,
  loss_rate_redline: LOSS_RATE_REDLINE,
  big_amount: BIG_AMOUNT,
  top_share_warn: TOP_SHARE_WARN
};

function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return v == null ? '' : String(v).trim(); }
function num(v, d) { const x = parseFloat(v); return Number.isNaN(x) ? (d === undefined ? 0 : d) : x; }
function r2(v) { return v == null ? v : Math.round(v * 100) / 100; }

function configOf(cfg) {
  const c = (cfg && cfg.loss) || cfg || {};
  return {
    loss_rate_warn: c.loss_rate_warn == null ? DEFAULT_CONFIG.loss_rate_warn : num(c.loss_rate_warn, DEFAULT_CONFIG.loss_rate_warn),
    loss_rate_redline: c.loss_rate_redline == null ? DEFAULT_CONFIG.loss_rate_redline : num(c.loss_rate_redline, DEFAULT_CONFIG.loss_rate_redline),
    big_amount: c.big_amount == null ? DEFAULT_CONFIG.big_amount : num(c.big_amount, DEFAULT_CONFIG.big_amount),
    top_share_warn: c.top_share_warn == null ? DEFAULT_CONFIG.top_share_warn : num(c.top_share_warn, DEFAULT_CONFIG.top_share_warn)
  };
}

function salesAmount(row) {
  for (const k of ['amount', 'total', 'revenue', 'price', 'money', '金额']) {
    const v = parseFloat(row && row[k]);
    if (!Number.isNaN(v)) return v;
  }
  return 0;
}

function isPendingStatus(st) { return !/已审|已通过|已批|驳回|作废/.test(str(st)); }
function isApprovedStatus(st) { return /已审|已通过|已批/.test(str(st)); }
function isRejectedStatus(st) { return /驳回|作废/.test(str(st)); }

/* ---------------- 损耗流水归因 ---------------- */

function normLossRecord(l) {
  return {
    id: l && l.id != null ? l.id : null,
    date: str(l && (l.date || l.ts)) || null,
    name: str(l && (l.name || l.ing_name)) || '未标',
    qty: num(l && l.qty, 0),
    amount: num(l && l.amount, 0),
    reason: str(l && l.reason) || '未分类'
  };
}

/** 损耗率 + 原因/原料归因 */
function lossReport(ext, data, cfg) {
  const conf = configOf(cfg);
  const logs = arr(data && data.logs).filter((l) => l && l.kind === 'loss');
  const reports = arr(ext && ext.loss_reports);
  const revenue = r2(arr(data && data.sales).reduce((s, r) => s + salesAmount(r), 0));
  const rows = logs.map(normLossRecord);

  const totalAmount = r2(rows.reduce((s, x) => s + x.amount, 0));
  const totalQty = r2(rows.reduce((s, x) => s + x.qty, 0) + reports.reduce((s, r) => s + num(r && r.qty, 0), 0));
  const lossRate = revenue > 0 ? Math.round((totalAmount / revenue) * 10000) / 100 : null;

  const byReasonAmount = {};
  rows.forEach((x) => { byReasonAmount[x.reason] = r2((byReasonAmount[x.reason] || 0) + x.amount); });
  const byReasonQty = {};
  reports.forEach((r) => {
    const k = str(r && r.reason) || '未分类';
    byReasonQty[k] = r2((byReasonQty[k] || 0) + num(r && r.qty, 0));
  });

  const byIng = {};
  rows.forEach((x) => { byIng[x.name] = r2((byIng[x.name] || 0) + x.amount); });
  const topIngredients = Object.keys(byIng).map((name) => ({ name, amount: byIng[name] })).sort((a, b) => b.amount - a.amount).slice(0, 6);
  const top = topIngredients[0];
  const topShare = (top && totalAmount > 0) ? Math.round((top.amount / totalAmount) * 1000) / 10 : null;

  const advice = [];
  if (lossRate != null && lossRate > conf.loss_rate_redline) advice.push(`损耗率 ${lossRate}% 超红线 ${conf.loss_rate_redline}%，立即复盘`);
  else if (lossRate != null && lossRate > conf.loss_rate_warn) advice.push(`损耗率 ${lossRate}% 高于 ${conf.loss_rate_warn}%，注意压降`);
  if (topShare != null && topShare > conf.top_share_warn) advice.push(`${top.name} 占损耗 ${topShare}%，重点关注`);
  if (!advice.length) advice.push('损耗平稳');

  return {
    rows,
    total_amount: totalAmount,
    total_qty: totalQty,
    revenue,
    loss_rate_pct: lossRate,
    by_reason_amount: byReasonAmount,
    by_reason_qty: byReasonQty,
    top_ingredients: topIngredients,
    top_share_pct: topShare,
    warn_pct: conf.loss_rate_warn,
    redline_pct: conf.loss_rate_redline,
    advice
  };
}

/* ---------------- 报损单审批 ---------------- */

function normReport(r) {
  return {
    id: r && r.id != null ? r.id : null,
    date: str(r && r.date) || null,
    ing_name: str(r && (r.ing_name || r.name)) || '-',
    qty: num(r && r.qty, 0),
    amount: r && r.amount != null ? num(r.amount) : null,
    reason: str(r && r.reason) || '未分类',
    reporter: str(r && r.reporter) || null,
    status: str(r && r.status) || '待审核'
  };
}

/** 报损单：待审批/已审批/已驳回 + 大额二次确认 */
function reportsReport(ext, cfg) {
  const conf = configOf(cfg);
  const rows = arr(ext && ext.loss_reports).map(normReport)
    .sort((a, b) => str(b.date).localeCompare(str(a.date)));
  const pending = rows.filter((r) => isPendingStatus(r.status));
  const approved = rows.filter((r) => isApprovedStatus(r.status));
  const rejected = rows.filter((r) => isRejectedStatus(r.status));
  const bigPending = pending.filter((r) => r.amount != null && r.amount >= conf.big_amount);

  const advice = [];
  if (pending.length) advice.push(`报损单 ${pending.length} 张待审批`);
  if (bigPending.length) advice.push(`报损金额 ≥¥${conf.big_amount} 共 ${bigPending.length} 张，需老板二次确认`);
  if (!rows.length) advice.push('暂无报损单');
  if (!advice.length) advice.push('报损审批正常');

  return {
    rows,
    counts: { pending: pending.length, approved: approved.length, rejected: rejected.length, big_pending: bigPending.length },
    big_amount: conf.big_amount,
    advice
  };
}

/* ---------------- 盘点差异 ---------------- */

/** 盘点差异：diff<0 盘亏、>0 盘盈（仅登记，不改库存） */
function inventoryReport(ext) {
  const rows = arr(ext && ext.loss_inventory_diff).map((d) => {
    const diff = num(d && (d.diff != null ? d.diff : (d.actual_qty != null && d.book_qty != null ? num(d.actual_qty) - num(d.book_qty) : 0)));
    return {
      id: d && d.id != null ? d.id : null,
      date: str(d && d.date) || null,
      ing_name: str(d && (d.ing_name || d.name)) || '-',
      book_qty: d && d.book_qty != null ? num(d.book_qty) : null,
      actual_qty: d && d.actual_qty != null ? num(d.actual_qty) : null,
      diff,
      note: str(d && d.note) || null
    };
  });
  let lossQty = 0;
  let overQty = 0;
  rows.forEach((d) => { if (d.diff < 0) lossQty += -d.diff; else overQty += d.diff; });
  const advice = [];
  if (rows.length) advice.push(`盘点差异 ${rows.length} 项（盘亏 ${r2(lossQty)} / 盘盈 ${r2(overQty)}）`);
  else advice.push('暂无盘点差异');
  return {
    rows,
    diff_count: rows.length,
    loss_qty: r2(lossQty),
    over_qty: r2(overQty),
    advice
  };
}

/* ---------------- 汇总 ---------------- */

function overviewReport(ext, data, cfg) {
  const conf = configOf(cfg);
  const loss = lossReport(ext, data, cfg);
  const reports = reportsReport(ext, cfg);
  const inventory = inventoryReport(ext);
  const alerts = [];
  if (loss.loss_rate_pct != null && loss.loss_rate_pct > loss.redline_pct) alerts.push({ level: 'red', text: `损耗率 ${loss.loss_rate_pct}% 超红线 ${loss.redline_pct}%` });
  else if (loss.loss_rate_pct != null && loss.loss_rate_pct > loss.warn_pct) alerts.push({ level: 'orange', text: `损耗率 ${loss.loss_rate_pct}% 偏高` });
  if (loss.top_share_pct != null && loss.top_share_pct > conf.top_share_warn) alerts.push({ level: 'orange', text: `${loss.top_ingredients[0] && loss.top_ingredients[0].name} 占损耗 ${loss.top_share_pct}%` });
  if (reports.counts.big_pending) alerts.push({ level: 'orange', text: `大额报损 ${reports.counts.big_pending} 张待确认（≥¥${reports.big_amount}）` });
  if (reports.counts.pending && !reports.counts.big_pending) alerts.push({ level: 'yellow', text: `报损单 ${reports.counts.pending} 张待审批` });
  return {
    loss: { total_amount: loss.total_amount, loss_rate_pct: loss.loss_rate_pct, top_ingredient: loss.top_ingredients[0] || null, top_share_pct: loss.top_share_pct },
    reports: reports.counts,
    inventory: { diff_count: inventory.diff_count, loss_qty: inventory.loss_qty, over_qty: inventory.over_qty },
    alerts,
    advice: [].concat(loss.advice, reports.advice, inventory.advice)
  };
}

module.exports = {
  LOSS_RATE_WARN,
  LOSS_RATE_REDLINE,
  BIG_AMOUNT,
  TOP_SHARE_WARN,
  DEFAULT_CONFIG,
  configOf,
  isPendingStatus,
  normLossRecord,
  lossReport,
  normReport,
  reportsReport,
  inventoryReport,
  overviewReport
};
