#!/usr/bin/env python3
"""今日后厨工单：按金丰一批≈67 个、午市备货节奏重种（幂等清 demo 日单）。

对齐单店日售 ~150 份：红 70 / 黑 60 / 黄 50 / 绿 45 / 白西葫芦 40
状态：早市已完成一批红、一批黑制作中、其余待开始；剔除非法 SKU WF-01。
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "store-inventory" / "data" / "餐厅系统.db"

# (sku_id, qty, planned_start_hhmm, status)
TODAY_PLAN = [
    ("SKU-WF-HONG", 70, "08:30", "已完成"),
    ("SKU-WF-HEI", 60, "09:30", "制作中"),
    ("SKU-WF-HUANG", 50, "10:30", "待开始"),
    ("SKU-WF-LV", 45, "11:00", "待开始"),
    ("SKU-WF-BAI-XIHULU", 40, "14:00", "待开始"),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DB))
    args = ap.parse_args()
    today = datetime.now().strftime("%Y-%m-%d")
    conn = sqlite3.connect(args.db)
    # 清掉今日全部 + 历史非法 SKU
    conn.execute("DELETE FROM sop_workorders WHERE date=? OR sku_id LIKE 'WF-%'", (today,))
    for sku, qty, hhmm, status in TODAY_PLAN:
        conn.execute(
            "INSERT INTO sop_workorders (date, sku_id, qty, planned_start, status, qc_records)"
            " VALUES (?,?,?,?,?,?)",
            (today, sku, qty, f"{today}T{hhmm}", status, "[]"),
        )
    conn.commit()
    rows = list(conn.execute(
        "SELECT id, sku_id, qty, status, planned_start FROM sop_workorders WHERE date=? ORDER BY planned_start",
        (today,),
    ))
    conn.close()
    print(json.dumps({"ok": True, "date": today, "workorders": rows}, ensure_ascii=False))


if __name__ == "__main__":
    main()
