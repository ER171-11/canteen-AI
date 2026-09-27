#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
熊猫五福餐厅 · 云端动作队列消费者（增量组件，核心零改动）

流程（每 30 秒一轮，或 --once 单次）：
  1. GET BFF /api/actions?status=待执行（Bearer token：--token 或环境变量 BFF_TOKEN）
  2. 逐条动作：
     a. GET 店内 /api/db 取 baseRev 与当前 data
     b. 按 action.type 把 payload 应用到 data：
        - restock.create / analysis.restock → data.orders 追加【草稿】采购单（PO，不入库）
        - recv.inbound → data.recv 确认入库（可把 PO 转为进货）
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
import re
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

# 已知动作类型（上线扩展；未知 type 仍驳回）
KNOWN_TYPES = (
    "restock.create",
    "recv.inbound",
    "config.update",
    "qc.record",
    "qc.pass",
    "plate.pass",
    "sample.log",
    "uniform.log",
    "pos.table_state",
    "pos.table_upsert",
    "pos.table_remove",
    "pos.merge",
    "pos.split",
    "pos.pay",
    "pos.rush",
    "pos.pack",
    "pos.void",
    "pos.ready",
    "pos.pass",
    "queue.serve",
    "dish.upsert",
    "dish.price",
    "dish.set_active",
    "dish.auto_link",
    "ing.upsert",
    "quote.upsert",
    "booking.upsert",
    "queue.call",
    "queue.join",
    "staff.shift_upsert",
    "staff.clock",
    "loss.report",
    "finance.freeze",
    "finance.approve",
    "finance.recon",
    "vip.campaign",
    "vip.coupon_redeem",
    "vip.checkin",
    "takeout.ack",
    "equipment.maintain",
    "review.followup",
    "supply.po",
    "vendor.upsert",
    "analysis.restock",
    "analysis.export_week",
    "recipe.substitute",
    "recipe.upsert",
    "stock.count",
    "order.mark",
    "fs.disinfect",
    "fs.trace_scan",
    "fs.cert.upsert",
    "day.close",
    "workorder.create",
    "workorder.advance",
    "workorder.step_clock",
    "recv.accept",
)


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
    """幂等执行新增表迁移（全部 CREATE TABLE IF NOT EXISTS），不触碰既有表。
    顺带尝试 002 的 ADD COLUMN（列已存在则忽略）。"""
    paths = [
        MIGRATION_SQL,
        os.path.join(BASE_DIR, "migrations", "002_seed_align.sql"),
        os.path.join(BASE_DIR, "migrations", "003_workorder_table.sql"),
        os.path.join(BASE_DIR, "migrations", "004_workorder_bom.sql"),
        os.path.join(BASE_DIR, "migrations", "005_accept_and_steps.sql"),
    ]
    conn = sqlite3.connect(db_path)
    try:
        for path in paths:
            if not os.path.exists(path):
                log.warning("迁移文件缺失: %s", path)
                continue
            with open(path, "r", encoding="utf-8") as f:
                sql = f.read()
            # 002 含 ALTER ADD COLUMN，重复执行会 duplicate column —— 逐条吞掉
            for stmt in sql.split(";"):
                s = stmt.strip()
                if not s or s.startswith("--"):
                    continue
                # 去掉行首注释块
                lines = [ln for ln in s.splitlines() if not ln.strip().startswith("--")]
                s = "\n".join(lines).strip()
                if not s:
                    continue
                try:
                    conn.execute(s)
                except sqlite3.OperationalError as exc:
                    msg = str(exc).lower()
                    if "duplicate column" in msg or "already exists" in msg:
                        continue
                    # 001 用 executescript 更稳；单条失败再整段尝试
                    log.debug("迁移语句跳过: %s (%s)", s[:60], exc)
            conn.commit()
    finally:
        conn.close()


def _r3(x):
    return round(float(x or 0) + 1e-12, 3)


def rebuild_stock(data):
    """对齐店内 HTML / import_orders_excel.rebuild_stock：期初+已入库进货+盘点/手工调整 → ings.stock/qty/avg。
    入库确认后必须调用，否则 App 库存页数字不变。"""
    ings = data.get("ings")
    if not isinstance(ings, list) or not ings:
        return "rebuild_stock 跳过（无 ings）"
    ing_map = {str(g.get("id")): g for g in ings if g.get("id") is not None}
    moves = []
    for g in ings:
        g["stock"] = 0
        g["avg"] = 0
        init = float(g.get("initStock") or 0)
        if init > 0:
            moves.append({
                "o": 0, "type": "期初", "gid": str(g["id"]),
                "date": g.get("initDate") or today(),
                "qty": init, "cost": float(g.get("initAvg") or 0), "ref": "期初",
            })
    for po in data.get("recv") or []:
        st = str(po.get("status") or "")
        # 仅已入库计入库存；草稿/待收不进
        if st and ("草稿" in st or "待" in st) and "已入库" not in st:
            continue
        for l in po.get("lines") or []:
            gid = l.get("ing") or l.get("ing_id")
            if gid is None:
                continue
            moves.append({
                "o": 2, "type": "采购入库", "gid": str(gid),
                "date": po.get("date") or today(),
                "qty": float(l.get("qty") or 0) * float(l.get("conv") or 1),
                "cost": float(l.get("unitCost") or l.get("price") or 0),
                "ref": po.get("no") or po.get("id"),
            })
    for l in data.get("logs") or []:
        # 只吃规范化流水，避免把 kind=loss 的旁路日志当重放源重复扣
        if l.get("type") == "盘点调整" and l.get("ing") is not None:
            moves.append({
                "o": 3, "type": "盘点调整", "gid": str(l["ing"]),
                "date": l.get("date") or today(),
                "qty": float(l.get("qty") or 0), "cost": 0,
                "ref": l.get("ref"), "adj": l,
            })
        elif l.get("type") == "手工调整" and l.get("ing") is not None:
            moves.append({
                "o": 1, "type": "手工调整", "gid": str(l["ing"]),
                "date": l.get("date") or today(),
                "qty": float(l.get("qty") or 0),
                "cost": float(l.get("inCost") or 0),
                "ref": l.get("ref"), "adj": l,
            })
    moves.sort(key=lambda m: (m["date"], m["o"]))
    gen = []
    gen_seq = 1
    for mv in moves:
        g = ing_map.get(mv["gid"])
        if not g:
            continue
        if mv["type"] == "手工调整":
            g["stock"] = _r3(mv["qty"])
            g["avg"] = float(mv["cost"] or 0)
        elif mv["qty"] > 0:
            val = float(g.get("stock") or 0) * float(g.get("avg") or 0) + mv["qty"] * mv["cost"]
            g["stock"] = _r3(float(g.get("stock") or 0) + mv["qty"])
            g["avg"] = _r3(val / g["stock"]) if g["stock"] else float(mv["cost"] or 0)
        else:
            g["stock"] = _r3(float(g.get("stock") or 0) + mv["qty"])
        if mv.get("adj") is not None:
            mv["adj"]["bal"] = _r3(g["stock"])
            mv["adj"]["cost"] = g["avg"]
            gen.append(mv["adj"])
        else:
            gen.append({
                "seq": gen_seq,
                "t": (mv["date"] or today()) + " 12:00",
                "date": mv["date"],
                "type": mv["type"],
                "ing": mv["gid"],
                "qty": _r3(mv["qty"]),
                "inCost": mv["cost"],
                "cost": g["avg"],
                "bal": _r3(g["stock"]),
                "ref": mv["ref"],
            })
            gen_seq += 1
    # 保留非重放日志（如 kind=loss 旁路），再并入重放流水
    keep = [x for x in (data.get("logs") or [])
            if isinstance(x, dict) and x.get("type") not in ("期初", "采购入库", "盘点调整", "手工调整")
            and not x.get("seq")]
    data["logs"] = keep + gen
    for g in ings:
        # App 读 qty||stock，两边对齐
        g["qty"] = g.get("stock")
        g["last"] = None
        # 打更新戳，三向合并时本机重算结果优先于对端旧 stock
        g["_u"] = now_iso()
    for po in sorted(
        [p for p in (data.get("recv") or []) if isinstance(p, dict)],
        key=lambda p: (p.get("date") or "", p.get("no") or ""),
        reverse=True,
    ):
        for l in po.get("lines") or []:
            g = ing_map.get(str(l.get("ing") or l.get("ing_id") or ""))
            if g is not None and g.get("last") is None:
                g["last"] = l.get("price")
    return "rebuild_stock 完成 ings=%d moves=%d" % (len(ings), len(moves))


def resolve_ing_id(data, payload):
    """从 payload 的 ing_id / name / ing_name 解析原料 id。
    匹配顺序：精确 → config.ing_alias 别名（含去括号名）→ 双向包含。"""
    raw = payload.get("ing_id") or payload.get("ing") or payload.get("gid")
    if raw is not None and str(raw).strip():
        return str(raw).strip()
    name = (payload.get("name") or payload.get("ing_name") or "").strip()
    if not name:
        return None
    for g in data.get("ings") or []:
        if (g.get("name") or "").strip() == name:
            return str(g.get("id"))
    alias = (data.get("config") or {}).get("ing_alias") or {}
    import re as _re
    stripped = _re.sub(r"[（(][^）)]*[）)]", "", name).strip()
    for key in (name, stripped):
        tgt = alias.get(key)
        if not tgt:
            continue
        for g in data.get("ings") or []:
            if (g.get("name") or "").strip() == str(tgt).strip():
                return str(g.get("id"))
    for g in data.get("ings") or []:
        n = (g.get("name") or "")
        if name in n or n in name:
            return str(g.get("id"))
    return None


def push_snapshot_once(store_url, bff_url, token, db_path):
    """消费成功后立刻推一帧，避免老板等默认间隔才看见改数。"""
    try:
        import importlib.util
        path = os.path.join(BASE_DIR, "snapshot_pusher.py")
        spec = importlib.util.spec_from_file_location("canteen_snapshot_pusher", path)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        ok = mod.push_once(
            store_url, bff_url, 5 * 1024 * 1024, token=token, db_path=db_path)
        log.info("执行后推快照: %s", "ok" if ok else "skip/fail")
        return ok
    except Exception as exc:  # noqa: BLE001
        log.warning("执行后推快照失败（不影响已落库）: %s", exc)
        return False


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

def parse_line_qty(raw):
    """菜谱常传 '500g'/'1.9L'；采购行只要数值。"""
    if isinstance(raw, (int, float)):
        return float(raw), ""
    s = str(raw or "").strip()
    if not s:
        return 0.0, ""
    m = re.match(r"^(\d+(?:\.\d+)?)\s*([a-zA-Z\u4e00-\u9fff%]*)$", s)
    if m:
        return float(m.group(1)), (m.group(2) or "").strip()
    m2 = re.search(r"(\d+(?:\.\d+)?)", s)
    if m2:
        return float(m2.group(1)), ""
    return 0.0, ""


def apply_restock(data, payload):
    """restock.create：向 data.orders 追加草稿采购单（PO）。不入库、不改 stock。
    对齐店内红线：plans/建议 → orders(采购) → recv(进货入库)。
    """
    orders = data.setdefault("orders", [])
    if not isinstance(orders, list):
        raise ValueError("data.orders 不是数组，拒绝写入")
    date = payload.get("date") or today()
    items = payload.get("items") or []
    lines = []
    for it in items:
        qty, unit_from_qty = parse_line_qty(it.get("qty"))
        unit = (it.get("unit") or unit_from_qty or "").strip()
        price = 0.0
        try:
            price = float(it.get("price") or 0)
        except (TypeError, ValueError):
            price = 0.0
        lines.append({
            "ing": it.get("ing_id") or it.get("ing") or it.get("name"),
            "name": it.get("name") or it.get("ing_id"),
            "qty": qty,
            "unit": unit,
            "price": price,
            "conv": 1,
            "amount": round(qty * price, 2),
            "unitCost": price,
        })
    if not lines:
        raise ValueError("restock.create 无有效明细行")
    payable = round(sum(l["amount"] for l in lines), 2)
    same_day = sum(1 for p in orders if p.get("date") == date)
    draft = {
        "id": "O" + uuid.uuid4().hex[:10],
        "no": "CG" + date.replace("-", "") + "-" + str(same_day + 1).zfill(2),
        "date": date,
        "supplier": payload.get("supplier") or "未指定供应商",
        "lines": lines,
        "payable": payable,
        "payments": [],
        "note": "【草稿·云端补货·待下单】" + (payload.get("note") or "自动生成≠自动下单，确认后仍为采购草稿"),
        "method": "现金/转账",
        "status": "草稿",
        "sku_id": payload.get("sku_id"),
        "from_recipe_qty": payload.get("qty"),
    }
    orders.append(draft)
    return "orders 追加采购草稿 %s（%d 行，应付 %.2f）" % (draft["no"], len(lines), payable)


def _deep_merge(dst, src):
    """一层嵌套合并：src 的 dict 值与 dst 同键 dict 合并，其它键覆盖。"""
    if not isinstance(dst, dict) or not isinstance(src, dict):
        return src
    out = dict(dst)
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def apply_config(data, payload):
    """config.update：深合并写入 data.config（嵌套 dict 不整键覆盖）。"""
    cfg = data.setdefault("config", {})
    if not isinstance(cfg, dict):
        raise ValueError("data.config 已存在且不是对象，拒绝覆盖")
    updates = payload.get("config") or payload.get("values") or payload
    if not isinstance(updates, dict) or not updates:
        raise ValueError("config.update 的 payload 必须是非空对象（可嵌于 config/values 键）")
    # 去掉误入的元字段
    clean = {k: v for k, v in updates.items() if k not in ("config", "values", "type", "base_rev", "operator")}
    if not clean:
        raise ValueError("config.update 无有效配置键")
    merged = _deep_merge(cfg, clean)
    data["config"] = merged
    return "config 深合并 %d 项: %s" % (len(clean), ",".join(clean.keys()))


def _wire_table_state(state):
    state = str(state or "free").strip() or "free"
    if state not in ("free", "busy", "clean", "rsv", "空闲", "就餐", "待清", "预订"):
        raise ValueError("非法桌态: %s" % state)
    return {"空闲": "free", "就餐": "busy", "待清": "clean", "预订": "rsv"}.get(state, state)


def apply_pos_table_state(data, payload, db_path=None):
    """pos.table_state：更新/创建桌台 state ∈ free|busy|clean|rsv；可附挂单 bill。
    payload.spawn_kitchen=true 且 busy+items 时，按挂单明细建挂桌工单（传菜对桌）。
    """
    pos = data.setdefault("pos", [])
    if not isinstance(pos, list):
        raise ValueError("data.pos 不是数组")
    tid = str(payload.get("table_id") or payload.get("id") or "").strip()
    if not tid:
        raise ValueError("缺少 table_id")
    wire = _wire_table_state(payload.get("state") or "free")
    bill = payload.get("items") if isinstance(payload.get("items"), list) else None
    amount = payload.get("amount")
    summary = payload.get("bill_summary") or payload.get("dish") or payload.get("summary")

    def _apply_bill(t):
        if wire == "free":
            t.pop("bill", None)
            t.pop("amount", None)
            t.pop("bill_summary", None)
            return
        if bill is not None:
            t["bill"] = bill
            if amount is not None:
                try:
                    t["amount"] = float(amount)
                except (TypeError, ValueError):
                    t["amount"] = amount
            if summary:
                t["bill_summary"] = summary
            elif bill:
                t["bill_summary"] = "、".join(
                    str(it.get("name") or it.get("sku") or "?") + "×" + str(it.get("qty") or 1)
                    for it in bill[:6]
                )
        elif amount is not None:
            try:
                t["amount"] = float(amount)
            except (TypeError, ValueError):
                t["amount"] = amount
            if summary:
                t["bill_summary"] = summary

    desc = None
    for t in pos:
        if str(t.get("id") or t.get("no")) == tid:
            t["state"] = wire
            _apply_bill(t)
            desc = "pos %s → %s%s" % (tid, wire, " ·挂单" if bill is not None else "")
            break
    if desc is None:
        row = {
            "id": tid,
            "no": payload.get("no") or tid,
            "name": payload.get("name") or tid,
            "state": wire,
            "seats": int(payload.get("seats") or 4),
            "zone": payload.get("zone") or "大厅",
        }
        pos.append(row)
        _apply_bill(row)
        desc = "pos 新建 %s → %s" % (tid, wire)

    # 挂单 → 后厨：一键建挂桌工单（备料路径；结账遇已备料则跳过售卖扣）
    spawn = payload.get("spawn_kitchen")
    if spawn in (True, 1, "1", "true", "True") and wire == "busy" and bill and db_path:
        spawned = []
        tno = str(payload.get("no") or tid)
        day = payload.get("date") or today()
        for it in bill:
            if not isinstance(it, dict):
                continue
            sku = it.get("sku_id") or it.get("sku") or it.get("name")
            if not sku:
                continue
            try:
                qty = int(float(it.get("qty") or 1))
            except (TypeError, ValueError):
                qty = 1
            if qty <= 0:
                continue
            try:
                wid = insert_workorder(db_path, {
                    "sku_id": sku,
                    "qty": qty,
                    "date": day,
                    "status": "待开始",
                    "table_id": tid,
                    "table_no": tno,
                    "name": it.get("name") or sku,
                    "planned_start": day + "T10:00",
                })
                spawned.append("%s#%s×%s" % (sku, wid, qty))
            except Exception as exc:  # noqa: BLE001
                log.warning("挂单建工单失败 table=%s sku=%s: %s", tid, sku, exc)
        if spawned:
            desc += " ·厨单" + ",".join(spawned[:6])
    return desc


def apply_pos_table_upsert(data, payload):
    """pos.table_upsert：桌台主数据（大厅/包间、座位数、名称）。"""
    pos = data.setdefault("pos", [])
    if not isinstance(pos, list):
        raise ValueError("data.pos 不是数组")
    tid = str(payload.get("table_id") or payload.get("id") or "").strip()
    if not tid:
        used = {str(t.get("id") or "") for t in pos}
        n = 1
        while ("T%d" % n) in used:
            n += 1
        tid = "T%d" % n
    zone = str(payload.get("zone") or payload.get("area") or "大厅").strip() or "大厅"
    if zone not in ("大厅", "包间"):
        # 兼容英文
        zone = "包间" if zone.lower() in ("vip", "private", "room", "包厢") else "大厅"
    seats = int(payload.get("seats") or 4)
    if seats < 1 or seats > 40:
        raise ValueError("座位数需在 1–40")
    name = str(payload.get("name") or "").strip() or (
        ("%s号桌" % payload.get("no")) if payload.get("no") else tid
    )
    no = str(payload.get("no") or "").strip() or tid.lstrip("T")
    state = payload.get("state")
    for t in pos:
        if str(t.get("id") or t.get("no")) == tid:
            t["id"] = tid
            t["name"] = name
            t["no"] = no
            t["seats"] = seats
            t["zone"] = zone
            if state is not None:
                t["state"] = _wire_table_state(state)
            return "pos 主数据更新 %s %s/%s座" % (tid, zone, seats)
    row = {
        "id": tid,
        "no": no,
        "name": name,
        "seats": seats,
        "zone": zone,
        "state": _wire_table_state(state or "free"),
    }
    pos.append(row)
    return "pos 新建主数据 %s %s/%s座" % (tid, zone, seats)


def apply_pos_table_remove(data, payload):
    """pos.table_remove：仅空闲桌可删（防误删在用桌）。"""
    pos = data.setdefault("pos", [])
    if not isinstance(pos, list):
        raise ValueError("data.pos 不是数组")
    tid = str(payload.get("table_id") or payload.get("id") or "").strip()
    if not tid:
        raise ValueError("缺少 table_id")
    force = bool(payload.get("force"))
    for i, t in enumerate(pos):
        if str(t.get("id") or t.get("no")) == tid:
            st = str(t.get("state") or "free")
            if st not in ("free", "空闲") and not force:
                raise ValueError("桌台 %s 当前 %s，仅空闲可删（或 force）" % (tid, st))
            pos.pop(i)
            return "pos 删除 %s" % tid
    raise ValueError("找不到桌台 %s" % tid)


def apply_dish_upsert(data, payload):
    """dish.upsert：菜品新增/修改（名/分类/售价/成本/上下架/sku_id）。"""
    dishes = data.setdefault("dishes", [])
    if not isinstance(dishes, list):
        raise ValueError("data.dishes 不是数组")
    name = str(payload.get("name") or "").strip()
    if not name and not (payload.get("id") or payload.get("dish_id")):
        raise ValueError("缺少菜品名")
    did = str(payload.get("id") or payload.get("dish_id") or "").strip()
    now = now_iso()

    def _apply_fields(d):
        if name:
            d["name"] = name
        if payload.get("cat") is not None:
            d["cat"] = payload.get("cat")
        if payload.get("price") is not None:
            d["price"] = float(payload.get("price"))
        if payload.get("est") is not None:
            d["est"] = float(payload.get("est"))
        if payload.get("cost") is not None:
            d["cost"] = float(payload.get("cost"))
        if payload.get("on") is not None:
            d["on"] = bool(payload.get("on") in (True, 1, "1", "true", "上架"))
        if "sku_id" in payload or "sku" in payload:
            sku = payload.get("sku_id") if "sku_id" in payload else payload.get("sku")
            if sku in (None, ""):
                d.pop("sku_id", None)
                d.pop("recipe_link", None)
            else:
                d["sku_id"] = str(sku).strip()
                if payload.get("recipe_link"):
                    d["recipe_link"] = payload.get("recipe_link")
                elif payload.get("link_reason"):
                    d["recipe_link"] = payload.get("link_reason")
        if payload.get("baoben_id") is not None:
            d["baoben_id"] = payload.get("baoben_id")
        d["_u"] = now

    for d in dishes:
        if did and str(d.get("id")) == did:
            if not name:
                name = str(d.get("name") or "")
            _apply_fields(d)
            return "dish 更新 %s %s sku=%s" % (d.get("id"), d.get("name"), d.get("sku_id") or "-")
        if not did and name and str(d.get("name")) == name:
            did = str(d.get("id"))
            _apply_fields(d)
            return "dish 同名更新 %s sku=%s" % (did, d.get("sku_id") or "-")
    # 新建（需 name）
    if not name:
        raise ValueError("缺少菜品名")
    nums = []
    for d in dishes:
        m = str(d.get("id") or "")
        if m.startswith("D") and m[1:].isdigit():
            nums.append(int(m[1:]))
    new_id = did or ("D%d" % ((max(nums) + 1) if nums else 900))
    price = float(payload.get("price") or 0)
    est = float(payload.get("est") if payload.get("est") is not None else (payload.get("cost") or 0))
    on_val = True if payload.get("on") is None else bool(
        payload.get("on") in (True, 1, "1", "true", "上架")
    )
    row = {
        "id": new_id,
        "name": name,
        "cat": payload.get("cat") or "常规",
        "price": price,
        "est": est,
        "cost": float(payload.get("cost") if payload.get("cost") is not None else est),
        "q": int(payload.get("q") or 0),
        "on": on_val,
        "_u": now,
    }
    if payload.get("sku_id") or payload.get("sku"):
        row["sku_id"] = str(payload.get("sku_id") or payload.get("sku")).strip()
    if payload.get("baoben_id"):
        row["baoben_id"] = payload.get("baoben_id")
    if payload.get("recipe_link") or payload.get("link_reason"):
        row["recipe_link"] = payload.get("recipe_link") or payload.get("link_reason")
    dishes.append(row)
    return "dish 新建 %s %s ¥%s sku=%s" % (new_id, name, price, row.get("sku_id") or "-")


def apply_dish_price(data, payload):
    """dish.price：调价（只改售价，可附 reason）。"""
    dishes = data.setdefault("dishes", [])
    if not isinstance(dishes, list):
        raise ValueError("data.dishes 不是数组")
    did = str(payload.get("id") or payload.get("dish_id") or "").strip()
    name = str(payload.get("name") or "").strip()
    if payload.get("price") is None:
        raise ValueError("缺少 price")
    new_price = float(payload.get("price"))
    if new_price < 0:
        raise ValueError("售价不能为负")
    for d in dishes:
        if (did and str(d.get("id")) == did) or (name and str(d.get("name")) == name):
            old = d.get("price")
            d["price"] = new_price
            d["_u"] = now_iso()
            if payload.get("reason"):
                d["price_note"] = str(payload.get("reason"))
            return "dish 调价 %s %s → ¥%s（原 ¥%s）" % (d.get("id"), d.get("name"), new_price, old)
    raise ValueError("找不到菜品 %s" % (did or name))


def apply_dish_set_active(data, payload):
    """dish.set_active：上下架。"""
    dishes = data.setdefault("dishes", [])
    if not isinstance(dishes, list):
        raise ValueError("data.dishes 不是数组")
    did = str(payload.get("id") or payload.get("dish_id") or "").strip()
    if not did:
        raise ValueError("缺少 id")
    on = payload.get("on")
    if on is None:
        raise ValueError("缺少 on")
    active = bool(on in (True, 1, "1", "true", "上架"))
    for d in dishes:
        if str(d.get("id")) == did:
            d["on"] = active
            d["_u"] = now_iso()
            return "dish %s %s" % (did, "上架" if active else "下架")
    raise ValueError("找不到菜品 %s" % did)


# 五福色别短名 → 有 BOM 的 sku（智能关联优先）
_WF_COLOR_SKU = {
    "红": "SKU-WF-HONG",
    "黄": "SKU-WF-HUANG",
    "绿": "SKU-WF-LV",
    "紫": "SKU-WF-ZI",
    "黑": "SKU-WF-HEI",
}
_WF_ALIAS_SKU = {
    "红饺": "SKU-WF-HONG",
    "黄饺": "SKU-WF-HUANG",
    "绿饺": "SKU-WF-LV",
    "紫饺": "SKU-WF-ZI",
    "黑饺": "SKU-WF-HEI",
    "酸菜饺": "SKU-WF-BAI-SUANCAI",
    "牛肉饺": "SKU-WF-BAI-NIUROU",
    "西葫芦饺": "SKU-WF-BAI-XIHULU",
    "山药饺": "SKU-WF-BAI-SHANYAO",
    "香菇猪肉饺": "SKU-APP-D9679BA1",
    "测试·香菇猪肉饺": "SKU-APP-D9679BA1",
    # 店招/营销短名 → 有 BOM 色饺
    "墨云水饺": "SKU-WF-HEI",
    "墨云饺": "SKU-WF-HEI",
    "黑金饺": "SKU-WF-HEI",
    "长寿饺": "SKU-WF-HONG",
    "富贵饺": "SKU-WF-HUANG",
    "康宁饺": "SKU-WF-LV",
    "好德饺": "SKU-WF-ZI",
}
# 名字里出现的色/馅暗示 → 色别（再映射到唯一色 SKU；白馅另走关键词）
_WF_NICK_COLOR = {
    "墨云": "黑", "墨鱼": "黑", "三鲜": "黑", "黑金": "黑",
    "翡翠": "绿", "菠菜": "绿", "玉米": "绿", "康宁": "绿",
    "长寿": "红", "冬菇": "红", "荸荠": "红",
    "富贵": "黄", "茴香": "黄",
    "好德": "紫", "香芹": "紫",
}


def _norm_menu_name(s):
    """去品牌前缀/空格，保留括号内色别与馅料，避免多色饺子撞成同名。"""
    import re
    t = str(s or "").strip()
    t = t.replace("|", "").replace("·", "").replace("／", "/")
    t = t.replace("（", "(").replace("）", ")")
    for p in ("御字牌", "熊猫五福", "五福餐厅"):
        t = t.replace(p, "")
    t = re.sub(r"\s+", "", t)
    return t


def _recipe_catalog(db_path):
    """有 BOM 的菜谱列表 [{sku_id,name,color,filling}]。"""
    if not db_path:
        return []
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT sku_id,name,color,filling,main,aux,seasoning FROM recipes"
        ).fetchall()
    finally:
        conn.close()
    out = []
    for sku, name, color, filling, main, aux, seasoning in rows:
        has_bom = False
        for col in (main, aux, seasoning):
            if not col:
                continue
            try:
                parsed = json.loads(col) if isinstance(col, str) else col
            except Exception:
                parsed = col
            if parsed:
                has_bom = True
                break
        if not has_bom:
            continue
        out.append({
            "sku_id": sku,
            "name": name or "",
            "color": color or "",
            "filling": filling or "",
        })
    return out


def score_dish_recipe(dish_name, recipe, dish_baoben=None, dish_cat=None):
    """0~1 匹配分 + 原因。"""
    from difflib import SequenceMatcher
    import re
    dn = str(dish_name or "").strip()
    rn = str(recipe.get("name") or "").strip()
    sku = str(recipe.get("sku_id") or "")
    color = str(recipe.get("color") or "")
    if not dn or not rn:
        return 0.0, ""
    if dn == rn:
        return 1.0, "全名一致"
    nd, nr = _norm_menu_name(dn), _norm_menu_name(rn)
    if nd and nd == nr:
        return 0.98, "规范化同名"
    # 别名表
    alias = _WF_ALIAS_SKU.get(dn) or _WF_ALIAS_SKU.get(nd)
    if alias and alias == sku:
        return 0.96, "别名"
    # 菜品分类字段直接是色别（红/黄/绿/紫/黑）
    cat = str(dish_cat or "").strip()
    if cat in _WF_COLOR_SKU and _WF_COLOR_SKU[cat] == sku:
        return 0.94, "分类色别"
    # 营销昵称 → 色别（仅饺子类，避免「黑金流沙包」「翡翠滑虾」误挂色饺）
    is_jiao = ("饺" in dn) or (cat in _WF_COLOR_SKU) or (cat == "白")
    for nick, nick_color in _WF_NICK_COLOR.items():
        if not is_jiao:
            break
        if nick in dn and nick_color == color and color in _WF_COLOR_SKU and _WF_COLOR_SKU[color] == sku:
            return 0.92, "昵称色别"
    # 色别短名：红饺 / 五福红 / 红·饺子
    if color and color in _WF_COLOR_SKU and _WF_COLOR_SKU[color] == sku:
        if re.search(r"%s\s*饺|饺.*?%s|五福.*?%s|%s.*?五福" % (color, color, color, color), dn):
            return 0.93, "色别短名"
        if nd in ("%s饺" % color, "五福%s" % color, "%s五福" % color):
            return 0.93, "色别短名"
        # （红）（…馅）括号色
        if re.search(r"[（(]\s*%s\s*[）)]" % color, dn):
            return 0.95, "括号色别"
    # 馅料关键词（饺子类）
    filling = str(recipe.get("filling") or "")
    fill_hit = 0
    for tok in re.findall(r"[\u4e00-\u9fff]{2,}", filling):
        if tok in dn:
            fill_hit += 1
    if is_jiao and fill_hit >= 2 and ("饺" in dn or "饺" in rn):
        return min(0.9, 0.7 + 0.08 * fill_hit), "馅料关键词×%d" % fill_hit
    if is_jiao and fill_hit >= 1 and color and color in dn and ("饺" in dn):
        return 0.88, "色+馅"
    # 白饺：仅馅料命中时挂对应白 SKU
    if is_jiao and color == "白" and fill_hit >= 1 and "饺" in dn:
        return min(0.91, 0.82 + 0.04 * fill_hit), "白饺馅料"
    # 互相包含
    if nd and nr and (nd in nr or nr in nd):
        # 过短泛名（如「五福饺子」）对多色菜谱压分，避免误挂
        if len(nd) <= 4 and fill_hit == 0 and not (color and color in dn):
            return 0.55, "短名包含"
        if dn in ("五福饺子", "全家福水饺", "水饺", "饺子") and color:
            return 0.35, "泛名歧义"
        return 0.85, "名称包含"
    ratio = SequenceMatcher(None, nd, nr).ratio() if nd and nr else 0.0
    if ratio >= 0.72:
        return ratio, "模糊%.0f%%" % (ratio * 100)
    return ratio * 0.5, ""


def match_dish_to_recipe(dish_name, recipes, dish_baoben=None, min_score=0.72, dish_cat=None):
    """返回 (sku_id, score, reason) 或 None；要求第一名明显领先。"""
    scored = []
    for r in recipes or []:
        sc, reason = score_dish_recipe(dish_name, r, dish_baoben, dish_cat=dish_cat)
        if sc > 0:
            scored.append((sc, reason, r))
    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    best_sc, best_reason, best = scored[0]
    if best_sc < min_score:
        return None
    # 全名一致直接采纳；否则第一名需明显领先，避免多色饺子误挂
    if best_sc < 0.99 and len(scored) > 1 and scored[1][0] >= best_sc - 0.05 and scored[1][0] >= min_score:
        return None
    return best.get("sku_id"), best_sc, best_reason or "智能匹配"


def apply_dish_auto_link(db_path, data, payload):
    """dish.auto_link：按菜名智能挂 sku_id；可选为无菜单的菜谱建壳。"""
    dishes = data.setdefault("dishes", [])
    if not isinstance(dishes, list):
        raise ValueError("data.dishes 不是数组")
    recipes = _recipe_catalog(db_path)
    if not recipes:
        return "dish.auto_link 无可用菜谱(BOM)"
    try:
        min_score = float(payload.get("min_score") if payload.get("min_score") is not None else 0.72)
    except (TypeError, ValueError):
        min_score = 0.72
    force = payload.get("force") in (True, 1, "1", "true")
    create_missing = payload.get("create_missing")
    if create_missing is None:
        create_missing = True
    create_missing = create_missing in (True, 1, "1", "true", "yes")

    linked = 0
    skipped = 0
    ambiguous = 0
    unmatched = 0
    details = []
    unmatched_names = []
    ambiguous_names = []
    used_skus = {str(d.get("sku_id")) for d in dishes if d.get("sku_id")}

    for d in dishes:
        if not isinstance(d, dict):
            continue
        if d.get("sku_id") and not force:
            skipped += 1
            continue
        hit = match_dish_to_recipe(
            d.get("name"), recipes, d.get("baoben_id"), min_score=min_score,
            dish_cat=d.get("cat")
        )
        if not hit:
            # 再试一次更宽松看是否歧义
            loose = match_dish_to_recipe(
                d.get("name"), recipes, d.get("baoben_id"), min_score=0.55,
                dish_cat=d.get("cat")
            )
            if loose is None:
                # 检查是否多个高分
                scored = []
                for r in recipes:
                    sc, reason = score_dish_recipe(
                        d.get("name"), r, d.get("baoben_id"), dish_cat=d.get("cat")
                    )
                    if sc >= 0.55:
                        scored.append(sc)
                nm = str(d.get("name") or "").strip()
                if len([s for s in scored if s >= 0.55]) >= 2:
                    ambiguous += 1
                    if nm:
                        ambiguous_names.append(nm)
                else:
                    unmatched += 1
                    if nm and ("饺" in nm or d.get("cat") in _WF_COLOR_SKU):
                        unmatched_names.append(nm)
            else:
                unmatched += 1
                nm = str(d.get("name") or "").strip()
                if nm and ("饺" in nm or d.get("cat") in _WF_COLOR_SKU):
                    unmatched_names.append(nm)
            continue
        sku, sc, reason = hit
        d["sku_id"] = sku
        d["recipe_link"] = "auto:%.2f:%s" % (sc, reason)
        d["_u"] = now_iso()
        used_skus.add(sku)
        linked += 1
        # 老板可读：菜名→色/短名
        rname = next((r.get("name") for r in recipes if r.get("sku_id") == sku), sku)
        color = next((r.get("color") for r in recipes if r.get("sku_id") == sku), "")
        short = ("%s饺" % color) if color else (str(rname)[:12] if rname else sku)
        details.append("%s→%s" % (d.get("name"), short))

    created = 0
    if create_missing:
        by_name = {str(x.get("name") or ""): x for x in dishes if isinstance(x, dict)}
        by_sku = {str(x.get("sku_id") or ""): x for x in dishes if isinstance(x, dict) and x.get("sku_id")}
        for r in recipes:
            sku = r["sku_id"]
            if sku in by_sku or sku in used_skus:
                continue
            # 已有同名菜但未挂 → 挂上
            existing = by_name.get(r["name"])
            if existing is not None:
                if not existing.get("sku_id") or force:
                    existing["sku_id"] = sku
                    existing["recipe_link"] = "auto:ensure"
                    existing["_u"] = now_iso()
                    linked += 1
                    details.append("%s→%s" % (existing.get("name"), sku))
                continue
            apply_dish_upsert(data, {
                "id": sku,
                "name": r["name"],
                "cat": r.get("color") or "常规",
                "sku_id": sku,
                "on": True,
                "price": 0,
                "recipe_link": "auto:from_recipe",
            })
            created += 1
            used_skus.add(sku)
            details.append("+%s" % sku)

    tip_parts = []
    if linked:
        tip_parts.append("新挂%d道" % linked)
    else:
        tip_parts.append("无新挂")
    if created:
        tip_parts.append("菜单补建%d道" % created)
    if skipped:
        tip_parts.append("已挂不动%d" % skipped)
    if ambiguous:
        tip_parts.append("歧义需手选%d" % ambiguous)
    # 未匹配里区分饺类（该管）与普通菜（可不管）
    jiao_miss = len(unmatched_names)
    other_miss = max(0, unmatched - jiao_miss)
    if jiao_miss:
        tip_parts.append("饺类未挂%d" % jiao_miss)
    if other_miss:
        tip_parts.append("非扣料菜跳过%d" % other_miss)
    tip_parts.append("厨房可扣料%d道" % len(recipes))
    tip = "；".join(tip_parts)
    if details:
        tip += "。挂靠：" + "、".join(details[:8])
        if len(details) > 8:
            tip += "…"
    if unmatched_names or ambiguous_names:
        hand = ambiguous_names[:4] + unmatched_names[:4]
        tip += "。请手选：" + "、".join(hand[:6])
        if len(ambiguous_names) + len(unmatched_names) > 6:
            tip += "…"
    return "dish.auto_link %s" % tip


def apply_ing_upsert(data, payload):
    """ing.upsert：原料产品库（包规/采购单位/供应商/安全线）。"""
    ings = data.setdefault("ings", [])
    if not isinstance(ings, list):
        raise ValueError("data.ings 不是数组")
    name = str(payload.get("name") or "").strip()
    iid = str(payload.get("id") or payload.get("ing_id") or "").strip()
    if not iid and not name:
        raise ValueError("缺少 id 或 name")
    now = now_iso()

    def patch(ing):
        if payload.get("name") is not None:
            ing["name"] = str(payload.get("name")).strip()
        for k_src, k_dst in (
            ("cat", "cat"), ("unit", "unit"), ("buy", "buy"), ("spec", "spec"),
            ("pack", "pack"), ("moq", "moq"), ("sup", "sup"), ("supplier", "sup"),
        ):
            if payload.get(k_src) is not None:
                ing[k_dst] = payload.get(k_src)
        if payload.get("conv") is not None:
            ing["conv"] = float(payload.get("conv") or 1)
        if payload.get("safe") is not None:
            ing["safe"] = float(payload.get("safe"))
            ing["safety"] = float(payload.get("safe"))
        if payload.get("est") is not None:
            ing["est"] = float(payload.get("est"))
        if payload.get("qty") is not None:
            q = float(payload.get("qty"))
            ing["qty"] = q
            ing["stock"] = q
        if payload.get("stock") is not None and payload.get("qty") is None:
            q = float(payload.get("stock"))
            ing["stock"] = q
            ing["qty"] = q
        if payload.get("avg") is not None:
            ing["avg"] = float(payload.get("avg"))
        if payload.get("on") is not None:
            ing["on"] = bool(payload.get("on") in (True, 1, "1", "true"))
        # pack 未传但有 buy：包规默认同采购单位
        if not ing.get("pack") and ing.get("buy"):
            ing["pack"] = ing.get("buy")
        ing["_u"] = now

    for ing in ings:
        if (iid and str(ing.get("id")) == iid) or (not iid and name and str(ing.get("name")) == name):
            patch(ing)
            return "ing 更新 %s %s" % (ing.get("id"), ing.get("name"))
    # 新建
    nums = []
    for ing in ings:
        m = str(ing.get("id") or "")
        if m.startswith("I") and m[1:].isdigit():
            nums.append(int(m[1:]))
    new_id = iid or ("I%d" % ((max(nums) + 1) if nums else 800))
    row = {
        "id": new_id,
        "name": name or new_id,
        "cat": payload.get("cat") or "原料",
        "unit": payload.get("unit") or "斤",
        "buy": payload.get("buy") or payload.get("pack") or payload.get("unit") or "斤",
        "pack": payload.get("pack") or payload.get("buy") or payload.get("unit") or "斤",
        "conv": float(payload.get("conv") or 1),
        "spec": payload.get("spec") or "",
        "moq": payload.get("moq") or "",
        "sup": payload.get("sup") or payload.get("supplier") or "",
        "qty": float(payload.get("qty") if payload.get("qty") is not None else payload.get("stock") or 0),
        "stock": float(payload.get("stock") if payload.get("stock") is not None else payload.get("qty") or 0),
        "safe": float(payload.get("safe") or 0),
        "safety": float(payload.get("safe") or 0),
        "est": float(payload.get("est") or 0),
        "avg": float(payload.get("avg") or 0),
        "on": True,
        "_u": now,
    }
    ings.append(row)
    return "ing 新建 %s %s" % (new_id, row["name"])


def apply_quote_upsert(data, payload):
    """quote.upsert：供应商报价（按 ing+src 幂等覆盖）。"""
    quotes = data.setdefault("quotes", [])
    if not isinstance(quotes, list):
        raise ValueError("data.quotes 不是数组")
    ing = str(payload.get("ing") or payload.get("ing_id") or "").strip()
    src = str(payload.get("src") or payload.get("supplier") or "").strip()
    if not ing or not src:
        raise ValueError("缺少 ing / src")
    if payload.get("price") is None:
        raise ValueError("缺少 price")
    price = float(payload.get("price"))
    now = now_iso()
    for q in quotes:
        if str(q.get("ing")) == ing and str(q.get("src")) == src:
            q["price"] = price
            q["per"] = payload.get("per") or q.get("per") or "buy"
            q["date"] = payload.get("date") or today()
            if payload.get("note") is not None:
                q["note"] = payload.get("note")
            q["_u"] = now
            return "quote 更新 %s@%s → ¥%s" % (ing, src, price)
    nums = []
    for q in quotes:
        m = str(q.get("id") or "")
        if m.startswith("Q") and m[1:].isdigit():
            nums.append(int(m[1:]))
    qid = payload.get("id") or ("Q%d" % ((max(nums) + 1) if nums else 200))
    quotes.append({
        "id": qid,
        "ing": ing,
        "name": payload.get("name") or ing,
        "src": src,
        "supplier": src,
        "price": price,
        "per": payload.get("per") or "buy",
        "unit": payload.get("unit") or "",
        "date": payload.get("date") or today(),
        "note": payload.get("note") or "",
        "_u": now,
    })
    # 顺带记住原料默认供应商
    if payload.get("set_default_sup"):
        for i in data.get("ings") or []:
            if str(i.get("id")) == ing:
                i["sup"] = src
                break
    return "quote 新建 %s %s@%s ¥%s" % (qid, ing, src, price)


def apply_loss_report(data, payload):
    """loss.report：写可重放「盘点调整」负向流水 + 旁路 logs，再 rebuild 扣库存。"""
    logs = data.setdefault("logs", [])
    if not isinstance(logs, list):
        raise ValueError("data.logs 不是数组")
    try:
        qty = float(payload.get("qty") or 0)
    except (TypeError, ValueError):
        qty = 0.0
    if qty == 0:
        raise ValueError("loss.report 数量不能为 0")
    gid = resolve_ing_id(data, payload)
    name = payload.get("name") or payload.get("ing_name") or "未命名损耗"
    # 旁路展示用
    logs.append({
        "id": "L" + uuid.uuid4().hex[:8],
        "kind": "loss",
        "name": name,
        "qty": qty,
        "amount": payload.get("amount"),
        "reason": payload.get("reason") or "",
        "ts": payload.get("ts") or now_iso(),
        "source": "queue",
        "ing": gid,
    })
    if gid:
        # 盘点调整负向：rebuild 时 o=3，在入库之后扣减
        logs.append({
            "type": "盘点调整",
            "ing": gid,
            "date": payload.get("date") or today(),
            "qty": -abs(qty),
            "ref": "报损·" + (payload.get("reason") or name),
            "source": "queue",
        })
        rb = rebuild_stock(data)
        return "报损扣库存 %s × %s（%s）" % (name, qty, rb)
    return "logs 追加损耗 %s（未匹配原料 id，库存未扣）" % name


def apply_recv_inbound(data, payload):
    """recv.inbound：确认入库，并 rebuild_stock 让 ings.stock/qty 立刻变化。"""
    recv = data.setdefault("recv", [])
    if not isinstance(recv, list):
        raise ValueError("data.recv 不是数组")
    rid = payload.get("id") or payload.get("recv_id")
    oid = payload.get("order_id") or payload.get("po_id")
    items = payload.get("items") or []
    if not rid and not oid and not items:
        # Kimi 拍照验货：无进货单/明细时仅审计登记，绝不空改账面
        if payload.get("kimi_draft") or str(payload.get("source") or "").startswith("kimi"):
            logs = data.setdefault("logs", [])
            note = (payload.get("note") or "")[:200]
            if isinstance(logs, list):
                logs.append({
                    "id": "KR" + uuid.uuid4().hex[:8],
                    "kind": "kimi_recv_audit",
                    "supplier": payload.get("supplier") or "Kimi验货",
                    "status": payload.get("status") or "待核对",
                    "note": note,
                    "date": payload.get("date") or today(),
                    "ts": payload.get("ts") or now_iso(),
                    "source": "kimi",
                })
            return "recv.inbound kimi 审计登记（未改账面）· %s" % (note or "验货结论")
        raise ValueError("recv.inbound 需提供 id / order_id / items 之一（空入库已拒绝）")

    msg = None
    if rid:
        found = False
        for r in recv:
            if str(r.get("id") or r.get("no")) == str(rid):
                r["status"] = payload.get("status") or "已入库"
                r["note"] = (r.get("note") or "") + " 【云端确认入库】"
                found = True
                msg = "recv %s → 已入库" % rid
                break
        if not found:
            raise ValueError("找不到进货单 %s" % rid)
    elif oid:
        orders = data.setdefault("orders", [])
        if not isinstance(orders, list):
            raise ValueError("data.orders 不是数组")
        src = None
        for o in orders:
            if str(o.get("id") or o.get("no")) == str(oid):
                src = o
                break
        if not src:
            raise ValueError("找不到采购单 %s" % oid)
        lines = list(src.get("lines") or [])
        if not lines:
            raise ValueError("采购单 %s 无明细行，拒绝空入库" % oid)
        date = payload.get("date") or src.get("date") or today()
        same_day = sum(1 for p in recv if p.get("date") == date)
        inbound = {
            "id": "R" + uuid.uuid4().hex[:10],
            "no": "JH" + date.replace("-", "") + "-" + str(same_day + 1).zfill(2),
            "date": date,
            "supplier": src.get("supplier") or payload.get("supplier") or "未指定供应商",
            "lines": lines,
            "payable": src.get("payable") or 0,
            "payments": list(src.get("payments") or []),
            "note": "【云端入库·自采购 %s】" % (src.get("no") or oid),
            "method": src.get("method") or "现金/转账",
            "status": "已入库",
            "from_order": src.get("id") or oid,
        }
        recv.append(inbound)
        src["status"] = "已转进货"
        src["note"] = (src.get("note") or "") + " → " + inbound["no"]
        msg = "orders %s → recv %s 已入库" % (oid, inbound["no"])
    else:
        # 无关联 PO：直接正式进货（须有明细）
        date = payload.get("date") or today()
        lines = []
        for it in items:
            qty = float(it.get("qty") or 0)
            price = float(it.get("price") or 0)
            if qty == 0:
                continue
            lines.append({
                "ing": it.get("ing_id") or it.get("ing"),
                "name": it.get("name"),
                "qty": qty,
                "price": price,
                "conv": 1,
                "amount": round(qty * price, 2),
                "unitCost": price,
            })
        if not lines:
            raise ValueError("recv.inbound items 无有效数量行")
        payable = round(sum(l["amount"] for l in lines), 2)
        same_day = sum(1 for p in recv if p.get("date") == date)
        inbound = {
            "id": "R" + uuid.uuid4().hex[:10],
            "no": "JH" + date.replace("-", "") + "-" + str(same_day + 1).zfill(2),
            "date": date,
            "supplier": payload.get("supplier") or "未指定供应商",
            "lines": lines,
            "payable": payable,
            "payments": [],
            "note": "【云端入库】" + (payload.get("note") or ""),
            "method": "现金/转账",
            "status": "已入库",
        }
        recv.append(inbound)
        msg = "recv 追加入库 %s（%d 行）" % (inbound["no"], len(lines))

    rb = rebuild_stock(data)
    return "%s；%s" % (msg, rb)


def append_sale(data, payload, *, channel, dish=None):
    """追加一条 data.sales（与既有 seed 口径对齐：date/hour/dish/qty/amount/channel）。"""
    sales = data.setdefault("sales", [])
    if not isinstance(sales, list):
        raise ValueError("data.sales 不是数组")
    now = datetime.now()
    items = payload.get("items") if isinstance(payload.get("items"), list) else None
    qty = payload.get("qty")
    if qty is None and items:
        try:
            qty = sum(float(it.get("qty") or 1) for it in items)
        except Exception:
            qty = len(items)
    if qty is None:
        qty = 1
    name = dish or payload.get("dish") or payload.get("name")
    if not name and items:
        name = items[0].get("sku") or items[0].get("name")
    if not name:
        name = "结账" if channel == "堂食" else (payload.get("platform") or "外卖")
    line = {
        "id": "S" + now.strftime("%Y%m%d%H%M") + uuid.uuid4().hex[:4],
        "date": payload.get("date") or today(),
        "hour": int(payload.get("hour") or now.hour),
        "dish": name,
        "qty": qty,
        "amount": float(payload.get("amount") or 0),
        "channel": channel,
        "method": payload.get("method") or payload.get("pay_method"),
        "table_id": payload.get("table_id") or payload.get("id"),
        "ts": payload.get("ts") or now_iso(),
        "source": "queue",
    }
    if items:
        line["items"] = items
    sales.append(line)
    return line


def _find_pos_table(data, tid):
    for t in data.get("pos") or []:
        if str(t.get("id") or t.get("no")) == tid:
            return t
    return None


def _bill_summary_of(bill):
    if not isinstance(bill, list) or not bill:
        return None
    return "、".join(
        str(it.get("name") or it.get("sku") or "?") + "×" + str(it.get("qty") or 1)
        for it in bill[:6]
    )


def apply_pos_service_note(data, payload, kind, db_path=None):
    """pos.rush / pack / ready / pass：前厅传菜状态机。
    rush=催（提优 planned_start）；ready=齐（挂桌工单→待传）；pass=传（挂桌工单→已完成）。
    """
    tid = str(payload.get("table_id") or payload.get("id") or "").strip()
    if not tid:
        raise ValueError("缺少 table_id")
    t = _find_pos_table(data, tid)
    note = payload.get("note") or payload.get("action") or kind
    if t is not None:
        flags = t.setdefault("service_flags", {})
        if not isinstance(flags, dict):
            flags = {}
            t["service_flags"] = flags
        flags[kind] = {
            "ts": payload.get("ts") or now_iso(),
            "note": note,
            "operator": payload.get("operator"),
        }
        if kind == "rush":
            t["rushed"] = True
            t.pop("passed", None)
        if kind == "pack":
            t["pack"] = True
        if kind == "ready":
            t["pass_ready"] = True
            t.pop("passed", None)
        if kind == "pass":
            t["passed"] = True
            t["rushed"] = False
            t["pass_ready"] = False
            flags.pop("rush", None)
            flags.pop("ready", None)
    logs = data.setdefault("logs", [])
    if isinstance(logs, list):
        logs.append({
            "id": "S" + uuid.uuid4().hex[:8],
            "kind": "pos_" + kind,
            "table_id": tid,
            "no": payload.get("no"),
            "note": note,
            "ts": payload.get("ts") or now_iso(),
            "source": "queue",
        })
    desc = "pos.%s %s · %s" % (kind, tid, note)
    if not db_path:
        return desc
    try:
        conn = sqlite3.connect(db_path)
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(sop_workorders)").fetchall()}
            if "table_id" not in cols:
                return desc
            if kind == "rush":
                cur = conn.execute(
                    "UPDATE sop_workorders SET planned_start=?"
                    " WHERE date=? AND table_id=? AND status NOT IN ('已完成','完成','作废','待传')",
                    (now_iso(), today(), tid),
                )
                conn.commit()
                if cur.rowcount:
                    desc += " ·优先工单%d" % cur.rowcount
            elif kind == "ready":
                # 齐：未完成挂桌工单标「待传」（前厅可传）
                cur = conn.execute(
                    "UPDATE sop_workorders SET status=?"
                    " WHERE date=? AND table_id=? AND status NOT IN ('已完成','完成','作废','待传')",
                    ("待传", today(), tid),
                )
                conn.commit()
                if cur.rowcount:
                    desc += " ·齐菜工单%d→待传" % cur.rowcount
            elif kind == "pass":
                # 传：待传/制作中等全部收口为已完成
                cur = conn.execute(
                    "UPDATE sop_workorders SET status=?"
                    " WHERE date=? AND table_id=? AND status NOT IN ('已完成','完成','作废')",
                    ("已完成", today(), tid),
                )
                conn.commit()
                if cur.rowcount:
                    desc += " ·已传工单%d→完成" % cur.rowcount
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("传菜 %s 回写工单失败 table=%s: %s", kind, tid, exc)
    return desc


def apply_pos_void(data, payload):
    """pos.void：就餐桌退菜。按 sku/name 从 bill 减 qty；无 bill 时只记 logs + 调整摘要。"""
    tid = str(payload.get("table_id") or payload.get("id") or "").strip()
    if not tid:
        raise ValueError("缺少 table_id")
    t = _find_pos_table(data, tid)
    if t is None:
        raise ValueError("桌台不存在: %s" % tid)
    dish = str(payload.get("dish") or payload.get("name") or "").strip()
    sku = str(payload.get("sku_id") or payload.get("sku") or "").strip()
    if not dish and not sku:
        raise ValueError("退菜需要 dish 或 sku")
    try:
        qty_void = int(payload.get("qty") or 1)
    except (TypeError, ValueError):
        qty_void = 1
    if qty_void <= 0:
        raise ValueError("退菜数量须 > 0")
    reason = payload.get("reason") or payload.get("note") or "退菜"
    bill = t.get("bill") if isinstance(t.get("bill"), list) else []
    new_bill = []
    removed = 0
    refund_amt = 0.0
    matched = False
    for it in bill:
        if not isinstance(it, dict):
            new_bill.append(it)
            continue
        name = str(it.get("name") or "")
        isku = str(it.get("sku_id") or it.get("sku") or "")
        hit = (sku and isku and sku == isku) or (dish and (dish == name or dish in name or name in dish))
        if not hit or matched:
            new_bill.append(it)
            continue
        matched = True
        try:
            cur_qty = int(it.get("qty") or 1)
        except (TypeError, ValueError):
            cur_qty = 1
        take = min(cur_qty, qty_void)
        removed = take
        try:
            unit = float(it.get("price") or it.get("amount") or 0)
            if it.get("amount") is not None and cur_qty > 0 and not it.get("price"):
                unit = float(it.get("amount")) / cur_qty
        except (TypeError, ValueError):
            unit = 0.0
        refund_amt = unit * take
        left = cur_qty - take
        if left > 0:
            row = dict(it)
            row["qty"] = left
            if row.get("amount") is not None:
                try:
                    row["amount"] = float(row["amount"]) - refund_amt
                except (TypeError, ValueError):
                    pass
            new_bill.append(row)
    if bill and not matched:
        raise ValueError("挂单中未找到菜品: %s" % (dish or sku))
    if bill:
        t["bill"] = new_bill
        summary = _bill_summary_of(new_bill)
        if summary:
            t["bill_summary"] = summary
        else:
            t.pop("bill_summary", None)
        if t.get("amount") is not None and refund_amt:
            try:
                t["amount"] = max(0.0, float(t.get("amount") or 0) - refund_amt)
            except (TypeError, ValueError):
                pass
        elif summary is None:
            t.pop("amount", None)
    else:
        # 无明细：用摘要登记退菜意图，便于确认台留痕
        prev = t.get("bill_summary") or ""
        tag = "退:%s×%s" % (dish or sku, qty_void)
        t["bill_summary"] = (tag + (" · " + prev if prev else ""))[:120]
        removed = qty_void
    logs = data.setdefault("logs", [])
    if isinstance(logs, list):
        logs.append({
            "id": "V" + uuid.uuid4().hex[:8],
            "kind": "pos_void",
            "table_id": tid,
            "dish": dish or sku,
            "sku": sku or None,
            "qty": removed or qty_void,
            "reason": reason,
            "refund": refund_amt,
            "ts": payload.get("ts") or now_iso(),
            "source": "queue",
        })
    return "pos.void %s · %s×%s · %s" % (tid, dish or sku, removed or qty_void, reason)


def apply_queue_serve(data, payload, db_path=None):
    """queue.serve：候餐发茶/小食 → logs + queue_serves 表（modules/booking 回读）。"""
    action = payload.get("action") or "候餐服务"
    item = payload.get("item") or payload.get("品名")
    qty = payload.get("qty") or 1
    day = payload.get("date") or today()
    ts = payload.get("ts") or now_iso()
    note = payload.get("note")
    qno = payload.get("queue_no") or payload.get("queueNo")
    wait_eta = payload.get("wait_eta_min")
    qcount = payload.get("queue_count")
    logs = data.setdefault("logs", [])
    if isinstance(logs, list):
        logs.append({
            "id": "QS" + uuid.uuid4().hex[:8],
            "kind": "queue_serve",
            "action": action,
            "qty": qty,
            "item": item,
            "note": note,
            "queue_no": qno,
            "wait_eta_min": wait_eta,
            "queue_count": qcount,
            "date": day,
            "ts": ts,
            "source": "queue",
        })
    rowid = None
    if db_path:
        try:
            rowid = insert_queue_serve(db_path, {
                "date": day,
                "action": action,
                "item": item,
                "qty": qty,
                "note": note,
                "queue_no": qno,
                "wait_eta_min": wait_eta,
                "queue_count": qcount,
                "ts": ts,
            })
        except Exception as exc:  # noqa: BLE001
            log.warning("queue_serves 落库失败: %s", exc)
    return "queue.serve %s ×%s%s" % (
        action, qty, (" id=%s" % rowid) if rowid else "")


def insert_queue_serve(db_path, payload):
    """queue.serve → queue_serves（缺表时按 005 兜底建表）。"""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS queue_serves ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " date TEXT, action TEXT, item TEXT, qty REAL, note TEXT,"
            " queue_no TEXT, wait_eta_min INTEGER, queue_count INTEGER,"
            " ts TEXT, source TEXT)"
        )
        cur = conn.execute(
            "INSERT INTO queue_serves"
            " (date, action, item, qty, note, queue_no, wait_eta_min, queue_count, ts, source)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                payload.get("date") or today(),
                payload.get("action") or "候餐服务",
                payload.get("item"),
                payload.get("qty") or 1,
                payload.get("note"),
                payload.get("queue_no"),
                payload.get("wait_eta_min"),
                payload.get("queue_count"),
                payload.get("ts") or now_iso(),
                "queue",
            ),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def apply_pos_pay(data, payload, db_path=None):
    """pos.pay：桌台结账 → free；清挂单；写 sales；默认按菜品 BOM 扣料。"""
    tid = str(payload.get("table_id") or payload.get("id") or "").strip()
    if not tid:
        raise ValueError("缺少 table_id")
    items = payload.get("items") if isinstance(payload.get("items"), list) else None
    amount = payload.get("amount")
    dish = payload.get("dish")
    for t in data.get("pos") or []:
        if str(t.get("id") or t.get("no")) == tid:
            if items is None and isinstance(t.get("bill"), list):
                items = t.get("bill")
                payload = dict(payload)
                payload["items"] = items
            if amount in (None, "", 0, "0") and t.get("amount") not in (None, ""):
                amount = t.get("amount")
                payload = dict(payload)
                payload["amount"] = amount
            if not dish and t.get("bill_summary"):
                dish = t.get("bill_summary")
            break
    apply_pos_table_state(data, {"table_id": tid, "no": payload.get("no"), "state": "free",
                                 "seats": payload.get("seats")})
    logs = data.setdefault("logs", [])
    if isinstance(logs, list):
        logs.append({
            "id": "P" + uuid.uuid4().hex[:8],
            "kind": "pos_pay",
            "table_id": tid,
            "amount": amount if amount is not None else payload.get("amount"),
            "method": payload.get("method") or "现金",
            "items": items,
            "ts": payload.get("ts") or now_iso(),
            "source": "queue",
        })
    sale = append_sale(
        data,
        payload,
        channel=payload.get("channel") or "堂食",
        dish=dish or payload.get("dish") or ("桌%s结账" % (payload.get("no") or tid)),
    )
    desc = "pos.pay %s amount=%s sales=%s lines=%s" % (
        tid,
        amount if amount is not None else payload.get("amount"),
        sale.get("id"),
        len(items or []),
    )
    # 默认扣 BOM；若本桌已有「备料已扣」工单则跳过对应 sku，避免与制作中叠扣
    if payload.get("deduct") is not False and items and db_path:
        try:
            bom = _deduct_bom_for_sale_items(
                db_path, data, items, ref="结账#%s" % tid, table_id=tid
            )
            if bom:
                desc += "；" + bom
        except Exception as exc:  # noqa: BLE001
            desc += "；BOM扣料跳过(%s)" % exc
    return desc


def apply_pos_merge_split(data, payload, kind):
    """pos.merge / pos.split：更新桌态 + 记元数据。
    merge: from → free，to → busy
    split: from 保持 busy，to → busy
    """
    src = str(payload.get("from") or payload.get("src") or "").strip()
    dst = str(payload.get("to") or payload.get("dst") or "").strip()
    if not src or not dst:
        raise ValueError("pos.%s 需要 from/to" % kind)
    if kind == "merge":
        apply_pos_table_state(data, {"table_id": src, "state": "free"})
        apply_pos_table_state(data, {"table_id": dst, "state": "busy",
                                     "no": payload.get("to_no") or dst,
                                     "seats": payload.get("seats")})
    else:
        apply_pos_table_state(data, {"table_id": src, "state": "busy",
                                     "no": payload.get("from_no") or src})
        apply_pos_table_state(data, {"table_id": dst, "state": "busy",
                                     "no": payload.get("to_no") or dst,
                                     "seats": payload.get("seats")})
    logs = data.setdefault("logs", [])
    if isinstance(logs, list):
        logs.append({
            "id": ("M" if kind == "merge" else "S") + uuid.uuid4().hex[:8],
            "kind": "pos_" + kind,
            "from": src,
            "to": dst,
            "ts": now_iso(),
            "source": "queue",
        })
    return "pos.%s %s → %s" % (kind, src, dst)


def insert_loss_report(db_path, payload):
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO loss_reports (date, ing_name, qty, reason, reporter, status, source)"
            " VALUES (?,?,?,?,?,?,?)",
            (payload.get("date") or today(),
             payload.get("ing_name") or payload.get("name") or "",
             payload.get("qty"),
             payload.get("reason") or "",
             payload.get("reporter") or "QUEUE",
             payload.get("status") or "待审核",
             "queue"))
        conn.commit()
        return cur.lastrowid
    except sqlite3.OperationalError:
        # source 列可能不存在
        cur = conn.execute(
            "INSERT INTO loss_reports (date, ing_name, qty, reason, reporter, status)"
            " VALUES (?,?,?,?,?,?)",
            (payload.get("date") or today(),
             payload.get("ing_name") or payload.get("name") or "",
             payload.get("qty"),
             payload.get("reason") or "",
             payload.get("reporter") or "QUEUE",
             payload.get("status") or "待审核"))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def insert_sample(db_path, payload):
    """sample.log → fs_samples。"""
    conn = sqlite3.connect(db_path)
    try:
        args = (payload.get("date") or today(),
                payload.get("meal") or "",
                payload.get("dish") or payload.get("name") or "",
                payload.get("weight_g") or payload.get("weight"),
                payload.get("keeper") or "QUEUE",
                payload.get("kept_at") or now_iso())
        try:
            cur = conn.execute(
                "INSERT INTO fs_samples (date, meal, dish, weight_g, keeper, kept_at, source)"
                " VALUES (?,?,?,?,?,?,?)", args + ("queue",))
        except sqlite3.OperationalError:
            cur = conn.execute(
                "INSERT INTO fs_samples (date, meal, dish, weight_g, keeper, kept_at)"
                " VALUES (?,?,?,?,?,?)", args)
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def insert_workorder(db_path, payload):
    """workorder.create → sop_workorders（可挂 table_id/table_no 供前厅传菜对桌）。"""
    conn = sqlite3.connect(db_path)
    try:
        # 确保挂桌列存在（老库未跑 003 时兜底）
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sop_workorders)").fetchall()}
        if "table_id" not in cols:
            conn.execute("ALTER TABLE sop_workorders ADD COLUMN table_id TEXT")
        if "table_no" not in cols:
            conn.execute("ALTER TABLE sop_workorders ADD COLUMN table_no TEXT")
        sku = payload.get("sku_id") or payload.get("sku") or "SKU001"
        qty = payload.get("qty") or 20
        day = payload.get("date") or today()
        start = payload.get("planned_start") or (day + "T10:00")
        status = payload.get("status") or "待开始"
        tid = str(payload.get("table_id") or "").strip() or None
        tno = str(payload.get("table_no") or payload.get("no") or "").strip() or None
        if tid and not tno:
            tno = tid
        cur = conn.execute(
            "INSERT INTO sop_workorders"
            " (date, sku_id, qty, planned_start, status, qc_records, table_id, table_no)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (day, sku, qty, start, status, "[]", tid, tno))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


WO_FLOW = ("待开始", "制作中", "待传", "已完成")


def _norm_wo_status(st):
    s = str(st or "").strip()
    if s in ("pending", "todo", "待备"):
        return "待开始"
    if s in ("doing", "in_progress", "进行中", "制作"):
        return "制作中"
    if s in ("ready", "pass_ready", "待出", "齐"):
        return "待传"
    if s in ("done", "完成", "finished", "passed", "已传"):
        return "已完成"
    if s in WO_FLOW:
        return s
    return s or "待开始"


def advance_workorder(db_path, data, payload):
    """workorder.advance：三态推进；进入「制作中」时按菜谱 BOM 备料扣一次，并打 bom_deducted=1。
    结账遇同桌同 sku 已备料则跳过售卖扣（互斥）。
    完成时可带 actual_yield 写入出成。
    """
    wid = payload.get("id") or payload.get("workorder_id")
    if wid is None or str(wid).strip() == "":
        raise ValueError("缺少 workorder id")
    conn = sqlite3.connect(db_path)
    try:
        # 确保 bom_deducted / actual_yield / steps_state 列
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sop_workorders)").fetchall()}
        if "bom_deducted" not in cols:
            conn.execute("ALTER TABLE sop_workorders ADD COLUMN bom_deducted INTEGER DEFAULT 0")
        if "actual_yield" not in cols:
            conn.execute("ALTER TABLE sop_workorders ADD COLUMN actual_yield REAL")
        if "steps_state" not in cols:
            conn.execute("ALTER TABLE sop_workorders ADD COLUMN steps_state TEXT")
        row = conn.execute(
            "SELECT id, status, sku_id, qty, COALESCE(bom_deducted,0) FROM sop_workorders WHERE id=?",
            (wid,),
        ).fetchone()
        if not row:
            raise ValueError("工单不存在: %s" % wid)
        cur_st = _norm_wo_status(row[1])
        sku = row[2]
        already = int(row[4] or 0)
        try:
            wo_qty = float(row[3] or 0)
        except (TypeError, ValueError):
            wo_qty = 0.0
        want = payload.get("status") or payload.get("to")
        if want:
            new_st = _norm_wo_status(want)
        else:
            try:
                idx = WO_FLOW.index(cur_st)
            except ValueError:
                idx = 0
            if idx >= len(WO_FLOW) - 1:
                return "workorder#%s 已是终态 %s" % (wid, cur_st)
            new_st = WO_FLOW[idx + 1]
        conn.execute("UPDATE sop_workorders SET status=? WHERE id=?", (new_st, wid))
        ay = payload.get("actual_yield")
        if ay is not None and str(ay).strip() != "":
            try:
                conn.execute(
                    "UPDATE sop_workorders SET actual_yield=? WHERE id=?",
                    (float(ay), wid),
                )
            except (TypeError, ValueError) as exc:
                raise ValueError("actual_yield 非法: %s" % ay) from exc
        conn.commit()
        desc = "workorder#%s %s → %s" % (wid, cur_st, new_st)
        if ay is not None and str(ay).strip() != "":
            desc += " ·出成=%s" % ay
    finally:
        conn.close()

    # 首次进入制作中且未备料扣：按 BOM 扣料一次
    deduct = ""
    if (
        new_st == "制作中"
        and cur_st != "制作中"
        and not already
        and payload.get("deduct") is not False
    ):
        try:
            deduct = _deduct_bom_for_workorder(db_path, data, sku, wo_qty, wid)
            if deduct:
                desc += "；备料扣 " + deduct
            # 无论是否匹配到原料，标记已处理，避免重复推进再扣
            conn = sqlite3.connect(db_path)
            try:
                conn.execute(
                    "UPDATE sop_workorders SET bom_deducted=1 WHERE id=?", (wid,)
                )
                conn.commit()
            finally:
                conn.close()
            desc += " ·已标记备料"
        except Exception as exc:  # noqa: BLE001
            log.warning("工单 BOM 扣料失败 wo=%s: %s", wid, exc)
            desc += "；BOM扣料跳过(%s)" % exc
    elif new_st == "制作中" and already:
        desc += " ·备料已扣跳过"
    return desc


def clock_workorder_step(db_path, payload):
    """workorder.step_clock：SOP 逐步打卡，写入 steps_state JSON。"""
    wid = payload.get("id") or payload.get("workorder_id")
    step_no = payload.get("step_no")
    if wid is None or str(wid).strip() == "":
        raise ValueError("缺少 workorder id")
    if step_no is None or str(step_no).strip() == "":
        raise ValueError("缺少 step_no")
    key = str(int(step_no)) if str(step_no).isdigit() else str(step_no)
    operator = payload.get("operator") or payload.get("staff") or "店员"
    done_at = payload.get("done_at") or now_iso()
    undo = bool(payload.get("undo") or payload.get("clear"))

    conn = sqlite3.connect(db_path)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sop_workorders)").fetchall()}
        if "steps_state" not in cols:
            conn.execute("ALTER TABLE sop_workorders ADD COLUMN steps_state TEXT")
        row = conn.execute(
            "SELECT id, steps_state, status FROM sop_workorders WHERE id=?", (wid,)
        ).fetchone()
        if not row:
            raise ValueError("工单不存在: %s" % wid)
        state = {}
        raw = row[1]
        if isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    state = parsed
            except Exception:
                state = {}
        elif isinstance(raw, dict):
            state = dict(raw)
        if undo:
            state.pop(key, None)
            action = "撤销"
        else:
            state[key] = {"done_at": done_at, "operator": operator}
            action = "打卡"
        conn.execute(
            "UPDATE sop_workorders SET steps_state=? WHERE id=?",
            (json.dumps(state, ensure_ascii=False), wid),
        )
        # 待开始工单首次打卡 → 自动切到制作中（不扣 BOM；扣料仍走 advance）
        st = _norm_wo_status(row[2])
        bumped = ""
        if not undo and st == "待开始":
            conn.execute(
                "UPDATE sop_workorders SET status=? WHERE id=?", ("制作中", wid)
            )
            bumped = " ·状态待开始→制作中"
        conn.commit()
        return "workorder#%s step %s %s by %s%s" % (wid, key, action, operator, bumped)
    finally:
        conn.close()


def insert_recv_accept(db_path, payload):
    """recv.accept：逐项验收结论写入 recv_accept 表。"""
    items = payload.get("items") or payload.get("lines")
    if not isinstance(items, list) or not items:
        # 单条扁平写法
        if payload.get("ing_name") or payload.get("name"):
            items = [payload]
        else:
            raise ValueError("recv.accept 需提供 items[] 或 ing_name")
    recv_id = payload.get("recv_id") or payload.get("order_id") or payload.get("id")
    source = payload.get("source") or "manual"
    ts = payload.get("ts") or now_iso()
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS recv_accept ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " recv_id TEXT, ing_name TEXT, qty_ordered REAL, qty_received REAL,"
            " qty_rejected REAL, verdict TEXT, detail TEXT,"
            " batch_no TEXT, cert_no TEXT, ts TEXT, source TEXT DEFAULT 'manual')"
        )
        n = 0
        for it in items:
            if not it:
                continue
            name = it.get("ing_name") or it.get("name") or it.get("ing")
            if not name:
                continue
            detail = it.get("detail")
            if detail is not None and not isinstance(detail, str):
                detail = json.dumps(detail, ensure_ascii=False)
            conn.execute(
                "INSERT INTO recv_accept"
                " (recv_id, ing_name, qty_ordered, qty_received, qty_rejected,"
                "  verdict, detail, batch_no, cert_no, ts, source)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    str(recv_id) if recv_id is not None else None,
                    str(name),
                    it.get("qty_ordered"),
                    it.get("qty_received") if it.get("qty_received") is not None else it.get("qty"),
                    it.get("qty_rejected") if it.get("qty_rejected") is not None else 0,
                    it.get("verdict") or it.get("result") or "pass",
                    detail,
                    it.get("batch_no") or it.get("batch"),
                    it.get("cert_no") or it.get("cert"),
                    it.get("ts") or ts,
                    it.get("source") or source,
                ),
            )
            n += 1
        if n == 0:
            raise ValueError("recv.accept 无有效验收行")
        conn.commit()
        return "recv_accept 写入 %d 行 · recv_id=%s" % (n, recv_id or "-")
    finally:
        conn.close()


def _prep_deducted_skus(db_path, table_id):
    """本桌今日已备料扣的 sku 集合（工单 bom_deducted=1）。"""
    if not db_path or not table_id:
        return set()
    conn = sqlite3.connect(db_path)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sop_workorders)").fetchall()}
        if "bom_deducted" not in cols or "table_id" not in cols:
            return set()
        rows = conn.execute(
            "SELECT sku_id FROM sop_workorders"
            " WHERE date=? AND table_id=? AND COALESCE(bom_deducted,0)=1",
            (today(), str(table_id)),
        ).fetchall()
        return {str(r[0]) for r in rows if r and r[0]}
    except sqlite3.OperationalError:
        return set()
    finally:
        conn.close()


def _parse_bom_qty_line(line):
    """解析 '面粉500g' / '猪肉 2斤' / dict → (name, qty, unit)。"""
    if isinstance(line, dict):
        name = str(line.get("name") or line.get("ing") or line.get("ing_name") or "").strip()
        if not name:
            return None
        try:
            qty = float(line.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0.0
        unit = str(line.get("unit") or "g").strip() or "g"
        return name, qty, unit
    s = str(line or "").strip()
    if not s:
        return None
    import re
    m = re.match(r"^(.+?)\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z\u4e00-\u9fff%]*)$", s)
    if m:
        name, qty_s, unit = m.group(1).strip(), m.group(2), (m.group(3) or "g").strip() or "g"
        try:
            return name, float(qty_s), unit
        except ValueError:
            return name, 0.0, unit
    return s, 0.0, "g"


def _recipe_bom_lines(db_path, sku):
    """按 sku_id / name 取菜谱主辅料行；无则 None。"""
    if not sku or not db_path:
        return None
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT main, aux, seasoning FROM recipes WHERE sku_id=?", (str(sku),)
        ).fetchone()
        if not row:
            row = conn.execute(
                "SELECT main, aux, seasoning FROM recipes WHERE name=?", (str(sku),)
            ).fetchone()
        if not row:
            return None
        lines = []
        for col in row:
            if not col:
                continue
            try:
                parsed = json.loads(col) if isinstance(col, str) else col
            except Exception:
                parsed = [col]
            if isinstance(parsed, list):
                lines.extend(parsed)
            else:
                lines.append(parsed)
        return lines
    finally:
        conn.close()


def _append_bom_deduct_logs(data, lines, scale, ref, note_sku):
    """把菜谱行按 scale 写入盘点调整（负数）；返回匹配原料条数。"""
    logs = data.setdefault("logs", [])
    if not isinstance(logs, list):
        return 0
    n = 0
    for line in lines or []:
        parsed = _parse_bom_qty_line(line)
        if not parsed:
            continue
        name, qty, unit = parsed
        if qty <= 0:
            continue
        need = _r3(qty * scale)
        gid = resolve_ing_id(data, {"name": name, "ing_name": name})
        if gid is None:
            continue
        logs.append({
            "type": "盘点调整",
            "ing": gid,
            "date": today(),
            "qty": -abs(need),
            "ref": ref,
            "note": "BOM扣料 %s %s%s ×%.2f批 · %s" % (name, need, unit, scale, note_sku or ""),
            "source": "queue",
        })
        n += 1
    return n


def _deduct_bom_for_workorder(db_path, data, sku, wo_qty, wid):
    if not sku or not isinstance(data, dict):
        return ""
    lines = _recipe_bom_lines(db_path, sku)
    if not lines:
        return "无菜谱%s跳过扣料" % sku
    # 菜谱默认按 20 份/批；工单 qty 按份缩放
    base = 20.0
    scale = (wo_qty / base) if wo_qty > 0 else 1.0
    n = _append_bom_deduct_logs(data, lines, scale, "工单#%s·%s" % (wid, sku), sku)
    if n <= 0:
        return "BOM无匹配原料"
    rb = rebuild_stock(data)
    return "BOM扣%d料 scale=%.2f；%s" % (n, scale, rb)


def _deduct_bom_for_sale_items(db_path, data, items, ref, table_id=None):
    """结账明细按份扣 BOM（菜谱基准 20 份/批）。
    若 table_id 对应工单已备料扣（bom_deducted=1），同 sku 跳过售卖扣，防双重扣料。
    """
    if not isinstance(data, dict) or not items:
        return ""
    prep_skus = _prep_deducted_skus(db_path, table_id)
    dish_by_id = {}
    dish_by_name = {}
    for d in data.get("dishes") or []:
        if not isinstance(d, dict):
            continue
        if d.get("id") is not None:
            dish_by_id[str(d.get("id"))] = d
        if d.get("name"):
            dish_by_name[str(d.get("name"))] = d
    total = 0
    miss = []
    skipped = []
    for it in items:
        if not isinstance(it, dict):
            continue
        sku = it.get("sku_id") or it.get("sku")
        # 从菜单挂靠补 sku
        if not sku or sku == it.get("name"):
            d = None
            if it.get("id") is not None:
                d = dish_by_id.get(str(it.get("id")))
            if d is None and it.get("name"):
                d = dish_by_name.get(str(it.get("name")))
            if d and d.get("sku_id"):
                sku = d.get("sku_id")
        if not sku:
            sku = it.get("name") or it.get("id")
        if not sku:
            continue
        sku_s = str(sku)
        if sku_s in prep_skus:
            skipped.append(sku_s)
            continue
        try:
            qty = float(it.get("qty") or 1)
        except (TypeError, ValueError):
            qty = 1.0
        lines = _recipe_bom_lines(db_path, sku)
        if not lines:
            # 再试菜名匹配菜谱
            lines = _recipe_bom_lines(db_path, it.get("name") or "")
        if not lines:
            miss.append(sku_s)
            continue
        scale = (qty / 20.0) if qty > 0 else 0.0
        total += _append_bom_deduct_logs(
            data, lines, scale, ref, "%s×%s" % (sku, qty)
        )
    tips = []
    if skipped:
        tips.append("备料已扣跳过:" + "/".join(skipped[:4]))
    if total <= 0:
        if miss:
            tips.append("无菜谱:" + "/".join(miss[:4]))
        elif not skipped:
            tips.append("BOM无匹配原料")
        return "；".join(tips) if tips else ""
    rb = rebuild_stock(data)
    tips.append("售卖扣%d料；%s" % (total, rb))
    return "；".join(tips)


def insert_fs_cert(db_path, payload):
    """fs.cert.upsert：登记/续期证照。"""
    conn = sqlite3.connect(db_path)
    try:
        cid = payload.get("id")
        ctype = payload.get("cert_type") or payload.get("type") or "食品经营许可"
        holder = payload.get("holder") or payload.get("name") or "本店"
        cert_no = payload.get("cert_no") or payload.get("no") or ""
        expire = payload.get("expire_at") or payload.get("expire") or ""
        status = payload.get("status") or "有效"
        issued = payload.get("issued_at") or today()
        if cid:
            conn.execute(
                "UPDATE fs_certs SET cert_type=?, holder=?, cert_no=?, expire_at=?, status=?, issued_at=?"
                " WHERE id=?",
                (ctype, holder, cert_no, expire, status, issued, cid),
            )
            conn.commit()
            return "fs_certs#%s 续期至 %s" % (cid, expire or "-")
        cur = conn.execute(
            "INSERT INTO fs_certs (cert_type, holder, cert_no, issued_at, expire_at, status)"
            " VALUES (?,?,?,?,?,?)",
            (ctype, holder, cert_no, issued, expire, status),
        )
        conn.commit()
        return "fs_certs 新建 id=%s %s" % (cur.lastrowid, ctype)
    finally:
        conn.close()


def apply_day_close(db_path, data, payload):
    """day.close：老板确认打烊日清 → app_audit + fin_cash 登记。"""
    date = payload.get("date") or today()
    sold_c = payload.get("sold_count")
    sold_a = payload.get("sold_amount")
    inbound_c = payload.get("inbound_count")
    loss_c = payload.get("loss_count")
    open_wo = payload.get("workorders_open")
    note = payload.get("note") or "App 确认打烊"
    body = (
        "售出%s笔¥%s · 入库%s笔 · 报损%s笔 · 未完工单%s · %s"
        % (sold_c, sold_a, inbound_c, loss_c, open_wo, note)
    )
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS app_audit ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "kind TEXT, title TEXT, body TEXT,"
            "ts TEXT DEFAULT (datetime('now','localtime')))"
        )
        conn.execute(
            "INSERT INTO app_audit (kind, title, body) VALUES (?,?,?)",
            ("day_close", "打烊日清 " + date, body),
        )
        try:
            amt = float(sold_a or 0)
        except (TypeError, ValueError):
            amt = 0.0
        try:
            conn.execute(
                "INSERT INTO fin_cash (ts, kind, amount, account, note) VALUES (?,?,?,?,?)",
                (now_iso(), "打烊日清", amt, "堂食+外卖", body),
            )
        except sqlite3.OperationalError as exc:
            log.warning("fin_cash 写入跳过: %s", exc)
        conn.commit()
    finally:
        conn.close()
    # 旁路标记到 data.config 供首页可读
    cfg = data.setdefault("config", {})
    if isinstance(cfg, dict):
        cfg["last_day_close"] = {
            "date": date,
            "sold_count": sold_c,
            "sold_amount": sold_a,
            "inbound_count": inbound_c,
            "loss_count": loss_c,
            "workorders_open": open_wo,
            "ts": now_iso(),
            "note": note,
        }
    return "day.close %s %s" % (date, body)


def apply_finance_recon(db_path, data, payload):
    """finance.recon：老板确认当日堂食/外卖/采购三方勾兑 → fin_cash + config 标记。"""
    date = payload.get("date") or today()

    def _f(k, *alts):
        for key in (k,) + alts:
            if payload.get(key) not in (None, ""):
                try:
                    return float(payload.get(key))
                except (TypeError, ValueError):
                    return 0.0
        return 0.0

    dine = _f("dine_in", "dine", "堂食")
    takeout = _f("takeout", "外卖")
    purchase = _f("purchase", "采购")
    note = payload.get("note") or "App三方勾兑确认"
    sales_sum = dine + takeout
    body = "堂食¥%.2f · 外卖¥%.2f · 采购¥%.2f · 差¥%.2f · %s" % (
        dine, takeout, purchase, sales_sum - purchase, note
    )
    conn = sqlite3.connect(db_path)
    try:
        try:
            conn.execute(
                "INSERT INTO fin_cash (ts, kind, amount, account, note) VALUES (?,?,?,?,?)",
                (now_iso(), "三方勾兑", sales_sum, "收银vs采购", body),
            )
        except sqlite3.OperationalError as exc:
            log.warning("fin_cash 三方勾兑跳过: %s", exc)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS app_audit ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "kind TEXT, title TEXT, body TEXT,"
                "ts TEXT DEFAULT (datetime('now','localtime')))"
            )
            conn.execute(
                "INSERT INTO app_audit (kind, title, body) VALUES (?,?,?)",
                ("finance_recon", "三方勾兑 " + date, body),
            )
        except sqlite3.OperationalError as exc:
            log.warning("app_audit 三方勾兑跳过: %s", exc)
        conn.commit()
    finally:
        conn.close()
    cfg = data.setdefault("config", {})
    if isinstance(cfg, dict):
        cfg["last_finance_recon"] = {
            "date": date,
            "dine_in": dine,
            "takeout": takeout,
            "purchase": purchase,
            "gap": round(sales_sum - purchase, 2),
            "ts": now_iso(),
            "note": note,
        }
    return "finance.recon %s %s" % (date, body)


def upsert_booking(db_path, payload):
    """booking.upsert → bookings 表（有 id 则更新状态，否则插入）。"""
    conn = sqlite3.connect(db_path)
    try:
        bid = payload.get("id")
        if bid:
            conn.execute(
                "UPDATE bookings SET status=? WHERE id=?",
                (payload.get("status") or "confirmed", bid))
            conn.commit()
            return "booking#%s status=%s" % (bid, payload.get("status"))
        args = (
            payload.get("guest_name") or payload.get("name") or "散客",
            payload.get("phone") or "",
            payload.get("date") or today(),
            payload.get("time") or "",
            payload.get("party_size") or 2,
            payload.get("table_id"),
            payload.get("status") or "confirmed",
            payload.get("note") or "",
        )
        try:
            cur = conn.execute(
                "INSERT INTO bookings (guest_name, phone, date, time, party_size, table_id, status, note, source)"
                " VALUES (?,?,?,?,?,?,?,?,?)", args + ("queue",))
        except sqlite3.OperationalError:
            cur = conn.execute(
                "INSERT INTO bookings (guest_name, phone, date, time, party_size, table_id, status, note)"
                " VALUES (?,?,?,?,?,?,?,?)", args)
        conn.commit()
        return "booking 插入 id=%s" % cur.lastrowid
    finally:
        conn.close()


def update_queue_call(db_path, payload):
    """queue.call：更新排队状态为叫号/就餐。"""
    conn = sqlite3.connect(db_path)
    try:
        qid = payload.get("id") or payload.get("queue_no")
        st = payload.get("status") or "叫号"
        if not qid:
            raise ValueError("缺少 queue id/queue_no")
        cur = conn.execute(
            "UPDATE queue SET status=? WHERE id=? OR queue_no=?",
            (st, qid, str(qid)))
        conn.commit()
        if cur.rowcount == 0:
            raise ValueError("排队号不存在: %s" % qid)
        return "queue %s → %s" % (qid, st)
    finally:
        conn.close()


def insert_queue_join(db_path, payload):
    """queue.join：现场取号入队。"""
    conn = sqlite3.connect(db_path)
    try:
        date = payload.get("date") or today()
        party = int(payload.get("party_size") or payload.get("party") or 2)
        # 当日号：Q + 序号
        try:
            row = conn.execute(
                "SELECT COUNT(*) FROM queue WHERE date=?", (date,)
            ).fetchone()
            n = int(row[0] or 0) + 1
        except sqlite3.OperationalError:
            n = 1
        qno = str(payload.get("queue_no") or ("Q%02d" % n))
        status = payload.get("status") or "排队中"
        ts = payload.get("ts") or now_iso()
        try:
            cur = conn.execute(
                "INSERT INTO queue (queue_no, date, party_size, status, ts, source)"
                " VALUES (?,?,?,?,?,?)",
                (qno, date, party, status, ts, "queue"),
            )
        except sqlite3.OperationalError:
            cur = conn.execute(
                "INSERT INTO queue (queue_no, date, party_size, status, ts)"
                " VALUES (?,?,?,?,?)",
                (qno, date, party, status, ts),
            )
        conn.commit()
        return "queue.join %s party=%s id=%s" % (qno, party, cur.lastrowid)
    finally:
        conn.close()


def insert_staff_clock(db_path, payload):
    """staff.clock：补打卡。"""
    conn = sqlite3.connect(db_path)
    try:
        try:
            cur = conn.execute(
                "INSERT INTO staff_clock (staff_id, ts, kind, status, source)"
                " VALUES (?,?,?,?,?)",
                (payload.get("staff_id") or "",
                 payload.get("ts") or now_iso(),
                 payload.get("kind") or "上班",
                 payload.get("status") or "补录",
                 "queue"))
        except sqlite3.OperationalError:
            cur = conn.execute(
                "INSERT INTO staff_clock (staff_id, ts, kind)"
                " VALUES (?,?,?)",
                (payload.get("staff_id") or "",
                 payload.get("ts") or now_iso(),
                 payload.get("kind") or "上班"))
        conn.commit()
        return "staff_clock rowid=%s" % cur.lastrowid
    finally:
        conn.close()


def upsert_staff_shift(db_path, payload):
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO staff_shifts (staff_id, staff_name, date, shift, start_time, end_time, role)"
            " VALUES (?,?,?,?,?,?,?)",
            (payload.get("staff_id") or "",
             payload.get("staff_name") or payload.get("name") or "",
             payload.get("date") or today(),
             payload.get("shift") or "早班",
             payload.get("start_time") or "",
             payload.get("end_time") or "",
             payload.get("role") or ""))
        conn.commit()
        return "staff_shifts rowid=%s" % cur.lastrowid
    finally:
        conn.close()


def insert_uniform_log(db_path, payload):
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO staff_train (staff_id, course, passed, ts, remark)"
            " VALUES (?,?,?,?,?)",
            (payload.get("staff_id") or "uniform",
             payload.get("course") or "工服合规检查",
             1 if payload.get("pass") in (1, True, "1", "合格", "pass") else 0,
             payload.get("ts") or now_iso(),
             payload.get("note") or payload.get("remark") or "queue"))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def insert_disinfect(db_path, payload):
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO fs_disinfect (date, area, method, operator, ts, source)"
            " VALUES (?,?,?,?,?,?)",
            (payload.get("date") or today(),
             payload.get("area") or "",
             payload.get("method") or "",
             payload.get("operator") or "QUEUE",
             payload.get("ts") or now_iso(),
             "queue"))
        conn.commit()
        return cur.lastrowid
    except sqlite3.OperationalError:
        cur = conn.execute(
            "INSERT INTO fs_disinfect (date, area, method, operator, ts)"
            " VALUES (?,?,?,?,?)",
            (payload.get("date") or today(),
             payload.get("area") or "",
             payload.get("method") or "",
             payload.get("operator") or "QUEUE",
             payload.get("ts") or now_iso()))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def insert_fs_trace(db_path, payload):
    """fs.trace_scan → fs_trace（扫码溯源登记）。"""
    conn = sqlite3.connect(db_path)
    try:
        name = payload.get("name") or payload.get("ing_name") or ""
        batch = payload.get("batch") or payload.get("batch_no") or payload.get("lot") or ""
        supplier = payload.get("supplier") or ""
        recv = payload.get("recv_date") or today()
        check = payload.get("check_result") or "合格"
        try:
            cur = conn.execute(
                "INSERT INTO fs_trace (batch_no, ing_name, supplier, recv_date, check_result, source)"
                " VALUES (?,?,?,?,?,?)",
                (batch, name, supplier, recv, check, "queue"))
        except sqlite3.OperationalError:
            cur = conn.execute(
                "INSERT INTO fs_trace (batch_no, ing_name, supplier, recv_date)"
                " VALUES (?,?,?,?)",
                (batch, name, supplier, recv))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def insert_eq_maintain(db_path, payload):
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO eq_maintain (device, kind, ts, operator, cost, next_due, note)"
            " VALUES (?,?,?,?,?,?,?)",
            (payload.get("device") or "",
             payload.get("kind") or "保养",
             payload.get("ts") or now_iso(),
             payload.get("operator") or "QUEUE",
             payload.get("cost"),
             payload.get("next_due"),
             payload.get("note") or ""))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def insert_vip_campaign(db_path, payload):
    """活动草案：写入 vip_coupons 作为未使用券模板。"""
    conn = sqlite3.connect(db_path)
    try:
        code = payload.get("code") or ("CMP" + uuid.uuid4().hex[:8].upper())
        gift = payload.get("gift") or payload.get("note")
        ctype = payload.get("type") or payload.get("campaign_type") or "活动"
        if gift and ctype in ("活动", "生日赠"):
            ctype = "%s·%s" % (ctype, gift)
        # value：数字面额；无数字时用 0，礼品说明进 type
        raw_val = payload.get("value")
        if raw_val is None:
            raw_val = payload.get("amount")
        try:
            value = float(raw_val) if raw_val not in (None, "") else 0
        except (TypeError, ValueError):
            # 折扣文案如「8折」→ type 补充，value 记 0
            if raw_val and not gift:
                ctype = "%s·%s" % (ctype, raw_val)
            value = 0
        cur = conn.execute(
            "INSERT OR IGNORE INTO vip_coupons (code, member_id, type, value, status, valid_to)"
            " VALUES (?,?,?,?,?,?)",
            (code,
             payload.get("member_id"),
             ctype,
             value,
             "未使用",
             payload.get("valid_to")))
        conn.commit()
        return "vip_coupons code=%s type=%s value=%s" % (code, ctype, value)
    finally:
        conn.close()


def redeem_vip_coupon(db_path, payload):
    code = str(payload.get("code") or "").strip()
    if not code:
        raise ValueError("vip.coupon_redeem 缺 code")
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "UPDATE vip_coupons SET status=? WHERE code=?",
            ("已核销", code),
        )
        if cur.rowcount <= 0:
            conn.execute(
                "INSERT INTO vip_coupons (code, member_id, type, value, status, valid_to) VALUES (?,?,?,?,?,?)",
                (code, payload.get("member_id"), payload.get("type") or "核销",
                 payload.get("value") or 0, "已核销", None),
            )
        conn.commit()
        return "vip_coupons redeem %s" % code
    finally:
        conn.close()


def insert_week_export(db_path, payload):
    title = payload.get("title") or "经营周报"
    note = str(payload.get("note") or "App 导出周报草案")
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS app_audit ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "kind TEXT, title TEXT, body TEXT,"
            "ts TEXT DEFAULT (datetime('now','localtime')))"
        )
        conn.execute(
            "INSERT INTO app_audit (kind, title, body) VALUES (?,?,?)",
            ("week_export", title, note),
        )
        conn.commit()
        return "app_audit week_export"
    finally:
        conn.close()


def insert_recipe_substitute(db_path, payload):
    frm = payload.get("from_ing") or payload.get("from") or "?"
    to = payload.get("to_ing") or payload.get("to") or "?"
    dish = payload.get("dish") or ""
    body = "%s → %s · %s" % (frm, to, dish)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS app_audit ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "kind TEXT, title TEXT, body TEXT,"
            "ts TEXT DEFAULT (datetime('now','localtime')))"
        )
        conn.execute(
            "INSERT INTO app_audit (kind, title, body) VALUES (?,?,?)",
            ("recipe_substitute", "缺料替换", body),
        )
        conn.commit()
        return "recipe.substitute %s→%s (记审计)" % (frm, to)
    finally:
        conn.close()


def _bom_lines(payload, key):
    """把 main/aux/seasoning 收成字符串行：原料名+用量+单位。"""
    raw = payload.get(key)
    if raw is None:
        return None  # 未传则不改
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if item is None:
            continue
        if isinstance(item, str):
            s = item.strip()
            if s:
                out.append(s)
            continue
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("ing") or item.get("ing_name") or "").strip()
        if not name:
            continue
        qty = item.get("qty")
        unit = str(item.get("unit") or "g").strip() or "g"
        if qty is None or qty == "":
            out.append(name)
        else:
            try:
                qf = float(qty)
                qtxt = ("%g" % qf)
            except (TypeError, ValueError):
                qtxt = str(qty)
            out.append("%s%s%s" % (name, qtxt, unit))
    return out


def upsert_recipe(db_path, data, payload):
    """recipe.upsert：写 SQLite recipes；可选同步菜品壳、缺料原料建档。"""
    name = str(payload.get("name") or "").strip()
    sku = str(payload.get("sku_id") or payload.get("sku") or payload.get("id") or "").strip()
    if not name and not sku:
        raise ValueError("recipe.upsert 缺 name/sku_id")

    conn = sqlite3.connect(db_path)
    try:
        row = None
        if sku:
            row = conn.execute(
                "SELECT sku_id,name,color,filling,face_main,main,aux,seasoning,"
                "steps,params,blessing,diet_tags,version FROM recipes WHERE sku_id=?",
                (sku,),
            ).fetchone()
        if not row and name:
            row = conn.execute(
                "SELECT sku_id,name,color,filling,face_main,main,aux,seasoning,"
                "steps,params,blessing,diet_tags,version FROM recipes WHERE name=?",
                (name,),
            ).fetchone()
            if row:
                sku = row[0]

        if not sku:
            sku = "SKU-APP-" + uuid.uuid4().hex[:8].upper()

        def jload(s, default):
            if not s:
                return default
            try:
                return json.loads(s)
            except Exception:
                return default

        if row:
            cur = {
                "sku_id": row[0],
                "name": row[1],
                "color": row[2],
                "filling": row[3],
                "face_main": row[4],
                "main": jload(row[5], []),
                "aux": jload(row[6], []),
                "seasoning": jload(row[7], []),
                "steps": jload(row[8], []),
                "params": jload(row[9], {}),
                "blessing": row[10],
                "diet_tags": jload(row[11], []),
                "version": int(row[12] or 1),
            }
        else:
            cur = {
                "sku_id": sku,
                "name": name or sku,
                "color": None,
                "filling": None,
                "face_main": None,
                "main": [],
                "aux": [],
                "seasoning": [],
                "steps": [],
                "params": {},
                "blessing": None,
                "diet_tags": [],
                "version": 0,
            }

        if name:
            cur["name"] = name
        for k in ("color", "filling", "face_main", "blessing"):
            if payload.get(k) is not None:
                cur[k] = payload.get(k)
        for k in ("main", "aux", "seasoning", "steps"):
            lines = _bom_lines(payload, k)
            if lines is not None:
                cur[k] = lines
        if payload.get("params") is not None and isinstance(payload.get("params"), dict):
            cur["params"] = payload.get("params")
        if payload.get("diet_tags") is not None:
            tags = payload.get("diet_tags")
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",") if t.strip()]
            cur["diet_tags"] = tags if isinstance(tags, list) else []
        cur["version"] = int(cur.get("version") or 0) + 1
        now = now_iso()

        conn.execute(
            "INSERT OR REPLACE INTO recipes"
            " (sku_id,name,color,filling,face_main,main,aux,seasoning,"
            "  steps,params,blessing,diet_tags,version,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                cur["sku_id"], cur["name"], cur["color"], cur["filling"], cur["face_main"],
                json.dumps(cur["main"], ensure_ascii=False),
                json.dumps(cur["aux"], ensure_ascii=False),
                json.dumps(cur["seasoning"], ensure_ascii=False),
                json.dumps(cur["steps"], ensure_ascii=False),
                json.dumps(cur["params"] or {}, ensure_ascii=False),
                cur["blessing"],
                json.dumps(cur["diet_tags"] or [], ensure_ascii=False),
                cur["version"], now,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    parts = ["recipe %s v%s" % (cur["sku_id"], cur["version"])]

    # 缺料原料建档（产品库）
    ensure = payload.get("ensure_ings") in (True, 1, "1", "true", "yes")
    if ensure:
        names = []
        for key in ("main", "aux", "seasoning"):
            for line in cur.get(key) or []:
                # 去掉尾部用量
                n = re.sub(r"[\d./]+\s*[a-zA-Z\u4e00-\u9fff]*\s*$", "", str(line)).strip()
                n = re.sub(r"[（(].*?[）)]", "", n).strip() or str(line).strip()
                if n and n not in names:
                    names.append(n)
        ings = data.setdefault("ings", [])
        existing = {str(g.get("name") or "") for g in ings if isinstance(g, dict)}
        created = 0
        for n in names:
            if n in existing or n in ("清水", "水"):
                continue
            # 从 BOM 行猜单位
            unit = "g"
            for line in (cur.get("main") or []) + (cur.get("aux") or []) + (cur.get("seasoning") or []):
                if str(line).startswith(n) or n in str(line):
                    m = re.search(r"(\d+(?:\.\d+)?)(g|kg|斤|ml|L|个|只|把|袋)$", str(line))
                    if m:
                        unit = m.group(2)
                    break
            apply_ing_upsert(data, {
                "name": n,
                "unit": unit,
                "cat": "菜谱挂钩",
                "qty": 0,
                "safe": 0,
                "on": True,
            })
            existing.add(n)
            created += 1
        if created:
            parts.append("建原料%d" % created)

    # 同步堂食菜品壳（可卖）
    sync_dish = payload.get("sync_dish")
    if sync_dish is None:
        sync_dish = True
    if sync_dish in (True, 1, "1", "true", "yes"):
        dish_payload = {
            "id": payload.get("dish_id") or cur["sku_id"],
            "name": cur["name"],
            "cat": payload.get("dish_cat") or payload.get("cat") or cur.get("color") or "常规",
            "price": payload.get("price"),
            "cost": payload.get("cost"),
            "on": payload.get("on", True),
            "sku_id": cur["sku_id"],
            "recipe_link": "from_recipe",
        }
        # 去掉 None 价，避免写成 0 误伤
        if dish_payload["price"] is None:
            dish_payload.pop("price")
        if dish_payload["cost"] is None:
            dish_payload.pop("cost")
        try:
            parts.append(apply_dish_upsert(data, dish_payload))
        except Exception as dex:  # noqa: BLE001
            parts.append("dish跳过:%s" % dex)

    return " · ".join(parts)


def apply_order_mark(data, payload):
    """order.mark：采购单状态迁移（草稿→已发/已下单，不入库）。"""
    orders = data.setdefault("orders", [])
    if not isinstance(orders, list):
        raise ValueError("data.orders 不是数组")
    oid = str(payload.get("order_id") or payload.get("id") or payload.get("no") or "").strip()
    if not oid:
        raise ValueError("order.mark 缺 order_id")
    status = str(payload.get("status") or "已发").strip() or "已发"
    # 规范化：已下单/已订/shipped → 已发
    if status in ("已下单", "已订", "shipped", "ordered"):
        status = "已发"
    for o in orders:
        if str(o.get("id") or "") == oid or str(o.get("no") or "") == oid:
            old = o.get("status")
            if old in ("已转进货", "已入库", "done"):
                raise ValueError("采购单 %s 已入库，不能再改状态" % oid)
            o["status"] = status
            note = payload.get("note")
            if note:
                o["note"] = (o.get("note") or "") + " 【%s】" % note
            else:
                o["note"] = (o.get("note") or "") + " 【确认下单·待到货】"
            if payload.get("supplier"):
                o["supplier"] = payload.get("supplier")
            o["_u"] = now_iso()
            return "orders %s %s → %s" % (o.get("no") or oid, old, status)
    raise ValueError("找不到采购单 %s" % oid)


def apply_stock_count(data, db_path, payload):
    """stock.count：记差异 + 写盘点调整流水并 rebuild_stock（真改账面）。"""
    name = payload.get("name") or payload.get("ing_name") or "原料"
    gid = resolve_ing_id(data, payload)
    book = payload.get("book_qty")
    if book is None:
        book = payload.get("book")
    real = payload.get("real_qty")
    if real is None:
        real = payload.get("real")
    try:
        book_f = float(book) if book is not None else None
    except (TypeError, ValueError):
        book_f = None
    try:
        real_f = float(real) if real is not None else None
    except (TypeError, ValueError):
        real_f = None

    # 旁路差异表（审计）
    try:
        insert_stock_count(db_path, payload)
    except Exception as exc:  # noqa: BLE001
        log.warning("loss_inventory_diff 旁路失败: %s", exc)

    if gid is None:
        return "stock.count %s（未匹配原料，仅记差异表）" % name
    if real_f is None:
        # Kimi/草稿盘点：差异表已写，无实盘数不改账面
        note = (payload.get("note") or "")[:120]
        return "stock.count %s（仅审计登记，未改账面）· %s" % (name, note or "缺实盘数")

    # 账面：优先用传入 book，否则读当前 stock
    if book_f is None:
        for g in data.get("ings") or []:
            if str(g.get("id")) == str(gid):
                book_f = float(g.get("qty") if g.get("qty") is not None else (g.get("stock") or 0))
                break
        if book_f is None:
            book_f = 0.0
    delta = _r3(real_f - book_f)
    logs = data.setdefault("logs", [])
    if not isinstance(logs, list):
        raise ValueError("data.logs 不是数组")
    # 用「手工调整」按实盘绝对值落账：rebuild 从零重放时，盘点差异 Δ 会在无期初/入库基线时变成错误账面
    logs.append({
        "type": "手工调整",
        "ing": gid,
        "date": payload.get("date") or today(),
        "qty": real_f,
        "ref": "盘点·" + name,
        "note": payload.get("note") or ("账面 %s → 实盘 %s（Δ%s）" % (book_f, real_f, delta)),
        "source": "queue",
        "inCost": 0,
    })
    # 同步改 ings 即时字段，避免等 rebuild 前快照仍显示旧数
    for g in data.get("ings") or []:
        if str(g.get("id")) == str(gid):
            g["qty"] = real_f
            g["stock"] = real_f
            break
    rb = rebuild_stock(data)
    return "stock.count %s 账面%s→实盘%s Δ%s；%s" % (name, book_f, real_f, delta, rb)


def insert_stock_count(db_path, payload):
    name = payload.get("name") or payload.get("ing_name") or "原料"
    conn = sqlite3.connect(db_path)
    try:
        try:
            conn.execute(
                "INSERT INTO loss_inventory_diff (name, book_qty, real_qty, note, ts)"
                " VALUES (?,?,?,?,datetime('now','localtime'))",
                (
                    name,
                    payload.get("book_qty") or payload.get("book"),
                    payload.get("real_qty") or payload.get("real"),
                    payload.get("note") or "App 盘点",
                ),
            )
            conn.commit()
        except sqlite3.OperationalError:
            conn.execute(
                "INSERT INTO loss_reports (date, ing_name, qty, reason, status)"
                " VALUES (date('now','localtime'),?,?,?,?)",
                (name, payload.get("qty") or 0, "盘点差异", "已登记"),
            )
            conn.commit()
        return "stock.count %s" % name
    finally:
        conn.close()


def insert_takeout_ack(db_path, payload):
    conn = sqlite3.connect(db_path)
    try:
        oid = payload.get("id") or payload.get("order_id")
        if oid:
            conn.execute(
                "UPDATE takeout_orders SET status=? WHERE id=?",
                (payload.get("status") or "已确认", oid))
            conn.commit()
            return "takeout_orders#%s ack" % oid
        cur = conn.execute(
            "INSERT INTO takeout_reconcile (date, platform, amount, status, note)"
            " VALUES (?,?,?,?,?)",
            (payload.get("date") or today(),
             payload.get("platform") or "",
             payload.get("amount"),
             payload.get("status") or "已对账",
             payload.get("note") or "queue ack"))
        conn.commit()
        return "takeout_reconcile rowid=%s" % cur.lastrowid
    except sqlite3.OperationalError as exc:
        # 表列差异时退化为 note 登记
        return "takeout.ack skipped cols: %s" % exc
    finally:
        conn.close()


def insert_review_followup(db_path, payload):
    """review.followup：差评跟进 / 堂食当场客诉。
    无 review_id 时先落 rv_reviews（当场客诉），再写 rv_improve。
    """
    conn = sqlite3.connect(db_path)
    try:
        rid = payload.get("review_id")
        created = None
        if not rid and (
            payload.get("content")
            or payload.get("source")
            or payload.get("table_id")
            or str(payload.get("action") or "").find("客诉") >= 0
        ):
            content = payload.get("content") or payload.get("note") or "堂食客诉"
            tid = payload.get("table_id") or payload.get("no")
            if tid:
                content = ("桌%s · " % tid) + content
            cur = conn.execute(
                "INSERT INTO rv_reviews (source, rating, content, ts, handled)"
                " VALUES (?,?,?,?,0)",
                (
                    payload.get("source") or "堂食当场",
                    payload.get("rating") if payload.get("rating") is not None else 2.0,
                    content,
                    payload.get("ts") or now_iso(),
                ),
            )
            rid = cur.lastrowid
            created = rid
        if rid:
            # 当场客诉默认仍待跟进；显式 handled=1 才标已处理
            if payload.get("handled") in (1, True, "1", "true"):
                conn.execute("UPDATE rv_reviews SET handled=1 WHERE id=?", (rid,))
            elif created is None:
                # 对已有差评做跟进 → 标已处理
                conn.execute("UPDATE rv_reviews SET handled=1 WHERE id=?", (rid,))
        cur = conn.execute(
            "INSERT INTO rv_improve (review_id, action, owner, due, status)"
            " VALUES (?,?,?,?,?)",
            (
                rid,
                payload.get("action") or payload.get("note") or "跟进",
                payload.get("owner") or "QUEUE",
                payload.get("due"),
                payload.get("status") or ("待处理" if created else "进行中"),
            ),
        )
        conn.commit()
        if created:
            return "rv_reviews#%s + rv_improve#%s（当场客诉）" % (created, cur.lastrowid)
        return "rv_improve rowid=%s" % cur.lastrowid
    finally:
        conn.close()


def insert_vip_checkin(db_path, payload, data=None):
    """vip.checkin：会员到店识别 → vip_visits + 会员状态「在店」。"""
    mid = str(
        payload.get("member_id")
        or payload.get("id")
        or payload.get("phone")
        or ""
    ).strip()
    name = payload.get("name") or payload.get("guest_name") or ""
    phone = payload.get("phone") or ""
    if not mid and not name and not phone:
        raise ValueError("vip.checkin 需 member_id / name / phone 之一")
    if not mid:
        mid = "V" + (phone[-4:] if phone else uuid.uuid4().hex[:6])
    tid = str(payload.get("table_id") or payload.get("no") or "").strip() or None
    ts = payload.get("ts") or now_iso()
    visit_id = None
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS vip_visits ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " member_id TEXT, name TEXT, phone TEXT,"
            " table_id TEXT, note TEXT, ts TEXT, source TEXT)"
        )
        # 尽量挂上已知会员
        if not name or not phone:
            row = conn.execute(
                "SELECT name, phone FROM vip_members WHERE member_id=? OR phone=?",
                (mid, phone or mid),
            ).fetchone()
            if row:
                name = name or (row[0] or "")
                phone = phone or (row[1] or "")
                mid = mid or mid
        cur = conn.execute(
            "INSERT INTO vip_visits (member_id, name, phone, table_id, note, ts, source)"
            " VALUES (?,?,?,?,?,?,?)",
            (
                mid,
                name or mid,
                phone,
                tid,
                payload.get("note") or "到店识别",
                ts,
                "queue",
            ),
        )
        visit_id = cur.lastrowid
        # 更新/插入会员状态
        exists = conn.execute(
            "SELECT member_id FROM vip_members WHERE member_id=? OR (?!='' AND phone=?)",
            (mid, phone, phone),
        ).fetchone()
        if exists:
            conn.execute(
                "UPDATE vip_members SET status=? WHERE member_id=?",
                ("在店", exists[0]),
            )
            mid = exists[0]
        else:
            try:
                conn.execute(
                    "INSERT INTO vip_members (member_id, name, phone, level, joined_at, status)"
                    " VALUES (?,?,?,?,?,?)",
                    (mid, name or mid, phone or None, "到店客", today(), "在店"),
                )
            except sqlite3.IntegrityError:
                conn.execute(
                    "UPDATE vip_members SET status=? WHERE member_id=?",
                    ("在店", mid),
                )
        conn.commit()
    finally:
        conn.close()
    if data is not None:
        logs = data.setdefault("logs", [])
        if isinstance(logs, list):
            logs.append({
                "id": "VC" + uuid.uuid4().hex[:8],
                "kind": "vip_checkin",
                "member_id": mid,
                "name": name,
                "phone": phone,
                "table_id": tid,
                "note": payload.get("note"),
                "ts": ts,
                "source": "queue",
            })
        if tid:
            t = _find_pos_table(data, tid)
            if t is not None:
                t["vip_member_id"] = mid
                t["vip_name"] = name or mid
    return "vip.checkin %s%s id=%s" % (
        name or mid,
        (" @%s" % tid) if tid else "",
        visit_id,
    )


def insert_fin_split(db_path, payload, approve=False):
    conn = sqlite3.connect(db_path)
    try:
        if approve and payload.get("id"):
            conn.execute(
                "UPDATE fin_split SET status=? WHERE id=?",
                (payload.get("status") or "已结算", payload.get("id")))
            conn.commit()
            return "fin_split#%s approved" % payload.get("id")
        cur = conn.execute(
            "INSERT INTO fin_split (period, party, amount, ratio, frozen_until, status)"
            " VALUES (?,?,?,?,?,?)",
            (payload.get("period") or today()[:7],
             payload.get("party") or "",
             payload.get("amount"),
             payload.get("ratio"),
             payload.get("frozen_until"),
             "冻结中" if not approve else (payload.get("status") or "已结算")))
        conn.commit()
        return "fin_split rowid=%s" % cur.lastrowid
    finally:
        conn.close()


def upsert_vendor(db_path, data, payload):
    """vendor.upsert：供应商档案 → SQLite sup_vendors + data.vendors/suppliers。"""
    name = str(payload.get("name") or "").strip()
    vid = str(payload.get("vendor_id") or payload.get("id") or "").strip()
    if not name and not vid:
        raise ValueError("vendor.upsert 缺 name/vendor_id")
    if not name:
        name = vid
    if not vid:
        vid = "V" + uuid.uuid4().hex[:8].upper()

    contact = payload.get("contact")
    phone = payload.get("phone")
    category = payload.get("category") or payload.get("cat")
    level = payload.get("level") or payload.get("rating")
    status = payload.get("status") or "合作中"
    period = payload.get("period") or payload.get("settle") or "月结30天"
    note = payload.get("note") or ""
    now = now_iso()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sup_vendors ("
            "vendor_id TEXT PRIMARY KEY, name TEXT, contact TEXT, phone TEXT,"
            "category TEXT, level TEXT, status TEXT DEFAULT '合作中', rev INTEGER)"
        )
        for col, typ in (("period", "TEXT"), ("note", "TEXT"), ("updated_at", "TEXT")):
            try:
                conn.execute("ALTER TABLE sup_vendors ADD COLUMN %s %s" % (col, typ))
            except sqlite3.OperationalError:
                pass
        exist = conn.execute(
            "SELECT vendor_id FROM sup_vendors WHERE vendor_id=? OR name=?",
            (vid, name),
        ).fetchone()
        if exist:
            vid = exist[0]
            conn.execute(
                "UPDATE sup_vendors SET name=?, contact=?, phone=?, category=?, level=?,"
                " status=?, period=?, note=?, updated_at=? WHERE vendor_id=?",
                (name, contact, phone, category, str(level) if level is not None else None,
                 status, period, note, now, vid),
            )
            action = "更新"
        else:
            conn.execute(
                "INSERT INTO sup_vendors"
                " (vendor_id,name,contact,phone,category,level,status,period,note,updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (vid, name, contact, phone, category, str(level) if level is not None else None,
                 status, period, note, now),
            )
            action = "新建"
        conn.commit()
    finally:
        conn.close()

    row = {
        "id": vid,
        "vendor_id": vid,
        "name": name,
        "contact": contact,
        "phone": phone,
        "category": category,
        "level": level,
        "status": status,
        "period": period,
        "note": note,
        "_u": now,
    }
    try:
        if level is not None and str(level).replace(".", "", 1).isdigit():
            row["rating"] = float(level)
    except (TypeError, ValueError):
        pass

    vendors = data.setdefault("vendors", [])
    if not isinstance(vendors, list):
        vendors = []
        data["vendors"] = vendors
    hit = False
    for i, v in enumerate(vendors):
        if not isinstance(v, dict):
            continue
        if str(v.get("id") or v.get("vendor_id") or "") == vid or str(v.get("name") or "") == name:
            merged = dict(v)
            merged.update({k: val for k, val in row.items() if val is not None})
            vendors[i] = merged
            hit = True
            break
    if not hit:
        vendors.append(row)

    names = []
    for v in vendors:
        if isinstance(v, dict) and v.get("name"):
            names.append(str(v["name"]))
        elif isinstance(v, str) and v.strip():
            names.append(v.strip())
    for s in (data.get("suppliers") or []):
        if isinstance(s, str) and s.strip() and s.strip() not in names:
            names.append(s.strip())
    if name not in names:
        names.append(name)
    data["suppliers"] = names

    return "vendor %s %s %s" % (action, vid, name)


def insert_supply_po(db_path, payload):
    """supply.po：供应商往来账登记一笔应付。"""
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO sup_accounts (vendor_id, kind, amount, ts, ref_no)"
            " VALUES (?,?,?,?,?)",
            (payload.get("vendor_id") or payload.get("supplier") or "",
             "应付",
             payload.get("amount") or payload.get("payable"),
             payload.get("ts") or now_iso(),
             payload.get("ref_no") or payload.get("po_no") or ("PO" + uuid.uuid4().hex[:8])))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


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
        # BFF 以 result.ok === false 判驳回；仅传 error 会被误标「已执行」
        body = {}
        if error is not None:
            body["result"] = {"ok": False, "error": str(error)}
            body["error"] = str(error)
        elif result is not None:
            if isinstance(result, dict) and "ok" not in result:
                result = dict(result)
                result["ok"] = True
            body["result"] = result
        body["trace_id"] = trace_id
        # 429/5xx 重试（BFF 令牌桶 60/min，密集拍板时回调可能撞限流；
        # 不重试会导致"已落库但动作卡待执行"，重确认引发重复执行）
        status, resp = 0, {}
        for attempt in range(1, 5):
            status, resp = http_json(
                "POST", bff_url.rstrip("/") + "/api/actions/%s/execute" % aid,
                body, token=token)
            if status != 429 and not (isinstance(status, int) and status >= 500):
                break
            retry_after = 1
            if isinstance(resp, dict):
                try:
                    retry_after = max(1, int(resp.get("retry_after") or 1))
                except Exception:
                    retry_after = 1
            alog.warning("回调 execute 第 %s/4 次 http=%s，%ss 后重试 id=%s trace=%s",
                         attempt, status, retry_after, aid, trace_id)
            time.sleep(retry_after * attempt)
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
        if atype == "restock.create" or atype == "analysis.restock":
            desc = apply_restock(data, payload)
        elif atype == "recv.inbound":
            desc = apply_recv_inbound(data, payload)
        elif atype == "config.update":
            desc = apply_config(data, payload)
        elif atype in ("qc.record", "qc.pass", "plate.pass"):
            rowid = insert_qc_record(db_path, payload)
            desc = "%s → qc_records rowid=%s" % (atype, rowid)
        elif atype == "pos.table_state":
            desc = apply_pos_table_state(data, payload, db_path=db_path)
        elif atype == "pos.table_upsert":
            desc = apply_pos_table_upsert(data, payload)
        elif atype == "pos.table_remove":
            desc = apply_pos_table_remove(data, payload)
        elif atype == "dish.upsert":
            desc = apply_dish_upsert(data, payload)
        elif atype == "dish.price":
            desc = apply_dish_price(data, payload)
        elif atype == "dish.set_active":
            desc = apply_dish_set_active(data, payload)
        elif atype == "dish.auto_link":
            desc = apply_dish_auto_link(db_path, data, payload)
        elif atype == "ing.upsert":
            desc = apply_ing_upsert(data, payload)
        elif atype == "quote.upsert":
            desc = apply_quote_upsert(data, payload)
        elif atype == "pos.pay":
            desc = apply_pos_pay(data, payload, db_path=db_path)
        elif atype == "pos.rush":
            desc = apply_pos_service_note(data, payload, "rush", db_path=db_path)
        elif atype == "pos.pack":
            desc = apply_pos_service_note(data, payload, "pack", db_path=db_path)
        elif atype == "pos.ready":
            desc = apply_pos_service_note(data, payload, "ready", db_path=db_path)
        elif atype == "pos.pass":
            desc = apply_pos_service_note(data, payload, "pass", db_path=db_path)
        elif atype == "pos.void":
            desc = apply_pos_void(data, payload)
        elif atype == "pos.merge":
            desc = apply_pos_merge_split(data, payload, "merge")
        elif atype == "pos.split":
            desc = apply_pos_merge_split(data, payload, "split")
        elif atype == "loss.report":
            desc = apply_loss_report(data, payload)
            try:
                rid = insert_loss_report(db_path, payload)
                desc += " + loss_reports#%s" % rid
            except Exception as lex:  # noqa: BLE001
                alog.warning("loss_reports 旁路失败: %s", lex)
        elif atype == "sample.log":
            rowid = insert_sample(db_path, payload)
            desc = "fs_samples 插入 rowid=%s" % rowid
        elif atype == "fs.disinfect":
            rowid = insert_disinfect(db_path, payload)
            desc = "fs_disinfect 插入 rowid=%s" % rowid
        elif atype == "fs.trace_scan":
            rowid = insert_fs_trace(db_path, payload)
            desc = "fs_trace 扫码 rowid=%s" % rowid
        elif atype == "fs.cert.upsert":
            desc = insert_fs_cert(db_path, payload)
        elif atype == "day.close":
            desc = apply_day_close(db_path, data, payload)
        elif atype == "uniform.log":
            rowid = insert_uniform_log(db_path, payload)
            desc = "uniform/staff_train rowid=%s" % rowid
        elif atype == "booking.upsert":
            desc = upsert_booking(db_path, payload)
        elif atype == "queue.call":
            desc = update_queue_call(db_path, payload)
        elif atype == "queue.join":
            desc = insert_queue_join(db_path, payload)
        elif atype == "queue.serve":
            desc = apply_queue_serve(data, payload, db_path)
        elif atype == "staff.clock":
            desc = insert_staff_clock(db_path, payload)
        elif atype == "staff.shift_upsert":
            desc = upsert_staff_shift(db_path, payload)
        elif atype == "finance.freeze":
            desc = insert_fin_split(db_path, payload, approve=False)
        elif atype == "finance.approve":
            desc = insert_fin_split(db_path, payload, approve=True)
        elif atype == "finance.recon":
            desc = apply_finance_recon(db_path, data, payload)
        elif atype == "vip.campaign":
            desc = insert_vip_campaign(db_path, payload)
        elif atype == "vip.coupon_redeem":
            desc = redeem_vip_coupon(db_path, payload)
        elif atype == "analysis.export_week":
            desc = insert_week_export(db_path, payload)
        elif atype == "recipe.substitute":
            desc = insert_recipe_substitute(db_path, payload)
        elif atype == "recipe.upsert":
            desc = upsert_recipe(db_path, data, payload)
        elif atype == "stock.count":
            desc = apply_stock_count(data, db_path, payload)
        elif atype == "order.mark":
            desc = apply_order_mark(data, payload)
        elif atype == "takeout.ack":
            desc = insert_takeout_ack(db_path, payload)
            # 有金额则计入当日 sales（外卖渠道），供打烊「售出」日清
            if payload.get("amount") not in (None, "", 0, "0"):
                sale = append_sale(
                    data,
                    payload,
                    channel="外卖",
                    dish=payload.get("dish") or payload.get("platform") or "外卖",
                )
                desc += " + sales#%s" % sale.get("id")
        elif atype == "equipment.maintain":
            rowid = insert_eq_maintain(db_path, payload)
            desc = "eq_maintain rowid=%s" % rowid
        elif atype == "review.followup":
            desc = insert_review_followup(db_path, payload)
        elif atype == "vip.checkin":
            desc = insert_vip_checkin(db_path, payload, data)
        elif atype == "workorder.create":
            rowid = insert_workorder(db_path, payload)
            desc = "sop_workorders 插入 rowid=%s" % rowid
        elif atype == "workorder.advance":
            desc = advance_workorder(db_path, data, payload)
        elif atype == "workorder.step_clock":
            desc = clock_workorder_step(db_path, payload)
        elif atype == "recv.accept":
            desc = insert_recv_accept(db_path, payload)
        elif atype == "supply.po":
            # 同时追加草稿采购 + 往来账
            desc = apply_restock(data, payload)
            try:
                rid = insert_supply_po(db_path, payload)
                desc += " + sup_accounts#%s" % rid
            except Exception as sex:  # noqa: BLE001
                alog.warning("sup_accounts 旁路失败: %s", sex)
        elif atype == "vendor.upsert":
            desc = upsert_vendor(db_path, data, payload)
        else:
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
    # 立刻推快照，老板刷新即可看到库存/桌态变化
    push_snapshot_once(store_url, bff_url, token, db_path)
    return "executed", new_rev


# ---------- 主循环 ----------

def fetch_pending(bff_url, token):
    from urllib.parse import quote
    url = bff_url.rstrip("/") + "/api/actions?status=" + quote("待执行")
    status, resp = 0, {}
    for attempt in range(1, 5):
        status, resp = http_json("GET", url, token=token)
        if status != 429 and not (isinstance(status, int) and status >= 500):
            break
        retry_after = 1
        if isinstance(resp, dict):
            try:
                retry_after = max(1, int(resp.get("retry_after") or 1))
            except Exception:
                retry_after = 1
        log.warning("拉取动作第 %s/4 次 http=%s，%ss 后重试", attempt, status, retry_after)
        time.sleep(retry_after * attempt)
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
