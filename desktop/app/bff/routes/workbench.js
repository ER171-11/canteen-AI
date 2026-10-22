'use strict';
/*
 * routes/workbench.js — 岗位工作台（只读）
 *   GET /api/workbench/procurement?date=  采购：按需求×菜谱BOM→库存缺口→采购清单 + 验收标准数
 *   GET /api/workbench/kitchen?date=      厨师：今日工单 + 菜谱标准 + 品控
 *   GET /api/workbench/accept-standards   验收标准库（转发 inventory）
 * 红线：只读；下单/入库/工单写操作仍走确认台。
 */
const workbench = require('../lib/workbench');
const { loadSnapshot } = require('./snapshot');

function arr(v) { return Array.isArray(v) ? v : []; }

async function handle(req, res, ctx, pathname) {
  if (req.method !== 'GET') return false;

  if (pathname === '/api/workbench/procurement') {
    const snap = loadSnapshot();
    const date = (ctx.query.get('date') || '').trim();
    const out = workbench.procurement(snap ? (snap.ext || {}) : {}, snap ? (snap.data || {}) : {}, date || undefined);
    let standards = 0;
    try {
      const lib = require('../lib/accept_standards');
      const s = (typeof lib.listStandards === 'function') ? lib.listStandards() : lib;
      standards = arr(Array.isArray(s) ? s : (s && s.items)).length;
    } catch (e) { standards = 0; }
    out.accept_standards = standards;
    ctx.sendJSON(res, 200, Object.assign(out, { rev: snap ? snap.rev : null }));
    return true;
  }

  if (pathname === '/api/workbench/kitchen') {
    const snap = loadSnapshot();
    const date = (ctx.query.get('date') || '').trim();
    const out = workbench.kitchenWorkbench(snap ? (snap.ext || {}) : {}, snap ? (snap.data || {}) : {}, date || undefined);
    ctx.sendJSON(res, 200, Object.assign(out, { rev: snap ? snap.rev : null }));
    return true;
  }

  if (pathname === '/api/workbench/recv') {
    const snap = loadSnapshot();
    const date = (ctx.query.get('date') || '').trim();
    const out = workbench.recvWorkbench(snap ? (snap.ext || {}) : {}, snap ? (snap.data || {}) : {}, date || undefined);
    ctx.sendJSON(res, 200, Object.assign(out, { rev: snap ? snap.rev : null }));
    return true;
  }

  return false;
}

module.exports = { handle };
