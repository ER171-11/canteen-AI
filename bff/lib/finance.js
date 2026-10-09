'use strict';
/*
 * lib/finance.js — 发票 / 税务 / 现金流水 / 分账 纯逻辑（M9-T2/T4/T5）
 *
 * 纯函数，无 IO：便于单测与路由复用。数据源为快照
 *   ext.fin_invoices（发票）/ ext.fin_tax（税务）/ ext.fin_cash（现金）/ ext.fin_split（分账）+ data.config
 *
 * 财税/运营口径：
 *   发票（M9-T2）：销项月度开票额度（默认 5 万）余量 + 使用率；超支/临近告警。
 *   税务（M9-T4）：待申报税种合计；申报截止 = 属期次月 15 日，逾期未申报告警。
 *   现金流（M9-T4）：收入/支出/净额 + 按账户归集；净额为负告警。
 *   分账（M9-T5）：frozen_until 冻结期内不可划出（防纠纷红线）；到期方可解冻。
 *   阈值一律可配（BFF 本地 finance_config.json）。
 */

const DAY_MS = 86400000;
const INVOICE_QUOTA_DEFAULT = 50000;
const SPLIT_FROZEN_DAYS = 30;
const TAX_DEADLINE_DAY = 15;  // 属期次月 15 日为申报截止

const DEFAULT_CONFIG = {
  invoice_quota_monthly: INVOICE_QUOTA_DEFAULT,
  split_frozen_days: SPLIT_FROZEN_DAYS,
  tax_deadline_day: TAX_DEADLINE_DAY
};

function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return v == null ? '' : String(v).trim(); }
function num(v, d) { const x = parseFloat(v); return Number.isNaN(x) ? (d === undefined ? 0 : d) : x; }
function r2(v) { return v == null ? v : Math.round(v * 100) / 100; }
function monthOf(now) { return new Date(now == null ? Date.now() : now).toISOString().slice(0, 7); }
function tsMs(v) { const t = new Date(str(v)).getTime(); return Number.isNaN(t) ? null : t; }
function isIncomeKind(k) { return /收入|收|入账|存款/.test(str(k)); }
function isFiled(status) { return /已申报|已缴|已完|filed|completed/i.test(str(status)); }

function configOf(cfg) {
  const c = (cfg && cfg.finance) || cfg || {};
  return {
    invoice_quota_monthly: c.invoice_quota_monthly == null ? DEFAULT_CONFIG.invoice_quota_monthly : num(c.invoice_quota_monthly, DEFAULT_CONFIG.invoice_quota_monthly),
    split_frozen_days: c.split_frozen_days == null ? DEFAULT_CONFIG.split_frozen_days : num(c.split_frozen_days, DEFAULT_CONFIG.split_frozen_days),
    tax_deadline_day: c.tax_deadline_day == null ? DEFAULT_CONFIG.tax_deadline_day : num(c.tax_deadline_day, DEFAULT_CONFIG.tax_deadline_day)
  };
}

/* ---------------- 发票 ---------------- */

function normInvoice(inv) {
  return {
    id: inv && inv.id != null ? inv.id : null,
    invoice_no: str(inv && (inv.invoice_no || inv.no)) || null,
    kind: str(inv && inv.kind) || '普票',
    direction: str(inv && inv.direction) || '销项',
    amount: num(inv && inv.amount, 0),
    tax: inv && inv.tax != null ? num(inv.tax) : null,
    status: str(inv && inv.status) || '已开具',
    ts: str(inv && inv.ts) || null
  };
}

/** 发票台账 + 月度销项额度 */
function invoicesReport(ext, data, cfg, now) {
  const conf = configOf(cfg);
  const at = now == null ? Date.now() : now;
  const month = monthOf(at);
  const rows = arr(ext && ext.fin_invoices).map(normInvoice)
    .sort((a, b) => str(b.ts).localeCompare(str(a.ts)));

  const byDirection = {};
  const byKind = {};
  let issued = 0;
  rows.forEach((r) => {
    byDirection[r.direction] = r2((byDirection[r.direction] || 0) + r.amount);
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    if (str(r.direction).indexOf('销') >= 0 && str(r.ts).indexOf(month) === 0) issued += r.amount;
  });
  issued = r2(issued);
  const quota = conf.invoice_quota_monthly;
  const remaining = r2(quota - issued);
  const usagePct = quota > 0 ? Math.round((issued / quota) * 1000) / 10 : null;

  const advice = [];
  if (usagePct != null && remaining < 0) advice.push(`发票额度已超支 ¥${Math.abs(remaining).toFixed(0)}`);
  else if (usagePct != null && usagePct >= 80) advice.push(`发票额度剩余 ¥${remaining.toFixed(0)}（已用 ${usagePct}%）`);
  if (!advice.length) advice.push('发票额度充足');

  return {
    rows,
    count: rows.length,
    by_direction: byDirection,
    by_kind: byKind,
    month,
    issued_this_month: issued,
    quota,
    remaining,
    usage_pct: usagePct,
    advice
  };
}

/* ---------------- 税务 ---------------- */

/** 属期（YYYY-MM）申报截止时刻：次月 tax_deadline_day 日 00:00 */
function periodDeadline(period, day) {
  const m = str(period).match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10); // 1-12
  const nextY = mo === 12 ? y + 1 : y;
  const nextM = mo === 12 ? 1 : mo + 1;
  const dd = String(day == null ? TAX_DEADLINE_DAY : day).padStart(2, '0');
  const t = new Date(nextY + '-' + String(nextM).padStart(2, '0') + '-' + dd + 'T00:00:00Z').getTime();
  return Number.isNaN(t) ? null : t;
}

/** 税务申报：待申报 + 逾期（超次月截止日未申报） */
function taxReport(ext, cfg, now) {
  const conf = configOf(cfg);
  const at = now == null ? Date.now() : now;
  const rows = arr(ext && ext.fin_tax).map((t) => {
    const period = str(t && t.period);
    const status = str(t && t.status) || '待申报';
    const filed = isFiled(status);
    const deadline = periodDeadline(period, conf.tax_deadline_day);
    const daysLeft = deadline == null ? null : Math.ceil((deadline - at) / DAY_MS);
    return {
      id: t && t.id != null ? t.id : null,
      period,
      kind: str(t && t.kind) || '增值税',
      amount: num(t && t.amount, 0),
      status,
      filed_at: str(t && t.filed_at) || null,
      filed,
      overdue: !filed && deadline != null && at > deadline,
      deadline: deadline == null ? null : new Date(deadline).toISOString(),
      days_left: daysLeft
    };
  });
  rows.sort((a, b) => (a.filed ? 1 : 0) - (b.filed ? 1 : 0) ||
    (a.days_left == null ? 1e9 : a.days_left) - (b.days_left == null ? 1e9 : b.days_left));

  const pending = rows.filter((x) => !x.filed);
  const byKind = {};
  rows.forEach((r) => { byKind[r.kind] = r2((byKind[r.kind] || 0) + r.amount); });
  const counts = { filed: 0, pending: 0, overdue: 0 };
  rows.forEach((r) => { if (r.filed) counts.filed += 1; else counts.pending += 1; if (r.overdue) counts.overdue += 1; });

  const advice = [];
  const overdue = rows.filter((x) => x.overdue);
  if (overdue.length) advice.push(`税务逾期未申报 ${overdue.length} 项（${overdue.map((x) => x.kind).join('、')}）`);
  if (pending.length) advice.push(`待申报税种 ${pending.length} 项 · 合计 ¥${r2(pending.reduce((s, x) => s + x.amount, 0)).toFixed(0)}`);
  if (!advice.length) advice.push('税务申报正常');

  return {
    rows,
    pending,
    pending_count: pending.length,
    payable: r2(pending.reduce((s, x) => s + x.amount, 0)),
    by_kind: byKind,
    counts,
    deadline_day: conf.tax_deadline_day,
    advice
  };
}

/* ---------------- 现金流 ---------------- */

function normCash(c) {
  return {
    id: c && c.id != null ? c.id : null,
    ts: str(c && c.ts) || null,
    kind: str(c && c.kind) || '支出',
    amount: num(c && c.amount, 0),
    account: str(c && (c.account || c.acc)) || '未标',
    note: str(c && c.note) || null
  };
}

function cashflowReport(ext, cfg) {
  const conf = configOf(cfg);
  const rows = arr(ext && ext.fin_cash).map(normCash)
    .sort((a, b) => str(b.ts).localeCompare(str(a.ts)));
  let income = 0;
  let expense = 0;
  const byAccount = {};
  const byKind = {};
  rows.forEach((c) => {
    const inc = isIncomeKind(c.kind);
    if (inc) income += c.amount; else expense += c.amount;
    if (!byAccount[c.account]) byAccount[c.account] = { income: 0, expense: 0 };
    if (inc) byAccount[c.account].income += c.amount; else byAccount[c.account].expense += c.amount;
    byKind[c.kind] = r2((byKind[c.kind] || 0) + c.amount);
  });
  const net = r2(income - expense);

  const advice = [];
  if (net < 0) advice.push(`现金流为负 ¥${Math.abs(net).toFixed(0)}，注意支出节奏`);
  if (!rows.length) advice.push('暂无现金流水');
  if (!advice.length) advice.push('现金流平稳');

  return {
    rows,
    income: r2(income),
    expense: r2(expense),
    net,
    by_account: byAccount,
    by_kind: byKind,
    advice
  };
}

/* ---------------- 分账 ---------------- */

function normSplit(s) {
  return {
    id: s && s.id != null ? s.id : null,
    period: str(s && s.period) || null,
    party: str(s && s.party) || '-',
    amount: num(s && s.amount, 0),
    ratio: s && s.ratio != null ? num(s.ratio) : null,
    frozen_until: str(s && s.frozen_until) || null,
    status: str(s && s.status) || '待结算'
  };
}

/** 分账：冻结期内不可划出（红线）；到期方可解冻 */
function splitReport(ext, cfg, now) {
  const conf = configOf(cfg);
  const at = now == null ? Date.now() : now;
  const rows = arr(ext && ext.fin_split).map((s) => {
    const r = normSplit(s);
    const frozen = /冻结/.test(r.status);
    const untilMs = tsMs(r.frozen_until);
    const daysLeft = untilMs == null ? null : Math.ceil((untilMs - at) / DAY_MS);
    // 冻结中：无冻结日 或 未到期 → 不可解冻；到期 → 可解冻
    const canRelease = frozen && (untilMs == null ? false : at >= untilMs);
    return Object.assign({}, r, { frozen, days_left: daysLeft, can_release: canRelease });
  });
  rows.sort((a, b) => (a.frozen === b.frozen ? 0 : a.frozen ? -1 : 1) || (a.days_left == null ? 1e9 : a.days_left) - (b.days_left == null ? 1e9 : b.days_left));

  const frozen = rows.filter((x) => x.frozen);
  const frozenAmount = r2(frozen.reduce((s, x) => s + x.amount, 0));
  const releasable = frozen.filter((x) => x.can_release);
  const counts = { frozen: frozen.length, settled: rows.length - frozen.length, releasable: releasable.length };
  const frozenUntil = frozen
    .map((x) => x.frozen_until)
    .filter(Boolean)
    .sort()
    .pop() || null;

  const advice = [];
  if (frozen.length) advice.push(`分账冻结 ¥${frozenAmount.toFixed(0)}${frozenUntil ? '（最晚至 ' + frozenUntil + '）' : ''}`);
  if (releasable.length) advice.push(`${releasable.length} 笔分账已到期，可解冻结算`);
  if (!advice.length) advice.push('分账台账平稳');

  return {
    rows,
    counts,
    frozen_count: frozen.length,
    frozen_amount: frozenAmount,
    frozen_until: frozenUntil,
    releasable: releasable.map((x) => ({ id: x.id, party: x.party, amount: x.amount })),
    advice
  };
}

/* ---------------- 汇总 ---------------- */

function overviewReport(ext, data, cfg, now) {
  const invoices = invoicesReport(ext, data, cfg, now);
  const tax = taxReport(ext, cfg, now);
  const cashflow = cashflowReport(ext, cfg);
  const split = splitReport(ext, cfg, now);
  const alerts = [];
  if (invoices.usage_pct != null && invoices.remaining < 0) alerts.push({ level: 'red', text: `发票额度超支 ¥${Math.abs(invoices.remaining).toFixed(0)}` });
  else if (invoices.usage_pct != null && invoices.usage_pct >= 80) alerts.push({ level: 'orange', text: `发票额度已用 ${invoices.usage_pct}%` });
  tax.rows.filter((t) => t.overdue).forEach((t) => alerts.push({ level: 'red', text: `${t.kind}（${t.period}）逾期未申报 ¥${t.amount}` }));
  if (tax.pending_count && !tax.counts.overdue) alerts.push({ level: 'yellow', text: `待申报税种 ${tax.pending_count} 项 · ¥${tax.payable}` });
  if (cashflow.net < 0) alerts.push({ level: 'orange', text: `现金流为负 ¥${Math.abs(cashflow.net)}` });
  if (split.counts.releasable) alerts.push({ level: 'yellow', text: `${split.counts.releasable} 笔分账已到期可解冻` });
  return {
    invoices: { count: invoices.count, issued_this_month: invoices.issued_this_month, quota: invoices.quota, remaining: invoices.remaining, usage_pct: invoices.usage_pct },
    tax: { pending_count: tax.pending_count, payable: tax.payable, overdue: tax.counts.overdue },
    cashflow: { income: cashflow.income, expense: cashflow.expense, net: cashflow.net },
    split: { frozen_count: split.frozen_count, frozen_amount: split.frozen_amount, releasable: split.counts.releasable },
    alerts,
    advice: [].concat(invoices.advice, tax.advice, cashflow.advice, split.advice)
  };
}

module.exports = {
  DAY_MS,
  INVOICE_QUOTA_DEFAULT,
  SPLIT_FROZEN_DAYS,
  TAX_DEADLINE_DAY,
  DEFAULT_CONFIG,
  configOf,
  isFiled,
  normInvoice,
  invoicesReport,
  periodDeadline,
  taxReport,
  normCash,
  cashflowReport,
  normSplit,
  splitReport,
  overviewReport
};
