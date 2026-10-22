'use strict';
/*
 * db.js — SQLite 存储层的 Node 移植，逐行对照 store-inventory/server/db.py。
 *
 * 存储层：SQLite 保存整库 JSON + rev 乐观锁 + 自动快照。
 *
 * 设计要点
 * 1. 业务数据(DB) 原样以 JSON 存进 docs.data；
 * 2. rev 单调递增，写入时校验，避免两台机器互相盲覆盖；
 * 3. 每次写入前把"旧版本"存入 snapshots（rev = 旧 rev），三向合并时作为 base；
 * 4. 每次启动做一次文件级冷备份到 data/backups/，可随时整库回滚；
 * 5. 使用默认 journal（非 WAL）。
 *
 * 零第三方依赖：仅用 Node 内置 node:sqlite / fs / path。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// 与 db.py 的 SCHEMA 逐字一致
const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs(
  id         INTEGER PRIMARY KEY CHECK(id=1),
  data       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at TEXT,
  machine    TEXT,
  app        TEXT
);
CREATE TABLE IF NOT EXISTS snapshots(
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  rev     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  ts      TEXT,
  machine TEXT,
  note    TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_rev ON snapshots(rev);
`;

const pad2 = (n) => String(n).padStart(2, '0');

// 对应 db.py 的 now_iso()：本地时区、秒级、带偏移
function nowIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset(); // 东为正（分钟）
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60)
  );
}

// 对应 db.py 的 Conflict
class Conflict extends Error {
  constructor(rev, updatedAt, machine) {
    super('rev conflict');
    this.name = 'Conflict';
    this.rev = rev;
    this.updated_at = updatedAt;
    this.machine = machine;
  }
}

// node:sqlite 返回 null 原型对象，转成普通对象以对齐 Python dict
function rowToObj(row) {
  if (!row) return row;
  return Object.assign({}, row);
}

class Store {
  constructor(dbPath, backupDir = null, keepDays = 30, keepCount = 200) {
    this.db_path = path.resolve(dbPath);
    this.backup_dir = backupDir ? path.resolve(backupDir) : null;
    this.keep_days = keepDays;
    this.keep_count = keepCount;
    fs.mkdirSync(path.dirname(this.db_path), { recursive: true });
    if (this.backup_dir) fs.mkdirSync(this.backup_dir, { recursive: true });
    this._init();
  }

  // ---------- 基础 ----------
  _conn() {
    // Python 每次操作新开连接；这里同样每次新开，用完即关
    return new DatabaseSync(this.db_path);
  }

  _withConn(fn) {
    const conn = this._conn();
    try {
      return fn(conn);
    } finally {
      try { conn.close(); } catch (e) { /* ignore */ }
    }
  }

  _init() {
    this._withConn((conn) => conn.exec(SCHEMA));
  }

  // ---------- 读 ----------
  // 返回 {empty, rev, data, updated_at, machine}
  get() {
    const row = this._withConn((conn) =>
      conn.prepare('SELECT * FROM docs WHERE id=1').get()
    );
    if (!row) {
      return { empty: true, rev: 0, data: null, updated_at: null, machine: null };
    }
    return {
      empty: false,
      rev: row.rev,
      data: JSON.parse(row.data),
      updated_at: row.updated_at,
      machine: row.machine,
    };
  }

  rev() {
    return this.get().rev;
  }

  size() {
    try {
      return fs.statSync(this.db_path).size;
    } catch (e) {
      return 0;
    }
  }

  // ---------- 写 ----------
  /*
   * 写入整库。rev 必须与当前 rev 一致（force=true 时忽略）。
   * 空库首次写入接受任意 rev。成功前自动把旧版本存入 snapshots。
   */
  put(rev, data, machine, note = '', force = false) {
    const cur = this.get();
    if (!cur.empty && !force && toInt(rev) !== cur.rev) {
      throw new Conflict(cur.rev, cur.updated_at, cur.machine);
    }

    if (!cur.empty) {
      this._save_snapshot(cur.rev, cur.data, cur.machine, note || 'before-write');
    }

    const newRev = (cur.rev || 0) + 1;
    const payload = JSON.stringify(data);
    const ts = nowIso();
    this._withConn((conn) => {
      conn.prepare(
        'INSERT INTO docs(id,data,rev,updated_at,machine,app)' +
        ' VALUES(1,?,?,?,?,?)' +
        ' ON CONFLICT(id) DO UPDATE SET data=excluded.data, rev=excluded.rev,' +
        ' updated_at=excluded.updated_at, machine=excluded.machine, app=excluded.app'
      ).run(payload, newRev, ts, machine, 'panda-inv');
    });
    // 写入后的版本同样留档：客户端下次带着 rev=N 来同步时，base 一定找得到
    this._save_snapshot(newRev, data, machine, note || 'after-write');
    return { ok: true, rev: newRev, updated_at: ts };
  }

  // ---------- 快照 ----------
  _save_snapshot(rev, data, machine, note = '') {
    const inserted = this._withConn((conn) => {
      const exists = conn.prepare('SELECT id FROM snapshots WHERE rev=? LIMIT 1').get(rev);
      if (exists) return false;
      conn.prepare(
        'INSERT INTO snapshots(rev,data,ts,machine,note) VALUES(?,?,?,?,?)'
      ).run(rev, JSON.stringify(data), nowIso(), machine, note);
      return true;
    });
    if (inserted) this._trim_snapshots();
  }

  snapshot(machine, note = 'manual') {
    const cur = this.get();
    if (cur.empty) return null;
    this._save_snapshot(cur.rev, cur.data, machine, note);
    return cur.rev;
  }

  get_snapshot(rev) {
    const row = this._withConn((conn) =>
      conn.prepare(
        'SELECT * FROM snapshots WHERE rev=? ORDER BY id DESC LIMIT 1'
      ).get(rev)
    );
    if (!row) return null;
    return {
      rev: row.rev,
      data: JSON.parse(row.data),
      ts: row.ts,
      machine: row.machine,
      note: row.note,
    };
  }

  list_snapshots(limit = 50) {
    const rows = this._withConn((conn) =>
      conn.prepare(
        'SELECT id,rev,ts,machine,note,length(data) AS size' +
        ' FROM snapshots ORDER BY id DESC LIMIT ?'
      ).all(limit)
    );
    return rows.map(rowToObj);
  }

  rollback(rev, machine) {
    const snap = this.get_snapshot(rev);
    if (!snap) return null;
    return this.put(this.rev(), snap.data, machine, 'rollback-to-' + rev, true);
  }

  _trim_snapshots() {
    this._withConn((conn) => {
      conn.prepare(
        'DELETE FROM snapshots WHERE id NOT IN' +
        ' (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)'
      ).run(this.keep_count);
    });
  }

  // ---------- 文件级冷备份 ----------
  cold_backup(tag = 'boot') {
    if (!this.backup_dir || !fs.existsSync(this.db_path)) return null;
    fs.mkdirSync(this.backup_dir, { recursive: true });
    const d = new Date();
    const stamp =
      d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    const name = '餐厅系统_' + stamp + '_' + tag + '.db';
    const dst = path.join(this.backup_dir, name);
    try {
      fs.copyFileSync(this.db_path, dst);
    } catch (exc) { // 备份失败不影响主流程
      console.log('[warn] 冷备份失败: ' + (exc && exc.message));
      return null;
    }
    this._trim_backups();
    return dst;
  }

  _trim_backups() {
    let files;
    try {
      files = fs.readdirSync(this.backup_dir)
        .filter((f) => f.endsWith('.db'))
        .sort()
        .reverse();
    } catch (e) {
      return;
    }
    const expire = Date.now() / 1000 - this.keep_days * 86400;
    for (const f of files.slice(this.keep_count)) {
      try { fs.unlinkSync(path.join(this.backup_dir, f)); } catch (e) { /* ignore */ }
    }
    for (const f of files.slice(0, this.keep_count)) {
      const p = path.join(this.backup_dir, f);
      try {
        if (fs.statSync(p).mtimeMs / 1000 < expire) fs.unlinkSync(p);
      } catch (e) { /* ignore */ }
    }
  }
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

module.exports = { SCHEMA, nowIso, Conflict, Store };
