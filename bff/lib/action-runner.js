'use strict';
/*
 * lib/action-runner.js — 动作执行核心（ADR-010 Phase 0 接缝层）
 *
 * 职责：把一个动作「跑算法 + 乐观锁落库」，**不碰队列**（队列由调用方决定语义）。
 *   - BFF 路由（routes/actions.js::applyToSnapshot）：执行后按 HTTP 语义回状态码；
 *   - 独立 worker（lib/worker.js）：执行后按 worker 语义 ack（已执行/重试/驳回）。
 *
 * 与旧 applyToSnapshot 的差别：旧实现读快照后**盲写**（rev 自增不校验基准）；
 *   这里改为 casWrite(expectedRev = 读到的 rev)，冲突返回 conflict —— 对齐红线「乐观锁 rev」。
 *
 * 返回 outcome：
 *   executed     落库成功，rev 为新的快照 rev
 *   rejected     算法返回失败（out.ok=false）
 *   need-manual  动作类型未登记（算法层无 handler），不静默丢弃
 *   no-snapshot  当前无快照（空库/未播种）
 *   conflict     casWrite 时 rev 已被他人推进
 */
async function applyAction(adapter, action, opts) {
  const { executeAction } = require('./algorithms/execute');

  const snap = adapter.readSnapshot();
  if (!snap) return { outcome: 'no-snapshot', ok: false };

  let out;
  try {
    out = await executeAction(snap, action, opts);
  } catch (e) {
    return { outcome: 'rejected', ok: false, error: (e && e.message) || String(e) };
  }

  if (!out || !out.handled) {
    return {
      outcome: 'need-manual',
      ok: false,
      error: (out && out.error) || ('算法未登记 ' + ((action && action.type) || ''))
    };
  }
  if (!out.ok) {
    return { outcome: 'rejected', ok: false, error: out.error || 'algorithm failed' };
  }

  const expectedRev = Number.isFinite(snap.rev) ? snap.rev : 0;
  const next = Object.assign({}, out.snapshot, { generated_at: new Date().toISOString() });
  const cas = adapter.casWrite(null, expectedRev, next);
  if (!cas.ok) return { outcome: 'conflict', ok: false, rev: cas.rev };

  return { outcome: 'executed', ok: true, rev: cas.rev, result: out.result };
}

module.exports = { applyAction };
