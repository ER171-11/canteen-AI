#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
熊猫五福餐厅 · 云端动作队列消费者（增量组件，核心零改动）

流程（每 30 秒一轮，或 --once 单次）：
  1. GET BFF /api/actions?status=待执行（Bearer token：--token 或环境变量 BFF_TOKEN）
  2. 逐条动作：
     a. GET 店内 /api/db 取 baseRev 与当前 data
     b. 按 action.type 把 payload 应用到 data：
        - restock.create → 向 data.recv 追加【草稿】采购单（payments 为空=未付款，
          ing 未知时置 null 并保留品名，rebuildStock 对未知 ing 有跳过兜底，安全）
        - config.update  → 合并写入 data.config（新增顶层键，不改既有字段）
        - qc.record      → 插入本地 sqlite qc_records 表（整库 data 不变，仍走 sync 登记）
     c. POST 店内 /api/sync {baseRev, data, machine:"QUEUE"}（三向合并写回）
     d. 回调 BFF：成功 POST /api/actions/{id}/execute {result:{new_rev}}
        失败回调 {error}；未知 type 回调驳回
  3. 冲突（sync 返回非 ok 或 action=need-manual）→ 标记「需人工确认」
     （本地 actions_queue 表同步登记，人工确认走 /api/actions/{id}/confirm，不在本组件职责内）

红线：只读/调用 server 公开 API，不修改 server/*.py 与受保护 HTML；
本地 sqlite 只写新增表（actions_queue/qc_records），不触碰 docs/snapshots。

trace_id 全链路透传：动作自带则沿用，缺失则本地生成，贯穿日志与回调。
仅使用 Python 标准库。
"""

import argparse
import json
import logging
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime

DEFAULT_STORE_URL = "http://127.0.0.1:8765"
DEFAULT_BFF_URL = "http://127.0.0.1:8787"
DEFAULT_INTERVAL = 30

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "data", "餐厅系统.db")
MIGRATION_SQL = os.path.join(BASE_DIR, "migrations", "001_new_tables.sql")

log = logging.getLogger("queue_consumer")

# 已知动作类型
KNOWN_TYPES = ("restock.create", "config.update", "qc.record")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def today():
    return datetime.now().strftime("%Y-%m-%d")


def http_json(method, url, payload=None, token=None, timeout=30):
    """urllib 极简 JSON 客户端，返回 (http_status, parsed_body)。HTTPError 也解析响应体。"""
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            parsed = {"raw": raw[:200].decode("utf-8", "replace")}
        return exc.code, parsed


# ---------- 本地 sqlite（只写新增表） ----------

def ensure_tables(db_path):
    """幂等执行新增表迁移（全部 CREATE TABLE IF NOT EXISTS），不触碰既有表。"""
    if not os.path.exists(MIGRATION_SQL):
        log.warning("迁移文件缺失: %s（跳过建表，qc/actions 登记将不可用）", MIGRATION_SQL)
        return
    with open(MIGRATION_SQL, "r", encoding="utf-8") as f:
        sql = f.read()
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(sql)
        conn.commit()
    finally:
        conn.close()


def record_action(db_path, action, status, rev=None, trace_id=None):
    """把动作登记到本地 actions_queue 表（新增表，幂等覆盖）。"""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO actions_queue"
            " (id, type, payload, status, rev, created_at, executed_at, operator, trace_id)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (str(action.get("id")), action.get("type"),
             json.dumps(action.get("payload"), ensure_ascii=False),
             status, rev, action.get("created_at") or now_iso(),
             now_iso() if status != "queued" else None,
             "QUEUE", trace_id))
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - 登记失败不阻断主流程
        log.warning("actions_queue 登记失败: %s", exc)
    finally:
        conn.close()


def insert_qc_record(db_path, payload):
    """qc.record：插入本地 qc_records 表，返回 rowid。"""
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO qc_records (workorder_id, sku_id, sample_weight, pass, ts, source)"
            " VALUES (?,?,?,?,?,?)",
            (payload.get("workorder_id"), payload.get("sku_id"),
             payload.get("sample_weight"),
             1 if payload.get("pass") in (1, True, "1", "合格") else 0,
             payload.get("ts") or now_iso(),
             payload.get("source") or "auto"))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


# ---------- 动作应用（纯函数式改 data 副本） ----------

def apply_restock(data, payload):
    """restock.create：向 data.recv 追加草稿采购单。返回变更说明。"""
    recv = data.setdefault("recv", [])
    if not isinstance(recv, list):
        raise ValueError("data.recv 不是数组，拒绝写入")
    date = payload.get("date") or today()
    items = payload.get("items") or []
    lines = []
    for it in items:
        qty = float(it.get("qty") or 0)
        price = float(it.get("price") or 0)
        lines.append({
            "ing": it.get("ing_id"),          # 未知原料置 null，人工补录后生效
            "name": it.get("name"),
            "qty": qty,
            "price": price,
            "conv": 1,
            "amount": round(qty * price, 2),
            "unitCost": price,
        })
    payable = round(sum(l["amount"] for l in lines), 2)
    same_day = sum(1 for p in recv if p.get("date") == date)
    draft = {
        "id": "R" + uuid.uuid4().hex[:10],
        "no": "JH" + date.replace("-", "") + "-" + str(same_day + 1).zfill(2),
        "date": date,
        "supplier": payload.get("supplier") or "未指定供应商",
        "lines": lines,
        "payable": payable,
        "payments": [],                        # 草稿=未付款
        "note": "【草稿·云端补货】" + (payload.get("note") or "待人工确认后生效"),
        "method": "现金/转账",
        "status": "草稿",
    }
    recv.append(draft)
    return "recv 追加草稿 %s（%d 行，应付 %.2f）" % (draft["no"], len(lines), payable)


def apply_config(data, payload):
    """config.update：合并写入 data.config（新增顶层键，不覆盖既有字段之外的配置）。"""
    cfg = data.setdefault("config", {})
    if not isinstance(cfg, dict):
        raise ValueError("data.config 已存在且不是对象，拒绝覆盖")
    updates = payload.get("config") or payload.get("values") or payload
    if not isinstance(updates, dict) or not updates:
        raise ValueError("config.update 的 payload 必须是非空对象（可嵌于 config/values 键）")
    cfg.update(updates)
    return "config 更新 %d 项: %s" % (len(updates), ",".join(updates.keys()))


# ---------- 单条动作处理 ----------

def process_action(action, store_url, bff_url, token, db_path):
    """处理一条动作，返回 (outcome, detail)。outcome ∈ executed/failed/rejected/conflict。"""
    aid = action.get("id")
    atype = action.get("type")
    payload = action.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}
    trace_id = action.get("trace_id") or uuid.uuid4().hex
    alog = logging.getLogger("queue_consumer.action")
    alog.info("开始处理 id=%s type=%s trace=%s", aid, atype, trace_id)

    def callback(result=None, error=None):
        body = {}
        if result is not None:
            body["result"] = result
        if error is not None:
            body["error"] = error
        body["trace_id"] = trace_id
        status, resp = http_json(
            "POST", bff_url.rstrip("/") + "/api/actions/%s/execute" % aid,
            body, token=token)
        alog.info("回调 execute id=%s http=%s resp=%s trace=%s", aid, status, resp, trace_id)
        return status, resp

    if atype not in KNOWN_TYPES:
        alog.warning("未知动作类型，驳回 id=%s type=%s trace=%s", aid, atype, trace_id)
        callback(error="未知动作类型: %s（支持: %s）" % (atype, "/".join(KNOWN_TYPES)))
        record_action(db_path, action, "rejected", trace_id=trace_id)
        return "rejected", atype

    # 1) 取 baseRev 与当前 data
    status, doc = http_json("GET", store_url.rstrip("/") + "/api/db")
    if status != 200 or not doc.get("ok"):
        err = "店内 /api/db 不可达: http=%s %s" % (status, doc)
        alog.error("%s trace=%s", err, trace_id)
        callback(error=err)
        record_action(db_path, action, "failed", trace_id=trace_id)
        return "failed", err
    base_rev = doc.get("rev")
    data = doc.get("data")
    if not isinstance(data, dict):
        data = {}

    # 2) 应用 payload
    try:
        if atype == "restock.create":
            desc = apply_restock(data, payload)
        elif atype == "config.update":
            desc = apply_config(data, payload)
        elif atype == "qc.record":
            rowid = insert_qc_record(db_path, payload)
            desc = "qc_records 插入 rowid=%s（整库 data 不变）" % rowid
        else:  # 理论不可达
            raise ValueError("unhandled type %s" % atype)
    except Exception as exc:  # noqa: BLE001
        err = "应用 payload 失败: %s" % exc
        alog.exception("%s trace=%s", err, trace_id)
        callback(error=err)
        record_action(db_path, action, "failed", trace_id=trace_id)
        return "failed", err
    alog.info("已应用: %s trace=%s", desc, trace_id)

    # 3) 三向合并写回
    status, resp = http_json(
        "POST", store_url.rstrip("/") + "/api/sync",
        {"baseRev": base_rev, "data": data, "machine": "QUEUE"})
    ok = status == 200 and resp.get("ok") and resp.get("action") != "need-manual"
    if not ok:
        err = "sync 冲突/异常: http=%s resp=%s" % (status, {k: v for k, v in resp.items() if k != "data"})
        alog.warning("标记「需人工确认」id=%s %s trace=%s", aid, err, trace_id)
        callback(error="需人工确认: " + err)
        record_action(db_path, action, "需人工确认", rev=base_rev, trace_id=trace_id)
        return "conflict", err

    new_rev = resp.get("rev")
    alog.info("执行成功 id=%s new_rev=%s action=%s trace=%s",
              aid, new_rev, resp.get("action"), trace_id)
    callback(result={"new_rev": new_rev, "desc": desc})
    record_action(db_path, action, "done", rev=new_rev, trace_id=trace_id)
    return "executed", new_rev


# ---------- 主循环 ----------

def fetch_pending(bff_url, token):
    from urllib.parse import quote
    url = bff_url.rstrip("/") + "/api/actions?status=" + quote("待执行")
    status, resp = http_json("GET", url, token=token)
    if status != 200:
        raise RuntimeError("拉取动作失败: http=%s %s" % (status, resp))
    if isinstance(resp, list):
        return resp
    if isinstance(resp, dict):
        for key in ("items", "actions", "data"):
            if isinstance(resp.get(key), list):
                return resp[key]
    return []


def run_once(store_url, bff_url, token, db_path):
    try:
        actions = fetch_pending(bff_url, token)
    except Exception as exc:  # noqa: BLE001
        log.error("BFF 不可达，本轮跳过: %s", exc)
        return False
    log.info("拉到待执行动作 %d 条", len(actions))
    for action in actions:
        try:
            outcome, detail = process_action(action, store_url, bff_url, token, db_path)
            log.info("动作 id=%s 结果=%s detail=%s", action.get("id"), outcome, detail)
        except Exception:  # noqa: BLE001 - 单条失败不影响其余动作
            log.exception("动作 id=%s 处理出现未捕获异常", action.get("id"))
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description="云端动作队列消费者（BFF → 店内库）")
    ap.add_argument("--store-url", default=DEFAULT_STORE_URL)
    ap.add_argument("--bff-url", default=DEFAULT_BFF_URL)
    ap.add_argument("--interval", type=float, default=DEFAULT_INTERVAL)
    ap.add_argument("--once", action="store_true", help="单次执行后退出")
    ap.add_argument("--token", default=os.environ.get("BFF_TOKEN", ""),
                    help="BFF 访问令牌（默认读环境变量 BFF_TOKEN）")
    ap.add_argument("--db", default=DEFAULT_DB_PATH, help="本地 sqlite 路径")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    if not args.token:
        log.warning("未提供 BFF token（--token 或 BFF_TOKEN），请求将不带鉴权头")

    try:
        ensure_tables(args.db)
    except Exception as exc:  # noqa: BLE001
        log.warning("建表检查失败（不影响主流程）: %s", exc)

    log.info("启动 store=%s bff=%s interval=%ss once=%s db=%s",
             args.store_url, args.bff_url, args.interval, args.once, args.db)

    if args.once:
        ok = run_once(args.store_url, args.bff_url, args.token, args.db)
        return 0 if ok else 1

    while True:
        try:
            run_once(args.store_url, args.bff_url, args.token, args.db)
        except Exception:  # noqa: BLE001 - 循环兜底，失败不退出
            log.exception("本轮消费出现未捕获异常，继续循环")
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
