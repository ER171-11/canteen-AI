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
 *   POST /api/actions/{id}/reject  {reason} → queued/待执行 → 已驳回（管理端审批）
 *
 * 状态机四态：待执行 / 已执行 / 已驳回 / 已过期（queued 或 待执行 超 24h 未执行自动过期）
 */
const crypto = require('crypto');
const store = require('../lib/store');
const { WRITE_ROLES, mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');
const policy = require('../lib/policy');
const siAudit = require('../lib/si_audit');

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
function enqueue(type, payload, operator, traceId, meta) {
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
  const m = meta || {};
  const action = {
    id: 'act_' + crypto.randomBytes(8).toString('hex'),
    type: String(type || ''),
    payload: payload == null ? {} : payload,
    operator: operator || null,
    hash,
    status: 'queued',
    rev: snap ? snap.rev : null,
    /* 分级授权预留：谁是发起方 / 命中政策 / 授权级别 / 回滚引用（P0 仅记录，不自动执行） */
    origin: (m.origin === 'si') ? 'si' : (m.origin || 'human'),
    policy_id: m.policy_id || null,
    tier: m.tier != null ? m.tier : (m.origin === 'si' ? 1 : 3),
    rollback_ref: m.rollback_ref || null,
    si_trace: m.si_trace || null,
    /* 分级授权执行痕迹 */
    auto_executed: false,
    executed_rev: null,
    via: null,
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
    origin: a.origin || 'human',
    policy_id: a.policy_id || null,
    tier: a.tier == null ? null : a.tier,
    rollback_ref: a.rollback_ref || null,
    auto_executed: a.auto_executed === true,
    executed_rev: a.executed_rev == null ? null : a.executed_rev,
    via: a.via || null,
    rollback_available: a.auto_executed === true && a.via === 'bff' && a.status === '已执行',
    created_at: a.created_at,
    confirmed_at: a.confirmed_at,
    executed_at: a.executed_at,
    error: a.error,
    trace_id: a.trace_id
  };
}

/* ------------------------------------------------------------------ */
/* 分级授权：政策命中则 queued → 待执行（消费者随后按原路径落库）        */
/* ------------------------------------------------------------------ */
const ROLLBACK_FILE = 'si_rollbacks.json';
const ROLLBACK_KEEP = 5;

function saveRollback(action, snap) {
  const all = store.readJSON(ROLLBACK_FILE, {});
  const ids = Object.keys(all);
  if (ids.length >= ROLLBACK_KEEP) {
    ids.sort((x, y) => new Date(all[x].saved_at).getTime() - new Date(all[y].saved_at).getTime());
    delete all[ids[0]];
  }
  all[action.id] = {
    action_id: action.id,
    type: action.type,
    saved_at: new Date().toISOString(),
    rev: snap ? snap.rev : null,
    data: snap ? snap.data : null,
    ext: snap && snap.ext !== undefined ? snap.ext : null
  };
  store.writeJSON(ROLLBACK_FILE, all);
}

/** 命中政策→提前置「待执行」并留回滚引用与审计；否则保持 queued */
function maybeAutoExecute(action) {
  if (!action || action.origin !== 'si' || action.status !== 'queued') return { auto: false };
  const ev = policy.evaluate(action);
  if (!ev.auto) {
    siAudit.log({
      trace_id: action.trace_id, action_id: action.id, type: action.type,
      origin: action.origin, decision: 'hold', policy_id: null,
      tier: action.tier, rev: action.rev, reason: ev.reason, amount: ev.amount
    });
    return { auto: false, reason: ev.reason };
  }
  const q = loadQueue();
  const a = q.find((x) => x.id === action.id);
  if (!a || a.status !== 'queued') return { auto: false, reason: '状态已变化' };
  const snap = loadSnapshot();
  saveRollback(a, snap);
  const now = new Date().toISOString();
  a.status = '待执行';
  a.auto_executed = true;
  a.tier = 2;
  a.policy_id = ev.policy_id;
  a.confirmed_by = 'si-policy:' + ev.policy_id;
  a.confirmed_at = now;
  a.updated_at = now;
  a.rollback_ref = ROLLBACK_FILE + '#' + a.id;
  saveQueue(q);
  siAudit.log({
    trace_id: a.trace_id, action_id: a.id, type: a.type, origin: 'si',
    decision: 'auto_execute', policy_id: ev.policy_id, tier: 2,
    rev: a.rev, reason: ev.reason, amount: ev.amount
  });
  return { auto: true, policy_id: ev.policy_id, tier: 2, reason: ev.reason };
}

/** 供 SI 战役/值守调用：入队 + 政策求值（命中则自动进入待执行） */
function propose(type, payload, meta) {
  const m = meta || {};
  const operator = m.operator || 'SI';
  const { action, dedup } = enqueue(type, payload, operator, m.trace_id || null, {
    origin: m.origin || 'si',
    policy_id: m.policy_id,
    tier: m.tier,
    rollback_ref: m.rollback_ref,
    si_trace: m.si_trace
  });
  const auto = dedup ? { auto: false } : maybeAutoExecute(action);
  return {
    action,
    id: action.id,
    dedup,
    auto: auto.auto === true,
    policy_id: auto.policy_id || null,
    reason: auto.reason || null
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

    // POST /api/actions —— 入队（需登录且可写）
  if (req.method === 'POST' && pathname === '/api/actions') {
    if (!ctx.auth) {
      ctx.sendJSON(res, 401, { ok: false, error: 'unauthorized: bearer token required' });
      return true;
    }
    if (!mayWriteActions(ctx.auth)) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required（当前账号只读，请用老板/店长登录）' });
      return true;
    }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || !String(body.type || '').trim()) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing type' });
      return true;
    }
    const operator = body.operator || ctx.auth.account || ctx.auth.role;
    const { action, dedup } = enqueue(body.type, body.payload, operator, ctx.traceId, {
      origin: body.origin,
      policy_id: body.policy_id,
      tier: body.tier,
      rollback_ref: body.rollback_ref,
      si_trace: body.si_trace
    });
    const auto = dedup ? { auto: false } : maybeAutoExecute(action);
    ctx.sendJSON(res, 200, {
      ok: true,
      id: action.id,
      status: auto.auto ? '待执行' : action.status,
      rev: action.rev,
      created_at: action.created_at,
      trace_id: action.trace_id,
      dedup,
      auto_executed: auto.auto === true,
      policy_id: auto.policy_id || null,
      auto_reason: auto.reason || null
    });
    return true;
  }

  // /api/actions/{id}/confirm|status|execute|reject
  // POST /api/actions/{id}/apply —— BFF 侧执行已迁移算法（作用于云端快照副本）
  const am = pathname.match(/^\/api\/actions\/([^/]+)\/apply$/);
  if (am && req.method === 'POST') {
    if (!ctx.auth || !mayWriteActions(ctx.auth)) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
      return true;
    }
    const id = am[1];
    const q = loadQueue();
    if (sweep(q)) saveQueue(q);
    const a = q.find((x) => x.id === id);
    if (!a) {
      ctx.sendJSON(res, 404, { ok: false, error: 'action not found', id });
      return true;
    }
    if (OPEN_STATES.indexOf(a.status) < 0) {
      ctx.sendJSON(res, 409, { ok: false, error: 'invalid state: ' + a.status, id, status: a.status });
      return true;
    }
    const { executeAction } = require('../lib/algorithms/execute');
    const snap = loadSnapshot();
    if (!snap) {
      ctx.sendJSON(res, 409, { ok: false, error: 'no snapshot', id });
      return true;
    }
    const out = executeAction(snap, a);
    if (!out.handled) {
      // 未登记的算法：交回店内消费者（need-manual），不静默丢弃
      ctx.sendJSON(res, 422, { ok: false, error: out.error, id, status: a.status, route: 'store-consumer' });
      return true;
    }
    if (!out.ok) {
      a.status = '已驳回';
      a.error = out.error;
      a.executed_at = new Date().toISOString();
      a.updated_at = a.executed_at;
      saveQueue(q);
      ctx.sendJSON(res, 200, { ok: false, id, status: a.status, error: a.error });
      return true;
    }
    // 落库新快照：rev 自增，保证 confirm 的 rev 校验语义
    const store = require('../lib/store');
    const newRev = typeof snap.rev === 'number' ? snap.rev + 1 : 1;
    const next = Object.assign({}, out.snapshot, {
      rev: newRev,
      generated_at: new Date().toISOString()
    });
    store.writeJSON('snapshot.json', next);
    a.status = '已执行';
    a.executed_rev = newRev;
    a.via = 'bff';
    a.result = out.result == null ? null : out.result;
    a.error = null;
    a.executed_at = next.generated_at;
    a.updated_at = a.executed_at;
    saveQueue(q);
    ctx.sendJSON(res, 200, {
      ok: true, id, status: a.status, rev: newRev,
      executed_at: a.executed_at, result: a.result
    });
    return true;
  }

  const m = pathname.match(/^\/api\/actions\/([^/]+)\/(confirm|status|execute|reject|rollback)$/);
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
        executed_at: a.executed_at,
        error: a.error || undefined,
        result: a.result == null ? undefined : a.result,
        desc: (a.result && (a.result.desc || a.result.detail)) || undefined
      });
      return true;
    }

    if (sub === 'confirm') {
      if (!ctx.auth || !mayWriteActions(ctx.auth)) {
        ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
        return true;
      }
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
      a.confirmed_by = body.operator || ctx.auth.account || ctx.auth.role || null;
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
      const rejected = (result && result.ok === false) || !!body.error;
      a.status = rejected ? '已驳回' : '已执行';
      a.error = rejected
        ? String((result && result.error) || body.error || 'rejected by consumer')
        : null;
      a.result = result == null ? null : result;
      a.executed_at = new Date().toISOString();
      a.updated_at = a.executed_at;
      const newRev = result && (result.new_rev != null ? result.new_rev : result.rev);
      if (newRev != null) a.executed_rev = newRev;
      a.via = 'store';
      saveQueue(q);
      ctx.sendJSON(res, 200, { ok: true, id: a.id, status: a.status, executed_at: a.executed_at, error: a.error || undefined });
      return true;
    }

    if (sub === 'reject') {
      if (!ctx.auth || !mayWriteActions(ctx.auth)) {
        ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
        return true;
      }
      const { buf } = await ctx.readBody(req);
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      body = body || {};
      if (OPEN_STATES.indexOf(a.status) < 0) {
        ctx.sendJSON(res, 409, { ok: false, error: 'invalid state: ' + a.status, id, status: a.status });
        return true;
      }
      a.status = '已驳回';
      a.error = String(body.reason || body.error || 'rejected by admin');
      a.updated_at = new Date().toISOString();
      a.executed_at = a.updated_at;
      saveQueue(q);
      ctx.sendJSON(res, 200, { ok: true, id: a.id, status: a.status, error: a.error });
      return true;
    }

    if (sub === 'rollback') {
      if (!ctx.auth || !mayWriteActions(ctx.auth)) {
        ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
        return true;
      }
      const deny = (reason) => {
        siAudit.log({
          trace_id: ctx.traceId, action_id: a.id, type: a.type, origin: 'human',
          decision: 'rollback_denied', policy_id: a.policy_id || null,
          tier: a.tier, rev: a.executed_rev, reason,
          operator: ctx.auth.account || ctx.auth.role
        });
        ctx.sendJSON(res, 409, { ok: false, id: a.id, need_manual: true, reason });
      };
      if (a.status !== '已执行') return deny('当前状态不可回滚：' + a.status);
      if (!a.auto_executed) return deny('仅自动执行的动作支持一键回滚');
      if (a.via !== 'bff') {
        return deny('该动作由店内消费者落库，云端无权威副本；请走店内快照回滚或人工处理');
      }
      const all = store.readJSON(ROLLBACK_FILE, {});
      const rb = all[a.id];
      if (!rb || rb.data == null) return deny('未找到回滚快照');
      const cur = loadSnapshot();
      const curRev = cur ? cur.rev : null;
      if (a.executed_rev != null && String(curRev) !== String(a.executed_rev)) {
        return deny('执行后已有新变更（rev ' + curRev + ' ≠ ' + a.executed_rev + '），禁止自动回滚');
      }
      const now = new Date().toISOString();
      const nextRev = (typeof curRev === 'number' ? curRev : 0) + 1;
      store.writeJSON('snapshot.json', {
        rev: nextRev,
        generated_at: now,
        machine: 'SI-ROLLBACK',
        data: rb.data,
        ext: rb.ext
      });
      a.status = '已回滚';
      a.error = null;
      a.updated_at = now;
      a.result = Object.assign({}, a.result || {}, { rollback_to_rev: nextRev });
      saveQueue(q);
      siAudit.log({
        trace_id: ctx.traceId, action_id: a.id, type: a.type, origin: 'human',
        decision: 'rollback', policy_id: a.policy_id || null, tier: a.tier,
        rev: nextRev, reason: 'restored pre-action snapshot',
        operator: ctx.auth.account || ctx.auth.role
      });
      ctx.sendJSON(res, 200, { ok: true, id: a.id, status: a.status, rev: nextRev });
      return true;
    }
  }

  return false;
}

module.exports = { handle, enqueue, propose };
