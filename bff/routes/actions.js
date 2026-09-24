'use strict';
/*
 * routes/actions.js — actions 写回队列（红线②：所有写操作统一进队列，BFF 不直接写店内 DB）
 *
 *   GET  /api/actions?status=待执行         → 列表
 *   POST /api/actions {type, payload, operator}
 *        → 入队 {id, status:"queued", rev:当前快照rev, created_at, trace_id}
 *        幂等：type+payload+operator 哈希防重，重复提交返回已有 id（dedup:true）
 *   POST /api/actions/{id}/confirm {operator, rev}
 *        → queued→待执行；rev 与当前快照 rev 不符 409
 *   GET|POST /api/actions/{id}/status       → {status, executed_at, error?}
 *   POST /api/actions/{id}/execute {result} → 店内消费器回调，置 已执行/已驳回
 *
 * 状态机四态：待执行 / 已执行 / 已驳回 / 已过期（queued 或 待执行 超 24h 未执行自动过期）
 */
const crypto = require('crypto');
const store = require('../lib/store');
const { loadSnapshot } = require('./snapshot');

const FILE = 'actions_queue.json';
const EXPIRE_MS = 24 * 3600 * 1000;
const OPEN_STATES = ['queued', '待执行'];

function loadQueue() {
  const q = store.readJSON(FILE, []);
  return Array.isArray(q) ? q : [];
}

function saveQueue(q) { store.writeJSON(FILE, q); }

// 过期清扫：queued/待执行 超 24h → 已过期；返回是否有变更
function sweep(q) {
  const now = Date.now();
  let dirty = false;
  for (const a of q) {
    if (OPEN_STATES.indexOf(a.status) >= 0 && now - new Date(a.created_at).getTime() > EXPIRE_MS) {
      a.status = '已过期';
      a.updated_at = new Date().toISOString();
      dirty = true;
    }
  }
  return dirty;
}

function hashOf(type, payload, operator) {
  return crypto.createHash('sha256')
    .update(String(type) + '|' + JSON.stringify(payload == null ? null : payload) + '|' + String(operator || ''))
    .digest('hex');
}

// 入队（幂等）：返回 {action, dedup}
function enqueue(type, payload, operator, traceId) {
  const q = loadQueue();
  sweep(q);
  const hash = hashOf(type, payload, operator);
  const exist = q.find((a) => a.hash === hash && OPEN_STATES.indexOf(a.status) >= 0);
  if (exist) {
    if (sweep(q)) saveQueue(q);
    return { action: exist, dedup: true };
  }
  const snap = loadSnapshot();
  const now = new Date().toISOString();
  const action = {
    id: 'act_' + crypto.randomBytes(8).toString('hex'),
    type: String(type || ''),
    payload: payload == null ? {} : payload,
    operator: operator || null,
    hash,
    status: 'queued',
    rev: snap ? snap.rev : null,
    created_at: now,
    updated_at: now,
    confirmed_by: null,
    confirmed_at: null,
    executed_at: null,
    error: null,
    result: null,
    trace_id: traceId || null
  };
  q.push(action);
  saveQueue(q);
  return { action, dedup: false };
}

function publicView(a) {
  return {
    id: a.id,
    type: a.type,
    payload: a.payload,
    operator: a.operator,
    status: a.status,
    rev: a.rev,
    created_at: a.created_at,
    confirmed_at: a.confirmed_at,
    executed_at: a.executed_at,
    error: a.error,
    trace_id: a.trace_id
  };
}

async function handle(req, res, ctx, pathname) {
  // GET /api/actions?status=
  if (req.method === 'GET' && pathname === '/api/actions') {
    const q = loadQueue();
    if (sweep(q)) saveQueue(q);
    const st = (ctx.query.get('status') || '').trim();
    const list = st ? q.filter((a) => a.status === st) : q;
    ctx.sendJSON(res, 200, { ok: true, count: list.length, items: list.map(publicView) });
    return true;
  }

  // POST /api/actions —— 入队
  if (req.method === 'POST' && pathname === '/api/actions') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || !String(body.type || '').trim()) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing type' });
      return true;
    }
    const { action, dedup } = enqueue(body.type, body.payload, body.operator, ctx.traceId);
    ctx.sendJSON(res, 200, {
      ok: true,
      id: action.id,
      status: action.status,
      rev: action.rev,
      created_at: action.created_at,
      trace_id: action.trace_id,
      dedup
    });
    return true;
  }

  // /api/actions/{id}/confirm|status|execute
  const m = pathname.match(/^\/api\/actions\/([^/]+)\/(confirm|status|execute)$/);
  if (m) {
    const id = m[1];
    const sub = m[2];
    if (sub === 'status' && req.method !== 'GET' && req.method !== 'POST') return false;
    if (sub !== 'status' && req.method !== 'POST') return false;

    const q = loadQueue();
    if (sweep(q)) saveQueue(q);
    const a = q.find((x) => x.id === id);
    if (!a) {
      ctx.sendJSON(res, 404, { ok: false, error: 'action not found', id });
      return true;
    }

    if (sub === 'status') {
      ctx.sendJSON(res, 200, {
        ok: true, id: a.id, status: a.status,
        executed_at: a.executed_at, error: a.error || undefined
      });
      return true;
    }

    if (sub === 'confirm') {
      const { buf } = await ctx.readBody(req);
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      body = body || {};
      if (a.status !== 'queued') {
        ctx.sendJSON(res, 409, { ok: false, error: 'invalid state: ' + a.status, id, status: a.status });
        return true;
      }
      const snap = loadSnapshot();
      const curRev = snap ? snap.rev : null;
      if (String(body.rev) !== String(curRev)) {
        ctx.sendJSON(res, 409, {
          ok: false, error: 'rev mismatch', id,
          expected_rev: curRev, got_rev: body.rev == null ? null : body.rev
        });
        return true;
      }
      a.status = '待执行';
      a.confirmed_by = body.operator || null;
      a.confirmed_at = new Date().toISOString();
      a.updated_at = a.confirmed_at;
      saveQueue(q);
      ctx.sendJSON(res, 200, { ok: true, id: a.id, status: a.status, rev: a.rev, confirmed_at: a.confirmed_at });
      return true;
    }

    if (sub === 'execute') {
      const { buf } = await ctx.readBody(req);
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      body = body || {};
      if (OPEN_STATES.indexOf(a.status) < 0) {
        ctx.sendJSON(res, 409, { ok: false, error: 'invalid state: ' + a.status, id, status: a.status });
        return true;
      }
      const result = body.result;
      const rejected = result && result.ok === false;
      a.status = rejected ? '已驳回' : '已执行';
      a.error = rejected ? String((result && result.error) || 'rejected by consumer') : null;
      a.result = result == null ? null : result;
      a.executed_at = new Date().toISOString();
      a.updated_at = a.executed_at;
      saveQueue(q);
      ctx.sendJSON(res, 200, { ok: true, id: a.id, status: a.status, executed_at: a.executed_at, error: a.error || undefined });
      return true;
    }
  }

  return false;
}

module.exports = { handle, enqueue };
