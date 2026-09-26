#!/usr/bin/env python3
"""按饺子店真实日耗固化原料安全线（对齐《熊猫五福App原型》量级）。

口径（单店 · 日售约 150–160 份五色饺）：
  - 火龙果汁：现 0.44kg / 安全 2kg · 告急（红饺色源）
  - 墨鱼汁：现约够 1 天 · 告急（黑饺色源）
  - 面粉：25kg/袋，日耗约 0.5 袋
  - 猪肉前肩：日耗约 6 斤；蛋约 1.2 板/日
  - 非主链：灌到安全线以上，避免假告急刷屏

优先走店内 /api/sync（与常驻 store 一致）；失败回退写 sqlite。

用法：
  python3 store-inventory/seed_safety_runthrough.py
  TOKEN=... python3 store-inventory/snapshot_pusher.py --once --token \"$TOKEN\"
"""
from __future__ import annotations

import json
import sqlite3
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "store-inventory" / "data" / "餐厅系统.db"
STORE_URL = "http://127.0.0.1:8765"

RULES = [
    ("exact", "火龙果汁", 0.44, 2.0, 0.22, "kg"),
    ("contains", "墨鱼汁", 0.35, 2.0, 0.25, "瓶"),
    ("contains", "紫薯粉", 0.8, 2.5, 0.35, "瓶"),
    ("contains", "菠菜", 2.5, 4.0, 1.5, "斤"),
    ("contains", "南瓜", 3.5, 6.0, 2.0, "斤"),
    ("contains", "雪花面粉", 3.0, 6.0, 0.5, "袋"),
    ("contains", "雪花粉", 3.0, 6.0, 0.5, "袋"),
    ("exact", "黑猪前肩肉", 8.0, 15.0, 6.0, "斤"),
    ("exact", "黑猪前腿", 5.0, 10.0, 3.0, "斤"),
    ("exact", "黑猪五花肉", 12.0, 20.0, 5.0, "斤"),
    ("exact", "大白菜", 6.0, 12.0, 4.0, "斤"),
    ("exact", "圆白菜", 4.0, 8.0, 2.5, "斤"),
    ("exact", "【GY】红洋葱", 3.0, 6.0, 2.0, "斤"),
    ("exact", "【GV】红洋葱", 3.0, 6.0, 2.0, "斤"),
    ("contains", "鸡蛋30枚", 4.0, 8.0, 1.2, "板"),
    ("contains", "芝麻香油", 1.5, 3.0, 0.4, "瓶"),
    ("contains", "雪天精制盐", 20.0, 30.0, 1.5, "包"),
    ("contains", "虾仁", 4.0, 8.0, 2.5, "斤"),
]


def _apply_rule(ing: dict, qty: float, safe: float, est: float, unit: str | None, now: str) -> None:
    ing["qty"] = qty
    ing["stock"] = qty
    ing["safe"] = safe
    ing["safety"] = safe
    ing["est"] = est
    if unit:
        ing["unit"] = unit
    ing["_u"] = now


def _ensure_dragonfruit(ings: list, now: str) -> bool:
    for ing in ings:
        if "火龙" in str(ing.get("name") or ""):
            return False
    ings.append({
        "id": "I-HLG",
        "name": "火龙果汁",
        "unit": "kg",
        "qty": 0.44,
        "stock": 0.44,
        "safe": 2.0,
        "safety": 2.0,
        "est": 0.22,
        "cat": "色源",
        "note": "红饺面皮色源 · seed_safety",
        "_u": now,
    })
    return True


def _mutate(ings: list, now: str) -> tuple[int, int, bool]:
    added = _ensure_dragonfruit(ings, now)
    touched = 1 if added else 0
    hit_ids: set[str] = set()
    for match, key, qty, safe, est, unit in RULES:
        for ing in ings:
            name = str(ing.get("name") or "")
            iid = str(ing.get("id") or "")
            if iid in hit_ids:
                continue
            ok = (name == key) if match == "exact" else (key in name)
            if not ok:
                continue
            _apply_rule(ing, qty, safe, est, unit, now)
            hit_ids.add(iid)
            touched += 1
    for ing in ings:
        iid = str(ing.get("id") or "")
        if iid in hit_ids:
            continue
        q = float(ing.get("qty") if ing.get("qty") is not None else ing.get("stock") or 0)
        safe = float(ing.get("safe") or ing.get("safety") or 0)
        if safe <= 0:
            unit = str(ing.get("unit") or "")
            if unit in ("袋", "箱", "件"):
                safe = max(q, 2.0)
            elif unit == "板":
                safe = max(q, 4.0)
            else:
                safe = 1.0 if q <= 0 else max(q * 1.2, 1.0)
            ing["safe"] = round(safe, 2)
            ing["safety"] = round(safe, 2)
            ing["est"] = round(safe / 4, 2)
        fill = float(ing["safe"]) * 1.25
        ing["qty"] = round(fill, 2)
        ing["stock"] = round(fill, 2)
        ing["_u"] = now
        touched += 1
    return touched, len(hit_ids), added


def _via_store() -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(STORE_URL.rstrip("/") + "/api/db", timeout=8) as resp:
            doc = json.loads(resp.read().decode())
        data = doc.get("data") if isinstance(doc.get("data"), dict) else {}
        ings = list(data.get("ings") or [])
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        touched, rules, added = _mutate(ings, now)
        data["ings"] = ings
        body = json.dumps(
            {"baseRev": doc.get("rev"), "data": data, "machine": "SEED_SAFETY"},
            ensure_ascii=False,
        ).encode("utf-8")
        req = urllib.request.Request(
            STORE_URL.rstrip("/") + "/api/sync",
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            out = json.loads(resp.read().decode())
        if not out.get("ok"):
            return False, str(out)
        return True, f"store rev={out.get('rev')} touched={touched} rules={rules} hlg={added}"
    except Exception as e:
        return False, str(e)


def _via_sqlite() -> str:
    conn = sqlite3.connect(str(DB))
    row = conn.execute("SELECT data FROM docs WHERE id=1").fetchone()
    if not row:
        raise SystemExit("docs 空")
    data = json.loads(row[0])
    ings = data.get("ings") or []
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    touched, rules, added = _mutate(ings, now)
    data["ings"] = ings
    conn.execute("UPDATE docs SET data=? WHERE id=1", (json.dumps(data, ensure_ascii=False),))
    try:
        conn.execute("UPDATE snapshot_rev SET rev = rev + 1")
    except sqlite3.Error:
        pass
    conn.commit()
    conn.close()
    return f"sqlite touched={touched} rules={rules} hlg={added}"


def main() -> None:
    ok, msg = _via_store()
    if ok:
        print("ok", msg)
        return
    print("store sync miss:", msg, "→ sqlite fallback")
    print("ok", _via_sqlite())


if __name__ == "__main__":
    main()
