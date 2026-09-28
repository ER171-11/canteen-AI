'use strict';
/*
 * routes/policies.js — SI 分级授权政策与审计（只改政策，不碰业务数据）
 *
 *   GET    /api/policies            → {auto_enabled, caps, policies[], today_auto}
 *   POST   /api/policies            → 新增/更新政策（需 actions.write）
 *   POST   /api/policies/toggle     → {auto_enabled}（需 actions.write）
 *   DELETE /api/policies/{id}       → 删除政策（需 actions.write）
 *   GET    /api/si/audit?limit=50   → SI 决策审计
 *
 * 红线：政策只决定 queued→待执行 的提前量；写路径仍是队列→consumer→/api/sync。
 */
const policy = require('../lib/policy');
const siAudit = require('../lib/si_audit');
const { mayWriteActions } = require('../lib/auth');

function view() {
  const cfg = policy.list();
  return {
    ok: true,
    auto_enabled: cfg.auto_enabled,
    caps: cfg.caps,
    policies: cfg.policies,
    today_auto: policy.todayAutoCount(),
    never_auto: Array.from(policy.NEVER_AUTO).sort()
  };
}

async function handle(req, res, ctx, pathname) {
  if (req.method === 'GET' && pathname === '/api/policies') {
    ctx.sendJSON(res, 200, view());
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/si/audit') {
    const limit = parseInt(ctx.query.get('limit') || '50', 10) || 50;
    ctx.sendJSON(res, 200, { ok: true, items: siAudit.tail(limit).reverse() });
    return true;
  }

  const canWrite = ctx.auth && mayWriteActions(ctx.auth);

  if (req.method === 'POST' && pathname === '/api/policies/toggle') {
    if (!canWrite) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
      return true;
    }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    body = body || {};
    policy.setAutoEnabled(body.auto_enabled === true);
    siAudit.log({
      trace_id: ctx.traceId, decision: 'toggle_auto',
      origin: 'human', policy_id: null,
      reason: 'auto_enabled=' + (body.auto_enabled === true),
      operator: ctx.auth.account || ctx.auth.role
    });
    ctx.sendJSON(res, 200, view());
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/policies') {
    if (!canWrite) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
      return true;
    }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || typeof body !== 'object') {
      ctx.sendJSON(res, 400, { ok: false, error: 'invalid body' });
      return true;
    }
    const rec = policy.upsert(Object.assign({}, body, {
      created_by: ctx.auth.account || ctx.auth.role
    }));
    siAudit.log({
      trace_id: ctx.traceId, decision: 'policy_upsert', origin: 'human',
      policy_id: rec.id, reason: rec.name,
      operator: ctx.auth.account || ctx.auth.role
    });
    ctx.sendJSON(res, 200, { ok: true, policy: rec });
    return true;
  }

  const dm = pathname.match(/^\/api\/policies\/([^/]+)$/);
  if (dm && req.method === 'DELETE') {
    if (!canWrite) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
      return true;
    }
    const removed = policy.remove(dm[1]);
    siAudit.log({
      trace_id: ctx.traceId, decision: 'policy_remove', origin: 'human',
      policy_id: dm[1], reason: removed ? 'removed' : 'not found',
      operator: ctx.auth.account || ctx.auth.role
    });
    ctx.sendJSON(res, 200, { ok: true, removed });
    return true;
  }

  return false;
}

module.exports = { handle, view };
