'use strict';
/*
 * routes/auth.js — 登录（公开端点，无需 token）
 *   POST /api/auth/login {account, device_fp} → {ok, token, role, expires_at}
 */
const auth = require('../lib/auth');

async function handle(req, res, ctx, pathname) {
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || !String(body.account || '').trim()) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing account' });
      return true;
    }
    const r = auth.login(body.account, body.device_fp, 'app');
    ctx.sendJSON(res, 200, { ok: true, token: r.token, role: r.role, expires_at: r.expires_at });
    return true;
  }
  return false;
}

module.exports = { handle };
