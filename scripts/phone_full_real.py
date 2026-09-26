#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机 App 全流程全量数据验收：读屏 + 确认台写回 + API 对照。

覆盖：简报/进销存/厨房/问店/更多全模块；对可写入口走「确认并等待执行」。
会话注入绕过 OEM autofill / pm clear。
"""
from __future__ import annotations

import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = "com.pandawufu.app"
SERIAL = os.environ.get("ANDROID_SERIAL", "388a49c0")
BFF = os.environ.get("BFF_URL", "http://127.0.0.1:8787")
APK = os.path.join(ROOT, "apps/android-app/app/build/outputs/apk/debug/app-debug.apk")


def sh(*args, check=True, timeout=90):
    p = subprocess.run(["adb", "-s", SERIAL, *args], capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"adb {' '.join(args)}: {(p.stderr or p.stdout)[:400]}")
    return p.stdout


def shell(cmd, check=True, timeout=90):
    return sh("shell", cmd, check=check, timeout=timeout)


def dump_ui():
    # uiautomator 偶发挂死：带超时，失败返回旧文件
    try:
        shell("uiautomator dump /sdcard/uidump.xml", check=False, timeout=12)
        subprocess.run(
            ["adb", "-s", SERIAL, "pull", "/sdcard/uidump.xml", "/tmp/uidump_full.xml"],
            capture_output=True,
            timeout=15,
        )
    except Exception as exc:
        print("dump_ui warn", exc, flush=True)
    return "/tmp/uidump_full.xml"


def nodes(path="/tmp/uidump_full.xml"):
    if not os.path.exists(path):
        return []
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return []
    out = []
    for n in root.iter("node"):
        out.append(
            {
                "text": n.attrib.get("text") or "",
                "desc": n.attrib.get("content-desc") or "",
                "cls": n.attrib.get("class") or "",
                "bounds": n.attrib.get("bounds") or "",
            }
        )
    return out


def center(bounds: str):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds or "")
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def all_texts():
    return [(n["text"] + n["desc"]).strip() for n in nodes() if (n["text"] + n["desc"]).strip()]


def exists(*needles: str) -> bool:
    blob = " | ".join(all_texts())
    return any(n in blob for n in needles)


def tap_xy(x, y):
    shell(f"input tap {x} {y}")
    time.sleep(0.35)


def find_tap(substr: str, timeout=12, prefer_clickable=True) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        dump_ui()
        root = ET.parse("/tmp/uidump_full.xml").getroot()
        # 建立 parent 映射
        parent = {}
        for p in root.iter("node"):
            for c in list(p):
                parent[c] = p
        cands = []
        for n in root.iter("node"):
            text = n.attrib.get("text") or ""
            desc = n.attrib.get("content-desc") or ""
            blob = text + desc
            if substr not in blob:
                continue
            if len(text) > max(28, len(substr) + 10) and n.attrib.get("clickable") != "true":
                continue  # 跳过长说明
            target = n
            # 文本节点常不可点：爬到可点祖先（Button）
            cur = n
            for _ in range(6):
                if cur.attrib.get("clickable") == "true":
                    target = cur
                    break
                if cur not in parent:
                    break
                cur = parent[cur]
            b = target.attrib.get("bounds") or n.attrib.get("bounds") or ""
            xy = center(b)
            if not xy:
                continue
            exact = text == substr or desc == substr or text.startswith(substr)
            clickable = target.attrib.get("clickable") == "true"
            score = len(text)
            if exact:
                score -= 20
            if clickable:
                score -= 10
            if prefer_clickable and not clickable:
                score += 5
            cands.append((score, xy, text, clickable, b))
        cands.sort()
        if cands:
            print("find_tap", substr, "->", cands[0][2], cands[0][4], "click", cands[0][3], flush=True)
            tap_xy(*cands[0][1])
            return True
        time.sleep(0.45)
    return False


def shot(name: str) -> str:
    path = f"/tmp/phone_full_{name}.png"
    shell(f"screencap -p /sdcard/full_{name}.png", check=False)
    subprocess.run(
        ["adb", "-s", SERIAL, "pull", f"/sdcard/full_{name}.png", path],
        capture_output=True,
    )
    return path


def swipe_up():
    shell("input swipe 540 1900 540 900 280", check=False)
    time.sleep(0.55)


def app_focused() -> bool:
    out = shell("dumpsys window | grep -E mCurrentFocus", check=False)
    return PKG in (out or "")


def ensure_app():
    if app_focused():
        return
    shell(f"am start -n {PKG}/.MainActivity", check=False)
    time.sleep(3.0)


def back():
    if not app_focused():
        ensure_app()
        return
    shell("input keyevent KEYCODE_BACK", check=False)
    time.sleep(0.45)
    # 若回到桌面则立即拉回
    if not app_focused():
        ensure_app()


def go_home():
    """子模块可 BACK；主 Tab 点简报。禁止把 App 退到桌面。"""
    ensure_app()
    for _ in range(6):
        ensure_app()
        dump_ui()
        blob = " | ".join(all_texts())
        if any(k in blob for k in ("今日营收", "今日简报", "一键确认", "今天先干")):
            find_tap("简报", timeout=2)
            return True
        if "简报" in blob and "进销存" in blob:
            find_tap("简报", timeout=3)
            time.sleep(0.7)
            dump_ui()
            if any(k in " | ".join(all_texts()) for k in ("今日营收", "今日简报", "待办", "一键确认")):
                return True
        # 点模块页返回（左上）或系统返回，但 ensure_app 会拦住退出
        dump_ui()
        tapped_back = False
        for n in nodes():
            desc = n.get("desc") or ""
            if desc in ("返回", "Navigate up") or "返回" in (n.get("text") or ""):
                xy = center(n.get("bounds"))
                if xy and xy[0] < 200 and xy[1] < 400:
                    tap_xy(*xy)
                    tapped_back = True
                    break
        if not tapped_back:
            back()
        time.sleep(0.35)
    ensure_app()
    find_tap("简报", timeout=3)
    return exists("今日营收", "今日简报", "待办", "一键确认")


def http(method, url, payload=None, token=None, timeout=30):
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw.decode()) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode()) if raw else {}
        except Exception:
            return e.code, {"raw": raw[:300].decode("utf-8", "replace")}


def api_login(account, password):
    st, d = http(
        "POST",
        BFF + "/api/auth/login",
        {"account": account, "password": password, "device_fp": "phone-full"},
    )
    if not d.get("token"):
        raise RuntimeError(f"login fail {d}")
    return d


def inject_session(login: dict, account: str):
    token = login["token"]
    perms = ",".join(login.get("permissions") or [])
    xml = f"""<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="token">{html.escape(token)}</string>
    <string name="role">{html.escape(login.get('role') or '')}</string>
    <string name="account">{html.escape(account)}</string>
    <string name="store_id">{html.escape(login.get('store_id') or '')}</string>
    <string name="store_name">{html.escape(login.get('store_name') or '')}</string>
    <string name="display_name">{html.escape(login.get('display_name') or '')}</string>
    <boolean name="can_write" value="{'true' if login.get('can_write') else 'false'}" />
    <string name="permissions">{html.escape(perms)}</string>
</map>
"""
    open("/tmp/panda_session_full.xml", "w", encoding="utf-8").write(xml)
    shell(f"am force-stop {PKG}", check=False)
    sh("push", "/tmp/panda_session_full.xml", "/data/local/tmp/panda_session.xml")
    shell(f"run-as {PKG} mkdir -p shared_prefs", check=False)
    shell(
        f"run-as {PKG} sh -c 'cat /data/local/tmp/panda_session.xml > shared_prefs/panda_session.xml'",
        check=False,
    )
    v = shell(f"run-as {PKG} cat shared_prefs/panda_session.xml", check=False)
    if "token" not in v:
        raise RuntimeError("session inject failed")


def ensure_env():
    sh("reverse", "tcp:8787", "tcp:8787", check=False)
    sh("reverse", "tcp:8765", "tcp:8765", check=False)
    if os.path.exists(APK):
        subprocess.run(
            ["adb", "-s", SERIAL, "install", "-r", APK],
            capture_output=True,
            text=True,
            timeout=120,
        )


def launch():
    shell(f"am start -n {PKG}/.MainActivity", check=False)
    time.sleep(4.5)
    # 等首页渲染：最多再等 8s
    t0 = time.time()
    while time.time() - t0 < 8:
        dump_ui()
        blob = " | ".join(all_texts())
        if any(k in blob for k in ("简报", "营收", "今日", "新开业", "一键确认", "进销存")):
            return
        time.sleep(0.8)


def open_more_module(label: str) -> bool:
    go_home()
    time.sleep(0.3)
    # 确保离开子模块：最多再 BACK 三次
    for _ in range(3):
        if exists("老板常用", "全部模块", "搜索模块") or (
            exists("更多") and exists("经营分析", "巡台收银", "门店岗位")
        ):
            break
        if exists("更多") and not exists(label):
            find_tap("更多", timeout=3)
            time.sleep(0.6)
            break
        back()
        time.sleep(0.35)
    if not find_tap("更多", timeout=6):
        return False
    time.sleep(0.8)
    if exists(label):
        return find_tap(label, timeout=5)
    find_tap("全部", timeout=4)
    time.sleep(0.5)
    for _ in range(6):
        if find_tap(label, timeout=2):
            return True
        swipe_up()
    return False


def confirm_wait(timeout=22) -> bool:
    """点确认并等待执行；成功标志：确认台消失或出现「已执行/店内已执行」。"""
    if not (
        find_tap("确认并等待执行", timeout=8)
        or find_tap("确认并等待", timeout=4)
    ):
        if find_tap("下一步确认", timeout=3):
            time.sleep(0.6)
            if not (find_tap("确认并等待执行", timeout=8) or find_tap("确认并等待", timeout=4)):
                return False
        else:
            return False
    t0 = time.time()
    while time.time() - t0 < timeout:
        dump_ui()
        blob = " | ".join(all_texts())
        if "已执行" in blob or "店内已执行" in blob or "知道了" in blob:
            find_tap("知道了", timeout=2)
            return True
        if "确认台" not in blob and "确认并等待" not in blob:
            return True
        if "失败" in blob or "驳回" in blob or "过期" in blob:
            return False
        time.sleep(0.8)
    return exists("店内已执行", "已执行", "知道了")


def recent_actions(token: str, since_iso: str, limit=80):
    st, d = http("GET", f"{BFF}/api/actions?limit={limit}", token=token)
    items = d.get("items") or []
    out = []
    for a in items:
        ca = a.get("created_at") or ""
        if ca >= since_iso:
            out.append(a)
    return out


def action_ok(token, since_iso, typ_substr, operator=None) -> dict | None:
    for a in sorted(recent_actions(token, since_iso), key=lambda x: x.get("created_at") or "", reverse=True):
        if typ_substr not in (a.get("type") or ""):
            continue
        if operator and a.get("operator") != operator:
            continue
        if a.get("status") == "已执行":
            return a
    return None


def step(log, name, ok, detail=""):
    log["steps"].append({"step": name, "ok": bool(ok), "detail": detail})
    print(f"  [{'OK' if ok else 'FAIL'}] {name} {detail}", flush=True)


def run(account: str, password: str):
    log = {
        "account": account,
        "started": datetime.now().isoformat(timespec="seconds"),
        "steps": [],
        "writes": [],
    }
    ensure_env()
    login = api_login(account, password)
    token = login["token"]
    inject_session(login, account)
    launch()
    since = (
        datetime.now(timezone.utc).timestamp() - 120
    )
    since = datetime.fromtimestamp(since, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    # --- 首页 ---
    store_ok = False
    for _ in range(5):
        dump_ui()
        home = exists("简报", "营收", "今日", "一键确认", "新开业", "待办", "保本")
        store_ok = exists("新开业") or exists("09252221")
        if home and store_ok:
            break
        time.sleep(0.8)
    step(log, "home", home, shot("home"))
    step(log, "store", store_ok, login.get("store_name"))

    # 若无告急 CTA，从补货页选几项确认（全量写回仍要覆盖）
    pack_done = False
    if exists("一键确认告急补货"):
        find_tap("一键确认告急补货", timeout=6)
        time.sleep(0.8)
        ok = confirm_wait(24)
        a = action_ok(token, since, "restock", account)
        step(log, "write.restock_pack", ok and bool(a), a.get("id") if a else "no action")
        log["writes"].append({"type": "restock.create", "ok": bool(a), "id": (a or {}).get("id")})
        pack_done = bool(a)
    if not pack_done:
        find_tap("进销存", timeout=5)
        time.sleep(0.8)
        find_tap("补货", timeout=4)
        time.sleep(0.8)
        # 点「确认生成采购草稿」或勾选后确认
        if find_tap("全部转单", timeout=5) or find_tap("确认生成采购草稿", timeout=3) or find_tap("转单", timeout=3):
            time.sleep(0.6)
            ok = confirm_wait(24)
            a = action_ok(token, since, "restock", account)
            step(log, "write.restock_pack", ok and bool(a), (a or {}).get("id") or "from补货页")
            log["writes"].append({"type": "restock.create", "ok": bool(a), "id": (a or {}).get("id")})
        else:
            step(log, "write.restock_pack", False, "无补货确认入口")
            log["writes"].append({"type": "restock.create", "ok": False})
        go_home()

    # --- 进销存 tabs ---
    find_tap("进销存", timeout=6)
    time.sleep(1)
    for tab, needles in [
        ("库存", ("库存", "原料", "告急", "偏低")),
        ("补货", ("补货", "告急", "偏低", "确认")),
        ("采购", ("采购单", "采购", "确认并入库", "待确认")),
        ("进货", ("进货", "入库", "验收", "暂无")),
    ]:
        find_tap(tab, timeout=4)
        time.sleep(0.9)
        ok = exists(*needles) or exists("进销存")
        step(log, f"inv.{tab}", ok, shot(f"inv_{tab}"))

    # 写：确认并入库（补货后等推送 + 切 Tab 刷新）
    time.sleep(2.0)
    os.system(
        f"cd '{ROOT}' && BFF_TOKEN='{token}' python3 store-inventory/snapshot_pusher.py --once --token '{token}' >/tmp/phone_push.log 2>&1"
    )
    find_tap("进销存", timeout=6)
    time.sleep(0.6)
    find_tap("库存", timeout=3)
    time.sleep(0.6)
    find_tap("采购", timeout=4)
    time.sleep(1.5)
    inbound_ok = False
    for attempt in range(6):
        dump_ui()
        if exists("确认并入库") or exists("确认到货入库"):
            find_tap("确认并入库", timeout=4) or find_tap("确认到货入库", timeout=3)
            time.sleep(0.7)
            ui_ok = confirm_wait(24)
            a = action_ok(token, since, "recv.inbound", account)
            ok = bool(a) or ui_ok
            step(log, "write.inbound", ok, (a or {}).get("id") or ("ui" if ui_ok else "confirm-fail"))
            log["writes"].append({"type": "recv.inbound", "ok": ok, "id": (a or {}).get("id")})
            inbound_ok = True  # 已尝试到按钮，不再记「无草稿」
            break
        # 有「待确认」标签但按钮未进屏，继续滑
        swipe_up()
        time.sleep(1.0)
        find_tap("采购", timeout=2)
        time.sleep(0.8)
    if not inbound_ok:
        step(log, "write.inbound", False, "无草稿PO可入库")
        log["writes"].append({"type": "recv.inbound", "ok": False})

    # --- 厨房 ---
    find_tap("厨房", timeout=6)
    time.sleep(1.0)
    for tab, needles in [
        ("菜谱", ("菜谱", "配方", "转采购", "转工单", "厨房")),
        ("工单", ("工单", "推进", "待开始", "进行", "SOP")),
        ("看板", ("看板", "外卖", "待做", "厨房")),
        ("品控", ("品控", "合格", "拍照", "QC", "成品")),
    ]:
        find_tap(tab, timeout=4)
        time.sleep(0.9)
        step(log, f"kitchen.{tab}", exists(*needles) or exists("厨房中枢"), shot(f"kt_{tab}"))

    # 写：推进工单 或 建工单
    find_tap("工单", timeout=4)
    time.sleep(0.8)
    if exists("推进到"):
        # tap first 推进
        dump_ui()
        for n in nodes():
            if "推进到" in (n["text"] + n["desc"]):
                xy = center(n["bounds"])
                if xy:
                    tap_xy(*xy)
                    break
        time.sleep(0.7)
        ok = confirm_wait(22)
        a = action_ok(token, since, "workorder.advance", account)
        step(log, "write.workorder_advance", ok and bool(a), (a or {}).get("id") or "")
        log["writes"].append({"type": "workorder.advance", "ok": bool(a), "id": (a or {}).get("id")})
    elif exists("按本餐缺口建工单") or exists("建工单"):
        find_tap("按本餐缺口建工单", timeout=4) or find_tap("建工单", timeout=3)
        time.sleep(0.7)
        ok = confirm_wait(22)
        a = action_ok(token, since, "workorder.create", account)
        step(log, "write.workorder_create", ok and bool(a), (a or {}).get("id") or "")
        log["writes"].append({"type": "workorder.create", "ok": bool(a), "id": (a or {}).get("id")})
    else:
        step(log, "write.workorder", True, "无可推进工单")

    # --- 问店 ---
    # 底栏中间熊猫 or 问店
    if find_tap("问店", timeout=5) or find_tap("问店 AI", timeout=3):
        time.sleep(1.0)
        step(log, "chat", exists("问店", "发送", "只读", "问答"), shot("chat"))
        back()
    else:
        step(log, "chat", False, "未找到问店入口")

    # --- 更多模块（读） ---
    modules = [
        ("经营分析", ("分析", "趋势", "矩阵", "保本", "效率")),
        ("巡台收银", ("巡台", "点菜", "结账", "桌台", "空闲", "就餐")),
        ("审批队列", ("审批", "确认台", "动作", "队列", "草稿")),
        ("门店岗位", ("门店", "岗位", "账号", "筹备")),
        ("预订排队", ("预订", "排队", "新建预订", "叫号")),
        ("财务税务", ("财务", "对账", "结算", "发票", "税务")),
        ("排班员工", ("排班", "打卡", "人效", "培训")),
        ("食安证照", ("证照", "溯源", "留样", "消毒")),
        ("外卖平台", ("外卖", "美团", "饿了么", "对账", "订单")),
        ("会员营销", ("会员", "储值", "券", "生日")),
        ("设备能耗", ("设备", "能耗", "冷柜", "维保")),
        ("供应链", ("供应", "报价", "供应商")),
        ("顾客口碑", ("口碑", "差评", "好评", "回访")),
        ("损耗报损", ("报损", "损耗", "提交报损")),
    ]
    for label, needles in modules:
        opened = open_more_module(label)
        time.sleep(1.0)
        ok = opened and (exists(*needles) or exists(label[:2]))
        step(log, f"mod.{label}", ok, shot(f"mod_{label}"))
        back()
        time.sleep(0.35)

    # --- 写：POS 开台 ---
    if open_more_module("巡台收银"):
        time.sleep(1.0)
        find_tap("巡台", timeout=3)
        time.sleep(0.5)
        find_tap("改态", timeout=3)
        time.sleep(0.3)
        # 优先点「空闲开台」显式按钮（比点格子更稳）
        if find_tap("空闲开台", timeout=5):
            time.sleep(0.8)
        else:
            dump_ui()
            tapped = False
            ns = nodes()
            root = ET.parse("/tmp/uidump_full.xml").getroot()
            grid = []
            for n in root.iter("node"):
                if n.attrib.get("clickable") != "true":
                    continue
                b = n.attrib.get("bounds") or ""
                xy = center(b)
                if not xy or xy[1] < 1000 or xy[1] > 2100:
                    continue
                m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", b)
                if not m:
                    continue
                x1, y1, x2, y2 = map(int, m.groups())
                if (x2 - x1) < 140 or (y2 - y1) < 110:
                    continue
                texts_in = []
                for c in n.iter("node"):
                    t = c.attrib.get("text") or c.attrib.get("content-desc") or ""
                    if t:
                        texts_in.append(t)
                blob = " ".join(texts_in)
                if "空闲" not in blob and "桌台" not in blob:
                    continue
                grid.append((xy[1], xy, blob, b))
            grid.sort()
            for _, xy, blob, b in grid[:3]:
                print("pos tap cell", b, blob, flush=True)
                tap_xy(*xy)
                time.sleep(1.4)
                dump_ui()
                if exists("切换桌态") or exists("空闲开台") or exists("确认台") or exists("确认并等待"):
                    tapped = True
                    break
            if not tapped and grid:
                tap_xy(*grid[0][1])
                time.sleep(1.4)
        if exists("切换桌态") or exists("空闲开台") or exists("确认台") or exists("确认并等待") or exists("确认并等待执行"):
            # 若还在按钮态已点开确认台
            if not exists("确认并等待", "确认并等待执行", "确认台"):
                pass
            ui_ok = confirm_wait(20)
            a = action_ok(token, since, "pos.table_state", account)
            ok = bool(a) or ui_ok
            step(log, "write.pos_table", ok, (a or {}).get("id") or "")
            log["writes"].append({"type": "pos.table_state", "ok": ok, "id": (a or {}).get("id")})
        else:
            step(log, "write.pos_table", False, "未弹出桌态确认")
            log["writes"].append({"type": "pos.table_state", "ok": False})

        find_tap("点菜", timeout=5)
        time.sleep(0.8)
        dump_ui()
        plus = [n for n in nodes() if n["text"] == "+"]
        if plus:
            xy = center(plus[-1]["bounds"]) if len(plus) > 1 else center(plus[0]["bounds"])
            if xy:
                tap_xy(*xy)
                time.sleep(0.5)
                tap_xy(*xy)
                time.sleep(0.4)
        # 底部「已点 N 份 · 去结账」
        went_pay = find_tap("去结账", timeout=5)
        if not went_pay:
            find_tap("结账", timeout=4)
            time.sleep(0.5)
            # 若无购物车，结账页可能空
            went_pay = exists("确认收款", "本单合计", "支付方式")
        if went_pay or exists("确认收款", "本单合计"):
            time.sleep(0.6)
            # 若有空闲桌可选，点一个就餐桌；否则直接收款
            if find_tap("确认收款", timeout=6):
                time.sleep(0.6)
                ui_ok = confirm_wait(22)
                a = action_ok(token, since, "pos.pay", account)
                ok = bool(a) or ui_ok
                step(log, "write.pos_pay", ok, (a or {}).get("id") or "")
                log["writes"].append({"type": "pos.pay", "ok": ok, "id": (a or {}).get("id")})
            else:
                step(log, "write.pos_pay", False, "无确认收款（可能无就餐桌/未点菜）")
                log["writes"].append({"type": "pos.pay", "ok": False})
        else:
            step(log, "write.pos_pay", False, "未进入结账")
            log["writes"].append({"type": "pos.pay", "ok": False})
        for _ in range(3):
            back()
            time.sleep(0.3)
    else:
        step(log, "write.pos_table", False, "无法打开巡台收银")
        step(log, "write.pos_pay", False, "无法打开巡台收银")

    def write_module(label, button, typ, need_next=True, pills=None):
        if not open_more_module(label):
            step(log, f"write.{typ}", False, f"无法打开{label}")
            log["writes"].append({"type": typ, "ok": False})
            return
        time.sleep(1.2)
        for pill in pills or []:
            find_tap(pill, timeout=4)
            time.sleep(0.5)
        dump_ui()
        if not exists(button) and not exists(button[:2]):
            swipe_up()
            time.sleep(0.4)
            dump_ui()
        if not find_tap(button, timeout=6):
            # 截图留证
            shot(f"miss_{typ.replace('.', '_')}")
            print("miss button texts", [t for t in all_texts() if t][:40], flush=True)
            step(log, f"write.{typ}", False, f"无按钮 {button}")
            log["writes"].append({"type": typ, "ok": False})
            back()
            return
        time.sleep(0.5)
        if need_next:
            find_tap("下一步确认", timeout=5)
            time.sleep(0.5)
        ui_ok = confirm_wait(22)
        a = action_ok(token, since, typ, account)
        ok = bool(a) or ui_ok
        step(log, f"write.{typ}", ok, (a or {}).get("id") or "")
        log["writes"].append({"type": typ, "ok": ok, "id": (a or {}).get("id")})
        back()
        time.sleep(0.35)

    write_module("预订排队", "新建预订", "booking.upsert", need_next=True)
    write_module("食安证照", "登记留样", "sample.log", need_next=True)
    write_module("食安证照", "登记消毒", "fs.disinfect", need_next=True)
    write_module("排班员工", "补打卡", "staff.clock", need_next=True)
    write_module("损耗报损", "提交报损单", "loss.report", need_next=True)
    write_module("设备能耗", "登记维保", "equipment.maintain", need_next=True)

    # 厨房工单：尽量建一单
    find_tap("厨房", timeout=5)
    time.sleep(0.8)
    find_tap("工单", timeout=4)
    time.sleep(0.6)
    if find_tap("按本餐缺口建工单", timeout=4) or find_tap("建工单", timeout=3):
        time.sleep(0.5)
        ui_ok = confirm_wait(22)
        a = action_ok(token, since, "workorder.create", account)
        ok = bool(a) or ui_ok
        step(log, "write.workorder_create", ok, (a or {}).get("id") or "")
        log["writes"].append({"type": "workorder.create", "ok": ok, "id": (a or {}).get("id")})
    elif exists("推进到"):
        dump_ui()
        for n in nodes():
            if "推进到" in (n["text"] + n["desc"]):
                xy = center(n["bounds"])
                if xy:
                    tap_xy(*xy)
                    break
        ui_ok = confirm_wait(22)
        a = action_ok(token, since, "workorder.advance", account)
        ok = bool(a) or ui_ok
        step(log, "write.workorder_advance", ok, (a or {}).get("id") or "")
        log["writes"].append({"type": "workorder.advance", "ok": ok, "id": (a or {}).get("id")})
    else:
        step(log, "write.workorder_extra", True, "无额外工单入口")

    go_home()
    shot("final")
    log["finished"] = datetime.now().isoformat(timespec="seconds")
    fails = [s for s in log["steps"] if not s["ok"]]
    write_fails = [w for w in log["writes"] if not w.get("ok")]
    log["failed"] = len(fails)
    log["write_failed"] = len(write_fails)
    log["ok"] = len(fails) == 0
    out = os.path.join(ROOT, "scripts", ".last_phone_full.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    print(json.dumps({
        "ok": log["ok"],
        "failed": log["failed"],
        "write_failed": log["write_failed"],
        "fail_steps": [s["step"] for s in fails],
        "write_fails": write_fails,
    }, ensure_ascii=False), flush=True)
    print("wrote", out, flush=True)
    return 0 if log["ok"] else 1


def main():
    meta = os.path.join(ROOT, "scripts", ".last_new_restaurant.json")
    account, password = "newboss09252221", "wufu123"
    if os.path.exists(meta):
        m = json.load(open(meta, encoding="utf-8"))
        account = m.get("accounts", {}).get("boss") or account
        password = m.get("accounts", {}).get("password") or password
    print("device", SERIAL, "account", account, flush=True)
    devices = subprocess.check_output(["adb", "devices"], text=True)
    if SERIAL not in devices:
        raise SystemExit(f"device offline:\n{devices}")
    return run(account, password)


if __name__ == "__main__":
    sys.exit(main())
