#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全新餐厅开业引导：组织建店 + 开账号 + 灌最小主数据 + 推快照。

用法:
  python3 scripts/bootstrap_new_restaurant.py
  python3 scripts/bootstrap_new_restaurant.py --name '熊猫五福·江东新店'
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BFF = os.environ.get("BFF_URL", "http://127.0.0.1:8787")
STORE = os.environ.get("STORE_URL", "http://127.0.0.1:8765")


def http(method, url, payload=None, token=None, timeout=30):
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
            parsed = {"raw": raw[:300].decode("utf-8", "replace")}
        return exc.code, parsed


def login(account="boss", password="wufu123"):
    st, resp = http(
        "POST",
        BFF + "/api/auth/login",
        {"account": account, "password": password, "device_fp": "bootstrap-new"},
    )
    if st != 200 or not resp.get("token"):
        raise SystemExit(f"login failed: {st} {resp}")
    return resp["token"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default=None)
    ap.add_argument("--city", default="海口")
    ap.add_argument("--account", default=None, help="新店老板账号")
    args = ap.parse_args()

    stamp = datetime.now().strftime("%m%d%H%M")
    store_name = args.name or f"熊猫五福·新开业店{stamp}"
    boss_acc = args.account or f"newboss{stamp}"
    cashier_acc = f"cash{stamp}"
    kitchen_acc = f"kit{stamp}"

    print("==> 1) 登录总部老板")
    token = login()
    print("  token ok")

    print("==> 2) 筹备新门店")
    st, resp = http(
        "POST",
        BFF + "/api/org/stores",
        {
            "name": store_name,
            "brand": "熊猫五福",
            "city": args.city,
            "address": f"{args.city}新开业测试点",
            "status": "筹备中",
        },
        token=token,
    )
    print("  ", st, resp.get("ok"), resp.get("store", {}).get("id"), resp.get("error"))
    if not resp.get("ok"):
        raise SystemExit("create store failed")
    store = resp["store"]
    store_id = store["id"]

    print("==> 3) 开岗位账号")
    users = []
    for acc, name, pos in [
        (boss_acc, "新店老板", "pos_boss"),
        (cashier_acc, "新店收银", "pos_cashier"),
        (kitchen_acc, "新店后厨", "pos_kitchen"),
    ]:
        st, r = http(
            "POST",
            BFF + "/api/org/users",
            {
                "account": acc,
                "password": "wufu123",
                "display_name": name,
                "position_id": pos,
                "store_id": store_id,
            },
            token=token,
        )
        print(f"  {acc}: ok={r.get('ok')} err={r.get('error')}")
        if r.get("ok"):
            users.append(acc)

    print("==> 4) 校验新账号可登录")
    st, me = http(
        "POST",
        BFF + "/api/auth/login",
        {"account": boss_acc, "password": "wufu123", "device_fp": "new-boss"},
    )
    print(f"  login {boss_acc}: ok={me.get('ok')} store={me.get('storeName')} role={me.get('role')}")
    new_token = me.get("token") or token

    print("==> 5) 补齐店内主数据（若缺桌台/模块）")
    # seed 脚本是幂等 INSERT OR REPLACE
    for script in ("seed_modules.py", "seed_master_data.py", "seed_recipes.py"):
        path = os.path.join(ROOT, "store-inventory", script)
        if os.path.exists(path):
            rc = os.system(f"cd '{ROOT}/store-inventory' && python3 '{script}' >/tmp/seed_{script}.log 2>&1")
            print(f"  {script}: exit={rc}")

    print("==> 6) 推送快照")
    env = os.environ.copy()
    env["BFF_TOKEN"] = new_token if False else token  # pusher 用总部 token 即可
    rc = os.system(
        f"cd '{ROOT}' && BFF_TOKEN='{token}' python3 store-inventory/snapshot_pusher.py --once --token '{token}' | tail -5"
    )

    out = {
        "ok": True,
        "store": store,
        "accounts": {
            "boss": boss_acc,
            "cashier": cashier_acc,
            "kitchen": kitchen_acc,
            "password": "wufu123",
        },
        "bff": BFF,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    out_path = os.path.join(ROOT, "scripts", ".last_new_restaurant.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("==> 完成")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"写入 {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
