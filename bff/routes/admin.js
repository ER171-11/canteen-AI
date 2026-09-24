'use strict';
/*
 * routes/admin.js — 管理后台（admin-web）骨架
 *   POST /api/admin/login          公开：同 auth/login，标记来源 admin-web
 *   GET  /api/admin/kimi-log?limit → kimi_log.jsonl 尾部
 *   GET  /api/admin/audit?limit    → audit.jsonl 尾部
 *   GET  /api/admin/config         → 当前配置（取自快照 data.config，无则默认）
 *   POST /api/admin/config         → 写配置走 actions 队列（type="config.update"），仅 老板/店长
 *   GET  /api/admin/{dishes,recipes,staff,members,tables,vendors}
 *                                  → 只读，取自快照 data 对应 key，无则空数组
 */
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { loadSnapshot } = require('./snapshot');
const { enqueue } = require('./actions');

const READONLY_KEYS = ['dishes', 'recipes', 'staff', 'members', 'tables', 'vendors'];

const DEFAULT_CONFIG = {
  safety_stock: {},
  uniform_sop: '工服整洁 / 帽子 / 口罩 / 洗手消毒',
  plate_sop: '五色齐整，宫廷御膳点缀规范',
  note: '默认配置（快照未携带 config 模块）'
};

async function handle(req, res, ctx, pathname) {
  // 公开登录
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || !String(body.account || '').trim()) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing account' });
      return true;
    }
    const r = auth.login(body.account, body.device_fp, 'admin-web');
    ctx.sendJSON(res, 200, { ok: true, token: r.token, role: r.role, expires_at: r.expires_at, source: 'admin-web' });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/kimi-log') {
    ctx.sendJSON(res, 200, { ok: true, items: audit.tail('kimi_log.jsonl', ctx.query.get('limit')) });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/audit') {
    ctx.sendJSON(res, 200, { ok: true, items: audit.tail('audit.jsonl', ctx.query.get('limit')) });
    return true;
  }

  if (pathname === '/api/admin/config') {
    if (req.method === 'GET') {
      const snap = loadSnapshot();
      const fromSnap = !!(snap && snap.data && snap.data.config && typeof snap.data.config === 'object');
      ctx.sendJSON(res, 200, {
        ok: true,
        config: fromSnap ? snap.data.config : DEFAULT_CONFIG,
        source: fromSnap ? 'snapshot' : 'default',
        rev: snap ? snap.rev : null
      });
      return true;
    }
    if (req.method === 'POST') {
      // RBAC：admin 写操作仅 老板/店长
      if (!ctx.auth || auth.WRITE_ROLES.indexOf(ctx.auth.role) < 0) {
        ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: 仅老板/店长可写配置', role: ctx.auth ? ctx.auth.role : null });
        return true;
      }
      const { buf } = await ctx.readBody(req);
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      if (!body || typeof body.config !== 'object' || body.config === null) {
        ctx.sendJSON(res, 400, { ok: false, error: 'missing config(object)' });
        return true;
      }
      const { action, dedup } = enqueue('config.update', body.config, ctx.auth.account, ctx.traceId);
      ctx.sendJSON(res, 200, {
        ok: true, queued: true, dedup,
        id: action.id, status: action.status, rev: action.rev,
        note: '配置写已进入 actions 队列，由店内消费器执行后生效'
      });
      return true;
    }
    return false;
  }

  // 只读业务端点
  const m = pathname.match(/^\/api\/admin\/([a-z]+)$/);
  if (m && READONLY_KEYS.indexOf(m[1]) >= 0) {
    if (req.method !== 'GET') return false;
    const key = m[1];
    const snap = loadSnapshot();
    const arr = snap && snap.data && Array.isArray(snap.data[key]) ? snap.data[key] : [];
    ctx.sendJSON(res, 200, { ok: true, key, count: arr.length, items: arr, rev: snap ? snap.rev : null });
    return true;
  }

  return false;
}

module.exports = { handle };
