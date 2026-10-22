'use strict';
/*
 * routes/actions.js — actions 写回队列（红线②：所有写操作统一进队列，BFF 不直接写店内 DB）
 *
 *   GET  /api/actions?status=待执行         → 列表
 *   POST /api/actions {type, payload, operator}
 *        → 入队 {id, status:"queued", rev:当前快照rev, created_at, trace_id}
 *        幂等（两级，均返回已有 id + dedup:true）：
 *          ① 队列内：同 type+payload+operator 且仍在 OPEN（queued/待执行）→ 复用同一动作
 *          ② 事后：同指纹的动作**已执行**且在 EXECUTED_DEDUP_MS 窗口内 → 复用该已执行动作
 *             （dedup_of:"executed"）——防「连点两下 / 客户端重投 / 网络重试」产生两条动作、两笔入库
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
const provider = require('../lib/provider');

const FILE = 'actions_queue.json';
const EXPIRE_MS = 24 * 3600 * 1000;
const OPEN_STATES = ['queued', '待执行'];
/*
 * 事后幂等窗口：同一指纹的动作「已执行」之后，在此窗口内再次提交视为**同一次操作**，复用原动作不新建。
 * 取值权衡：太短挡不住重投；太长会把「同一操作人过一会儿确实想再做一次同样的写操作」误判成重复。
 * 5 分钟足够覆盖连点、超时重试、客户端/队列消息重投，而「同一 payload 逐字节相同」的独立操作在此窗口内极罕见。
 * 仅对「已执行」生效：已驳回/已过期/已回滚都允许重新发起（驳回后重申请是正常诉求）。
 */
const EXECUTED_DEDUP_MS = 5 * 60 * 1000;

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

// 动作终态时刻（已执行动作以 executed_at 为准）
function finishedAtMs(a) {
  const t = new Date(a.executed_at || a.updated_at || a.created_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

/* 事后幂等：同一次操作在「已执行」后又被提交（连点两下 / 重投）→ 返回那条已执行动作，不再新建 */
function findExecutedDup(q, hash, nowMs) {
  let hit = null;
  for (const a of q) {
    if (a.hash !== hash || a.status !== '已执行') continue;
    const t = finishedAtMs(a);
    if (nowMs - t > EXECUTED_DEDUP_MS) continue;
    if (!hit || t > finishedAtMs(hit)) hit = a;
  }
  return hit;
}

// 入队（幂等）：返回 {action, dedup, dedup_of}
function enqueue(type, payload, operator, traceId, meta) {
  const q = loadQueue();
  const dirty = sweep(q);            // 过期清扫的变更必须落盘（否则复投会命中一条「应已过期」的动作）
  const flush = () => { if (dirty) saveQueue(q); };
  const hash = hashOf(type, payload, operator);
  const exist = q.find((a) => a.hash === hash && OPEN_STATES.indexOf(a.status) >= 0);
  if (exist) {
    flush();
    return { action: exist, dedup: true, dedup_of: 'open' };
  }
  const done = findExecutedDup(q, hash, Date.now());
  if (done) {
    flush();
    return { action: done, dedup: true, dedup_of: 'executed' };
  }
  const snap = loadSnapshot();
  const now = new Date().toISOString();
  const m = meta || {};
  const fh = provider.isFrontHouseAction(type);
  const action = {
    id: 'act_' + crypto.randomBytes(8).toString('hex'),
    type: String(type || ''),
    payload: payload == null ? {} : payload,
    operator: operator || null,
    /* 前厅动作预留：meituan 模式下不写库，置 self 后启用（红线：切回自营才触达） */
    front_house: fh,
    pending_provider: fh ? provider.frontHouseProvider() : null,
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
    front_house: a.front_house === true,
    pending_provider: a.pending_provider || null,
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

/**
 * 把动作应用到「云端快照副本」（BFF 侧执行已迁移算法）。
 * 两个入口共用同一段逻辑：
 *   ① 端点 POST /api/actions/{id}/apply（人工触发）；
 *   ② 桌面端本地执行开关（CANTEEN_LOCAL_APPLY=1，确认后自动执行，见 confirm 分支）。
 * @returns {Promise<{status:number, body:object}>} HTTP 状态码 + 响应体
 */
async function applyToSnapshot(id, ctx) {
  const q = loadQueue();
  if (sweep(q)) saveQueue(q);
  const a = q.find((x) => x.id === id);
  if (!a) return { status: 404, body: { ok: false, error: 'action not found', id } };
  if (OPEN_STATES.indexOf(a.status) < 0) {
    return { status: 409, body: { ok: false, error: 'invalid state: ' + a.status, id, status: a.status } };
  }
  // 前厅动作在美团承接模式下禁止写库（切换 self 后才允许消费）
  if (a.front_house && !provider.isSelf()) {
    return {
      status: 423,
      body: {
        ok: false,
        error: 'pending_provider: 前厅动作在美团承接模式下不写库，置 FRONT_OF_HOUSE_PROVIDER=self 后启用',
        id, status: a.status
      }
    };
  }
  const { executeAction } = require('../lib/algorithms/execute');
  const snap = loadSnapshot();
  if (!snap) return { status: 409, body: { ok: false, error: 'no snapshot', id } };
  /* await 兼容异步算法（如 safety.ai_judge 需调用视觉模型）；同步算法返回值直接可用 */
  const out = await executeAction(snap, a);
  if (!out.handled) {
    // 未登记的算法：交回店内消费者（need-manual），不静默丢弃
    return { status: 422, body: { ok: false, error: out.error, id, status: a.status, route: 'store-consumer' } };
  }
  if (!out.ok) {
    a.status = '已驳回';
    a.error = out.error;
    a.executed_at = new Date().toISOString();
    a.updated_at = a.executed_at;
    saveQueue(q);
    return { status: 200, body: { ok: false, id, status: a.status, error: a.error } };
  }
  // 落库新快照：rev 自增，保证 confirm 的 rev 校验语义
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
  return {
    status: 200,
    body: { ok: true, id, status: a.status, rev: newRev, executed_at: a.executed_at, result: a.result }
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
    const { action, dedup, dedup_of: dupOf } = enqueue(body.type, body.payload, operator, ctx.traceId, {
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
      dedup_of: dupOf || null,
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
    const r = await applyToSnapshot(am[1], ctx);
    ctx.sendJSON(res, r.status, r.body);
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
      // 前厅动作在美团承接模式下禁止确认（切换 self 后才允许）
      if (a.front_house && !provider.isSelf()) {
        ctx.sendJSON(res, 423, {
          ok: false,
          error: 'pending_provider: 前厅动作在美团承接模式下不写库，置 FRONT_OF_HOUSE_PROVIDER=self 后启用',
          id, status: a.status
        });
        return true;
      }
      const snap = loadSnapshot();
      const curRev = snap ? snap.rev : null;
      // 准入提示锁：比对「云端快照 rev」（pusher 透传的店内 rev 滞后副本）。
      // 它只给出「你确认时基于的云端视图是否过期」的早期反馈，不是数据安全边界；
      // 真正的落库乐观锁在消费器 /api/sync 的 baseRev 三方合并（见 store-node/consumer.js）。
      // 两把锁不能合一：BFF 不直连店内 DB（红线②③⑤），confirm 只能看云端快照。
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
      /* 桌面端本地执行开关（CANTEEN_LOCAL_APPLY=1）：
       * 桌面端只跑 BFF、没有店内消费器（store-node/consumer），确认后没人执行队列，
       * 动作会永远停在「待执行」——审批中心看着成功、单据和库存却永远不变。
       * 开启后由 BFF 直接把动作应用到云端快照副本（复用 apply 同一段逻辑）。
       * 注意：开启后动作不会再回店内消费器（状态直接变「已执行」），
       *       故不可与真实店内节点（consumer）并用，只在「无店内节点」的桌面上开。 */
      let applied = null;
      if (process.env.CANTEEN_LOCAL_APPLY === '1') {
        const r = await applyToSnapshot(id, ctx);
        applied = Object.assign({ http: r.status }, r.body);
      }
      ctx.sendJSON(res, 200, {
        ok: true,
        id: a.id,
        status: applied && applied.ok ? applied.status : a.status,
        rev: a.rev,
        confirmed_at: a.confirmed_at,
        applied
      });
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
