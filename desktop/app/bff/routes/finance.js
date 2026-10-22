'use strict';
/*
 * routes/finance.js — M9 财务税务 模块 API
 *   数据源：店内快照 ext.fin_invoices / fin_tax / fin_cash / fin_split + data.config
 *
 *   GET  /api/finance/invoices            发票台账 + 月度销项额度
 *   GET  /api/finance/tax                 税务申报（待申报/逾期）
 *   GET  /api/finance/cashflow            现金流水（收入/支出/净额）
 *   GET  /api/finance/split               分账（冻结红线/可解冻）
 *   GET  /api/finance/overview            财务看板汇总
 *   GET  /api/finance/config / POST       发票额度/冻结期/申报日（BFF 本地配置，可配）
 *   POST /api/finance/invoice             开票登记 → finance.invoice 入队
 *   POST /api/finance/tax                 税务申报登记 → finance.tax 入队
 *   POST /api/finance/cash                现金流水登记 → finance.cash 入队
 *   POST /api/finance/split               分账冻结登记 → finance.freeze 入队
 *   POST /api/finance/split/approve       分账解冻/结算 → finance.approve 入队
 *   POST /api/finance/recon               三方勾兑确认 → finance.recon 入队
 *
 * 红线①：GET 全为只读；红线②：所有写操作一律 enqueue 进 actions 队列（经审批中心确认才落库）。
 */
const store = require('../lib/store');
const { enqueue } = require('./actions');
const { mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');
const finance = require('../lib/finance');

const CONFIG_FILE = 'finance_config.json';

function trim(v) { return String(v == null ? '' : v).trim(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function dayOf(dateStr) {
  const s = trim(dateStr);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayStr();
}
function monthOf(period) {
  const s = trim(period);
  return /^\d{4}-\d{2}$/.test(s) ? s : todayStr().slice(0, 7);
}

function loadExt() {
  const snap = loadSnapshot();
  return { snap, ext: (snap && snap.ext) || {}, data: (snap && snap.data) || {} };
}

/** 生效配置：BFF 本地配置 > 快照 data.config.finance > 默认 */
function effectiveConfig() {
  const local = store.readJSON(CONFIG_FILE, null);
  const snap = loadSnapshot();
  const snapCfg = (snap && snap.data && snap.data.config) || {};
  const patch = local ? { finance: local } : {};
  return Object.assign({}, snapCfg, patch);
}
function config() { return finance.configOf(effectiveConfig()); }

/* ---------------- 只读聚合 ---------------- */

function invoicesPayload() {
  const { ext, data, snap } = loadExt();
  const rep = finance.invoicesReport(ext, data, effectiveConfig(), Date.now());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function taxPayload() {
  const { ext, snap } = loadExt();
  const rep = finance.taxReport(ext, effectiveConfig(), Date.now());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function cashflowPayload() {
  const { ext, snap } = loadExt();
  const rep = finance.cashflowReport(ext, effectiveConfig());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function splitPayload() {
  const { ext, snap } = loadExt();
  const rep = finance.splitReport(ext, effectiveConfig(), Date.now());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function overviewPayload() {
  const { ext, data, snap } = loadExt();
  const rep = finance.overviewReport(ext, data, effectiveConfig(), Date.now());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}

/* ---------------- 写操作 ---------------- */

async function readJson(ctx, req) {
  try {
    const { buf } = await ctx.readBody(req);
    const b = JSON.parse(buf.toString('utf8'));
    return b && typeof b === 'object' ? b : {};
  } catch (e) { return {}; }
}
function operatorOf(ctx, body) {
  return (body && body.operator) || (ctx.auth && (ctx.auth.account || ctx.auth.role)) || null;
}
function doEnqueue(type, payload, operator, traceId) {
  const { action } = enqueue(type, payload, operator, traceId, {});
  return action && action.id;
}
function pickNum(v, d, min) {
  if (v == null || v === '' || isNaN(parseFloat(v))) return d;
  const n = parseFloat(v);
  return Math.max(min == null ? -Infinity : min, n);
}

function handle(req, res, ctx, pathname) {
  if (pathname.indexOf('/api/finance') !== 0) return false;
  const m = req.method;

  /* ---------- 只读 ---------- */
  if (m === 'GET' || m === 'HEAD') {
    if (pathname === '/api/finance/invoices') { ctx.sendJSON(res, 200, invoicesPayload()); return true; }
    if (pathname === '/api/finance/tax') { ctx.sendJSON(res, 200, taxPayload()); return true; }
    if (pathname === '/api/finance/cashflow') { ctx.sendJSON(res, 200, cashflowPayload()); return true; }
    if (pathname === '/api/finance/split') { ctx.sendJSON(res, 200, splitPayload()); return true; }
    if (pathname === '/api/finance/overview') { ctx.sendJSON(res, 200, overviewPayload()); return true; }
    if (pathname === '/api/finance/config') {
      const snap = loadSnapshot();
      ctx.sendJSON(res, 200, {
        ok: true,
        finance: config(),
        defaults: finance.DEFAULT_CONFIG,
        rev: snap ? snap.rev : null
      });
      return true;
    }
    return false;
  }

  if (m !== 'POST') return false;

  const write = ['/api/finance/config', '/api/finance/invoice', '/api/finance/tax',
    '/api/finance/cash', '/api/finance/split', '/api/finance/split/approve', '/api/finance/recon'];
  if (write.indexOf(pathname) < 0) return false;
  if (!ctx.auth || !mayWriteActions(ctx.auth)) {
    ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
    return true;
  }

  (async () => {
    const body = await readJson(ctx, req);
    const snap = loadSnapshot();
    const rev = snap ? snap.rev : null;

    /* 配置可配 */
    if (pathname === '/api/finance/config') {
      const src = (body && (body.finance || body)) || {};
      const cur = config();
      const next = {
        invoice_quota_monthly: Math.round(pickNum(src.invoice_quota_monthly, cur.invoice_quota_monthly, 0)),
        split_frozen_days: Math.round(pickNum(src.split_frozen_days, cur.split_frozen_days, 0)),
        tax_deadline_day: Math.round(pickNum(src.tax_deadline_day, cur.tax_deadline_day, 1))
      };
      if (next.tax_deadline_day > 28) {
        ctx.sendJSON(res, 400, { ok: false, error: '申报截止日需 ≤ 28', given: next });
        return;
      }
      store.writeJSON(CONFIG_FILE, Object.assign({}, next, { updated_at: new Date().toISOString(), by: operatorOf(ctx, body) }));
      ctx.sendJSON(res, 200, { ok: true, finance: next, rev });
      return;
    }

    /* 开票登记 */
    if (pathname === '/api/finance/invoice') {
      const amount = body.amount;
      if (amount == null || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        ctx.sendJSON(res, 400, { ok: false, error: 'amount 必填且 > 0' });
        return;
      }
      const id = doEnqueue('finance.invoice', {
        invoice_no: trim(body.invoice_no || body.no) || undefined,
        kind: trim(body.kind) || '普票',
        direction: trim(body.direction) || '销项',
        amount: parseFloat(amount),
        tax: body.tax == null ? undefined : parseFloat(body.tax),
        ts: trim(body.ts) || undefined,
        status: trim(body.status) || '已开具'
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '开票登记已入队 → 审批中心确认' });
      return;
    }

    /* 税务申报登记 */
    if (pathname === '/api/finance/tax') {
      const kind = trim(body.kind);
      if (!kind) { ctx.sendJSON(res, 400, { ok: false, error: 'kind 必填（增值税/所得税/附加）' }); return; }
      if (body.amount == null || isNaN(parseFloat(body.amount))) {
        ctx.sendJSON(res, 400, { ok: false, error: 'amount 必填且为数值' });
        return;
      }
      const status = trim(body.status) || '待申报';
      const id = doEnqueue('finance.tax', {
        period: monthOf(body.period),
        kind,
        amount: parseFloat(body.amount),
        filed_at: finance.isFiled(status) ? (trim(body.filed_at) || new Date().toISOString()) : undefined,
        status
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '税务申报登记已入队 → 审批中心确认' });
      return;
    }

    /* 现金流水登记 */
    if (pathname === '/api/finance/cash') {
      const kind = trim(body.kind);
      if (!kind) { ctx.sendJSON(res, 400, { ok: false, error: 'kind 必填（收入/支出/存款/备用金）' }); return; }
      if (body.amount == null || isNaN(parseFloat(body.amount))) {
        ctx.sendJSON(res, 400, { ok: false, error: 'amount 必填且为数值' });
        return;
      }
      const id = doEnqueue('finance.cash', {
        ts: trim(body.ts) || undefined,
        kind,
        amount: parseFloat(body.amount),
        account: trim(body.account) || '未标',
        note: trim(body.note) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '现金流水已入队 → 审批中心确认' });
      return;
    }

    /* 分账冻结 */
    if (pathname === '/api/finance/split') {
      const party = trim(body.party);
      if (!party) { ctx.sendJSON(res, 400, { ok: false, error: 'party 必填' }); return; }
      if (body.amount == null || isNaN(parseFloat(body.amount)) || parseFloat(body.amount) <= 0) {
        ctx.sendJSON(res, 400, { ok: false, error: 'amount 必填且 > 0' });
        return;
      }
      const id = doEnqueue('finance.freeze', {
        period: monthOf(body.period),
        party,
        amount: parseFloat(body.amount),
        ratio: body.ratio == null ? undefined : parseFloat(body.ratio),
        frozen_until: trim(body.frozen_until) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '分账冻结已入队 → 审批中心确认' });
      return;
    }

    /* 分账解冻/结算 */
    if (pathname === '/api/finance/split/approve') {
      const id0 = body.id;
      if (id0 == null || id0 === '') { ctx.sendJSON(res, 400, { ok: false, error: 'id 必填' }); return; }
      const id = doEnqueue('finance.approve', {
        id: id0,
        party: trim(body.party) || undefined,
        amount: body.amount == null ? undefined : parseFloat(body.amount),
        status: trim(body.status) || '已结算'
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '分账结算已入队 → 审批中心确认' });
      return;
    }

    /* 三方勾兑 */
    if (pathname === '/api/finance/recon') {
      const id = doEnqueue('finance.recon', {
        date: dayOf(body.date),
        dine_in: body.dine_in == null ? undefined : parseFloat(body.dine_in),
        takeout: body.takeout == null ? undefined : parseFloat(body.takeout),
        purchase: body.purchase == null ? undefined : parseFloat(body.purchase),
        note: trim(body.note) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '三方勾兑已入队 → 审批中心确认' });
      return;
    }

    ctx.sendJSON(res, 404, { ok: false, error: 'not found' });
  })();

  return true;
}

module.exports = { handle };
