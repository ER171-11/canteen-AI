#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
熊猫五福餐厅 · 整库快照推送器（增量组件，核心零改动）

流程：
  1. GET 店内服务 /api/db 取 {rev, data}
  2. 计算 data 的 JSON 体积，超过阈值（默认 5MB）告警并跳过本次推送
  3. 从本地 SQLite 新表（recipes/sop_steps/sop_workorders/qc_records）读取并组装 ext
     （JSON TEXT 列注入时解析回对象/数组；表不存在/为空 → 对应 key 为空数组，不报错）
  4. POST 云端 BFF /api/snapshot/push {rev, data, ext, machine}
  5. 成功后写本地状态 data/pusher_state.json {last_rev, last_ts, last_ext} 并记日志

只读店内服务（GET）与本地新表（SELECT），绝不写回；不碰 docs/snapshots 主数据（红线）。

参数：
  --store-url  店内服务地址（默认 http://127.0.0.1:8765）
  --bff-url    云端 BFF 地址（默认 http://127.0.0.1:8787）
  --interval   循环间隔秒数（默认 60）
  --once       只执行一次后退出
  --max-bytes  快照体积上限（默认 5*1024*1024，含 ext）
  --db         本地 sqlite 路径（默认 data/餐厅系统.db），ext 数据源
  --token      BFF Bearer token（也可用环境变量 BFF_TOKEN）

异常处理：网络/HTTP 异常按指数退避重试 3 次；最终失败记日志但不退出循环。
仅使用 Python 标准库。
"""

import argparse
import json
import logging
import os
import socket
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

DEFAULT_STORE_URL = "http://127.0.0.1:8765"
DEFAULT_BFF_URL = "http://127.0.0.1:8787"
DEFAULT_INTERVAL = 60
DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5MB

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(BASE_DIR, "data", "pusher_state.json")
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "data", "餐厅系统.db")

# ext 契约：表名 → 需要把 JSON TEXT 解析回对象/数组的列
EXT_TABLES = {
    "recipes": ("main", "aux", "seasoning", "steps", "params", "diet_tags"),
    "sop_steps": ("tools", "inputs", "params"),
    "sop_workorders": ("qc_records", "steps_state"),
    "qc_records": (),
    "accept_standards": (),
    "recv_accept": ("detail",),
    # Sprint 2 新增 10 模块（行直接序列化，无 JSON TEXT 列）
    "staff_shifts": (),
    "staff_clock": (),
    "staff_perf": (),
    "staff_train": (),
    "fs_certs": (),
    "fs_trace": (),
    "fs_samples": (),
    "fs_disinfect": (),
    "bookings": (),
    "queue": (),
    "queue_serves": (),
    # 主数据补齐：会员/外卖/口碑/设备/财务/桌台
    "vip_members": (),
    "vip_balance": (),
    "vip_coupons": (),
    "vip_visits": (),
    "takeout_orders": (),
    "takeout_reviews": (),
    "takeout_reconcile": (),
    "rv_reviews": (),
    "rv_improve": (),
    "eq_maintain": (),
    "eq_energy": (),
    "eq_temp": (),
    "fin_invoices": (),
    "fin_tax": (),
    "fin_cash": (),
    "fin_split": (),
    "pos_tables": (),
    "loss_reports": (),
    "sup_vendors": (),
    "sup_prices": (),
    "sup_accounts": (),
}

log = logging.getLogger("snapshot_pusher")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def http_json(method, url, payload=None, timeout=30, token=None):
    """urllib 极简 JSON 客户端，返回 (http_status, parsed_body)。"""
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer %s" % token
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, json.loads(raw.decode("utf-8")) if raw else {}


def with_retry(fn, desc, retries=3, base_delay=2.0):
    """指数退避重试：2s/4s/8s。全部失败抛最后一次异常。"""
    last = None
    for attempt in range(1, retries + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - 统一退避，逐次记日志
            last = exc
            log.warning("%s 第 %d/%d 次失败: %s", desc, attempt, retries, exc)
            if attempt < retries:
                time.sleep(base_delay * (2 ** (attempt - 1)))
    raise last


def load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(rev, ext_counts):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    state = {"last_rev": rev, "last_ts": now_iso(), "last_ext": ext_counts}
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)
    return state


def build_ext(db_path):
    """
    从本地 sqlite 新表组装 ext（红线：只 SELECT 新表，绝不碰 docs/snapshots）。
    表不存在/为空 → 对应 key 为空数组，不报错。返回 (ext, counts)。
    """
    ext, counts = {}, {}
    if not os.path.exists(db_path):
        log.warning("本地库不存在: %s，ext 全部置空数组", db_path)
        return {t: [] for t in EXT_TABLES}, {t: 0 for t in EXT_TABLES}
    conn = sqlite3.connect(db_path)
    try:
        for table, json_cols in EXT_TABLES.items():
            try:
                cur = conn.execute("SELECT * FROM %s" % table)
                cols = [d[0] for d in cur.description]
                rows = []
                for tup in cur.fetchall():
                    row = dict(zip(cols, tup))
                    for c in json_cols:
                        v = row.get(c)
                        if isinstance(v, str) and v:
                            try:
                                row[c] = json.loads(v)
                            except Exception:
                                pass  # 非 JSON 文本原样保留
                    rows.append(row)
                ext[table] = rows
                counts[table] = len(rows)
            except sqlite3.OperationalError as exc:
                log.info("ext 表 %s 不可读（%s），按空数组处理", table, exc)
                ext[table] = []
                counts[table] = 0
    finally:
        conn.close()
    return ext, counts


def push_once(store_url, bff_url, max_bytes, token=None, db_path=DEFAULT_DB_PATH):
    """单次推送。返回 True=已推送, False=跳过/失败（异常已被吞掉并记日志）。"""
    try:
        _, doc = with_retry(
            lambda: http_json("GET", store_url.rstrip("/") + "/api/db"),
            "GET /api/db")
    except Exception as exc:  # noqa: BLE001
        log.error("店内服务不可达，本次跳过: %s", exc)
        return False

    if not doc.get("ok"):
        log.error("/api/db 返回异常: %s", doc)
        return False

    rev = doc.get("rev")
    data = doc.get("data")
    if data is None:
        log.warning("店内库为空（rev=%s），跳过推送", rev)
        return False

    ext, ext_counts = build_ext(db_path)

    state = load_state()
    if state.get("last_rev") == rev and state.get("last_ext") == ext_counts:
        log.info("rev=%s 且 ext 行数未变，跳过", rev)
        return True

    blob = json.dumps({"data": data, "ext": ext}, ensure_ascii=False).encode("utf-8")
    size = len(blob)
    if size > max_bytes:
        log.warning("快照体积 %d 字节超过阈值 %d 字节，本次跳过（可用 --max-bytes 调整）",
                    size, max_bytes)
        return False

    machine = socket.gethostname()
    payload = {"rev": rev, "data": data, "ext": ext, "machine": machine}
    try:
        status, resp = with_retry(
            lambda: http_json("POST", bff_url.rstrip("/") + "/api/snapshot/push",
                              payload, token=token),
            "POST /api/snapshot/push")
    except Exception as exc:  # noqa: BLE001
        log.error("推送 BFF 失败（rev=%s, %d 字节）: %s", rev, size, exc)
        return False

    if status >= 400 or (isinstance(resp, dict) and resp.get("ok") is False):
        log.error("BFF 拒绝推送: http=%s resp=%s", status, resp)
        return False

    saved = save_state(rev, ext_counts)
    log.info("推送成功 rev=%s size=%dB machine=%s last_ts=%s ext=%s",
             rev, size, machine, saved["last_ts"],
             ",".join("%s:%d" % (k, v) for k, v in ext_counts.items()))
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description="整库快照推送器（店内 → 云端 BFF）")
    ap.add_argument("--store-url", default=DEFAULT_STORE_URL)
    ap.add_argument("--bff-url", default=DEFAULT_BFF_URL)
    ap.add_argument("--interval", type=float, default=DEFAULT_INTERVAL)
    ap.add_argument("--once", action="store_true", help="单次执行后退出")
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--token", default=os.environ.get("BFF_TOKEN", ""),
                    help="BFF Bearer token（也可用环境变量 BFF_TOKEN）")
    ap.add_argument("--db", default=DEFAULT_DB_PATH,
                    help="本地 sqlite 路径（ext 数据源，只读新表）")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    log.info("启动 store=%s bff=%s interval=%ss max_bytes=%d once=%s db=%s",
             args.store_url, args.bff_url, args.interval, args.max_bytes, args.once,
             args.db)

    if not args.token:
        log.warning("未配置 BFF token（--token 或 BFF_TOKEN），BFF 若开启鉴权将推送失败")

    if args.once:
        ok = push_once(args.store_url, args.bff_url, args.max_bytes,
                       token=args.token, db_path=args.db)
        return 0 if ok else 1

    while True:
        try:
            push_once(args.store_url, args.bff_url, args.max_bytes,
                      token=args.token, db_path=args.db)
        except Exception:  # noqa: BLE001 - 循环兜底，失败不退出
            log.exception("本轮推送出现未捕获异常，继续循环")
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
