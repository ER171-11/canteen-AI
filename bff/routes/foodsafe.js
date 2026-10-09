'use strict';
/*
 * routes/foodsafe.js — M4 食安证照模块 API（数据源：店内快照 ext.fs_* + data.recv/data.sales）
 *
 *   GET  /api/foodsafe/certs?level=          证照台账：逾期/红/橙/黄/绿 + 禁岗 + 停业风险
 *   GET  /api/foodsafe/trace?batch=          溯源批次；带 batch 时下钻进货/销售记录
 *   GET  /api/foodsafe/samples               留样 48h 状态机 + 克重合规 + 到期提醒
 *   GET  /api/foodsafe/disinfect?span=7      消毒记录 + 7 日达标率趋势
 *   GET  /api/foodsafe/overview              食安看板汇总
 *   GET  /api/foodsafe/config / POST         证照临期阈值（BFF 本地配置，可配）
 *   POST /api/foodsafe/certs                 证照登记/续期 → fs.cert.upsert 入队
 *   POST /api/foodsafe/samples               留样登记（克重不足拦截）→ sample.log 入队
 *   POST /api/foodsafe/samples/ingest        Kimi 识别入档：≥91% 入档 / <91% 待复核
 *   POST /api/foodsafe/samples/clear         销毁登记 → fs.sample_clear 入队
 *   POST /api/foodsafe/disinfect             消毒登记 → fs.disinfect 入队
 *
 * 红线①：GET 全为只读；红线②：所有写操作一律 enqueue 进 actions 队列（经审批中心确认才落库）。
 */
const store = require('../lib/store');
const { enqueue } = require('./actions');
const { mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');
const foodsafety = require('../lib/foodsafety');

const CONFIG_FILE = 'foodsafe_config.json';
/** Kimi 留样识别置信度门槛：≥91% 自动入档；<91% 转人工待复核（不入档、不写回） */
const AUTO_ARCHIVE_CONF = 91;

function arr(v) { return Array.isArray(v) ? v : []; }
function trim(v) { return String(v == null ? '' : v).trim(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function dayOf(dateStr) {
  const s = trim(dateStr);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayStr();
}
function q1(url, key) {
  const v = url && url.get ? url.get(key) : null;
  return v == null ? null : String(v);
}

function loadExt() {
  const snap = loadSnapshot();
  return {
    snap,
    ext: (snap && snap.ext) || {},
    data: (snap && snap.data) || {}
  };
}

/** 生效阈值：BFF 本地配置 > 快照 config.foodsafety.cert > 默认 */
function effectiveConfig() {
  const local = store.readJSON(CONFIG_FILE, null);
  const snap = loadSnapshot();
  const snapCfg = (snap && snap.data && snap.data.config) || {};
  const patch = local && local.cert ? { foodsafety: { cert: local.cert } } : {};
  return Object.assign({}, snapCfg, patch);
}
function thresholds() { return foodsafety.thresholdsOf(effectiveConfig()); }

/* ---------------- 只读聚合 ---------------- */

function certsPayload(url) {
  const { ext, snap } = loadExt();
  const rep = foodsafety.certReport(ext, Date.now(), effectiveConfig());
  const filter = trim(q1(url, 'level'));
  let rows = rep.rows;
  if (filter === 'health' || filter === 'store') rows = rows.filter((r) => r.kind === filter);
  else if (filter) rows = rows.filter((r) => r.level === filter);
  return {
    ok: true,
    rev: snap ? snap.rev : null,
    rows,
    counts: rep.counts,
    thresholds: rep.thresholds,
    health_blocked: rep.health_blocked,
    store_risks: rep.store_risks,
    store_stop_risk: rep.store_stop_risk,
    advice: rep.advice
  };
}

function tracePayload(url) {
  const { ext, data, snap } = loadExt();
  const rep = foodsafety.traceReport(ext, data, { batch: q1(url, 'batch') || q1(url, 'q') });
  rep.rev = snap ? snap.rev : null;
  rep.sales_source = arr(data && data.sales).length ? 'snapshot' : 'none';
  return rep;
}

function samplesPayload() {
  const { ext, snap } = loadExt();
  const rep = foodsafety.sampleReport(ext, Date.now());
  return Object.assign({
    ok: true,
    rev: snap ? snap.rev : null,
    hold_hours: foodsafety.SAMPLE_HOLD_H,
    warn_hours: foodsafety.SAMPLE_WARN_H,
    weight_rule: { '饺子': foodsafety.WEIGHT_JIAOZI, '热菜/其他': foodsafety.WEIGHT_HOTDISH },
    auto_archive_conf: AUTO_ARCHIVE_CONF
  }, rep);
}

function disinfectPayload(url) {
  const { ext, snap } = loadExt();
  const span = parseInt(q1(url, 'span'), 10);
  const rep = foodsafety.disinfectReport(ext, dayOf(q1(url, 'date')), Date.now(), span > 0 ? span : 7);
  rep.ok = true;
  rep.rev = snap ? snap.rev : null;
  return rep;
}

function overviewPayload() {
  const { ext, data, snap } = loadExt();
  const now = Date.now();
  const cert = foodsafety.certReport(ext, now, effectiveConfig());
  const sample = foodsafety.sampleReport(ext, now);
  const dis = foodsafety.disinfectReport(ext, todayStr(), now, 7);
  const trace = foodsafety.traceReport(ext, data, null);
  const alerts = [];
  if (cert.store_risks.length) alerts.push({ level: 'expired', text: '停业风险：店铺证照已过期，已推送老板' });
  cert.rows.filter((r) => r.blocked).forEach((r) => alerts.push({ level: 'red', text: `${r.holder} 健康证 ${r.level}（${r.days} 天），排班禁岗` }));
  sample.reminders.forEach((r) => alerts.push({ level: r.level, text: r.text }));
  if (dis.today_missed.length) alerts.push({ level: 'yellow', text: `今日消毒未完成区域：${dis.today_missed.join('、')}` });
  if (trace.missing_cert) alerts.push({ level: 'yellow', text: `溯源批次待补检验报告 ${trace.missing_cert} 个` });
  return {
    ok: true,
    rev: snap ? snap.rev : null,
    certs: { counts: cert.counts, health_blocked: cert.health_blocked, store_risks: cert.store_risks.length, store_stop_risk: cert.store_stop_risk, thresholds: cert.thresholds },
    samples: sample.summary,
    disinfect: { areas: dis.areas.length, today_done: dis.today_done, today_missed: dis.today_missed, avg_rate: dis.avg_rate },
    trace: { batches: trace.batches, missing_cert: trace.missing_cert },
    alerts
  };
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
  if (pathname.indexOf('/api/foodsafe') !== 0) return false;
  const m = req.method;

  /* ---------- 只读 ---------- */
  if (m === 'GET' || m === 'HEAD') {
    if (pathname === '/api/foodsafe/certs') { ctx.sendJSON(res, 200, certsPayload(ctx.query)); return true; }
    if (pathname === '/api/foodsafe/trace') { ctx.sendJSON(res, 200, tracePayload(ctx.query)); return true; }
    if (pathname === '/api/foodsafe/samples') { ctx.sendJSON(res, 200, samplesPayload()); return true; }
    if (pathname === '/api/foodsafe/disinfect') { ctx.sendJSON(res, 200, disinfectPayload(ctx.query)); return true; }
    if (pathname === '/api/foodsafe/overview') { ctx.sendJSON(res, 200, overviewPayload()); return true; }
    if (pathname === '/api/foodsafe/config') {
      const snap = loadSnapshot();
      ctx.sendJSON(res, 200, {
        ok: true,
        cert: thresholds(),
        defaults: foodsafety.DEFAULT_THRESHOLDS,
        config: effectiveConfig().foodsafety || null,
        rev: snap ? snap.rev : null
      });
      return true;
    }
    return false;
  }

  if (m !== 'POST') return false;

  /* ---------- 写操作：统一权限闸门（红线：所有写回经确认台） ---------- */
  const write = ['/api/foodsafe/config', '/api/foodsafe/certs', '/api/foodsafe/samples',
    '/api/foodsafe/samples/ingest', '/api/foodsafe/samples/clear', '/api/foodsafe/disinfect'];
  if (write.indexOf(pathname) < 0) return false;
  if (!ctx.auth || !mayWriteActions(ctx.auth)) {
    ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
    return true;
  }

  (async () => {
    const body = await readJson(ctx, req);
    const snap = loadSnapshot();
    const rev = snap ? snap.rev : null;

    /* 阈值可配 */
    if (pathname === '/api/foodsafe/config') {
      const src = (body && (body.cert || body)) || {};
      const cur = thresholds();
      const next = {
        block: src.block == null ? cur.block : Math.max(0, parseInt(src.block, 10) || 0),
        red: src.red == null ? cur.red : Math.max(0, parseInt(src.red, 10) || 0),
        orange: src.orange == null ? cur.orange : Math.max(0, parseInt(src.orange, 10) || 0),
        yellow: src.yellow == null ? cur.yellow : Math.max(0, parseInt(src.yellow, 10) || 0)
      };
      if (!(next.block <= next.red && next.red <= next.orange && next.orange <= next.yellow)) {
        ctx.sendJSON(res, 400, { ok: false, error: '阈值需满足 逾期禁营 ≤ 红 ≤ 橙 ≤ 黄', given: next });
        return;
      }
      store.writeJSON(CONFIG_FILE, { cert: next, updated_at: new Date().toISOString(), by: operatorOf(ctx, body) });
      ctx.sendJSON(res, 200, { ok: true, cert: next, rev });
      return;
    }

    /* 证照登记/续期 */
    if (pathname === '/api/foodsafe/certs') {
      const type = trim(body.cert_type || body.type);
      const holder = trim(body.holder || body.name);
      const expireAt = trim(body.expire_at);
      if (!type || !holder) { ctx.sendJSON(res, 400, { ok: false, error: 'cert_type 与 holder 必填' }); return; }
      if (!expireAt) { ctx.sendJSON(res, 400, { ok: false, error: 'expire_at 必填' }); return; }
      const id = doEnqueue('fs.cert.upsert', {
        id: body.id != null ? body.id : undefined,
        cert_type: type,
        holder,
        cert_no: trim(body.cert_no) || undefined,
        issued_at: trim(body.issued_at) || undefined,
        expire_at: expireAt,
        status: trim(body.status) || '有效'
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '证照登记已入队 → 审批中心确认' });
      return;
    }

    /* 留样登记（克重不足拦截） */
    if (pathname === '/api/foodsafe/samples') {
      const dish = trim(body.dish);
      if (!dish) { ctx.sendJSON(res, 400, { ok: false, error: 'dish 必填' }); return; }
      const wc = foodsafety.weightCheck(dish, body.weight_g);
      if (wc.level === 'fail') {
        ctx.sendJSON(res, 422, {
          ok: false, error: wc.error, need_g: wc.need, weight_g: wc.weight,
          dish, rule: '饺子 ≥125g / 热菜 ≥200g'
        });
        return;
      }
      const id = doEnqueue('sample.log', {
        date: dayOf(body.date),
        meal: trim(body.meal) || undefined,
        dish,
        weight_g: wc.weight,
        keeper: trim(body.keeper) || operatorOf(ctx, body) || undefined,
        kept_at: trim(body.kept_at) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, {
        ok: true, action_id: id, rev,
        weight_level: wc.level, need_g: wc.need,
        due_at: new Date(Date.now() + foodsafety.SAMPLE_HOLD_H * 3600000).toISOString(),
        note: '留样登记已入队 → 审批中心确认'
      });
      return;
    }

    /* Kimi 识别入档：≥91% 入档 / <91% 待复核（不自动执行） */
    if (pathname === '/api/foodsafe/samples/ingest') {
      const dish = trim(body.dish);
      const conf = body.conf == null ? null : parseFloat(body.conf);
      const wc = foodsafety.weightCheck(dish, body.weight_g);
      if (!dish) { ctx.sendJSON(res, 400, { ok: false, error: 'dish 必填（Kimi 识别结果）' }); return; }
      if (wc.level === 'fail') {
        ctx.sendJSON(res, 422, { ok: false, error: wc.error, need_g: wc.need, weight_g: wc.weight, source: 'kimi' });
        return;
      }
      if (conf != null && conf < AUTO_ARCHIVE_CONF) {
        ctx.sendJSON(res, 200, {
          ok: true, archived: false, review: true, conf, threshold: AUTO_ARCHIVE_CONF,
          dish, weight_g: wc.weight, need_g: wc.need, weight_level: wc.level,
          reason: `Kimi 留样识别置信度 ${conf}% < ${AUTO_ARCHIVE_CONF}%，转人工待复核（不入档、不写回）`
        });
        return;
      }
      const id = doEnqueue('sample.log', {
        date: dayOf(body.date),
        meal: trim(body.meal) || undefined,
        dish,
        weight_g: wc.weight,
        keeper: trim(body.keeper) || operatorOf(ctx, body) || undefined,
        kept_at: trim(body.kept_at) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, {
        ok: true, archived: true, action_id: id, rev, conf: conf == null ? null : conf,
        source: trim(body.source) || 'kimi',
        note: `Kimi 识别置信度 ${conf == null ? '未知' : conf + '%'} ≥ ${AUTO_ARCHIVE_CONF}%，已入档 → 审批中心确认`
      });
      return;
    }

    /* 销毁登记 */
    if (pathname === '/api/foodsafe/samples/clear') {
      const id = body.id;
      if (id == null || id === '') { ctx.sendJSON(res, 400, { ok: false, error: 'id 必填' }); return; }
      const actionId = doEnqueue('fs.sample_clear', {
        id,
        dish: trim(body.dish) || undefined,
        cleared_at: trim(body.cleared_at) || new Date().toISOString(),
        by: operatorOf(ctx, body) || undefined,
        note: trim(body.note) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: actionId, rev, note: '销毁登记已入队 → 审批中心确认' });
      return;
    }

    /* 消毒登记 */
    if (pathname === '/api/foodsafe/disinfect') {
      const area = trim(body.area);
      if (!area) { ctx.sendJSON(res, 400, { ok: false, error: 'area 必填' }); return; }
      const id = doEnqueue('fs.disinfect', {
        date: dayOf(body.date),
        area,
        method: trim(body.method) || undefined,
        operator: trim(body.operator) || operatorOf(ctx, body) || undefined,
        ts: trim(body.ts) || undefined,
        result: trim(body.result) || '已完成'
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '消毒登记已入队 → 审批中心确认' });
      return;
    }

    ctx.sendJSON(res, 404, { ok: false, error: 'not found' });
  })();

  return true;
}

module.exports = { handle, AUTO_ARCHIVE_CONF };
