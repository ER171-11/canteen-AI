'use strict';
/*
 * routes/safety_points.js — 食安点位主数据读写（巡检 / 消毒）
 *
 *   GET  /api/safety/points?kind=inspection|disinfect
 *        → { ok, kind, points:[{id,name,zone,kind,every30,demo_image_key,demo_image_url,enabled,sort,note}],
 *            rev, using_defaults, configured }
 *          读快照 ext.fs_points；无自定义点位时回退内置默认（using_defaults=true）。
 *   POST /api/safety/points          { id?, name, zone?, kind, every30?, demo_image_key?, demo_image_url?, sort?, note? }
 *        → enqueue('safety_point.upsert', ...)  （红线②：写操作进队列 → 审批中心确认）
 *   POST /api/safety/points/remove   { id, kind }
 *        → enqueue('safety_point.remove', ...)
 *   POST /api/safety/points/seed     { kind }
 *        → enqueue('safety_point.seed', ...)  把内置默认点位导入为可编辑点位（一次审批）
 *   POST /api/safety/points/presign  { kind, id, store_id?, ext?, content_type? }
 *        → { ok, configured, key, method:"PUT", upload_url, headers, expires_in, photo_url }
 *          演示图上传预签名；App/后台直传对象存储，再把 key/url 回填点位后 upsert。
 *   POST /api/safety/points/sign     { keys:[] }  → { ok, items:[{key,url,public_url}] }（私有 bucket 读图）
 *
 * 红线（不变）：演示图与现场照片都**不经过 BFF、不落盘、不入库** —— 本路由只签发
 *   URL 与保存引用；请求体里出现 base64 图片字段一律 400 驳回（复用 qc_media.hasImagePayload）。
 *   未配置对象存储时返回 configured:false，前端降级为「图片不可用」，点位管理主流程不中断。
 */
const audit = require('../lib/audit');
const objstore = require('../lib/objstore');
const { mayWriteActions } = require('../lib/auth');
const { enqueue } = require('./actions');
const { loadSnapshot } = require('./snapshot');
const sp = require('../lib/safety_points');
const { hasImagePayload } = require('./qc_media');

const BASE = '/api/safety/points';
const MAX_SIGN_KEYS = 200;

function nowIso() {
  return new Date().toISOString();
}

function firstText() {
  for (let i = 0; i < arguments.length; i += 1) {
    const v = arguments[i];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/** ctx.query 既可能是 Map 也可能是普通对象，兼容取参 */
function qget(query, key) {
  if (!query) return null;
  const v = typeof query.get === 'function' ? query.get(key) : query[key];
  return v === undefined || v === null ? null : String(v);
}

async function readJson(req, ctx) {
  try {
    const { buf } = await ctx.readBody(req);
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function publicView(p) {
  return {
    id: p.id,
    name: p.name,
    zone: p.zone,
    kind: p.kind,
    every30: p.every30,
    demo_image_key: p.demo_image_key === undefined ? null : p.demo_image_key,
    demo_image_url: p.demo_image_url === undefined ? null : p.demo_image_url,
    enabled: p.enabled === undefined ? 1 : p.enabled,
    sort: p.sort === undefined ? 0 : p.sort,
    note: p.note === undefined ? null : p.note
  };
}

/** 留痕：只记动作与对象键，绝不记密钥与图片 */
function log(ctx, pathname, role, status, note, extra) {
  audit.write(Object.assign({
    ts: nowIso(),
    trace_id: ctx.traceId || null,
    method: 'POST',
    path: pathname,
    role: role || null,
    status: status,
    note: note
  }, extra || {}));
}

/** 统一的入队响应 */
function enqueueResp(ctx, res, type, payload, operator, pathname, role) {
  const { action, dedup } = enqueue(type, payload, operator, ctx.traceId, {});
  log(ctx, pathname, role, 200, 'safety_points.enqueue', { action_id: action.id, type: type });
  ctx.sendJSON(res, 200, {
    ok: true,
    action_id: action.id,
    status: action.status,
    rev: action.rev,
    dedup: !!dedup,
    note: '点位变更已入队 → 审批中心确认后落库'
  });
}

async function handle(req, res, ctx, pathname) {
  if (pathname.indexOf(BASE) !== 0) return false;

  /* ---------- 只读：点位列表 ---------- */
  if (req.method === 'GET' && pathname === BASE) {
    const kind = (qget(ctx.query, 'kind') || sp.KIND_INSPECTION).trim();
    if (!sp.isKind(kind)) {
      ctx.sendJSON(res, 400, { ok: false, error: 'kind 非法（inspection|disinfect）' });
      return true;
    }
    const snap = loadSnapshot();
    const ext = (snap && snap.ext) || {};
    const points = sp.resolvePoints(ext, kind).map(publicView);
    ctx.sendJSON(res, 200, {
      ok: true,
      kind: kind,
      points: points,
      count: points.length,
      rev: snap ? snap.rev : null,
      using_defaults: sp.usingDefaultPoints(ext, kind),
      configured: objstore.configured()
    });
    return true;
  }

  if (req.method !== 'POST') return false;
  // 只接管 BASE 本身或 BASE/xxx 子路径，其它一律不接管
  if (pathname !== BASE && pathname.indexOf(BASE + '/') !== 0) return false;

  const role = ctx.auth ? ctx.auth.role : null;
  const operator = (ctx.auth && (ctx.auth.account || ctx.auth.role)) || null;
  const canWrite = !!(ctx.auth && mayWriteActions(ctx.auth));
  const body = (await readJson(req, ctx)) || {};

  /* 图片载荷守卫：任何写端点夹带 base64 一律驳回 */
  if (hasImagePayload(body)) {
    log(ctx, pathname, role, 400, 'safety_points.reject_image_payload');
    ctx.sendJSON(res, 400, {
      ok: false,
      code: 'image_payload_rejected',
      error: '图片不得经过 BFF：请改用预签名 URL 直传对象存储'
    });
    return true;
  }

  /* ---------- 演示图上传预签名（写权限） ---------- */
  if (pathname === BASE + '/presign') {
    if (!canWrite) {
      log(ctx, pathname, role, 403, 'safety_points.forbidden');
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required', role: role });
      return true;
    }
    const key = objstore.buildPointDemoKey({
      store_id: firstText(body.store_id, body.storeId, ctx.storeId) || 'default',
      kind: firstText(body.kind) || 'inspection',
      id: firstText(body.id) || 'na',
      date: body.date,
      ext: firstText(body.ext, body.content_type) || 'jpg'
    });
    const signed = objstore.presignPut(key, {
      contentType: firstText(body.content_type, body.contentType) || 'image/jpeg'
    });
    if (!signed) {
      const st = objstore.status();
      ctx.sendJSON(res, 200, {
        ok: true,
        configured: false,
        key: null,
        upload_url: null,
        missing: st.missing,
        note: '对象存储未配置（OSS_* 环境变量缺失），演示图不可用'
      });
      return true;
    }
    const photoUrl = objstore.publicUrl(key);
    log(ctx, pathname, role, 200, 'safety_points.presign', { key: signed.key, kind: body.kind, id: body.id });
    ctx.sendJSON(res, 200, {
      ok: true,
      configured: true,
      key: signed.key,
      method: signed.method,
      upload_url: signed.url,
      headers: signed.headers,
      expires_in: signed.expires_in,
      photo_url: photoUrl,
      public_base: !!photoUrl
    });
    return true;
  }

  /* ---------- 读图预签名（私有 bucket） ---------- */
  if (pathname === BASE + '/sign') {
    const raw = Array.isArray(body.keys) ? body.keys : (body.key ? [body.key] : []);
    if (!objstore.configured()) {
      ctx.sendJSON(res, 200, { ok: true, configured: false, items: [] });
      return true;
    }
    const items = [];
    let skipped = 0;
    raw.slice(0, MAX_SIGN_KEYS).forEach((k) => {
      const signed = objstore.presignGet(k, { expires: body.expires });
      if (!signed) { skipped += 1; return; }
      items.push({ key: signed.key, url: signed.url, expires_in: signed.expires_in, public_url: objstore.publicUrl(signed.key) });
    });
    ctx.sendJSON(res, 200, { ok: true, configured: true, items: items, skipped: skipped, count: items.length });
    return true;
  }

  /* ---------- 写端点统一权限闸门 ---------- */
  const WRITE = [BASE, BASE + '/remove', BASE + '/seed'];
  if (WRITE.indexOf(pathname) >= 0 && !canWrite) {
    log(ctx, pathname, role, 403, 'safety_points.forbidden');
    ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required', role: role });
    return true;
  }

  /* 新增 / 编辑点位 */
  if (pathname === BASE) {
    const kind = firstText(body.kind);
    if (!sp.isKind(kind)) {
      ctx.sendJSON(res, 400, { ok: false, error: 'kind 必填(inspection|disinfect)' });
      return true;
    }
    if (!firstText(body.name)) {
      ctx.sendJSON(res, 400, { ok: false, error: 'name 必填' });
      return true;
    }
    enqueueResp(ctx, res, 'safety_point.upsert', {
      id: firstText(body.id),
      name: firstText(body.name),
      zone: firstText(body.zone),
      kind: kind,
      every30: body.every30 ? 1 : 0,
      demo_image_key: body.demo_image_key === undefined ? null : body.demo_image_key,
      demo_image_url: body.demo_image_url === undefined ? null : body.demo_image_url,
      sort: body.sort,
      note: body.note
    }, operator, pathname, role);
    return true;
  }

  /* 删除（逻辑删除） */
  if (pathname === BASE + '/remove') {
    const id = firstText(body.id);
    const kind = firstText(body.kind);
    if (!id || !sp.isKind(kind)) {
      ctx.sendJSON(res, 400, { ok: false, error: 'id 与 kind(inspection|disinfect) 必填' });
      return true;
    }
    enqueueResp(ctx, res, 'safety_point.remove', { id: id, kind: kind }, operator, pathname, role);
    return true;
  }

  /* 导入内置默认点位（一次性，幂等） */
  if (pathname === BASE + '/seed') {
    const kind = firstText(body.kind) || sp.KIND_INSPECTION;
    if (!sp.isKind(kind)) {
      ctx.sendJSON(res, 400, { ok: false, error: 'kind 非法（inspection|disinfect）' });
      return true;
    }
    enqueueResp(ctx, res, 'safety_point.seed', { kind: kind }, operator, pathname, role);
    return true;
  }

  ctx.sendJSON(res, 404, { ok: false, error: 'unknown safety points endpoint', path: pathname });
  return true;
}

module.exports = { handle };
