#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 订单/ 目录下的配送单 Excel（.xlsx / 伪 .xls=HTML）导入为 DB.recv，
再按店内同口径 rebuildStock，写回 SQLite，供原生 App 快照消费。

对齐 HTML commitRecvImport + migrateV4 + rebuildStock：
  - 品名去 *；实收数量/单价写进货行；新原料 stock/avg=0 后由重放生成
  - 单号 JH + yyyymmdd + 序号；供应商默认海南菜篮子实业有限公司
  - 指纹去重（品名+数量+单价集合），已入库跳过；顺带去掉 recv 重复行
  - 跳过：采购单整理（已是 84 行基线）、施工备用金汇总（非配送）

用法:
  python3 import_orders_excel.py [--dir 订单] [--db data/餐厅系统.db] [--dry-run]
  python3 import_orders_excel.py --push   # 导入后推 BFF（需 BFF_TOKEN 或自动 login boss）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

BASE = Path(__file__).resolve().parent
DEFAULT_DIR = BASE / "订单"
DEFAULT_DB = BASE / "data" / "餐厅系统.db"

sys.path.insert(0, str(BASE / "server"))
from db import Store  # noqa: E402

SKIP_FILES = {
    "采购单整理_熊猫五福.xlsx",  # seed 基线（89 行含未收，库内已是实收 84）
    "采购物品与施工备用金汇总表0924.xlsx",  # 非配送进货
}
DEFAULT_SUPPLIER = "海南菜篮子实业有限公司"

HEADER_ALIASES = {
    "name": {"品名", "商品名称", "商品名", "原料", "原料名称", "名称", "物料"},
    "qty": {"数量", "实收数", "实收", "收货数", "下单数", "订购数"},
    "price": {"单价", "单价(元)", "单价（元）", "价格"},
    "unit": {"单位", "采购单位"},
}


def now_tag():
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def r2(x):
    return round(float(x or 0) + 1e-12, 2)


def r3(x):
    return round(float(x or 0) + 1e-12, 3)


def clean_name(s):
    return re.sub(r"^[\s\u3000*＊·・]+", "", str(s or "")).strip()


def today_str():
    return datetime.now().strftime("%Y-%m-%d")


# ---------------- xlsx / html-xls ----------------
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def _col_row(ref):
    m = re.match(r"([A-Z]+)(\d+)", ref or "")
    if not m:
        return 0, 0
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return col - 1, int(m.group(2)) - 1


def read_xlsx_rows(path: Path):
    with zipfile.ZipFile(path) as z:
        ss = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", NS):
                texts = [
                    t.text or ""
                    for t in si.iter(
                        "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"
                    )
                ]
                ss.append("".join(texts))
        sheet = sorted(
            n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)
        )[0]
        root = ET.fromstring(z.read(sheet))
        grid = {}
        maxr = maxc = 0
        for c in root.findall("m:sheetData/m:row/m:c", NS):
            ref = c.get("r")
            if not ref:
                continue
            ci, ri = _col_row(ref)
            t = c.get("t")
            if t == "inlineStr":
                val = "".join(
                    n.text or ""
                    for n in c.iter(
                        "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"
                    )
                )
            else:
                v = c.find("m:v", NS)
                if v is None or v.text is None:
                    val = ""
                elif t == "s":
                    val = ss[int(v.text)]
                else:
                    val = v.text
            grid[(ri, ci)] = val
            maxr = max(maxr, ri)
            maxc = max(maxc, ci)
        return [[grid.get((r, c), "") for c in range(maxc + 1)] for r in range(maxr + 1)]


class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self._row = None
        self._in_td = False
        self._buf = []
        self.texts = []

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._in_td = True
            self._buf = []
        elif tag == "p":
            self._buf = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None:
            self._row.append("".join(self._buf).strip())
            self._in_td = False
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None
        elif tag == "p":
            t = "".join(self._buf).strip()
            if t:
                self.texts.append(t)

    def handle_data(self, data):
        self._buf.append(data)


def read_html_xls_rows(path: Path):
    p = _TableParser()
    p.feed(path.read_text(encoding="utf-8", errors="ignore"))
    rows = [[t] for t in p.texts]
    rows.extend(p.rows)
    return rows


def find_header(row):
    cells = [str(c).strip() for c in row]
    joined = "|".join(cells)
    if "品名" not in joined:
        return None
    if "单价" not in joined and "数量" not in joined:
        return None
    mapping = {}
    for ci, c in enumerate(cells):
        for k, als in HEADER_ALIASES.items():
            if c in als and k not in mapping:
                mapping[k] = ci
    if "name" in mapping and "qty" in mapping and "price" in mapping:
        return mapping
    return None


def extract_meta(rows):
    blob = "\n".join(" ".join(str(c) for c in r) for r in rows)
    date = None
    m = re.search(r"配送时间[：:]\s*(\d{4}-\d{2}-\d{2})", blob)
    if m:
        date = m.group(1)
    if not date:
        m = re.search(r"(20\d{2}-\d{2}-\d{2})", blob)
        if m:
            date = m.group(1)
    order = None
    m = re.search(
        r"(?:订单号|单据编号|配送单号)[：:]\s*([A-Za-z0-9\-_]{6,40})", blob
    )
    if m:
        order = m.group(1)
    merchant = None
    m = re.search(r"(?:收货商户|收货客户)[：:]\s*([^\s　\xa0]+)", blob)
    if m:
        merchant = m.group(1)
    return date, order, merchant


def parse_docs_from_rows(rows, fname):
    docs = []
    i = 0
    while i < len(rows):
        hi = None
        mapping = None
        for j in range(i, len(rows)):
            m = find_header(rows[j])
            if m:
                hi = j
                mapping = m
                break
        if hi is None:
            break
        meta_rows = rows[max(0, hi - 5) : hi + 1]
        date, order, merchant = extract_meta(meta_rows)
        lines = []
        j = hi + 1
        while j < len(rows):
            if find_header(rows[j]) and j > hi:
                break
            r = rows[j]
            joined = "".join(str(c) for c in r)
            if re.search(
                r"人民币大写|收货人签章|第一张单合计|第二张单合计|配送单[二三四五]",
                joined,
            ):
                if lines:
                    j += 1
                    break
                j += 1
                continue
            if re.match(r"^合计", joined.strip()):
                j += 1
                break
            name = clean_name(r[mapping["name"]] if mapping["name"] < len(r) else "")
            if not name or name == "品名":
                j += 1
                continue
            try:
                qty = float(r[mapping["qty"]]) if mapping["qty"] < len(r) else None
            except (TypeError, ValueError):
                qty = None
            try:
                price = float(r[mapping["price"]]) if mapping["price"] < len(r) else None
            except (TypeError, ValueError):
                price = None
            unit = (
                str(r[mapping["unit"]]).strip()
                if "unit" in mapping and mapping["unit"] < len(r)
                else "斤"
            ) or "斤"
            if qty is None or price is None or qty <= 0:
                j += 1
                continue
            lines.append(
                {"name": name, "qty": qty, "price": price, "unit": unit}
            )
            j += 1
        if lines:
            if not date:
                m = re.search(r"0?9(\d{2})", fname)
                if m:
                    date = f"2026-09-{m.group(1)}"
            docs.append(
                {
                    "date": date or today_str(),
                    "order": order,
                    "merchant": merchant,
                    "lines": lines,
                    "file": fname,
                }
            )
        i = j if j > hi else hi + 1
    return docs


def load_all_docs(order_dir: Path):
    docs = []
    for p in sorted(order_dir.iterdir()):
        if p.name in SKIP_FILES or p.name.startswith("."):
            continue
        suf = p.suffix.lower()
        try:
            if suf == ".xlsx":
                rows = read_xlsx_rows(p)
            elif suf == ".xls":
                # 伪 HTML 或真二进制；本目录均为 HTML
                head = p.read_bytes()[:8]
                if head[:4] == b"\xd0\xcf\x11\xe0":
                    print(f"[skip] 真二进制 .xls 暂不支持: {p.name}")
                    continue
                rows = read_html_xls_rows(p)
            else:
                continue
        except Exception as exc:  # noqa: BLE001
            print(f"[err ] 解析失败 {p.name}: {exc}")
            continue
        parsed = parse_docs_from_rows(rows, p.name)
        print(f"[file] {p.name}: {len(parsed)} 张配送明细")
        docs.extend(parsed)
    return docs


# ---------------- fingerprint / rebuild ----------------
def line_fp(lines_named):
    """lines_named: iterable of (name, qty, price)"""
    items = tuple(
        sorted((clean_name(n), r3(q), r2(p)) for n, q, p in lines_named)
    )
    payable = r2(sum(q * p for _, q, p in items))
    return (len(items), payable, items)


def items_subset(small_items, big_items):
    """small 的每一行是否都能在 big 里找到同品名+数量+单价（多重集合）。"""
    from collections import Counter

    c = Counter(big_items)
    for it in small_items:
        if c[it] <= 0:
            return False
        c[it] -= 1
    return True


def recv_fp(recv, ing_by_id):
    named = []
    for l in recv.get("lines") or []:
        g = ing_by_id.get(l["ing"])
        named.append((g["name"] if g else l["ing"], l["qty"], l["price"]))
    return line_fp(named)


def dedupe_recv(recv_list, ing_by_id):
    """精确指纹去重；再按 (date, payable, 行数) 去掉 zip 带入的脏重复。"""
    seen_fp = set()
    seen_soft = set()
    out = []
    removed = 0
    for r in recv_list:
        fp = recv_fp(r, ing_by_id)
        soft = (r.get("date"), r2(r.get("payable")), len(r.get("lines") or []))
        if fp in seen_fp or soft in seen_soft:
            removed += 1
            continue
        seen_fp.add(fp)
        seen_soft.add(soft)
        out.append(r)
    return out, removed, seen_fp


def already_imported(fp, fps_seen, existing_items_list, soft_keys, soft_key):
    if soft_key in soft_keys:
        return True
    if fp in fps_seen:
        return True
    # 拆分明细：子集命中已有进货单也视为已导入
    for big in existing_items_list:
        if items_subset(fp[2], big):
            return True
    return False


def find_ing(db, name):
    name = clean_name(name)
    for g in db["ings"]:
        if g["name"] == name:
            return g
    # 宽松：去括号前缀【GY】等后再比
    bare = re.sub(r"^【[^】]+】", "", name).strip()
    if bare != name:
        for g in db["ings"]:
            if g["name"] == bare or re.sub(r"^【[^】]+】", "", g["name"]).strip() == bare:
                return g
    return None


def create_ing(db, name, unit):
    seq = int(db.get("seq") or 0) + 1
    db["seq"] = seq
    g = {
        "id": f"I{seq}",
        "name": clean_name(name),
        "cat": "其他",
        "unit": unit or "斤",
        "buy": unit or "斤",
        "conv": 1,
        "spec": "",
        "stock": 0,
        "avg": 0,
        "initStock": 0,
        "initAvg": 0,
        "initDate": today_str(),
        "last": None,
        "safe": 0,
        "yld": 1,
        "on": True,
        "_u": int(datetime.now().timestamp() * 1000),
    }
    db["ings"].append(g)
    return g


def mk_po_line(g, qty, price):
    conv = float(g.get("conv") or 1) or 1
    return {
        "ing": g["id"],
        "qty": qty,
        "price": price,
        "conv": conv,
        "amount": r2(qty * price),
        "unitCost": r3(price / conv),
    }


def mk_no(prefix, date, i):
    return f"{prefix}{date.replace('-', '')}-{i:02d}"


def next_uid(db, prefix):
    seq = int(db.get("seq") or 0) + 1
    db["seq"] = seq
    return f"{prefix}{seq}"


def rebuild_stock(db):
    """Python 端口：对齐 HTML rebuildStock（移动加权 + 生成 logs）。"""
    ing_map = {g["id"]: g for g in db["ings"]}
    moves = []
    for g in db["ings"]:
        g["stock"] = 0
        g["avg"] = 0
        if float(g.get("initStock") or 0) > 0:
            moves.append(
                {
                    "o": 0,
                    "type": "期初",
                    "gid": g["id"],
                    "date": g.get("initDate") or today_str(),
                    "qty": float(g["initStock"]),
                    "cost": float(g.get("initAvg") or 0),
                    "ref": "期初",
                }
            )
    for po in db.get("recv") or []:
        for l in po.get("lines") or []:
            moves.append(
                {
                    "o": 2,
                    "type": "采购入库",
                    "gid": l["ing"],
                    "date": po["date"],
                    "qty": float(l["qty"]) * float(l.get("conv") or 1),
                    "cost": float(l.get("unitCost") or 0),
                    "ref": po["no"],
                }
            )
    for l in db.get("logs") or []:
        if l.get("type") == "盘点调整":
            moves.append(
                {
                    "o": 3,
                    "type": "盘点调整",
                    "gid": l["ing"],
                    "date": l["date"],
                    "qty": float(l["qty"]),
                    "cost": 0,
                    "ref": l.get("ref"),
                    "adj": l,
                }
            )
        elif l.get("type") == "手工调整":
            moves.append(
                {
                    "o": 1,
                    "type": "手工调整",
                    "gid": l["ing"],
                    "date": l["date"],
                    "qty": float(l["qty"]),
                    "cost": float(l.get("inCost") or 0),
                    "ref": l.get("ref"),
                    "adj": l,
                }
            )
    for s in db.get("sales") or []:
        # 销售出库依赖配方；无配方则跳过（与空 sales 一致）
        pass

    moves.sort(key=lambda m: (m["date"], m["o"]))
    gen = []
    gen_seq = 1
    for mv in moves:
        g = ing_map.get(mv["gid"])
        if not g:
            continue
        if mv["type"] == "手工调整":
            g["stock"] = r3(mv["qty"])
            g["avg"] = float(mv["cost"] or 0)
        elif mv["qty"] > 0:
            val = g["stock"] * g["avg"] + mv["qty"] * mv["cost"]
            g["stock"] = r3(g["stock"] + mv["qty"])
            g["avg"] = r3(val / g["stock"]) if g["stock"] else float(mv["cost"] or 0)
        else:
            g["stock"] = r3(g["stock"] + mv["qty"])
        if mv.get("adj") is not None:
            mv["adj"]["bal"] = r3(g["stock"])
            mv["adj"]["cost"] = g["avg"]
            gen.append(mv["adj"])
        else:
            gen.append(
                {
                    "seq": gen_seq,
                    "t": mv["date"] + " 12:00",
                    "date": mv["date"],
                    "type": mv["type"],
                    "ing": mv["gid"],
                    "qty": r3(mv["qty"]),
                    "inCost": mv["cost"],
                    "cost": g["avg"],
                    "bal": r3(g["stock"]),
                    "ref": mv["ref"],
                }
            )
            gen_seq += 1
    gen.sort(key=lambda x: (x["date"], x.get("seq") or 0))
    db["logs"] = gen
    for g in db["ings"]:
        g["last"] = None
    for po in sorted(
        db.get("recv") or [],
        key=lambda p: (p["date"], p["no"]),
        reverse=True,
    ):
        for l in po.get("lines") or []:
            g = ing_map.get(l["ing"])
            if g is not None and g["last"] is None:
                g["last"] = l["price"]


def import_docs(db, docs, fps_seen, existing_items_list, soft_keys):
    new_recv = 0
    new_ing = 0
    skipped = 0
    for doc in docs:
        named = [(r["name"], r["qty"], r["price"]) for r in doc["lines"]]
        fp = line_fp(named)
        soft = (doc["date"], fp[1], fp[0])
        if already_imported(fp, fps_seen, existing_items_list, soft_keys, soft):
            skipped += 1
            print(
                f"  skip {doc['file']} {doc['date']} order={doc['order']} "
                f"lines={fp[0]} ¥{fp[1]} (已入库)"
            )
            continue
        date = doc["date"]
        lines = []
        for row in doc["lines"]:
            g = find_ing(db, row["name"])
            if not g:
                g = create_ing(db, row["name"], row["unit"])
                new_ing += 1
            lines.append(mk_po_line(g, row["qty"], row["price"]))
        if not lines:
            continue
        payable = r2(sum(l["amount"] for l in lines))
        same_day = sum(1 for r in db["recv"] if r.get("date") == date)
        note_parts = []
        if doc.get("order"):
            note_parts.append(f"配送单号 {doc['order']}")
        if doc.get("merchant"):
            note_parts.append(f"收货商户 {doc['merchant']}")
        note_parts.append(f"来源 {doc['file']}")
        n = {
            "id": next_uid(db, "R"),
            "no": mk_no("JH", date, same_day + 1),
            "date": date,
            "supplier": DEFAULT_SUPPLIER,
            "lines": lines,
            "payable": payable,
            "payments": [],
            "note": " · ".join(note_parts),
            "method": "现金/转账",
            "_u": int(datetime.now().timestamp() * 1000),
        }
        db["recv"].append(n)
        if DEFAULT_SUPPLIER not in db["suppliers"]:
            db["suppliers"].append(DEFAULT_SUPPLIER)
        fps_seen.add(fp)
        existing_items_list.append(fp[2])
        soft_keys.add(soft)
        new_recv += 1
        print(
            f"  + {n['no']} {date} lines={len(lines)} ¥{payable} "
            f"← {doc['file']} ({doc.get('merchant') or '-'})"
        )
    return new_recv, new_ing, skipped


def summarize(db):
    ings = db.get("ings") or []
    recv = db.get("recv") or []
    stock_n = sum(1 for i in ings if (i.get("stock") or 0) > 0)
    stock_amt = sum((i.get("stock") or 0) * (i.get("avg") or 0) for i in ings)
    payable = sum(r.get("payable") or 0 for r in recv)
    return (
        f"ings={len(ings)} stock>0={stock_n} stock¥={stock_amt:.2f} "
        f"recv={len(recv)} payable¥={payable:.2f} logs={len(db.get('logs') or [])}"
    )


def push_snapshot(token: str | None):
    if not token:
        req = urllib.request.Request(
            "http://127.0.0.1:8787/api/auth/login",
            data=json.dumps({"account": "boss", "device_fp": "excel-import"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            token = json.loads(resp.read().decode())["token"]
    cmd = [
        sys.executable,
        str(BASE / "snapshot_pusher.py"),
        "--once",
        "--token",
        token,
    ]
    import subprocess

    return subprocess.call(cmd)


def main(argv=None):
    ap = argparse.ArgumentParser(description="导入订单/配送单 Excel → DB.recv")
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--push", action="store_true", help="导入后推 BFF 快照")
    args = ap.parse_args(argv)

    if not args.dir.is_dir():
        raise SystemExit(f"找不到订单目录: {args.dir}")
    if not args.db.is_file():
        raise SystemExit(f"找不到库: {args.db}")

    docs = load_all_docs(args.dir)
    store = Store(str(args.db), backup_dir=str(args.db.parent / "backups"))
    meta = store.get()
    if meta["empty"]:
        raise SystemExit("目标库为空")
    db = json.loads(json.dumps(meta["data"], ensure_ascii=False))

    print("[before]", summarize(db))
    ing_by_id = {g["id"]: g for g in db["ings"]}
    db["recv"], removed, fps = dedupe_recv(db.get("recv") or [], ing_by_id)
    if removed:
        print(f"[dedupe] 去掉重复进货单 {removed} 张")
    existing_items = [fp[2] for fp in fps]
    soft_keys = {
        (r.get("date"), r2(r.get("payable")), len(r.get("lines") or []))
        for r in db["recv"]
    }

    new_recv, new_ing, skipped = import_docs(
        db, docs, fps, existing_items, soft_keys
    )
    rebuild_stock(db)
    print("[after ]", summarize(db))
    print(f"[stat ] new_recv={new_recv} new_ing={new_ing} skipped={skipped}")

    if args.dry_run:
        print("dry-run：未写库")
        return 0

    bak = args.db.parent / "backups" / f"餐厅系统_{now_tag()}_pre_excel_import.db"
    bak.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.db, bak)
    print("[bak  ]", bak)

    info = store.put(
        rev=meta["rev"],
        data=db,
        machine="EXCEL-IMPORT",
        note=f"import_orders_excel: +{new_recv} recv, +{new_ing} ings",
    )
    print("[ok   ] wrote rev=%s" % info["rev"])

    if args.push:
        rc = push_snapshot(os.environ.get("BFF_TOKEN"))
        print("[push ] rc=%s" % rc)
        return rc
    return 0


if __name__ == "__main__":
    sys.exit(main())
