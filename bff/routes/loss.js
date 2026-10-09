'use strict';
/*
 * routes/loss.js — M12 损耗报损 模块 API
 *   数据源：店内快照 data.logs(kind=loss) / ext.loss_reports / ext.loss_inventory_diff + data.sales
 *
 *   GET  /api/loss/records              损耗流水归因（损耗率/原因/原料）
 *   GET  /api/loss/reports              报损单（待审批/已审批/已驳回 + 大额）
 *   GET  /api/loss/inventory            盘点差异（盘亏/盘盈，仅登记）
 *   GET  /api/loss/overview             损耗看板汇总
 *   GET  /api/loss/config / POST        损耗率红线/大额阈值/集中度阈值（BFF 本地配置，可配）
 *   POST /api/loss/report               报损登记（待审核）→ loss.report 入队
 *   POST /api/loss/approve              报损审批（扣库存）→ loss.approve 入队
 *   POST /api/loss/reject               报损驳回（不扣库存）→ loss.reject 入队
 *
 * 红线①：GET 全为只读；红线②：所有写操作一律 enqueue 进 actions 队列（经审批中心确认才落库）。
 */
const store = require('../lib/store');
const { enqueue } = require('./actions');
const { mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');
const loss = require('../lib/loss');

const CONFIG_FILE = 'loss_config.json';

function trim(v) { return String(v == null ? '' : v).trim(); }
function dayOf(dateStr) {
  const s = trim(dateStr);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
}

function loadExt() {
  const snap = loadSnapshot();
  return { snap, ext: (snap && snap.ext) || {}, data: (snap && snap.data) || {} };
}

/** 生效配置：BFF 本地配置 > 快照 data.config.loss > 默认 */
function effectiveConfig() {
  const local = store.readJSON(CONFIG_FILE, null);
  const snap = loadSnapshot();
  const snapCfg = (snap && snap.data && snap.data.config) || {};
  const patch = local ? { loss: local } : {};
  return Object.assign({}, snapCfg, patch);
}
function config() { return loss.configOf(effectiveConfig()); }

/* ---------------- 只读聚合 ---------------- */

function recordsPayload() {
  const { ext, data, snap } = loadExt();
  const rep = loss.lossReport(ext, data, effectiveConfig());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function reportsPayload() {
  const { ext, snap } = loadExt();
  const rep = loss.reportsReport(ext, effectiveConfig());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function inventoryPayload() {
  const { ext, snap } = loadExt();
  const rep = loss.inventoryReport(ext);
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function overviewPayload() {
  const { ext, data, snap } = loadExt();
  const rep = loss.overviewReport(ext, data, effectiveConfig());
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
  return Math.max(min == null ? -Infinity : min, parseFloat(v));
}

function handle(req, res, ctx, pathname) {
  if (pathname.indexOf('/api/loss') !== 0) return false;
  const m = req.method;

  /* ---------- 只读 ---------- */
  if (m === 'GET' || m === 'HEAD') {
    if (pathname === '/api/loss/records') { ctx.sendJSON(res, 200, recordsPayload()); return true; }
    if (pathname === '/api/loss/reports') { ctx.sendJSON(res, 200, reportsPayload()); return true; }
    if (pathname === '/api/loss/inventory') { ctx.sendJSON(res, 200, inventoryPayload()); return true; }
    if (pathname === '/api/loss/overview') { ctx.sendJSON(res, 200, overviewPayload()); return true; }
    if (pathname === '/api/loss/config') {
      const snap = loadSnapshot();
      ctx.sendJSON(res, 200, {
        ok: true,
        loss: config(),
        defaults: loss.DEFAULT_CONFIG,
        rev: snap ? snap.rev : null
      });
      return true;
    }
    return false;
  }

  if (m !== 'POST') return false;

  const write = ['/api/loss/config', '/api/loss/report', '/api/loss/approve', '/api/loss/reject'];
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
    if (pathname === '/api/loss/config') {
      const src = (body && (body.loss || body)) || {};
      const cur = config();
      const next = {
        loss_rate_warn: pickNum(src.loss_rate_warn, cur.loss_rate_warn, 0),
        loss_rate_redline: pickNum(src.loss_rate_redline, cur.loss_rate_redline, 0),
        big_amount: pickNum(src.big_amount, cur.big_amount, 0),
        top_share_warn: pickNum(src.top_share_warn, cur.top_share_warn, 0)
      };
      if (!(next.loss_rate_warn <= next.loss_rate_redline)) {
        ctx.sendJSON(res, 400, { ok: false, error: '需满足 预警 ≤ 红线', given: next });
        return;
      }
      store.writeJSON(CONFIG_FILE, Object.assign({}, next, { updated_at: new Date().toISOString(), by: operatorOf(ctx, body) }));
      ctx.sendJSON(res, 200, { ok: true, loss: next, rev });
      return;
    }

    /* 报损登记（待审核，不动账面） */
    if (pathname === '/api/loss/report') {
      const name = trim(body.ing_name || body.name);
      if (!name) { ctx.sendJSON(res, 400, { ok: false, error: 'ing_name 必填' }); return; }
      const qty = body.qty;
      if (qty == null || isNaN(parseFloat(qty)) || parseFloat(qty) === 0) {
        ctx.sendJSON(res, 400, { ok: false, error: 'qty 必填且不能为 0' });
        return;
      }
      const id = doEnqueue('loss.report', {
        date: dayOf(body.date),
        ing_name: name,
        name,
        qty: Math.abs(parseFloat(qty)),
        reason: trim(body.reason) || undefined,
        reporter: trim(body.reporter) || operatorOf(ctx, body) || undefined,
        amount: body.amount == null ? undefined : parseFloat(body.amount),
        pending: true
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '报损登记已入队（待审核）→ 审批中心确认' });
      return;
    }

    /* 报损审批（扣库存） */
    if (pathname === '/api/loss/approve') {
      const id0 = body.id;
      if (id0 == null || id0 === '') { ctx.sendJSON(res, 400, { ok: false, error: 'id 必填' }); return; }
      const id = doEnqueue('loss.approve', { id: id0 }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '报损审批已入队（扣库存）→ 审批中心确认' });
      return;
    }

    /* 报损驳回（不扣库存） */
    if (pathname === '/api/loss/reject') {
      const id0 = body.id;
      if (id0 == null || id0 === '') { ctx.sendJSON(res, 400, { ok: false, error: 'id 必填' }); return; }
      const id = doEnqueue('loss.reject', { id: id0, reason: trim(body.reason) || undefined }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '报损驳回已入队 → 审批中心确认' });
      return;
    }

    ctx.sendJSON(res, 404, { ok: false, error: 'not found' });
  })();

  return true;
}

module.exports = { handle };
