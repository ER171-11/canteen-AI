'use strict';
/*
 * routes/qc_media.js — 品控照片对象存储通道（A 块）
 *
 *   GET  /api/qc/media/status
 *        → {ok, configured, bucket?, host?, path_style?, public_base?, expire_sec?, missing[]}
 *   POST /api/qc/media/presign  {workorder_id, sku_id?, store_id?, ext?, content_type?, date?}
 *        → {ok, configured, key, method:"PUT", upload_url, headers, photo_url, expires_in}
 *          App 拿到 upload_url 后直传对象存储，再把 key/photo_url 放进品控动作 payload。
 *   POST /api/qc/media/sign     {keys:[...], expires?}
 *        → {ok, configured, items:[{key, url, expires_in, public_url}]}
 *          admin-web 展示不合格大图用；bucket 私有时这是唯一读法。
 *
 * 为什么没有 commit 端点：预签名直传后，key/URL 由 App 随品控动作一起提交，
 * 落库统一走 POST /api/actions（红线②：所有写操作进队列），
 * 不另设中间登记态，少一次往返也少一套不一致的可能。
 *
 * 红线（用户已确认「不改红线」）：
 *   图片本体**不经过 BFF、不落盘、不入库**。本路由只签发 URL 与返回引用，
 *   绝不接收 base64 —— 请求体里出现 imageBase64 / photo_base64 一律 400 驳回并留痕，
 *   与 bff/server.js:9「图片 base64 只用内存，响应后销毁」及 ci/redline_guard.sh 一致。
 *   未配置对象存储（缺环境变量）时返回 configured:false，前端据此降级为
 *   「仅识别 + 状态落库，后台标注图片不可用」，品控主流程不中断。
 */
const { mayWriteActions } = require('../lib/auth');
const audit = require('../lib/audit');
const objstore = require('../lib/objstore');

const IMAGE_PAYLOAD_KEYS = ['imagebase64', 'image', 'photobase64', 'base64', 'img', 'imagebytes', 'photo', 'imgbase64'];
const MAX_SIGN_KEYS = 200;

function firstText(primary, alias) {
  for (const v of [primary, alias]) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/** 键名归一：小写并抹掉下划线/连字符，避免 image_base64 / imageBase64 绕过检测 */
function normKeyName(k) {
  return String(k).toLowerCase().replace(/[_-]/g, '');
}

/** 请求体内出现图片载荷即视为违规（图片必须直传对象存储） */
function hasImagePayload(body) {
  if (!body || typeof body !== 'object') return false;
  for (const k of Object.keys(body)) {
    if (IMAGE_PAYLOAD_KEYS.indexOf(normKeyName(k)) < 0) continue;
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    return true;
  }
  return false;
}

async function readJson(req, ctx) {
  const { buf } = await ctx.readBody(req);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return null;
  }
}

/** 留痕：只记 key 与动作，绝不记密钥与图片 */
function log(ctx, pathname, role, status, note, extra) {
  audit.write(Object.assign({
    ts: new Date().toISOString(),
    trace_id: ctx.traceId || null,
    method: 'POST',
    path: pathname,
    role: role || null,
    status: status,
    note: note
  }, extra || {}));
}

async function handle(req, res, ctx, pathname) {
  if (pathname.indexOf('/api/qc/media/') !== 0) return false;

  const role = ctx.auth ? ctx.auth.role : null;
  const canWrite = !!(ctx.auth && mayWriteActions(ctx.auth));

  // GET /api/qc/media/status — 前端用来决定是否展示「图片不可用」降级标注
  if (req.method === 'GET' && pathname === '/api/qc/media/status') {
    ctx.sendJSON(res, 200, Object.assign({ ok: true }, objstore.status()));
    return true;
  }

  // POST /api/qc/media/presign — 签发上传 URL
  if (req.method === 'POST' && pathname === '/api/qc/media/presign') {
    if (!canWrite) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required', role });
      return true;
    }
    const body = (await readJson(req, ctx)) || {};

    if (hasImagePayload(body)) {
      log(ctx, pathname, role, 400, 'qc_media.reject_image_payload');
      ctx.sendJSON(res, 400, {
        ok: false,
        code: 'image_payload_rejected',
        error: '图片不得经过 BFF：请改用预签名 URL 直传对象存储'
      });
      return true;
    }

    const st = objstore.status();
    if (!st.configured) {
      ctx.sendJSON(res, 200, {
        ok: true,
        configured: false,
        code: 'objstore_not_configured',
        missing: st.missing,
        hint: '未配置对象存储：品控照常识别并落库状态，后台将标注「图片不可用」'
      });
      return true;
    }

    const workorderId = firstText(body.workorder_id, body.workorderId);
    if (!workorderId) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing workorder_id' });
      return true;
    }

    const key = objstore.buildQcKey({
      store_id: firstText(body.store_id, body.storeId) || ctx.storeId || 'default',
      workorder_id: workorderId,
      date: body.date,
      ext: body.ext
    });
    const signed = objstore.presignPut(key, {
      contentType: firstText(body.content_type, body.contentType) || 'image/jpeg'
    });
    if (!signed) {
      log(ctx, pathname, role, 503, 'qc_media.presign_failed');
      ctx.sendJSON(res, 503, { ok: false, error: 'presign failed' });
      return true;
    }

    const photoUrl = objstore.publicUrl(key);
    log(ctx, pathname, role, 200, 'qc_media.presign', { key: signed.key, workorder_id: workorderId });
    ctx.sendJSON(res, 200, {
      ok: true,
      configured: true,
      key: signed.key,
      method: signed.method,
      upload_url: signed.url,
      headers: signed.headers,
      expires_in: signed.expires_in,
      photo_url: photoUrl,
      public_base: !!photoUrl,
      store_id: firstText(body.store_id, body.storeId) || ctx.storeId || null
    });
    return true;
  }

  // POST /api/qc/media/sign — 批量换取读取 URL（后台看图）
  if (req.method === 'POST' && pathname === '/api/qc/media/sign') {
    const body = (await readJson(req, ctx)) || {};
    const raw = Array.isArray(body.keys) ? body.keys : (body.key ? [body.key] : []);
    const st = objstore.status();
    if (!st.configured) {
      ctx.sendJSON(res, 200, {
        ok: true,
        configured: false,
        code: 'objstore_not_configured',
        items: []
      });
      return true;
    }

    const items = [];
    let skipped = 0;
    raw.slice(0, MAX_SIGN_KEYS).forEach((k) => {
      const signed = objstore.presignGet(k, { expires: body.expires });
      if (!signed) {
        skipped += 1;
        return;
      }
      items.push({
        key: signed.key,
        url: signed.url,
        expires_in: signed.expires_in,
        public_url: objstore.publicUrl(signed.key)
      });
    });

    ctx.sendJSON(res, 200, {
      ok: true,
      configured: true,
      items: items,
      skipped: skipped,
      count: items.length
    });
    return true;
  }

  ctx.sendJSON(res, 404, { ok: false, error: 'unknown qc media endpoint', path: pathname });
  return true;
}

module.exports = { handle, hasImagePayload };
