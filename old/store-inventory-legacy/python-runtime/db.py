# -*- coding: utf-8 -*-
"""
存储层：SQLite 保存整库 JSON + rev 乐观锁 + 自动快照。

设计要点
1. 业务数据(DB) 原样以 JSON 存进 docs.data，前端 8 个 tab 业务代码零改动；
2. rev 单调递增，写入时校验，避免两台机器互相盲覆盖；
3. 每次写入前把"旧版本"存入 snapshots（rev = 旧 rev），三向合并时作为 base；
4. 每次启动做一次文件级冷备份到 data/backups/，可随时整库回滚；
5. 使用默认 journal（非 WAL），避免 -wal/-shm 文件在网盘同步时丢失。
"""
import json
import os
import shutil
import sqlite3
import time
from datetime import datetime

SCHEMA = """
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
"""


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


class Conflict(Exception):
    """写入版本号不匹配：服务端已被其它机器改过。"""

    def __init__(self, rev, updated_at, machine):
        super().__init__("rev conflict")
        self.rev = rev
        self.updated_at = updated_at
        self.machine = machine


class Store:
    def __init__(self, db_path, backup_dir=None, keep_days=30, keep_count=200):
        self.db_path = os.path.abspath(db_path)
        self.backup_dir = os.path.abspath(backup_dir) if backup_dir else None
        self.keep_days = keep_days
        self.keep_count = keep_count
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        if self.backup_dir:
            os.makedirs(self.backup_dir, exist_ok=True)
        self._init()

    # ---------- 基础 ----------
    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self):
        with self._conn() as conn:
            conn.executescript(SCHEMA)

    # ---------- 读 ----------
    def get(self):
        """返回 {empty, rev, data, updated_at, machine}"""
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM docs WHERE id=1").fetchone()
        if not row:
            return {"empty": True, "rev": 0, "data": None,
                    "updated_at": None, "machine": None}
        return {
            "empty": False,
            "rev": row["rev"],
            "data": json.loads(row["data"]),
            "updated_at": row["updated_at"],
            "machine": row["machine"],
        }

    def rev(self):
        return self.get()["rev"]

    def size(self):
        return os.path.getsize(self.db_path) if os.path.exists(self.db_path) else 0

    # ---------- 写 ----------
    def put(self, rev, data, machine, note="", force=False):
        """
        写入整库。rev 必须与当前 rev 一致（force=True 时忽略）。
        空库首次写入接受任意 rev。成功前自动把旧版本存入 snapshots。
        """
        cur = self.get()
        if not cur["empty"] and not force and int(rev or 0) != cur["rev"]:
            raise Conflict(cur["rev"], cur["updated_at"], cur["machine"])

        if not cur["empty"]:
            self._save_snapshot(cur["rev"], cur["data"], cur["machine"], note or "before-write")

        new_rev = (cur["rev"] or 0) + 1
        payload = json.dumps(data, ensure_ascii=False)
        ts = now_iso()
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO docs(id,data,rev,updated_at,machine,app)"
                " VALUES(1,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET data=excluded.data, rev=excluded.rev,"
                " updated_at=excluded.updated_at, machine=excluded.machine, app=excluded.app",
                (payload, new_rev, ts, machine, "panda-inv"),
            )
        # 写入后的版本同样留档：客户端下次带着 rev=N 来同步时，base 一定找得到
        self._save_snapshot(new_rev, data, machine, note or "after-write")
        return {"ok": True, "rev": new_rev, "updated_at": ts}

    # ---------- 快照 ----------
    def _save_snapshot(self, rev, data, machine, note=""):
        with self._conn() as conn:
            exists = conn.execute(
                "SELECT id FROM snapshots WHERE rev=? LIMIT 1", (rev,)).fetchone()
            if exists:
                return
            conn.execute(
                "INSERT INTO snapshots(rev,data,ts,machine,note) VALUES(?,?,?,?,?)",
                (rev, json.dumps(data, ensure_ascii=False), now_iso(), machine, note),
            )
        self._trim_snapshots()

    def snapshot(self, machine, note="manual"):
        cur = self.get()
        if cur["empty"]:
            return None
        self._save_snapshot(cur["rev"], cur["data"], machine, note)
        return cur["rev"]

    def get_snapshot(self, rev):
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM snapshots WHERE rev=? ORDER BY id DESC LIMIT 1", (rev,)
            ).fetchone()
        if not row:
            return None
        return {"rev": row["rev"], "data": json.loads(row["data"]),
                "ts": row["ts"], "machine": row["machine"], "note": row["note"]}

    def list_snapshots(self, limit=50):
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id,rev,ts,machine,note,length(data) AS size"
                " FROM snapshots ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def rollback(self, rev, machine):
        snap = self.get_snapshot(rev)
        if not snap:
            return None
        return self.put(self.rev(), snap["data"], machine, note="rollback-to-%s" % rev, force=True)

    def _trim_snapshots(self):
        with self._conn() as conn:
            conn.execute(
                "DELETE FROM snapshots WHERE id NOT IN"
                " (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)",
                (self.keep_count,),
            )

    # ---------- 文件级冷备份 ----------
    def cold_backup(self, tag="boot"):
        if not self.backup_dir or not os.path.exists(self.db_path):
            return None
        os.makedirs(self.backup_dir, exist_ok=True)
        name = "餐厅系统_%s_%s.db" % (datetime.now().strftime("%Y%m%d_%H%M%S"), tag)
        dst = os.path.join(self.backup_dir, name)
        try:
            shutil.copy2(self.db_path, dst)
        except Exception as exc:  # 备份失败不影响主流程
            print("[warn] 冷备份失败: %s" % exc)
            return None
        self._trim_backups()
        return dst

    def _trim_backups(self):
        try:
            files = sorted(
                (f for f in os.listdir(self.backup_dir) if f.endswith(".db")),
                reverse=True,
            )
        except FileNotFoundError:
            return
        expire = time.time() - self.keep_days * 86400
        for f in files[self.keep_count:]:
            try:
                os.remove(os.path.join(self.backup_dir, f))
            except OSError:
                pass
        for f in files[: self.keep_count]:
            p = os.path.join(self.backup_dir, f)
            try:
                if os.path.getmtime(p) < expire:
                    os.remove(p)
            except OSError:
                pass
