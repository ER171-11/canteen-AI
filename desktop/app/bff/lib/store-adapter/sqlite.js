'use strict';
/*
 * lib/store-adapter/sqlite.js — SQLite 适配器（Phase 0 本地替身 / 契约测试）
 *
 * 用 Node 内置 `node:sqlite`（DatabaseSync，同步 API，零安装），把同一套
 * StoreAdapter 契约落到真库上，用于：
 *   1) 契约测试：与 json 适配器跑同一套断言，证明接缝可用；
 *   2) 独立 worker 的本地演练（真事务 + 真 CAS，不是假快照）；
 *   3) Phase 1 接 PG 时的行为参照。
 *
 * 注意：Phase 0 的运行时主存**仍是 json**；本适配器不进生产、不改桌面行为。
 *   `node:sqlite` 为**懒加载**，桌面端默认（json）不会 require 它。
 *
 * 表：
 *   snapshots(store_id PK, rev, data TEXT, ext TEXT, meta TEXT, updated_at)
 *   action_queue(id PK, status, created_at, data TEXT)   // data = 整条动作 JSON
 *   audit(id AUTOINCREMENT, at, data TEXT)
 */
const DEFAULT_STORE_ID = 'default';

function sidOf(storeId) {
  return (storeId == null || storeId === '') ? DEFAULT_STORE_ID : String(storeId);
}

function parse(text, fallback) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

/** 快照里除 data/ext/rev 之外的顶层字段（generated_at/size/machine…） */
const META_KEYS = ['generated_at', 'size', 'machine'];

function metaOf(snapshot) {
  const meta = {};
  for (const k of META_KEYS) {
    if (snapshot && snapshot[k] !== undefined) meta[k] = snapshot[k];
  }
  return meta;
}

function revOf(row) {
  if (!row) return null;
  const n = Number(row.rev);
  return Number.isFinite(n) ? n : null;
}

function create(opts) {
  const o = opts || {};
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    throw new Error('SQLite 适配器不可用：当前 Node 未提供 node:sqlite（需 Node >= 22.5）。detail='
      + ((e && e.message) || e));
  }
  const db = new DatabaseSync(o.dbPath || ':memory:', { timeout: 15000 });

  db.exec([
    'CREATE TABLE IF NOT EXISTS snapshots (',
    '  store_id TEXT PRIMARY KEY,',
    '  rev INTEGER NOT NULL DEFAULT 0,',
    '  data TEXT,',
    '  ext TEXT,',
    '  meta TEXT,',
    '  updated_at TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS action_queue (',
    '  id TEXT PRIMARY KEY,',
    '  status TEXT,',
    '  created_at TEXT,',
    '  data TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS audit (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  at TEXT,',
    '  data TEXT',
    ');'
  ].join('\n'));

  function readSnapshot(storeId) {
    const row = db.prepare('SELECT rev, data, ext, meta FROM snapshots WHERE store_id=?').all(sidOf(storeId))[0];
    if (!row) return null;
    const data = parse(row.data, undefined);
    if (data === undefined) return null;
    const meta = parse(row.meta, {}) || {};
    const snap = Object.assign({}, meta, { rev: revOf(row), data });
    if (row.ext != null) snap.ext = parse(row.ext, null);
    return snap;
  }

  function writeSnapshot(storeId, snapshot) {
    const s = snapshot || {};
    const rev = Number.isFinite(s.rev) ? s.rev : 0;
    db.prepare([
      'INSERT INTO snapshots(store_id, rev, data, ext, meta, updated_at)',
      'VALUES(?,?,?,?,?,?)',
      'ON CONFLICT(store_id) DO UPDATE SET',
      '  rev=excluded.rev, data=excluded.data, ext=excluded.ext,',
      '  meta=excluded.meta, updated_at=excluded.updated_at'
    ].join('\n')).run(
      sidOf(storeId),
      rev,
      JSON.stringify(s.data === undefined ? null : s.data),
      s.ext == null ? null : JSON.stringify(s.ext),
      JSON.stringify(metaOf(s)),
      new Date().toISOString()
    );
  }

  function casWrite(storeId, expectedRev, snapshot) {
    const sid = sidOf(storeId);
    const s = snapshot || {};
    const exp = (expectedRev == null || expectedRev === '') ? 0 : Number(expectedRev);
    const now = new Date().toISOString();
    const dataText = JSON.stringify(s.data === undefined ? null : s.data);
    const extText = s.ext == null ? null : JSON.stringify(s.ext);
    const metaText = JSON.stringify(metaOf(s));

    const existing = db.prepare('SELECT rev FROM snapshots WHERE store_id=?').all(sid)[0];
    if (!existing) {
      if (exp !== 0) return { ok: false, conflict: true, rev: null };
      db.prepare('INSERT INTO snapshots(store_id, rev, data, ext, meta, updated_at) VALUES(?,?,?,?,?,?)')
        .run(sid, 1, dataText, extText, metaText, now);
      return { ok: true, rev: 1 };
    }

    const info = db.prepare(
      'UPDATE snapshots SET rev=rev+1, data=?, ext=?, meta=?, updated_at=? WHERE store_id=? AND rev=?'
    ).run(dataText, extText, metaText, now, sid, exp);
    const cur = db.prepare('SELECT rev FROM snapshots WHERE store_id=?').all(sid)[0];
    if (Number(info.changes) === 0) {
      return { ok: false, conflict: true, rev: revOf(cur) };
    }
    return { ok: true, rev: revOf(cur) };
  }

  function loadQueue() {
    return db.prepare('SELECT data FROM action_queue ORDER BY created_at, rowid').all()
      .map((r) => parse(r.data, null))
      .filter((a) => a && typeof a === 'object');
  }

  function saveQueue(arr) {
    const list = Array.isArray(arr) ? arr : [];
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM action_queue');
      const ins = db.prepare('INSERT INTO action_queue(id, status, created_at, data) VALUES(?,?,?,?)');
      for (const a of list) {
        if (!a || a.id == null) continue;
        ins.run(String(a.id), String(a.status || ''), String(a.created_at || ''), JSON.stringify(a));
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  function enqueue(action) {
    if (!action || action.id == null) throw new Error('enqueue: action.id required');
    db.prepare('INSERT OR REPLACE INTO action_queue(id, status, created_at, data) VALUES(?,?,?,?)')
      .run(String(action.id), String(action.status || ''), String(action.created_at || ''), JSON.stringify(action));
    return action;
  }

  /** 原子认领：BEGIN IMMEDIATE 串行化，多 worker 也不会取到同一条 */
  function claim(workerId, limit) {
    const n = Math.max(1, Math.min(100, Number(limit) || 10));
    const now = new Date().toISOString();
    const got = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare(
        "SELECT data FROM action_queue WHERE status='待执行' ORDER BY created_at, rowid LIMIT ?"
      ).all(n);
      const upd = db.prepare('UPDATE action_queue SET data=? WHERE id=?');
      for (const r of rows) {
        const a = parse(r.data, null);
        if (!a || a.status !== '待执行') continue;
        a.status = '执行中';
        a.claimed_by = workerId || null;
        a.claimed_at = now;
        a.attempts = (Number(a.attempts) || 0) + 1;
        a.updated_at = now;
        upd.run(JSON.stringify(a), String(a.id));
        got.push(JSON.parse(JSON.stringify(a)));
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
      throw e;
    }
    return got;
  }

  function ack(id, patch) {
    const row = db.prepare('SELECT data FROM action_queue WHERE id=?').all(String(id))[0];
    if (!row) return { ok: false, error: 'action not found: ' + id };
    const a = parse(row.data, {}) || {};
    Object.assign(a, patch || {}, { updated_at: new Date().toISOString() });
    db.prepare('UPDATE action_queue SET status=?, data=? WHERE id=?')
      .run(String(a.status || ''), JSON.stringify(a), String(id));
    return { ok: true, action: a };
  }

  function appendAudit(entry) {
    db.prepare('INSERT INTO audit(at, data) VALUES(?,?)')
      .run(new Date().toISOString(), JSON.stringify(entry == null ? null : entry));
  }

  function listAudit(limit) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 100));
    return db.prepare('SELECT data FROM audit ORDER BY id DESC LIMIT ?').all(n)
      .map((r) => parse(r.data, null))
      .filter((x) => x != null)
      .reverse();
  }

  return {
    kind: 'sqlite',
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
    close() { try { db.close(); } catch (e) { /* ignore */ } }
  };
}

module.exports = { create };
