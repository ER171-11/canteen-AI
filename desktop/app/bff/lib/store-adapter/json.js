'use strict';
/*
 * lib/store-adapter/json.js — JSON 文件适配器（生产现状，行为与旧代码逐字一致）
 *
 * 复用 lib/store.js（bff/data 下的 JSON / JSONL 原子写），把它的直读写收口到
 * 适配器接口。默认适配器就是它，故切换 Phase 0 不改变任何运行时行为。
 *
 * 文件：
 *   snapshot.json          → 主存快照
 *   actions_queue.json     → 动作队列
 *   action_audit.jsonl     → 接缝层审计（与 HTTP 的 audit.jsonl 分开，避免混淆）
 */
const store = require('../store');

const SNAP_FILE = 'snapshot.json';
const QUEUE_FILE = 'actions_queue.json';
const AUDIT_FILE = 'action_audit.jsonl';

/** 快照 rev 归一：非数字视为「无基准」 */
function revOf(snap) {
  if (!snap || typeof snap !== 'object') return null;
  return Number.isFinite(snap.rev) ? snap.rev : null;
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function create() {
  function readSnapshot() {
    const s = store.readJSON(SNAP_FILE, null);
    return (s && typeof s === 'object' && s.data !== undefined) ? s : null;
  }

  function writeSnapshot(storeId, snapshot) {
    store.writeJSON(SNAP_FILE, snapshot);
  }

  function casWrite(storeId, expectedRev, snapshot) {
    const cur = store.readJSON(SNAP_FILE, null);
    const curRev = revOf(cur);
    const exp = (expectedRev == null || expectedRev === '') ? null : Number(expectedRev);
    if (curRev == null) {
      // 空库首次写：只接受「无基准」或 rev=0
      if (!(exp == null || exp === 0)) return { ok: false, conflict: true, rev: null };
    } else if (exp == null || exp !== curRev) {
      return { ok: false, conflict: true, rev: curRev };
    }
    const nextRev = (curRev == null ? 0 : curRev) + 1;
    store.writeJSON(SNAP_FILE, Object.assign({}, snapshot, { rev: nextRev }));
    return { ok: true, rev: nextRev };
  }

  function loadQueue() {
    const q = store.readJSON(QUEUE_FILE, []);
    return Array.isArray(q) ? q : [];
  }

  function saveQueue(arr) {
    store.writeJSON(QUEUE_FILE, Array.isArray(arr) ? arr : []);
  }

  function enqueue(action) {
    const q = loadQueue();
    q.push(action);
    saveQueue(q);
    return action;
  }

  /** 原子认领：单进程内读-改-写；多 worker 并发依赖 sqlite/pg 实现 */
  function claim(workerId, limit) {
    const q = loadQueue();
    const now = new Date().toISOString();
    const n = Math.max(1, Math.min(100, Number(limit) || 10));
    const got = [];
    for (const a of q) {
      if (got.length >= n) break;
      if (!a || a.status !== '待执行') continue;
      a.status = '执行中';
      a.claimed_by = workerId || null;
      a.claimed_at = now;
      a.attempts = (Number(a.attempts) || 0) + 1;
      a.updated_at = now;
      got.push(a);
    }
    if (got.length) saveQueue(q);
    return clone(got);
  }

  function ack(id, patch) {
    const q = loadQueue();
    const a = q.find((x) => x && x.id === id);
    if (!a) return { ok: false, error: 'action not found: ' + id };
    Object.assign(a, patch || {}, { updated_at: new Date().toISOString() });
    saveQueue(q);
    return { ok: true, action: clone(a) };
  }

  function appendAudit(entry) {
    store.appendJSONL(AUDIT_FILE, entry);
  }

  function listAudit(limit) {
    return store.tailJSONL(AUDIT_FILE, limit);
  }

  return {
    kind: 'json',
    readSnapshot,
    writeSnapshot,
    casWrite,
    loadQueue,
    saveQueue,
    enqueue,
    claim,
    ack,
    updateAction: ack,
    appendAudit,
    listAudit,
    close() { /* 无句柄 */ }
  };
}

module.exports = { create, SNAP_FILE, QUEUE_FILE, AUDIT_FILE };
