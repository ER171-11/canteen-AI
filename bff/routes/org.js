'use strict';
/*
 * routes/org.js — 门店 / 岗位 / 用户管理
 *   GET   /api/org
 *   GET   /api/org/stores|positions|users
 *   POST  /api/org/users                 创建
 *   POST  /api/org/users/update          改岗/停用
 *   PATCH /api/org/users                 同上
 *   POST  /api/org/users/reset-password
 *   POST  /api/org/positions/update      改权限
 *   PATCH /api/org/positions             同上
 *   POST  /api/org/stores
 */
const org = require('../lib/org');
const auth = require('../lib/auth');

async function readJson(req, ctx) {
  const { buf } = await ctx.readBody(req);
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return {}; }
}

async function handle(req, res, ctx, pathname) {
  if (!pathname.startsWith('/api/org')) return false;

  if (req.method === 'GET' && pathname === '/api/org') {
    const o = org.load();
    const pub = org.listPublic(o);
    ctx.sendJSON(res, 200, Object.assign({
      ok: true,
      current_store_id: ctx.storeId || (ctx.auth && ctx.auth.store_id) || null
    }, pub));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/org/stores') {
    const o = org.load();
    ctx.sendJSON(res, 200, { ok: true, items: org.listPublic(o).stores });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/org/positions') {
    const o = org.load();
    ctx.sendJSON(res, 200, { ok: true, items: org.listPublic(o).positions });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/org/users') {
    if (!auth.hasPerm(ctx.auth, 'org.read') && !auth.hasPerm(ctx.auth, 'org.write')) {
      if (ctx.auth.role !== '老板' && ctx.auth.role !== '店长') {
        ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: org.read' });
        return true;
      }
    }
    const o = org.load();
    ctx.sendJSON(res, 200, { ok: true, items: org.listPublic(o).users });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/org/users') {
    const body = await readJson(req, ctx);
    const r = org.createUser(ctx.auth, body || {});
    if (!r.ok) {
      ctx.sendJSON(res, r.status || 400, { ok: false, error: r.error });
      return true;
    }
    ctx.sendJSON(res, 200, { ok: true, user: r.user });
    return true;
  }

  if ((req.method === 'POST' && pathname === '/api/org/users/update') ||
      (req.method === 'PATCH' && pathname === '/api/org/users')) {
    const body = await readJson(req, ctx);
    const r = org.updateUser(ctx.auth, body || {});
    if (!r.ok) {
      ctx.sendJSON(res, r.status || 400, { ok: false, error: r.error });
      return true;
    }
    ctx.sendJSON(res, 200, { ok: true, user: r.user });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/org/users/reset-password') {
    const body = await readJson(req, ctx);
    const r = org.resetPassword(ctx.auth, body || {});
    if (!r.ok) {
      ctx.sendJSON(res, r.status || 400, { ok: false, error: r.error });
      return true;
    }
    ctx.sendJSON(res, 200, r);
    return true;
  }

  if ((req.method === 'POST' && pathname === '/api/org/positions/update') ||
      (req.method === 'PATCH' && pathname === '/api/org/positions')) {
    const body = await readJson(req, ctx);
    const r = org.updatePosition(ctx.auth, body || {});
    if (!r.ok) {
      ctx.sendJSON(res, r.status || 400, { ok: false, error: r.error });
      return true;
    }
    ctx.sendJSON(res, 200, r);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/org/stores') {
    if (!auth.hasPerm(ctx.auth, 'org.write')) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: org.write' });
      return true;
    }
    const body = (await readJson(req, ctx)) || {};
    const o = org.load();
    const id = 'store_' + require('crypto').randomBytes(4).toString('hex');
    const row = {
      id,
      name: body.name || '新门店',
      brand: body.brand || '熊猫五福',
      city: body.city || '',
      address: body.address || '',
      status: body.status || '筹备中',
      created_at: new Date().toISOString()
    };
    o.stores.push(row);
    org.save(o);
    ctx.sendJSON(res, 200, { ok: true, store: row });
    return true;
  }

  if ((req.method === 'POST' && pathname === '/api/org/stores/update') ||
      (req.method === 'PATCH' && pathname === '/api/org/stores')) {
    const body = (await readJson(req, ctx)) || {};
    const r = org.updateStore(ctx.auth, body);
    if (!r.ok) {
      ctx.sendJSON(res, r.status || 400, { ok: false, error: r.error });
      return true;
    }
    ctx.sendJSON(res, 200, { ok: true, store: r.store });
    return true;
  }

  return false;
}

module.exports = { handle };
