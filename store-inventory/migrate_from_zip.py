#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「餐厅系统.zip」里的真实进销存库灌入本仓 store-inventory，供原生 App / BFF 快照消费。

规则（对齐 migrateV4）：
  - zip.v3 的 DB.pos（实收配送单）→ DB.recv，单号 CG→JH
  - 保留 zip 的 logs / ings.stock|avg|last / quotes / suppliers / platforms / sales
  - 保留本仓 v4 扩展：orders / plans / restock / dishAlias / config
  - 不碰 recipes 等 ext 增量表（只改 docs JSON）
  - 禁止写入虚构演示数据

用法:
  python3 migrate_from_zip.py [--zip PATH] [--db PATH] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ZIP = os.path.join(os.path.dirname(BASE), "餐厅系统.zip")
DEFAULT_DB = os.path.join(BASE, "data", "餐厅系统.db")
ZIP_DB_MEMBER = "餐厅系统/data/餐厅系统.db"

sys.path.insert(0, os.path.join(BASE, "server"))
from db import Store  # noqa: E402


def now_tag():
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def load_doc(db_path: str) -> dict:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT data FROM docs WHERE id=1").fetchone()
        if not row:
            raise SystemExit(f"空库: {db_path}")
        return json.loads(row[0])
    finally:
        conn.close()


def extract_zip_db(zip_path: str, dest_dir: str) -> str:
    out = os.path.join(dest_dir, "餐厅系统.db")
    with zipfile.ZipFile(zip_path) as zf:
        try:
            with zf.open(ZIP_DB_MEMBER) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
        except KeyError as exc:
            raise SystemExit(f"zip 内找不到 {ZIP_DB_MEMBER}") from exc
    return out


def restock_def():
    return {"days": 30, "lead": 1, "gap": 1, "useOnway": 1}


def migrate_v4_from_zip(zip_data: dict) -> dict:
    """对 zip 文档做 v3→v4 字段迁移，返回可合并进当前库的业务块。"""
    data = json.loads(json.dumps(zip_data, ensure_ascii=False))  # deep copy
    if data.get("pos") and not data.get("recv"):
        data["recv"] = data["pos"]
        del data["pos"]
    if not isinstance(data.get("recv"), list):
        data["recv"] = []
    if not isinstance(data.get("orders"), list):
        data["orders"] = []
    for r in data["recv"]:
        no = r.get("no") or ""
        if no.startswith("CG"):
            r["no"] = "JH" + no[2:]
    data["v"] = max(int(data.get("v") or 0), 4)
    data.pop("pos", None)
    return data


def merge(current: dict, migrated: dict) -> dict:
    """以当前库为壳，用 zip 真实经营数据覆盖库存相关集合。"""
    out = json.loads(json.dumps(current, ensure_ascii=False))

    # 真实经营数据：优先 zip（已迁 v4）
    for key in ("ings", "dishes", "recv", "logs", "quotes", "suppliers",
                "platforms", "sales", "seq", "rest"):
        if key in migrated:
            out[key] = migrated[key]

    # v4 壳字段：本仓已有则保留，缺则补齐
    if not isinstance(out.get("orders"), list):
        out["orders"] = migrated.get("orders") or []
    if not isinstance(out.get("plans"), list):
        out["plans"] = []
    if not out.get("dishAlias") or not isinstance(out["dishAlias"], dict):
        out["dishAlias"] = {}
    if not out.get("restock") or not isinstance(out["restock"], dict):
        out["restock"] = restock_def()
    if not out.get("config") or not isinstance(out["config"], dict):
        out["config"] = current.get("config") or {}

    out["pos"] = []  # v4 后空置，避免双源
    out["v"] = 4
    out["_recU"] = out.get("_recU") if isinstance(out.get("_recU"), dict) else {}
    return out


def summarize(data: dict) -> str:
    ings = data.get("ings") or []
    stock_n = sum(1 for i in ings if (i.get("stock") or 0) > 0)
    stock_amt = sum((i.get("stock") or 0) * (i.get("avg") or 0) for i in ings)
    recv = data.get("recv") or []
    payable = sum(r.get("payable") or 0 for r in recv)
    return (
        f"ings={len(ings)} stock>0={stock_n} stock¥={stock_amt:.2f} "
        f"recv={len(recv)} payable¥={payable:.2f} logs={len(data.get('logs') or [])} "
        f"quotes={len(data.get('quotes') or [])} dishes={len(data.get('dishes') or [])} "
        f"seq={data.get('seq')} v={data.get('v')}"
    )


def main(argv=None):
    ap = argparse.ArgumentParser(description="从餐厅系统.zip 迁移真实数据到 store-inventory")
    ap.add_argument("--zip", default=DEFAULT_ZIP, help="餐厅系统.zip 路径")
    ap.add_argument("--db", default=DEFAULT_DB, help="目标 SQLite 路径")
    ap.add_argument("--dry-run", action="store_true", help="只打印差异，不写库")
    args = ap.parse_args(argv)

    if not os.path.isfile(args.zip):
        raise SystemExit(f"找不到 zip: {args.zip}")
    if not os.path.isfile(args.db):
        raise SystemExit(f"找不到目标库: {args.db}")

    with tempfile.TemporaryDirectory(prefix="canteen_zip_") as tmp:
        zip_db = extract_zip_db(args.zip, tmp)
        zip_raw = load_doc(zip_db)
        cur = load_doc(args.db)

        print("[zip ]", summarize(zip_raw), f"pos={len(zip_raw.get('pos') or [])}")
        print("[cur ]", summarize(cur), f"recv={len(cur.get('recv') or [])}")

        migrated = migrate_v4_from_zip(zip_raw)
        merged = merge(cur, migrated)
        print("[merge]", summarize(merged))

        if args.dry_run:
            print("dry-run：未写库")
            return 0

        # 冷备份
        bak_dir = os.path.join(os.path.dirname(args.db), "backups")
        os.makedirs(bak_dir, exist_ok=True)
        bak = os.path.join(bak_dir, f"餐厅系统_{now_tag()}_pre_zip_migrate.db")
        shutil.copy2(args.db, bak)
        print("[bak ]", bak)

        store = Store(args.db, backup_dir=bak_dir)
        cur_meta = store.get()
        new_rev_info = store.put(
            rev=cur_meta["rev"],
            data=merged,
            machine="ZIP-MIGRATE",
            note="migrate_from_zip: pos→recv + logs/stock from 餐厅系统.zip",
            force=False,
        )
        print("[ok  ] wrote rev=%s %s" % (new_rev_info["rev"], summarize(merged)))
        return 0


if __name__ == "__main__":
    sys.exit(main())
