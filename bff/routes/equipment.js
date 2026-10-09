'use strict';
/*
 * routes/equipment.js — M8 设备温度 / 维保 / 能耗 模块 API
 *   数据源：店内快照 ext.eq_temps|eq_temp / ext.eq_maintain / ext.eq_energy + data.sales
 *
 *   GET  /api/equipment/temps             冷柜温度台账（分级/超温告警）
 *   GET  /api/equipment/maintain          维保记录 + 计划（逾期/临期）
 *   GET  /api/equipment/energy            能耗汇总（燃气/水/电 + 营收占比 + 预算）
 *   GET  /api/equipment/overview          设备看板汇总
 *   GET  /api/equipment/config / POST     温度上限/维保周期/能耗预算（BFF 本地配置，可配）
 *   POST /api/equipment/maintain          维保登记 → equipment.maintain 入队
 *   POST /api/equipment/temp              温度登记 → equipment.temp_log 入队
 *   POST /api/equipment/energy            能耗抄表 → equipment.energy_log 入队
 *
 * 红线①：GET 全为只读；红线②：所有写操作一律 enqueue 进 actions 队列（经审批中心确认才落库）。
 */
const store = require('../lib/store');
const { enqueue } = require('./actions');
const { mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');
const equipment = require('../lib/equipment');

const CONFIG_FILE = 'equipment_config.json';

function arr(v) { return Array.isArray(v) ? v : []; }
function trim(v) { return String(v == null ? '' : v).trim(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function dayOf(dateStr) {
  const s = trim(dateStr);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayStr();
}

function loadExt() {
  const snap = loadSnapshot();
  return { snap, ext: (snap && snap.ext) || {}, data: (snap && snap.data) || {} };
}

/** 生效配置：BFF 本地配置 > 快照 data.config.equipment > 默认 */
function effectiveConfig() {
  const local = store.readJSON(CONFIG_FILE, null);
  const snap = loadSnapshot();
  const snapCfg = (snap && snap.data && snap.data.config) || {};
  const patch = local ? { equipment: local } : {};
  return Object.assign({}, snapCfg, patch);
}
function config() { return equipment.configOf(effectiveConfig()); }

/* ---------------- 只读聚合 ---------------- */

function tempsPayload() {
  const { ext, snap } = loadExt();
  const rep = equipment.tempsReport(ext, effectiveConfig());
  return Object.assign({ ok: true, rev: snap ? snap.rev : null }, rep);
}

function maintainPayload() {
  const { ext, snap } = loadExt();
  const rep = equipment.maintainReport(ext, effectiveConfig(), Date.now());
  rep.ok = true;
  rep.rev = snap ? snap.rev : null;
  return rep;
}

function energyPayload() {
  const { ext, data, snap } = loadExt();
  const rep = equipment.energyReport(ext, data, effectiveConfig());
  rep.ok = true;
  rep.rev = snap ? snap.rev : null;
  return rep;
}

function overviewPayload() {
  const { ext, data, snap } = loadExt();
  const rep = equipment.overviewReport(ext, data, effectiveConfig(), Date.now());
  rep.ok = true;
  rep.rev = snap ? snap.rev : null;
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

function handle(req, res, ctx, pathname) {
  if (pathname.indexOf('/api/equipment') !== 0) return false;
  const m = req.method;

  /* ---------- 只读 ---------- */
  if (m === 'GET' || m === 'HEAD') {
    if (pathname === '/api/equipment/temps') { ctx.sendJSON(res, 200, tempsPayload()); return true; }
    if (pathname === '/api/equipment/maintain') { ctx.sendJSON(res, 200, maintainPayload()); return true; }
    if (pathname === '/api/equipment/energy') { ctx.sendJSON(res, 200, energyPayload()); return true; }
    if (pathname === '/api/equipment/overview') { ctx.sendJSON(res, 200, overviewPayload()); return true; }
    if (pathname === '/api/equipment/config') {
      const snap = loadSnapshot();
      ctx.sendJSON(res, 200, {
        ok: true,
        equipment: config(),
        defaults: equipment.DEFAULT_CONFIG,
        rev: snap ? snap.rev : null
      });
      return true;
    }
    return false;
  }

  if (m !== 'POST') return false;

  const write = ['/api/equipment/config', '/api/equipment/maintain', '/api/equipment/temp', '/api/equipment/energy'];
  if (write.indexOf(pathname) < 0) return false;
  if (!ctx.auth || !mayWriteActions(ctx.auth)) {
    ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
    return true;
  }

  (async () => {
    const body = await readJson(ctx, req);
    const snap = loadSnapshot();
    const rev = snap ? snap.rev : null;

    /* 阈值/预算可配 */
    if (pathname === '/api/equipment/config') {
      const src = (body && (body.equipment || body)) || {};
      const cur = config();
      const srcTemps = src.temps || {};
      const pickNum = (v, d, min) => {
        if (v == null || v === '' || isNaN(parseFloat(v))) return d;
        return Math.max(min == null ? -Infinity : min, parseFloat(v));
      };
      const next = {
        temps: {
          冷藏: pickNum(srcTemps['冷藏'], cur.temps['冷藏']),
          冷冻: pickNum(srcTemps['冷冻'], cur.temps['冷冻']),
          蔬菜: pickNum(srcTemps['蔬菜'], cur.temps['蔬菜'])
        },
        warn_margin: pickNum(src.warn_margin, cur.warn_margin, 0),
        over_alert_min: pickNum(src.over_alert_min, cur.over_alert_min, 0),
        maintain_interval_d: Math.round(pickNum(src.maintain_interval_d, cur.maintain_interval_d, 1)),
        maintain_due_soon_d: Math.round(pickNum(src.maintain_due_soon_d, cur.maintain_due_soon_d, 0)),
        energy_budget: pickNum(src.energy_budget, cur.energy_budget, 0)
      };
      if (next.maintain_due_soon_d > next.maintain_interval_d) {
        ctx.sendJSON(res, 400, { ok: false, error: '维保临期窗口需 ≤ 维保周期', given: next });
        return;
      }
      store.writeJSON(CONFIG_FILE, Object.assign({}, next, { updated_at: new Date().toISOString(), by: operatorOf(ctx, body) }));
      ctx.sendJSON(res, 200, { ok: true, equipment: next, rev });
      return;
    }

    /* 维保登记 */
    if (pathname === '/api/equipment/maintain') {
      const device = trim(body.device);
      if (!device) { ctx.sendJSON(res, 400, { ok: false, error: 'device 必填' }); return; }
      const id = doEnqueue('equipment.maintain', {
        device,
        kind: trim(body.kind) || '保养',
        ts: trim(body.ts) || undefined,
        operator: operatorOf(ctx, body) || undefined,
        cost: body.cost == null ? undefined : body.cost,
        next_due: trim(body.next_due) || undefined,
        note: trim(body.note) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '维保登记已入队 → 审批中心确认' });
      return;
    }

    /* 温度登记（高频时序表，不进 rev） */
    if (pathname === '/api/equipment/temp') {
      const device = trim(body.device);
      if (!device) { ctx.sendJSON(res, 400, { ok: false, error: 'device 必填' }); return; }
      const temp = body.temp != null ? body.temp : body.celsius;
      if (temp == null || isNaN(parseFloat(temp))) { ctx.sendJSON(res, 400, { ok: false, error: 'temp 必填且为数值' }); return; }
      const lvl = equipment.tempLevel(parseFloat(temp), equipment.limitOf(trim(body.kind) || '冷藏', config()), 0, config());
      const id = doEnqueue('equipment.temp_log', {
        device,
        temp: parseFloat(temp),
        ts: trim(body.ts) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, {
        ok: true, action_id: id, rev,
        level: lvl.level, over: lvl.over,
        note: '温度登记已入队（高频表，不进 rev）'
      });
      return;
    }

    /* 能耗抄表 */
    if (pathname === '/api/equipment/energy') {
      const device = trim(body.device);
      const kind = trim(body.kind);
      if (!device) { ctx.sendJSON(res, 400, { ok: false, error: 'device 必填' }); return; }
      if (!kind) { ctx.sendJSON(res, 400, { ok: false, error: 'kind 必填（电/水/气）' }); return; }
      const id = doEnqueue('equipment.energy_log', {
        date: dayOf(body.date),
        device,
        kind,
        reading: body.reading == null ? undefined : body.reading,
        usage: body.usage == null ? undefined : body.usage
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '能耗抄表已入队 → 审批中心确认' });
      return;
    }

    ctx.sendJSON(res, 404, { ok: false, error: 'not found' });
  })();

  return true;
}

module.exports = { handle };
