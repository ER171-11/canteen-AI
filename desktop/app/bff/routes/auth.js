'use strict';
/*
 * routes/auth.js
 *   POST /api/auth/login     {account, password?, device_fp}
 *   POST /api/auth/register  {account, password, invite_code, display_name?}
 *   GET  /api/auth/wechat/config
 *   POST /api/auth/wechat    {code, device_fp, account?, password?, invite_code?}
 *   GET  /api/auth/me
 */
const auth = require('../lib/auth');
const org = require('../lib/org');
const wechat = require('../lib/wechat');

async function handle(req, res, ctx, pathname) {
  if (req.method === 'GET' && pathname === '/api/auth/wechat/config') {
    ctx.sendJSON(res, 200, wechat.publicConfig());
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/wechat') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    body = body || {};
    const code = String(body.code || '').trim();
    if (!code) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing code' });
      return true;
    }
    const identity = await wechat.exchangeCode(code);
    if (!identity.ok) {
      ctx.sendJSON(res, identity.status || 401, { ok: false, error: identity.error || 'wechat auth failed' });
      return true;
    }
    const created = org.loginOrCreateWechat({
      openid: identity.openid,
      unionid: identity.unionid,
      nickname: identity.nickname,
      avatar: identity.avatar,
      account: body.account,
      password: body.password,
      invite_code: body.invite_code
    });
    if (!created.ok) {
      ctx.sendJSON(res, created.status || 400, { ok: false, error: created.error });
      return true;
    }
    const tokenPack = auth.issueToken(created.user, body.device_fp, 'wechat');
    ctx.sendJSON(res, 200, Object.assign({
      ok: true,
      account: created.user.account,
      wechat_demo: !!identity.demo,
      user: created.user
    }, tokenPack));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || !String(body.account || '').trim()) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing account' });
      return true;
    }
    const r = auth.login(body.account, body.device_fp, 'app', body.password);
    if (!r || r.error) {
      ctx.sendJSON(res, (r && r.status) || 401, { ok: false, error: (r && r.error) || 'login failed' });
      return true;
    }
    ctx.sendJSON(res, 200, Object.assign({ ok: true }, r));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    body = body || {};
    const r = org.register(body);
    if (!r.ok) {
      ctx.sendJSON(res, r.status || 400, { ok: false, error: r.error });
      return true;
    }
    // 注册成功后自动登录
    const login = auth.login(body.account, body.device_fp, 'app', body.password);
    ctx.sendJSON(res, 200, Object.assign({ ok: true, user: r.user }, login));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    if (!ctx.auth) {
      ctx.sendJSON(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    const o = org.load();
    const user = org.findUser(o, ctx.auth.account);
    const profile = user ? org.publicUser(o, user) : {
      account: ctx.auth.account,
      role: ctx.auth.role,
      display_name: ctx.auth.display_name,
      store_id: ctx.auth.store_id,
      store_name: (org.findStore(o, ctx.auth.store_id) || o.stores[0] || {}).name || ctx.auth.store_name,
      position_id: ctx.auth.position_id,
      position_name: ctx.auth.position_name,
      permissions: ctx.auth.permissions || [],
      can_write: !!ctx.auth.can_write
    };
    ctx.sendJSON(res, 200, { ok: true, user: profile });
    return true;
  }

  return false;
}

module.exports = { handle };
