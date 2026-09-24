'use strict';
/*
 * routes/snapshot.js — 店内整库快照的推送与读取（云端只存快照，不写店内 DB）
 *   POST /api/snapshot/push  {rev, data, machine}（机体 >5MB 拒收 413）
 *                            → 存 data/snapshot.json {rev, generated_at, size, data}
 *   GET  /api/snapshot/latest?module= → {rev, generated_at, size, data}
 *        module 按顶层 key 过滤 data 子集；无快照 404 {ok:false,error:"no snapshot"}
 */
const store = require('../lib/store');

const MAX_BODY = 5 * 1024 * 1024; // 5MB

function loadSnapshot() {
  const s = store.readJSON('snapshot.json', null);
  return (s && typeof s === 'object' && s.data !== undefined) ? s : null;
}

async function handle(req, res, ctx, pathname) {
  if (req.method === 'POST' && pathname === '/api/snapshot/push') {
    const cl = parseInt(req.headers['content-length'] || '0', 10);
    if (cl > MAX_BODY) {
      ctx.sendJSON(res, 413, { ok: false, error: 'payload too large (>' + MAX_BODY + ' bytes)' });
      return true;
    }
    const { tooLarge, buf } = await ctx.readBody(req, MAX_BODY);
    if (tooLarge) {
      ctx.sendJSON(res, 413, { ok: false, error: 'payload too large (>' + MAX_BODY + ' bytes)' });
      return true;
    }
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || typeof body.rev !== 'number' || !body.data || typeof body.data !== 'object') {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing rev(number) or data(object)' });
      return true;
    }
    const snap = {
      rev: body.rev,
      generated_at: new Date().toISOString(),
      size: buf.length,
      machine: body.machine || null,
      data: body.data
    };
    store.writeJSON('snapshot.json', snap);
    ctx.sendJSON(res, 200, { ok: true, rev: snap.rev, size: snap.size, generated_at: snap.generated_at });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/snapshot/latest') {
    const snap = loadSnapshot();
    if (!snap) {
      ctx.sendJSON(res, 404, { ok: false, error: 'no snapshot' });
      return true;
    }
    const mod = (ctx.query.get('module') || '').trim();
    let data = snap.data;
    if (mod) {
      data = {};
      if (Object.prototype.hasOwnProperty.call(snap.data, mod)) data[mod] = snap.data[mod];
    }
    ctx.sendJSON(res, 200, {
      ok: true,
      rev: snap.rev,
      generated_at: snap.generated_at,
      size: snap.size,
      data
    });
    return true;
  }

  return false;
}

module.exports = { handle, loadSnapshot };
