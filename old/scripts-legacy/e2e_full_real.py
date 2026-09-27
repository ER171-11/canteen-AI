#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全量真实写回验收：新店老板日课（API + 消费器）。

覆盖：补货→入库→报损→工单→品控→开台结账→预订→留样→消毒→审批状态。
输出 JSON 报告到 scripts/.last_e2e_report.json
"""
from __future__ import annotations

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


def http(method, url, payload=None, token=None, timeout=45):
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
    except Exception as exc:
        return 0, {"error": str(exc)}


def login(account, password="wufu123"):
    st, resp = http(
        "POST",
        BFF + "/api/auth/login",
        {"account": account, "password": password, "device_fp": "e2e-full"},
    )
    if not resp.get("token"):
        raise RuntimeError(f"login {account}: {resp}")
    return resp["token"], resp


def snap_rev(token):
    st, s = http("GET", BFF + "/api/snapshot/latest", token=token)
    return s.get("rev"), s


def store_db():
    st, doc = http("GET", STORE + "/api/db")
    return doc


def wait_executed(token, aid, timeout=40):
    t0 = time.time()
    last = {}
    while time.time() - t0 < timeout:
        st, last = http("GET", f"{BFF}/api/actions/{aid}/status", token=token)
        if last.get("status") in ("已执行", "已驳回", "已过期"):
            return last
        # 主动踢一脚 consumer
        if int(time.time() - t0) % 8 == 0:
            os.system(
                f"cd '{ROOT}' && BFF_TOKEN='{token}' node bff/store-node/consumer.js --once --token '{token}' >/tmp/e2e_consumer.log 2>&1"
            )
        time.sleep(1)
    return last


def propose_confirm(token, typ, payload, operator="boss"):
    rev, _ = snap_rev(token)
    enq = None
    for attempt in range(8):
        st, enq = http(
            "POST",
            BFF + "/api/actions",
            {"type": typ, "payload": payload, "operator": operator},
            token=token,
        )
        if enq.get("ok"):
            break
        if enq.get("error") == "rate limited":
            time.sleep(float(enq.get("retry_after") or 1) + 0.4)
            continue
        return {"step": typ, "ok": False, "phase": "enqueue", "resp": enq}
    if not enq or not enq.get("ok"):
        return {"step": typ, "ok": False, "phase": "enqueue", "resp": enq}
    aid = enq["id"]
    crev = enq.get("rev") if enq.get("rev") is not None else rev
    conf = None
    for attempt in range(8):
        # 每次确认前刷新快照 rev，避免并行推送导致 mismatch
        live_rev, _ = snap_rev(token)
        use_rev = live_rev if live_rev is not None else crev
        st, conf = http(
            "POST",
            f"{BFF}/api/actions/{aid}/confirm",
            {"operator": operator, "rev": use_rev},
            token=token,
        )
        if conf.get("ok"):
            break
        err = conf.get("error") or ""
        if err == "rate limited":
            time.sleep(float(conf.get("retry_after") or 1) + 0.4)
            continue
        if err == "rev mismatch":
            # 用服务端期望 rev 再试
            crev = conf.get("expected_rev", use_rev)
            time.sleep(0.35)
            continue
        return {"step": typ, "ok": False, "phase": "confirm", "id": aid, "resp": conf}
    if not conf or not conf.get("ok"):
        return {"step": typ, "ok": False, "phase": "confirm", "id": aid, "resp": conf}
    final = wait_executed(token, aid)
    return {
        "step": typ,
        "ok": final.get("status") == "已执行",
        "id": aid,
        "status": final.get("status"),
        "error": final.get("error"),
        "phase": "execute",
    }


def main():
    meta_path = os.path.join(ROOT, "scripts", ".last_new_restaurant.json")
    account = "boss"
    if os.path.exists(meta_path):
        meta = json.load(open(meta_path, encoding="utf-8"))
        account = meta.get("accounts", {}).get("boss") or "boss"

    print(f"==> 登录 {account}")
    token, info = login(account)
    results = []
    report = {
        "account": account,
        "store": info.get("storeName"),
        "started": datetime.now().isoformat(timespec="seconds"),
        "steps": results,
    }

    db0 = store_db()
    ings = (db0.get("data") or {}).get("ings") or []
    if not ings:
        results.append({"step": "precheck.ings", "ok": False, "error": "店内无原料"})
    else:
        ing = ings[0]
        gid = ing.get("id")
        gname = ing.get("name")
        qty0 = float(ing.get("qty") or ing.get("stock") or 0)
        results.append({"step": "precheck.ings", "ok": True, "sample": gname, "qty": qty0})

        # 1 补货
        r = propose_confirm(
            token,
            "restock.create",
            {
                "supplier": "全量验收供应商",
                "items": [{"ing_id": gid, "name": gname, "qty": 1.5, "unit": ing.get("unit") or "份", "price": 8}],
            },
            operator=account,
        )
        results.append(r)
        print(" restock", r)

        # 找 PO
        db1 = store_db()
        orders = (db1.get("data") or {}).get("orders") or []
        po = None
        for o in reversed(orders):
            if "全量验收" in str(o.get("supplier") or "") or "云端补货" in str(o.get("note") or ""):
                po = o
                break
        if not po and orders:
            po = orders[-1]
        if not po:
            results.append({"step": "find_po", "ok": False})
        else:
            results.append({"step": "find_po", "ok": True, "id": po.get("id"), "no": po.get("no")})
            # 2 入库
            r2 = propose_confirm(
                token, "recv.inbound", {"order_id": po.get("id")}, operator=account
            )
            results.append(r2)
            print(" inbound", r2)
            db2 = store_db()
            ings2 = {str(x.get("id")): x for x in ((db2.get("data") or {}).get("ings") or [])}
            g2 = ings2.get(str(gid)) or {}
            qty1 = float(g2.get("qty") or g2.get("stock") or 0)
            results.append(
                {
                    "step": "stock_delta",
                    "ok": qty1 > qty0 + 0.5,
                    "qty_before": qty0,
                    "qty_after": qty1,
                    "delta": round(qty1 - qty0, 3),
                }
            )
            print(" stock", qty0, "->", qty1)

            # 3 报损（小量）
            r3 = propose_confirm(
                token,
                "loss.report",
                {"ing_id": gid, "name": gname, "qty": 0.1, "amount": 1, "reason": "全量验收报损"},
                operator=account,
            )
            results.append(r3)
            print(" loss", r3)

    # 4 工单
    r = propose_confirm(
        token,
        "workorder.create",
        {"sku_id": "SKU001", "qty": 10, "status": "待开始", "note": "全量验收"},
        operator=account,
    )
    results.append(r)
    print(" workorder", r)
    if r.get("ok"):
        # 找最新工单 id
        st, wo = http("GET", BFF + "/api/sop/workorder", token=token)
        items = wo.get("items") or wo.get("workorders") or []
        wid = None
        if items:
            wid = items[0].get("id") or items[0].get("workorder_id")
        if wid:
            r2 = propose_confirm(
                token, "workorder.advance", {"id": wid}, operator=account
            )
            results.append(r2)
            print(" advance", r2)

    # 5 品控
    r = propose_confirm(
        token, "qc.pass", {"pass": True, "sku_id": "SKU001", "note": "全量验收品控"}, operator=account
    )
    results.append(r)

    # 6 POS 桌态 + 结账
    rev, snap = snap_rev(token)
    tables = ((snap.get("data") or {}).get("pos") or [])
    tid = None
    if isinstance(tables, list) and tables:
        tid = tables[0].get("id") or tables[0].get("table_id")
    if not tid:
        # store db
        db = store_db()
        pos = (db.get("data") or {}).get("pos") or []
        if pos:
            tid = pos[0].get("id") or pos[0].get("table_id")
    if tid:
        r = propose_confirm(
            token,
            "pos.table_state",
            {"table_id": tid, "state": "就餐", "id": tid},
            operator=account,
        )
        results.append(r)
        print(" table", r)
        r = propose_confirm(
            token,
            "pos.pay",
            {
                "table_id": tid,
                "id": tid,
                "amount": 88,
                "method": "微信",
                "items": [{"name": "五福饺", "qty": 2, "sku": "SKU001"}],
            },
            operator=account,
        )
        results.append(r)
        print(" pay", r)
    else:
        results.append({"step": "pos", "ok": False, "error": "无桌台"})

    # 7 预订 / 留样 / 消毒
    for typ, payload in [
        ("booking.upsert", {"guest_name": "全量验收客", "party_size": 4, "status": "待确认", "note": "e2e"}),
        ("sample.log", {"meal": "午餐", "dish": "验收留样", "weight_g": 125, "keeper": account}),
        ("fs.disinfect", {"area": "餐具区", "method": "高温", "operator": account}),
        ("staff.clock", {"staff_id": account, "kind": "上班", "status": "补录"}),
    ]:
        r = propose_confirm(token, typ, payload, operator=account)
        results.append(r)
        print(" ", typ, r.get("ok"), r.get("status"), r.get("error"))

    # 推快照
    os.system(
        f"cd '{ROOT}' && BFF_TOKEN='{token}' node bff/store-node/pusher.js --once --token '{token}' >/tmp/e2e_push.log 2>&1"
    )

    ok_n = sum(1 for x in results if x.get("ok"))
    fail = [x for x in results if not x.get("ok")]
    report["finished"] = datetime.now().isoformat(timespec="seconds")
    report["passed"] = ok_n
    report["failed"] = len(fail)
    report["ok"] = len(fail) == 0
    out = os.path.join(ROOT, "scripts", ".last_e2e_report.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps({"passed": ok_n, "failed": len(fail), "fail_steps": [x.get("step") for x in fail]}, ensure_ascii=False))
    print("report:", out)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
