#!/usr/bin/env python3
"""灌齐主数据：销售流水 / 会员 / 外卖 / 桌台 / 口碑 → sqlite + 店内 JSON data.sales/pos"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import urllib.request
from datetime import datetime, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(BASE, "data", "餐厅系统.db")
STORE_URL = os.environ.get("STORE_URL", "http://127.0.0.1:8765")


def today(offset=0):
    return (datetime.now() + timedelta(days=offset)).strftime("%Y-%m-%d")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def http_json(method, url, payload=None):
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        return resp.status, json.loads(raw.decode("utf-8")) if raw else {}


def seed_sqlite(db_path):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    # 桌台：午峰约 5/8 占用（对齐原型首页）
    tables = [
        ("T1", "1号桌", 4, "就餐"),
        ("T2", "2号桌", 4, "就餐"),
        ("T3", "3号桌", 6, "就餐"),
        ("T4", "4号桌", 4, "待清"),
        ("T5", "5号桌", 8, "预订"),
        ("T6", "6号桌", 4, "就餐"),
        ("T7", "包厢A", 10, "空闲"),
        ("T8", "包厢B", 12, "空闲"),
    ]
    for tid, name, cap, st in tables:
        cur.execute(
            "INSERT OR REPLACE INTO pos_tables (table_id, name, capacity, status) VALUES (?,?,?,?)",
            (tid, name, cap, st),
        )

    # 会员
    members = [
        ("M1001", "王女士", "13800001111", "金卡", today(-120)),
        ("M1002", "李先生", "13800002222", "银卡", today(-60)),
        ("M1003", "赵小姐", "13800003333", "普通", today(-10)),
    ]
    for mid, name, phone, level, joined in members:
        cur.execute(
            "INSERT OR REPLACE INTO vip_members (member_id, name, phone, level, joined_at, status) VALUES (?,?,?,?,?,?)",
            (mid, name, phone, level, joined, "正常"),
        )
        cur.execute(
            "INSERT OR REPLACE INTO vip_balance (member_id, balance, updated_at) VALUES (?,?,?)",
            (mid, 200 if level == "金卡" else 80, now_iso()),
        )

    # 外卖：清掉旧演示单后重种（今日午晚高峰若干单）
    cur.execute("DELETE FROM takeout_orders")
    takeout = [
        ("美团", "美1001", 88, 10, 78, "配送中"),
        ("美团", "美1002", 64, 8, 56, "已完成"),
        ("饿了么", "饿2001", 72, 9, 63, "已完成"),
        ("美团", "美1003", 96, 12, 84, "制作中"),
        ("饿了么", "饿2002", 58, 7, 51, "已完成"),
        ("美团", "美1004", 120, 14, 106, "待接单"),
    ]
    for plat, no, amt, comm, settle, st in takeout:
        cur.execute(
            "INSERT INTO takeout_orders (platform, platform_no, ts, amount, commission, settle, status)"
            " VALUES (?,?,?,?,?,?,?)",
            (plat, no, now_iso(), amt, comm, settle, st),
        )
    cur.execute(
        "INSERT INTO takeout_reconcile (platform, period, expect_amt, actual_amt, diff, status) VALUES (?,?,?,?,?,?)",
        ("美团", today()[:7], 1200, 1180, -20, "待核对"),
    )

    # 口碑
    reviews = [
        ("堂食", 5.0, "饺子很好吃，五福饺子推荐", 0),
        ("美团", 2.0, "等太久了，汤洒了", 0),
        ("大众点评", 4.5, "环境干净，服务不错", 1),
    ]
    for src, rating, content, handled in reviews:
        cur.execute(
            "INSERT INTO rv_reviews (source, rating, content, ts, handled) VALUES (?,?,?,?,?)",
            (src, rating, content, now_iso(), handled),
        )

    conn.commit()
    conn.close()
    print("sqlite seeded: pos_tables/vip/takeout/reviews")


def seed_store_json(store_url):
    status, doc = http_json("GET", store_url.rstrip("/") + "/api/db")
    if status != 200 or not doc.get("ok"):
        raise RuntimeError("store /api/db failed: %s %s" % (status, doc))
    base_rev = doc.get("rev")
    data = doc.get("data") if isinstance(doc.get("data"), dict) else {}

    data["pos"] = [
        {"id": "T1", "no": "1", "state": "busy", "seats": 4, "name": "1号桌", "zone": "大厅"},
        {"id": "T2", "no": "2", "state": "busy", "seats": 4, "name": "2号桌", "zone": "大厅"},
        {"id": "T3", "no": "3", "state": "busy", "seats": 6, "name": "3号桌", "zone": "大厅"},
        {"id": "T4", "no": "4", "state": "clean", "seats": 4, "name": "4号桌", "zone": "大厅"},
        {"id": "T5", "no": "5", "state": "rsv", "seats": 8, "name": "5号桌", "zone": "大厅"},
        {"id": "T6", "no": "6", "state": "busy", "seats": 4, "name": "6号桌", "zone": "大厅"},
        {"id": "T7", "no": "A", "state": "free", "seats": 10, "name": "包厢A", "zone": "包间"},
        {"id": "T8", "no": "B", "state": "free", "seats": 12, "name": "包厢B", "zone": "包间"},
    ]

    # 近 14 天销售：五色饺品名对齐原型日销量级（长寿≈78 / 三鲜≈62 / 富贵≈45 / 玉米≈51 / 好德≈41）
    # 单价取堂食常见价；外卖约占 18–22%
    dishes = [
        ("长寿饺", 32),   # 红
        ("三鲜饺", 36),   # 黑
        ("富贵饺", 30),   # 黄
        ("玉米饺", 30),   # 绿
        ("好德饺", 30),   # 紫
    ]
    # 今日目标份数（再按小时拆）
    day_targets = {
        "长寿饺": 78,
        "三鲜饺": 62,
        "富贵饺": 45,
        "玉米饺": 51,
        "好德饺": 41,
    }
    hour_share = {11: 0.18, 12: 0.28, 13: 0.14, 17: 0.12, 18: 0.18, 19: 0.10}
    sales = []
    for d in range(13, -1, -1):
        day = today(-d)
        # 周末略高、工作日略低
        wd = datetime.strptime(day, "%Y-%m-%d").weekday()
        factor = 1.12 if wd >= 5 else (0.92 if wd in (0, 1) else 1.0)
        for name, price in dishes:
            base = day_targets[name]
            # 历史日在目标附近抖动
            jitter = 1 + (((d * 3 + len(name)) % 9) - 4) * 0.03
            day_qty = max(8, int(round(base * factor * jitter)))
            remain = day_qty
            hours = list(hour_share.keys())
            for idx, h in enumerate(hours):
                if idx == len(hours) - 1:
                    qty = remain
                else:
                    qty = max(1, int(round(day_qty * hour_share[h])))
                    remain -= qty
                if qty <= 0:
                    continue
                # 午晚高峰一部分记外卖
                channel = "堂食"
                if h in (12, 18) and (d + h + len(name)) % 5 == 0:
                    channel = "美团" if h == 12 else "饿了么"
                sales.append({
                    "id": f"S{day.replace('-', '')}{h}{name[:1]}",
                    "date": day,
                    "hour": h,
                    "dish": name,
                    "qty": qty,
                    "amount": qty * price,
                    "channel": channel,
                    "color": {"长寿饺": "红", "三鲜饺": "黑", "富贵饺": "黄", "玉米饺": "绿", "好德饺": "紫"}[name],
                })
    data["sales"] = sales

    # platforms 摘要（约等于近两周外卖合计量级）
    data["platforms"] = [
        {"name": "美团", "orders": 48, "amount": 3120, "rating": 4.6},
        {"name": "饿了么", "orders": 31, "amount": 2050, "rating": 4.4},
    ]

    status, resp = http_json(
        "POST",
        store_url.rstrip("/") + "/api/sync",
        {"baseRev": base_rev, "data": data, "machine": "SEED"},
    )
    ok = status == 200 and resp.get("ok") and resp.get("action") != "need-manual"
    if not ok:
        raise RuntimeError("sync failed: %s %s" % (status, {k: v for k, v in resp.items() if k != "data"}))
    print("store json seeded: pos=%d sales=%d rev=%s" % (len(data["pos"]), len(sales), resp.get("rev")))
    return resp.get("rev")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--store-url", default=STORE_URL)
    ap.add_argument("--skip-store", action="store_true")
    args = ap.parse_args()
    seed_sqlite(args.db)
    if not args.skip_store:
        seed_store_json(args.store_url)


if __name__ == "__main__":
    main()
