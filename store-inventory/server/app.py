# -*- coding: utf-8 -*-
"""
熊猫五福餐厅进销存系统 · 本地数据库服务

零第三方依赖（只用 Python 标准库 http.server + sqlite3）。
前端页面无论从 file:// 双击打开，还是从 http://127.0.0.1:8765/ 访问，
都通过同一套 API 读写 SQLite，file:// 场景依赖 CORS 头放行。

API
  GET  /api/health         服务与数据库状态
  GET  /api/rev            仅取版本号（轻量心跳，判断是否需要合并）
  GET  /api/db             取整库 {rev, data}
  PUT  /api/db             {rev, data, machine} 整库写入（rev 不匹配返回 409）
  POST /api/sync           {baseRev, data, machine} 三向合并后写入
  GET  /api/snapshots      快照列表（可用于回滚）
  POST /api/snapshot       手动打快照
  POST /api/rollback       {rev} 回滚到指定快照
  GET  /                   静态页面（可选，便于 http 方式访问系统）
"""
import json
import os
import sys
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote, quote

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))   # server/
ROOT_DIR = os.path.dirname(BASE_DIR)                    # 项目根（config 里相对路径的基准）
sys.path.insert(0, BASE_DIR)

from db import Store, Conflict, now_iso  # noqa: E402
import merge as merge_mod  # noqa: E402

CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
DEFAULT_CONFIG = {
    "port": 8765,
    "host": "127.0.0.1",
    "db_path": "data/餐厅系统.db",
    "backup_dir": "data/backups",
    "machine_id": "SHOP",
    "snapshot_keep_days": 30,
    "snapshot_keep_count": 200,
    "serve_static": True,
    "static_root": ".",
    "index_file": "熊猫五福餐厅进销存系统_真实数据版.html",
    "open_browser": False,
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        pass
    except Exception as exc:
        print("[warn] 读取 config.json 失败，使用默认配置: %s" % exc)
    return cfg


def abspath(p):
    return p if os.path.isabs(p) else os.path.abspath(os.path.join(ROOT_DIR, p))


CFG = load_config()
STORE = Store(
    abspath(CFG["db_path"]),
    backup_dir=abspath(CFG["backup_dir"]),
    keep_days=CFG["snapshot_keep_days"],
    keep_count=CFG["snapshot_keep_count"],
)
STATIC_ROOT = abspath(CFG["static_root"])
MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel", ".csv": "text/csv; charset=utf-8",
    ".pdf": "application/pdf",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "PandaInvDB/1.0"

    # ---------- 基础 ----------
    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"),
                                            fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                return self._health()
            if path == "/api/rev":
                cur = STORE.get()
                return self._json({"ok": True, "rev": cur["rev"], "empty": cur["empty"],
                                   "updated_at": cur["updated_at"], "machine": cur["machine"]})
            if path == "/api/db":
                cur = STORE.get()
                return self._json({"ok": True, "rev": cur["rev"], "empty": cur["empty"],
                                   "updated_at": cur["updated_at"], "machine": cur["machine"],
                                   "data": cur["data"]})
            if path == "/api/snapshots":
                return self._json({"ok": True, "items": STORE.list_snapshots()})
            if CFG.get("serve_static"):
                return self._static(path)
            return self._json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            return self._json({"ok": False, "error": str(exc)}, 500)

    def do_PUT(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/db":
                payload = self._body()
                data = payload.get("data")
                if data is None:
                    return self._json({"ok": False, "error": "missing data"}, 400)
                machine = payload.get("machine") or CFG["machine_id"]
                try:
                    res = STORE.put(payload.get("rev"), data, machine,
                                    note="force-push" if payload.get("force") else "client-put",
                                    force=bool(payload.get("force")))
                except Conflict as cf:
                    cur = STORE.get()
                    return self._json({
                        "ok": False, "error": "conflict", "rev": cf.rev,
                        "updated_at": cf.updated_at, "machine": cf.machine,
                        "data": cur["data"],
                    }, 409)
                return self._json({"ok": True, **res})
            return self._json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            return self._json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self._body()
            if path == "/api/sync":
                return self._sync(payload)
            if path == "/api/snapshot":
                rev = STORE.snapshot(payload.get("machine") or CFG["machine_id"],
                                     payload.get("note") or "manual")
                return self._json({"ok": True, "rev": rev})
            if path == "/api/rollback":
                res = STORE.rollback(payload.get("rev"),
                                     payload.get("machine") or CFG["machine_id"])
                if not res:
                    return self._json({"ok": False, "error": "snapshot not found"}, 404)
                return self._json({"ok": True, **res})
            return self._json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            return self._json({"ok": False, "error": str(exc)}, 500)

    # ---------- 业务 ----------
    def _health(self):
        cur = STORE.get()
        stat = {
            "ings": len((cur["data"] or {}).get("ings", [])),
            "dishes": len((cur["data"] or {}).get("dishes", [])),
            "pos": len((cur["data"] or {}).get("pos", [])),
            "sales": len((cur["data"] or {}).get("sales", [])),
        } if cur["data"] else {}
        return self._json({
            "ok": True,
            "service": "panda-inv-db",
            "machine": CFG["machine_id"],
            "db_path": STORE.db_path,
            "db_size": STORE.size(),
            "rev": cur["rev"],
            "empty": cur["empty"],
            "updated_at": cur["updated_at"],
            "counts": stat,
            "time": now_iso(),
        })

    def _sync(self, payload):
        """三向合并同步：baseRev 快照 vs 本机 data vs 服务端当前。"""
        data = payload.get("data")
        if data is None:
            return self._json({"ok": False, "error": "missing data"}, 400)
        machine = payload.get("machine") or CFG["machine_id"]
        base_rev = int(payload.get("baseRev") or 0)

        cur = STORE.get()
        if cur["empty"]:
            res = STORE.put(0, data, machine, note="initial-from-client")
            return self._json({"ok": True, **res, "conflicts": [],
                               "action": "initialized"})

        if base_rev == cur["rev"]:
            res = STORE.put(cur["rev"], data, machine, note="sync-fast")
            return self._json({"ok": True, **res, "conflicts": [], "action": "fast"})

        base = STORE.get_snapshot(base_rev)
        if base is None and base_rev == 0:
            # 本机从未同步过：以空基准做并集合并，两端各自录入的数据都保留
            merged, conflicts = merge_mod.merge({}, data, cur["data"])
            res = STORE.put(cur["rev"], merged, machine, note="first-merge")
            return self._json({
                "ok": True, "action": "first-merge", "rev": res["rev"],
                "updated_at": res["updated_at"], "data": merged, "conflicts": conflicts,
            })
        if base is None:
            # base 快照缺失（已被清理且本机同步过）：保命存本地版本，采用服务端版本
            saved = STORE.snapshot(machine, note="orphan-local-from-%s@rev%s" % (machine, base_rev))
            STORE.cold_backup(tag="orphan")
            return self._json({
                "ok": True,
                "action": "need-manual",
                "rev": cur["rev"],
                "data": cur["data"],
                "conflicts": [],
                "message": "缺少合并基准(rev=%s)，本机数据已存为快照(rev=%s)，"
                           "当前已采用服务端数据。如需恢复，到设置页回滚。" % (base_rev, saved),
            })

        merged, conflicts = merge_mod.merge(base["data"], data, cur["data"])
        res = STORE.put(cur["rev"], merged, machine, note="sync-merge")
        return self._json({
            "ok": True,
            "action": "merged",
            "rev": res["rev"],
            "updated_at": res["updated_at"],
            "data": merged,
            "conflicts": conflicts,
        })

    # ---------- 静态文件 ----------
    def _static(self, path):
        if path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/" + quote(CFG["index_file"]))
            self._cors()
            self.end_headers()
            return
        rel = unquote(path.lstrip("/"))
        full = os.path.abspath(os.path.join(STATIC_ROOT, rel))
        if not full.startswith(STATIC_ROOT) or not os.path.isfile(full):
            return self._json({"ok": False, "error": "not found: %s" % rel}, 404)
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)


def build_store():
    """按当前 CFG 重建存储对象与静态根目录（命令行参数覆盖配置后调用）。"""
    global STORE, STATIC_ROOT
    STORE = Store(
        abspath(CFG["db_path"]),
        backup_dir=abspath(CFG["backup_dir"]),
        keep_days=CFG["snapshot_keep_days"],
        keep_count=CFG["snapshot_keep_count"],
    )
    STATIC_ROOT = abspath(CFG["static_root"])


def main():
    import argparse
    ap = argparse.ArgumentParser(description="熊猫五福餐厅本地数据库服务")
    ap.add_argument("--port", type=int, help="覆盖 config.json 的端口")
    ap.add_argument("--host", help="监听地址，局域网共享时用 0.0.0.0")
    ap.add_argument("--db", help="覆盖数据库文件路径")
    ap.add_argument("--machine", help="覆盖本机标识")
    ap.add_argument("--open-browser", action="store_true", help="启动后自动打开浏览器")
    args = ap.parse_args()
    if args.port:
        CFG["port"] = args.port
    if args.host:
        CFG["host"] = args.host
    if args.db:
        CFG["db_path"] = args.db
    if args.machine:
        CFG["machine_id"] = args.machine
    if args.open_browser:
        CFG["open_browser"] = True
    build_store()

    port = int(CFG["port"])
    host = CFG["host"]
    print("=" * 62)
    print("  熊猫五福餐厅 · 本地数据库服务")
    print("=" * 62)
    backup = STORE.cold_backup(tag="boot")
    cur = STORE.get()
    print("  数据库 : %s" % STORE.db_path)
    print("  本机标识: %s" % CFG["machine_id"])
    print("  当前版本: rev=%s  %s" % (cur["rev"], "（空库，等待首次写入）" if cur["empty"]
                                     else cur["updated_at"]))
    if backup:
        print("  启动备份: %s" % backup)
    print("  接口地址: http://%s:%s" % (host, port))
    print("-" * 62)
    print("  服务已就绪。请照常双击打开 HTML 使用（页面会自动连上本服务）。")
    print("  也可以浏览器访问 http://%s:%s/ " % (host, port))
    print("  关闭本窗口即停止服务（关闭后页面自动进入离线模式，数据暂存浏览器）。")
    print("=" * 62)
    if CFG.get("open_browser"):
        webbrowser.open("http://%s:%s/" % (host, port))
    srv = ThreadingHTTPServer((host, port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")


if __name__ == "__main__":
    main()
