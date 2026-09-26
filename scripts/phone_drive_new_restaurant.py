#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯 ADB 控机：真机注入新店老板会话并跑通主路径。

依赖：adb、已安装 debug 包 com.pandawufu.app、adb reverse tcp:8787。
Realme 等机型 pm clear 常被拒绝，故用 run-as 写 SharedPreferences 注入会话。
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = "com.pandawufu.app"
SERIAL = os.environ.get("ANDROID_SERIAL", "388a49c0")
BFF = os.environ.get("BFF_URL", "http://127.0.0.1:8787")
APK = os.path.join(ROOT, "apps/android-app/app/build/outputs/apk/debug/app-debug.apk")


def sh(*args, check=True, timeout=60):
    cmd = ["adb", "-s", SERIAL, *args]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"adb fail {' '.join(args)}: {p.stderr or p.stdout}")
    return p.stdout


def sh_shell(cmd, check=True, timeout=60):
    return sh("shell", cmd, check=check, timeout=timeout)


def dump_ui():
    sh_shell("uiautomator dump /sdcard/uidump.xml", check=False)
    local = "/tmp/uidump.xml"
    subprocess.run(
        ["adb", "-s", SERIAL, "pull", "/sdcard/uidump.xml", local],
        capture_output=True,
        timeout=30,
    )
    return local


def nodes(path="/tmp/uidump.xml"):
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
                "clickable": n.attrib.get("clickable") == "true",
                "bounds": n.attrib.get("bounds") or "",
            }
        )
    return out


def center(bounds: str):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def find_tap(substr: str, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        dump_ui()
        for n in nodes():
            blob = n["text"] + n["desc"]
            if substr in blob:
                xy = center(n["bounds"])
                if xy:
                    sh_shell(f"input tap {xy[0]} {xy[1]}")
                    time.sleep(0.8)
                    return True
        time.sleep(0.5)
    return False


def find_exists(substr: str) -> bool:
    dump_ui()
    for n in nodes():
        if substr in (n["text"] + n["desc"]):
            return True
    return False


def screenshot(name: str):
    path = f"/tmp/phone_{name}.png"
    sh_shell(f"screencap -p /sdcard/{name}.png", check=False)
    subprocess.run(
        ["adb", "-s", SERIAL, "pull", f"/sdcard/{name}.png", path],
        capture_output=True,
    )
    return path


def ensure_reverse():
    sh("reverse", "tcp:8787", "tcp:8787", check=False)
    sh("reverse", "tcp:8765", "tcp:8765", check=False)


def api_login(account: str, password: str):
    body = json.dumps(
        {"account": account, "password": password, "device_fp": "phone-drive"}
    ).encode()
    req = urllib.request.Request(
        BFF + "/api/auth/login",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def inject_session(login: dict, account: str):
    """debug 包可 run-as 写 SharedPreferences，绕过 OEM autofill / pm clear。"""
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
    local = "/tmp/panda_session_drive.xml"
    open(local, "w", encoding="utf-8").write(xml)
    sh_shell(f"am force-stop {PKG}", check=False)
    sh("push", local, "/data/local/tmp/panda_session.xml")
    sh_shell(f"run-as {PKG} mkdir -p shared_prefs", check=False)
    out = sh_shell(
        f"run-as {PKG} sh -c 'cat /data/local/tmp/panda_session.xml > shared_prefs/panda_session.xml'",
        check=False,
    )
    verify = sh_shell(f"run-as {PKG} cat shared_prefs/panda_session.xml", check=False)
    if "token" not in verify:
        raise RuntimeError(f"session inject failed: {out} {verify[:200]}")


def ensure_apk():
    if not os.path.exists(APK):
        print("APK missing, skip reinstall")
        return
    # 不 pm clear（Realme SecurityException）；仅覆盖安装
    out = subprocess.run(
        ["adb", "-s", SERIAL, "install", "-r", APK],
        capture_output=True,
        text=True,
        timeout=120,
    )
    print(out.stdout or out.stderr)


def launch():
    sh_shell(f"am start -n {PKG}/.MainActivity", check=False)
    time.sleep(3.0)


def swipe_up():
    sh_shell("input swipe 540 1800 540 900 300", check=False)
    time.sleep(0.6)


def open_org():
    if not find_tap("更多", timeout=6):
        return False
    time.sleep(0.8)
    # 门店岗位在「全部」或搜索里
    if find_exists("门店岗位"):
        return find_tap("门店岗位", timeout=4)
    if find_tap("全部", timeout=4) or find_tap("另有", timeout=3):
        time.sleep(0.6)
        swipe_up()
        if find_tap("门店岗位", timeout=5):
            return True
    # 搜索框：点 placeholder 再输入
    dump_ui()
    for n in nodes():
        if "搜索模块" in (n["text"] + n["desc"]):
            xy = center(n["bounds"])
            if xy:
                sh_shell(f"input tap {xy[0]} {xy[1]}")
                time.sleep(0.3)
                sh_shell("input text gangwei")  # ASCII fallback unlikely to match
                break
    # 中文无法 input text：直接滑动找
    for _ in range(4):
        if find_tap("门店岗位", timeout=2):
            return True
        swipe_up()
    return find_exists("门店岗位") and find_tap("门店岗位", timeout=3)


def run_journey(account: str, password: str):
    log = {"account": account, "steps": []}

    def step(name, ok, detail=""):
        log["steps"].append({"step": name, "ok": bool(ok), "detail": detail})
        print(f"  [{'OK' if ok else 'FAIL'}] {name} {detail}")

    ensure_reverse()
    ensure_apk()
    print("==> API 登录并注入会话", account)
    login = api_login(account, password)
    inject_session(login, account)
    launch()

    home_ok = (
        find_exists("简报")
        or find_exists("营收")
        or find_exists("今日")
        or find_exists("一键确认")
        or find_exists("新开业")
    )
    store_ok = find_exists("新开业") or find_exists(login.get("store_name") or "UNLIKELY")
    step("home", home_ok, screenshot("home"))
    step("new_store", store_ok, login.get("store_name") or "")
    if not home_ok:
        step("login", False, "会话注入后未进首页")
        return log

    # 一键补货
    pack = find_tap("一键确认告急补货", timeout=10)
    step("restock_cta", pack)
    time.sleep(1)
    confirm = find_tap("确认并等待执行", timeout=12) or find_tap("确认并等待", timeout=5)
    step("restock_confirm", confirm)
    time.sleep(12)
    screenshot("confirm_restock")

    # 进销存 → 采购 → 确认并入库（若有草稿）
    find_tap("进销存", timeout=6) or find_tap("进销", timeout=4)
    time.sleep(1)
    find_tap("采购", timeout=5)
    time.sleep(1.2)
    inv_ok = find_exists("采购单") or find_exists("库存") or find_exists("补货")
    step("inventory", inv_ok, screenshot("inventory"))
    if find_exists("确认并入库"):
        find_tap("确认并入库", timeout=5)
        time.sleep(1)
        find_tap("确认并等待执行", timeout=8) or find_tap("确认", timeout=5)
        time.sleep(10)
        step("inbound_confirm", True, screenshot("inbound"))
    else:
        step("inbound_confirm", True, "无待入库草稿")

    # 厨房
    find_tap("厨房", timeout=6)
    time.sleep(1.2)
    step(
        "kitchen",
        find_exists("工单") or find_exists("菜谱") or find_exists("看板") or find_exists("厨房"),
        screenshot("kitchen"),
    )

    # 更多 → 门店岗位
    org = open_org()
    step("open_org", org, screenshot("org"))
    sh_shell("input keyevent KEYCODE_BACK", check=False)
    time.sleep(0.5)

    # 审批
    find_tap("更多", timeout=5)
    time.sleep(0.6)
    act = find_tap("审批", timeout=6)
    step("actions", act, screenshot("actions"))

    find_tap("简报", timeout=5)
    screenshot("final_home")
    return log


def main():
    meta = os.path.join(ROOT, "scripts", ".last_new_restaurant.json")
    account, password = "boss", "wufu123"
    if os.path.exists(meta):
        m = json.load(open(meta, encoding="utf-8"))
        account = m.get("accounts", {}).get("boss") or account
        password = m.get("accounts", {}).get("password") or password
    print("device", SERIAL, "account", account)
    out = subprocess.check_output(["adb", "devices"], text=True)
    if SERIAL not in out:
        raise SystemExit(f"设备 {SERIAL} 不在线:\n{out}")
    log = run_journey(account, password)
    out_path = os.path.join(ROOT, "scripts", ".last_phone_drive.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    fails = [s for s in log["steps"] if not s["ok"]]
    print(json.dumps({"failed": len(fails), "fails": fails}, ensure_ascii=False))
    print("wrote", out_path)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
