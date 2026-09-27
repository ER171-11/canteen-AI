# -*- coding: utf-8 -*-
"""
熊猫五福餐厅 · 外接比价 · Selenium 网页抓价脚本
================================================
当 1688 开放平台接口（onebound 等）不好用/额度不够时，用真实浏览器人工可登录的方式抓价。

流水线：进销存系统「生成本次比价任务」→ 待比价任务.json
        → 本脚本用 Selenium 打开真实 Chrome 搜 1688
        → 比价结果.json（供系统「导入比价结果」）+ 比价结果.xlsx（人看）

与 fetch_quotes.py 的关系：
    共用同一份任务/结果 JSON 契约、共用一个 output 写出逻辑（直接 import fetch_quotes）。
    两个引擎任选其一，产出的 比价结果.json 都能被系统导入。

用法：
    python fetch_quotes_selenium.py                     # 全量抓取（自动找最新 待比价任务*.json）
    python fetch_quotes_selenium.py --limit 3           # 只抓前 3 种，先试跑
    python fetch_quotes_selenium.py --keyword 东古一品鲜  # 单个关键词调试
    python fetch_quotes_selenium.py --delay 2.5         # 每次操作间隔（默认 2.5 秒）
    python fetch_quotes_selenium.py --headless          # 无头模式（1688 可能拦截，仅备选）
    python fetch_quotes_selenium.py --dry-run           # 不开浏览器，验证输出链路

关键设计：
  1. 持久化 Chrome 用户目录（chrome_profile/）→ 首次登录后，以后免登录
  2. 反自动化检测：关掉 navigator.webdriver、enable-automation 等特征
  3. 节奏控制：每次浏览器操作之间 sleep ~2.5s（--delay 可调，带轻微抖动）
  4. 遇到登录/滑块验证 → 暂停并提示人工处理，程序自动轮询等待
  5. 选择器多套兜底（1688 前端改版频繁，单套选择器容易一夜失效）
"""

import argparse
import json
import os
import random
import re
import sys
import time
from datetime import date
from urllib.parse import quote

# ---- 复用 API 脚本里的任务读取 / 结果写出逻辑，避免两套实现跑偏 ----
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_quotes import (  # noqa: E402
    RESULT_NAME,
    EXCEL_NAME,
    HERE,
    die,
    info,
    find_task_file,
    load_task,
    write_json,
    write_excel,
)

# selenium 延迟导入：--dry-run 等不碰浏览器的场景即便没装 selenium 也能跑
webdriver = None
Options = Service = None
By = None


def ensure_selenium():
    """真正要开浏览器时才校验 selenium，避免拖累 dry-run / 纯输出逻辑。"""
    global webdriver, Options, Service, By
    if webdriver is not None:
        return
    try:
        from selenium import webdriver as _wd
        from selenium.webdriver.chrome.options import Options as _Opt
        from selenium.webdriver.chrome.service import Service as _Svc
        from selenium.webdriver.common.by import By as _By
    except ImportError:  # pragma: no cover
        die("缺少 selenium 依赖。请执行：\n"
            "    pip install -r requirements.txt\n"
            "  或在 比价脚本/ 目录双击 运行比价-网页版.bat 自动安装。")
    webdriver, Options, Service, By = _wd, _Opt, _Svc, _By


# ======================================================================
# 默认配置（可被 config.json 的 selenium 段覆盖，也可被命令行覆盖）
# ======================================================================
DEFAULTS = {
    "source": "1688(网页)",
    "delay": 2.5,          # 每次浏览器操作后的等待（秒）——「响应时间控制在 2.5 秒左右」
    "jitter": 0.35,        # 抖动幅度（±），让节奏不像机器人；设 0 则严格 2.5s
    "scrolls": 3,          # 每页下滑次数（触发懒加载，与参考代码一致）
    "pages": 1,            # 抓取翻页数（>1 时尝试点「下一页」，失败则停止翻页）
    "top_n": 3,            # 每个关键词取最便宜的 N 条
    "page_timeout": 25,    # 等待商品列表出现的秒数
    "login_wait": 300,     # 等待人工登录/过验证的最长秒数
    "profile_dir": "chrome_profile",
    "headless": False,
    "browser": "auto",         # chrome | edge | auto（auto=有 Chrome 用 Chrome，否则自动回落 Edge）
    "binary": "",              # 指定浏览器内核 exe 路径（留空自动探测）
    "keyword_suffix": "",
    "allow_conv_grab": False,   # conv≠1 的原料默认跳过（口径对不齐，容易错价）
}

SEARCH_URL = "https://s.1688.com/selloffer/offer_search.htm?keywords={kw}"
HOME_URL = "https://www.1688.com/"
LOGIN_COOKIES = {"cookie2", "unb", "_tb_token_", "sgcookie", "uc1", "uc2"}

# ---- 多套选择器兜底：1688 前端改版会让某一套失效，按顺序取第一个命中的 ----
CARD_SEL = [
    # 现版 1688 卡片 class 带 CSS Modules 哈希，如 offerCard--dMshu5T4
    "[class*='offerCard']",
    "[class*='offerCard'] > div",
    ".autotest_right_cpt",
    "[class*='offerList'] > div",
    ".sm-offer-item",
    ".offer-item",
    ".J_offerCard",
    "div[data-h5-type='offerCard']",
    ".sm-offer-list .sm-offer-item",
    "#sm-offer-list .sm-offer-item",
    ".offer-list .offer-item",
]
TITLE_SEL = [
    "[class*='offerTitle']",
    "[class*='titleText']",
    "[class*='offer-title']",
    ".title-text",
    ".offer-title",
    ".sm-offer-title",
    "a[title]",
    ".title",
    "h2",
]
PRICE_SEL = [
    "[class*='priceNum']",
    "[class*='priceText']",
    "[class*='offerPrice']",
    ".sm-offer-priceNum",
    ".sm-offer-priceText",
    ".sm-offer-price",
    ".offer-price",
    ".price",
]
SHOP_SEL = [
    "[class*='companyName']",
    "[class*='shopName']",
    "[class*='sellerName']",
    ".sm-offer-companyName",
    ".sm-offer-shopName",
    ".company-name",
    ".shop-name",
]
MOQ_SEL = [
    ".sm-offer-minOrder",
    "[class*=minOrder]",
    "[class*=min-order]",
    "[class*=moq]",
]
LOC_SEL = [
    ".sm-offer-location",
    "[class*=location]",
    ".sm-offer-address",
]
NEXT_SEL = [
    "a.fui-next",
    ".fui-next",
    "a[class*=next]",
    "#sm-offer-pagination a[class*=next]",
]

# 1688 首页搜索栏的多套选择器（首页改版就再补）
# 当前真实结构：<form id="alisearch-form" target="_blank">
#                 <textarea id="alisearch-input" name="keywords">
#                 <button class="searchBtn--...">
HOME_SEARCH_INPUT_SEL = [
    "#alisearch-input",                              # 当前 1688 PC 站主搜索框（textarea）
    "form#alisearch-form [name='keywords']",
    "form[action*='offer_search'] [name='keywords']",
    "textarea[name='keywords']",
    "input[name='keywords']",
    "#search-key",                                   # 历史选择器，兜底
    "input[placeholder*='搜索']",
]
HOME_SEARCH_BTN_SEL = [
    "form#alisearch-form button",
    "form[action*='offer_search'] button",
    "button[class*='searchBtn']",                    # CSS Modules 哈希兜底
    "button.searchBtn",
    ".searchAction button",
    "form[action*='offer_search'] [type='submit']",
]
NO_RESULT_TEXT = "空空如也"  # 1688 无结果提示里的关键字，反爬命中时的特征

NUM_RE = re.compile(r"\d+(?:\.\d+)?")
UNIT_RE = re.compile(r"[/／]\s*([^\s/／]{1,6})")
CN_RE = re.compile(r"[\u4e00-\u9fa5]{2,}")
OFFER_ID_RE = re.compile(r"offer/(\d+)\.html")


# ======================================================================
# 小工具
# ======================================================================
def human_delay(cfg, note=""):
    """节奏控制：默认 2.5s，带轻微抖动；jitter=0 则严格 2.5s。"""
    d = float(cfg["delay"])
    j = float(cfg.get("jitter") or 0)
    t = d + random.uniform(-j, j) if j > 0 else d
    t = max(0.2, t)
    if note:
        info(f"    …{note} 等待 {t:.1f}s")
    time.sleep(t)


def parse_price(text):
    """从价签文本里取最低价。'¥12.50'→12.5；'12.5-15'→12.5；'面议'→None。"""
    if not text:
        return None
    t = str(text).replace("￥", "¥").replace(",", "").strip()
    if any(k in t for k in ("面议", "询价", "登录", "查看")):
        return None
    vals = [float(x) for x in NUM_RE.findall(t) if float(x) > 0]
    return min(vals) if vals else None


def price_unit(text):
    """从价签里抠出单位，如 '¥12.50/件' → '件'。"""
    if not text:
        return ""
    m = UNIT_RE.search(str(text).replace("￥", "¥"))
    return m.group(1) if m else ""


def core_word(keyword):
    """取关键词里前 2 个汉字作为品牌/核心词，用于判断标题相关性。"""
    m = CN_RE.search(keyword or "")
    return (m.group(0) if m else (keyword or ""))[:2]


def text_of(parent, selectors):
    """按选择器列表依次尝试，返回第一个存在元素的 .text。"""
    for sel in selectors:
        try:
            el = parent.find_element(By.CSS_SELECTOR, sel)
            t = (el.text or "").strip()
            if t:
                return t
        except Exception:  # noqa: BLE001
            continue
    return ""


def attr_of(parent, selectors, attr):
    for sel in selectors:
        try:
            el = parent.find_element(By.CSS_SELECTOR, sel)
            v = el.get_attribute(attr)
            if v:
                return v.strip()
        except Exception:  # noqa: BLE001
            continue
    return ""


def drop_containers(driver, els, sel):
    """剔除“一个节点套着多张卡片”的容器（如前缀匹配命中 offerCardList 整列）。

    判定：某节点自身还包含 >=2 个同类节点，就直接用它的子节点替换掉它。
    """
    if not els:
        return els
    if len(els) == 1:
        try:
            inner = els[0].find_elements(By.CSS_SELECTOR, sel)
        except Exception:  # noqa: BLE001
            inner = []
        return inner or els
    try:
        counts = driver.execute_script(
            "var sel = arguments[1];"
            "return arguments[0].map(function(e){return e.querySelectorAll(sel).length;});",
            els, sel)
    except Exception:  # noqa: BLE001
        return els
    keep = [e for e, c in zip(els, counts) if c < 2]
    return keep or els


def find_cards(driver):
    """返回当前页面的商品卡片元素列表（按兜底选择器依次尝试）。"""
    for els, sel in iter_card_candidates(driver):
        return els, sel
    return [], ""


def iter_card_candidates(driver):
    """把所有命中的卡片选择器都试一遍，yield (元素列表, 选择器)。

    这样即使某一套选择器只匹配到容器 / 解析不出字段，也还能换下一套。
    """
    seen = []
    for sel in CARD_SEL:
        try:
            els = driver.find_elements(By.CSS_SELECTOR, sel)
        except Exception:  # noqa: BLE001
            continue
        if not els:
            continue
        els = drop_containers(driver, els, sel)
        fresh = []
        for e in els:
            # WebElement 的 __eq__ 按浏览器内部 id 判等，跨次查询也准
            if any(e == s for s in seen):
                continue
            seen.append(e)
            fresh.append(e)
        if fresh:
            yield fresh, sel


# ======================================================================
# 浏览器
# ======================================================================
def find_local_chrome():
    """常见 Chrome/Edge 安装路径探测（Chrome 未装时可回落到 Edge）。"""
    cands = [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ]
    out = []
    for p in cands:
        if p and "%" not in p and os.path.exists(p):
            out.append(p)
    return out


def _add_common_options(opts, cfg, profile):
    # 1) 反自动化检测
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)

    # 2) 持久化用户目录 → 登录一次，长期免登录
    opts.add_argument(f"--user-data-dir={profile}")
    opts.add_argument("--profile-directory=Default")

    # 3) 常规稳定性 / 中文本地化
    opts.add_argument("--start-maximized")
    opts.add_argument("--window-size=1500,940")
    opts.add_argument("--lang=zh-CN")
    opts.add_argument("--disable-notifications")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-default-browser-check")
    opts.add_argument("--disable-infobars")
    opts.add_argument("--disable-popup-blocking")
    opts.add_argument("--remote-allow-origins=*")
    opts.add_experimental_option("prefs", {
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
    })
    if cfg.get("headless"):
        opts.add_argument("--headless=new")
        info("[警告] 已启用无头模式，1688 对无头浏览器拦截较严格，若结果为空请去掉 --headless。")
    return opts


def _start_chromium(cfg, profile, browser, binary):
    """按 browser=chrome|edge 启动；返回 (driver, 实际浏览器名)。"""
    if browser == "edge":
        from selenium.webdriver.edge.options import Options as EdgeOptions
        from selenium.webdriver.edge.service import Service as EdgeService
        opts = _add_common_options(EdgeOptions(), cfg, profile)
        if binary:
            opts.binary_location = binary
        try:
            return webdriver.Edge(options=opts), "Edge"
        except Exception:  # noqa: BLE001
            try:
                from webdriver_manager.microsoft import EdgeChromiumDriverManager
                return webdriver.Edge(service=EdgeService(EdgeChromiumDriverManager().install()),
                                      options=opts), "Edge"
            except Exception as e2:  # noqa: BLE001
                die(f"无法启动 Edge：{e2}")
    # chrome 分支
    opts = _add_common_options(Options(), cfg, profile)
    if binary:
        opts.binary_location = binary
        info(f"指定浏览器内核：{binary}")
    try:
        return webdriver.Chrome(options=opts), "Chrome"
    except Exception as e1:  # noqa: BLE001
        info(f"Selenium Manager 启动 Chrome 失败（{e1}），改用 webdriver_manager 重试…")
        try:
            from webdriver_manager.chrome import ChromeDriverManager
            return webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=opts), "Chrome"
        except Exception as e2:  # noqa: BLE001
            import re as _re
            if _re.search(r"cannot find|no such file|not exist|binary", str(e2), _re.I):
                die("未找到 Chrome 浏览器。可选方案：\n"
                    "  1) 安装 Google Chrome；或\n"
                    "  2) 用本机自带的 Edge 跑： python fetch_quotes_selenium.py --browser edge\n"
                    "  3) 指定已有内核路径：  python fetch_quotes_selenium.py --binary \"D:\\...\\chrome.exe\"\n"
                    f"原始错误：{e2}")
            die("无法启动 Chrome，请确认网络可访问 googlechromelabs（可设国内镜像：\n"
                "  setx CHROME_DRIVER_MIRROR https://registry.npmmirror.com/-/binary/chromedriver )\n"
                f"原始错误：{e2}")


def build_driver(cfg):
    ensure_selenium()

    profile = cfg["profile_dir"]
    if not os.path.isabs(profile):
        profile = os.path.join(HERE, profile)
    os.makedirs(profile, exist_ok=True)

    browser = str(cfg.get("browser") or "chrome").lower()
    binary = cfg.get("binary") or ""

    # auto：Chrome 装了就用 Chrome，否则回落 Edge
    if browser in ("auto", ""):
        local = find_local_chrome()
        chrome = [p for p in local if "chrome" in p.lower()]
        edge = [p for p in local if "edge" in p.lower()]
        if chrome:
            browser, binary = "chrome", binary or chrome[0]
        elif edge:
            browser, binary = "edge", binary or edge[0]
            info("[提示] 未检测到 Chrome，自动改用本机 Edge 内核。")
        else:
            browser = "chrome"

    driver, used = _start_chromium(cfg, profile, browser, binary)
    info(f"已启动 {used}（用户目录：{profile}）")

    # 4) 抹掉 navigator.webdriver 等自动化指纹
    try:
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": """
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN','zh']});
                Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
                window.chrome = window.chrome || {runtime: {}};
            """
        })
    except Exception:  # noqa: BLE001
        pass

    driver.set_page_load_timeout(int(cfg.get("page_timeout") or 25) + 15)
    return driver


def debug_shot(driver, tag):
    try:
        d = os.path.join(HERE, "debug")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, f"{tag}_{time.strftime('%H%M%S')}.png")
        driver.save_screenshot(p)
        info(f"    （已存现场截图：{p}）")
        # 同步存一份 DOM，方便 1688 改版后按真实 class 更新选择器
        try:
            h = os.path.splitext(p)[0] + ".html"
            with open(h, "w", encoding="utf-8") as f:
                f.write(driver.page_source or "")
            info(f"    （已存页面 HTML：{h}）")
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        pass


def detect_block(driver):
    """返回 '' / 'login' / 'captcha'。"""
    try:
        url = (driver.current_url or "").lower()
        if "login.1688.com" in url or "login.taobao.com" in url or "login.tmall" in url:
            return "login"
    except Exception:  # noqa: BLE001
        pass
    for sel in ("#nc_1_wrapper", ".nc-container", "#baxia-dialog-content",
                "iframe[src*='punish']", ".nc_wrapper"):
        try:
            if driver.find_elements(By.CSS_SELECTOR, sel):
                return "captcha"
        except Exception:  # noqa: BLE001
            continue
    return ""


def is_logged_in(driver):
    try:
        names = {c.get("name") for c in driver.get_cookies()}
        if names & LOGIN_COOKIES:
            return True
    except Exception:  # noqa: BLE001
        pass
    for sel in (".site-nav-user-nick", ".site-nav-login-info-nick", "#login-info",
                ".member-nick", ".nick-name"):
        try:
            if driver.find_elements(By.CSS_SELECTOR, sel):
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def ensure_login(driver, cfg):
    """首次运行需人工登录一次；之后靠 chrome_profile 免登录。"""
    info("检查 1688 登录状态…")
    driver.get(HOME_URL)
    human_delay(cfg, "首页加载")

    if is_logged_in(driver):
        info("√ 已登录（复用 chrome_profile 里的会话）")
        return True

    info("")
    info("!" * 62)
    info("  检测到尚未登录 1688。")
    info("  请在刚刚弹出的浏览器窗口里完成登录：")
    info("    · 推荐用「手机 1688 / 淘宝 App 扫码」登录（最快）")
    info("    · 登录成功后不用做任何操作，程序会自动继续")
    info("  登录信息会保存在 比价脚本/chrome_profile/ 里，下次不用再登。")
    info("!" * 62)
    info("")

    deadline = time.time() + float(cfg.get("login_wait") or 300)
    last_tip = 0
    while time.time() < deadline:
        time.sleep(float(cfg["delay"]))
        try:
            if is_logged_in(driver):
                info("√ 检测到登录成功，继续。")
                human_delay(cfg, "登录后稳定")
                return True
        except Exception:  # noqa: BLE001
            pass
        left = int(deadline - time.time())
        if left % 30 <= 3 and left != last_tip:
            last_tip = left
            info(f"    …等待登录中，剩余 {left}s")
    debug_shot(driver, "login_timeout")
    die("等待登录超时。请重新运行脚本，并在浏览器里完成登录（或用 --login-wait 延长等待时间）。")


def wait_human_if_blocked(driver, cfg, where):
    """抓取过程中遇到登录/滑块 → 暂停提示人工处理并轮询。"""
    reason = detect_block(driver)
    if not reason:
        return True
    tip = "需要登录" if reason == "login" else "出现了滑块/安全验证"
    info("")
    info(f"  ! 在「{where}」处{tip}，请在浏览器里手动处理（登录 / 拖动滑块）。")
    info("    处理完成后程序会自动继续（最多等待 " + str(int(cfg.get('login_wait') or 300)) + "s）。")
    deadline = time.time() + float(cfg.get("login_wait") or 300)
    while time.time() < deadline:
        time.sleep(float(cfg["delay"]))
        if not detect_block(driver):
            info("    √ 验证已通过，继续抓取。")
            human_delay(cfg, "验证后稳定")
            return True
    debug_shot(driver, "block_timeout")
    info(f"  × 「{where}」验证超时，跳过该项。")
    return False


# ======================================================================
# 抓取
# ======================================================================
def parse_card(card):
    """把一张商品卡片解析成 dict；解析失败返回 None。"""
    title = text_of(card, TITLE_SEL)
    price_text = text_of(card, PRICE_SEL)
    price = parse_price(price_text)
    if not title or price is None:
        return None

    url = attr_of(card, ["a[href*='offer/']", "a[href*='detail']", "a[href]"], "href") or ""
    shop = text_of(card, SHOP_SEL)
    moq = text_of(card, MOQ_SEL)
    loc = text_of(card, LOC_SEL)

    num_iid = ""
    m = OFFER_ID_RE.search(url or "")
    if m:
        num_iid = m.group(1)
    else:
        num_iid = attr_of(card, ["[data-offer-id]", "[data-id]"], "data-offer-id") \
            or attr_of(card, ["[data-id]"], "data-id")

    return {
        "title": title,
        "price": price,
        "price_text": price_text,
        "price_unit": price_unit(price_text),
        "shop": shop,
        "moq": moq,
        "location": loc,
        "url": url,
        "num_iid": str(num_iid or ""),
    }


def parse_cards(cards):
    """把一批卡片元素解析成去重后的行列表。"""
    rows, seen = [], set()
    for c in cards:
        try:
            n = parse_card(c)
        except Exception:  # noqa: BLE001
            continue
        if not n:
            continue
        key = n["num_iid"] or n["url"] or (n["title"] + str(n["price"]))
        if key in seen:
            continue
        seen.add(key)
        rows.append(n)
    return rows


def collect_page(driver, cfg):
    """抓取当前页卡片（含下滑懒加载），返回 (rows, 命中的卡片选择器)。"""
    # 等商品列表出现
    deadline = time.time() + float(cfg.get("page_timeout") or 25)
    cands = []
    while time.time() < deadline:
        cands = list(iter_card_candidates(driver))
        if cands:
            break
        if detect_block(driver):
            return [], ""
        time.sleep(0.8)

    if not cands:
        return [], ""

    # 下滑触发懒加载（与参考代码一致的节奏）：元素变多就刷新候选
    for i in range(int(cfg.get("scrolls") or 0)):
        try:
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        except Exception:  # noqa: BLE001
            break
        human_delay(cfg, f"下滑 {i + 1}/{cfg.get('scrolls')}")
        more = list(iter_card_candidates(driver))
        if more and sum(len(e) for e, _ in more) > sum(len(e) for e, _ in cands):
            cands = more

    # 回顶
    try:
        driver.execute_script("window.scrollTo(0, 0);")
    except Exception:  # noqa: BLE001
        pass

    # 逐套选择器试解析：哪套能解析出字段就用哪套
    fallback = ""
    for els, sel in cands:
        fallback = fallback or sel
        rows = parse_cards(els)
        if rows:
            return rows, sel
    return [], fallback


def click_next(driver, cfg):
    for sel in NEXT_SEL:
        try:
            els = driver.find_elements(By.CSS_SELECTOR, sel)
        except Exception:  # noqa: BLE001
            continue
        for el in els:
            try:
                cls = (el.get_attribute("class") or "").lower()
                if "disabled" in cls:
                    continue
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
                human_delay(cfg)
                driver.execute_script("arguments[0].click();", el)
                return True
            except Exception:  # noqa: BLE001
                continue
    return False


def is_no_results_page(driver):
    """1688 在反爬命中时会返回「哎哟喂，这里空空如也~」占位页——用来识别。"""
    try:
        body = driver.find_element(By.CSS_SELECTOR, "body").text
        return NO_RESULT_TEXT in body
    except Exception:
        return False


def _ensure_main_window(driver, cfg):
    """
    确保 driver 当前焦点在「1688 首页」窗口；关掉所有其它窗口。
    1688 搜索 form 的 target="_blank" 会开新标签，搜下一个词前需要先关掉。
    """
    main = getattr(driver, "_main_window_handle", None)
    if main and main in driver.window_handles:
        for h in driver.window_handles:
            if h != main:
                try:
                    driver.switch_to.window(h)
                    driver.close()
                except Exception:
                    pass
        try:
            driver.switch_to.window(main)
        except Exception:
            pass
        return main

    # 没有记录的主窗口：找当前任何非搜索结果页
    for h in driver.window_handles:
        try:
            driver.switch_to.window(h)
            url = (driver.current_url or "").lower()
            if "1688.com" in url and "/selloffer/offer_search" not in url:
                driver._main_window_handle = h
                return h
        except Exception:
            continue

    # 实在没有就打开首页
    driver.get(HOME_URL)
    human_delay(cfg, "首次访问 1688 首页")
    driver._main_window_handle = driver.current_window_handle
    return driver._main_window_handle


def search_via_homepage(driver, cfg, keyword):
    """
    从 1688 首页搜索框输入关键词再点搜索——模拟真人操作。

    1688 对 Selenium 直接打开 `s.1688.com/selloffer/offer_search.htm?keywords=...`
    这种「裸链接」会做反爬：把搜索词改写成乱码（如「消毒液消铯锅烯萸」）并返回
    「空空如也」的占位页。走首页搜索框则走真实搜索接口，能拿到正常结果。

    1688 搜索 form 是 `<form id="alisearch-form" target="_blank">`——点搜索会在
    **新标签页**打开结果，所以本函数最后会把 driver 切到新窗口。

    成功提交返回 True；找不到搜索框时返回 False（调用方应回落 URL 直跳）。
    """
    from selenium.webdriver.common.keys import Keys as _Keys

    # 1) 先回首页窗口
    main_handle = _ensure_main_window(driver, cfg)
    cur = (driver.current_url or "").lower()
    if "1688.com" not in cur or "/selloffer/offer_search" in cur:
        driver.get(HOME_URL)
        human_delay(cfg, "回到 1688 首页")
        driver._main_window_handle = driver.current_window_handle
        main_handle = driver._main_window_handle

    # 2) 等搜索框出现（首页 JS 异步渲染，最多等 10 秒）
    inp = None
    deadline = time.time() + 10
    while time.time() < deadline and inp is None:
        for sel in HOME_SEARCH_INPUT_SEL:
            try:
                cand = driver.find_element(By.CSS_SELECTOR, sel)
                if cand and cand.is_displayed():
                    inp = cand
                    break
            except Exception:
                continue
        if inp is None:
            time.sleep(0.4)
    if inp is None:
        return False

    # 3) 聚焦 + 清空
    try:
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", inp)
        inp.click()
    except Exception:
        pass
    try:
        inp.clear()
    except Exception:
        pass
    human_delay(cfg, "准备输入")

    # 4) 一个字一个字敲（更像真人，避免一次性 send_keys 触发风控）
    for ch in keyword:
        inp.send_keys(ch)
        time.sleep(random.uniform(0.04, 0.16))
    human_delay(cfg, "关键词输入完毕")

    # 5) 提交：点搜索按钮（form target=_blank 会开新窗口）
    submitted = False
    for sel in HOME_SEARCH_BTN_SEL:
        try:
            btn = driver.find_element(By.CSS_SELECTOR, sel)
            if btn and btn.is_displayed():
                btn.click()
                submitted = True
                break
        except Exception:
            continue
    if not submitted:
        try:
            inp.send_keys(_Keys.RETURN)
        except Exception:
            pass

    # 6) 等新窗口出现，切换过去（1688 form 的 target=_blank）
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            new_handles = [h for h in driver.window_handles if h != main_handle]
            if new_handles:
                driver.switch_to.window(new_handles[0])
                return True
        except Exception:
            pass
        time.sleep(0.3)

    # 没有新窗口（form target 可能改了），保持当前窗口也算成功
    return True


def grab_keyword(driver, cfg, keyword):
    """搜一个关键词，返回 (rows, status)。status ∈ ok/blocked/empty/error。"""
    kw_used = keyword
    suffix = (cfg.get("keyword_suffix") or "").strip()
    if suffix and suffix not in kw_used:
        kw_used = f"{kw_used} {suffix}".strip()

    # 默认走首页搜索框（最像真人，1688 不会改关键词）；
    # 找不到搜索框时才回落 URL 直跳（保底）。
    used_homepage = search_via_homepage(driver, cfg, kw_used)
    if used_homepage:
        info("    · 已通过 1688 首页搜索框提交（防关键词改写）")
    else:
        url = SEARCH_URL.format(kw=quote(kw_used))
        try:
            driver.get(url)
            info("    （兜底：URL 直跳 1688 搜索页）")
        except Exception as e:  # noqa: BLE001
            info(f"    × 打开搜索页失败：{e}")
            return [], "error"
    human_delay(cfg, "搜索结果加载")

    if not wait_human_if_blocked(driver, cfg, f"搜索「{kw_used}」"):
        return [], "blocked"

    rows, used_sel = collect_page(driver, cfg)
    if not rows:
        if is_no_results_page(driver):
            info("    ! 1688 返回了「空空如也」占位页——可能是反爬命中，关键词被改写")
            debug_shot(driver, "noresult_" + re.sub(r"\W+", "", kw_used)[:12])
            return [], "blocked"
        # 再给一次机会（有时首屏慢）
        human_delay(cfg, "首屏为空，重试")
        if not wait_human_if_blocked(driver, cfg, f"搜索「{kw_used}」二次"):
            return [], "blocked"
        rows, used_sel = collect_page(driver, cfg)
    if not rows:
        debug_shot(driver, "empty_" + re.sub(r"\W+", "", kw_used)[:12])
        return [], "empty"
    info(f"    命中卡片选择器 {used_sel}，本页 {len(rows)} 条")

    # 翻页
    pages = int(cfg.get("pages") or 1)
    for p in range(2, pages + 1):
        human_delay(cfg, f"翻到第 {p} 页")
        if not click_next(driver, cfg):
            info(f"    （第 {p} 页：未找到可点的下一页，停止翻页）")
            break
        human_delay(cfg, f"第 {p} 页加载")
        if not wait_human_if_blocked(driver, cfg, f"第 {p} 页"):
            break
        more, _ = collect_page(driver, cfg)
        if not more:
            break
        rows.extend(more)
    return rows, "ok"


def to_result_items(raw_rows, task_item, cfg):
    """把卡片明细转成系统可导入的报价条目（最便宜的 top_n 条）。"""
    gname = task_item.get("ingName") or task_item.get("ingId")
    buy_unit = (task_item.get("buy") or "").strip()
    conv = float(task_item.get("conv") or 1) or 1
    kw = (task_item.get("keyword") or gname or "").strip()
    core = core_word(kw)

    raw_rows.sort(key=lambda r: r["price"])
    out = []
    for i, n in enumerate(raw_rows[: int(cfg.get("top_n") or 3)]):
        price = float(n["price"])
        notes = []
        if n.get("price_text") and n["price_text"] not in (f"{price:g}", f"¥{price:g}"):
            notes.append(f"价签:{n['price_text']}")
        if n.get("moq"):
            notes.append(f"起订:{n['moq']}")
        pu = n.get("price_unit") or ""
        if pu and buy_unit and pu != buy_unit:
            notes.append(f"页面单位/{pu}（任务采购单位:{buy_unit}）需核对")
        if core and core not in n["title"]:
            notes.append("标题未含核心词，需核对是否同品")
        notes.append(f"规格核对:{n['title'][:36]}")
        if n.get("num_iid"):
            notes.append(f"商品ID:{n['num_iid']}")
        if conv != 1:
            notes.append("任务换算率≠1，规格口径务必人工核对")

        out.append({
            "ingId": task_item.get("ingId"),
            "ingName": gname,
            "keyword": kw,
            "source": cfg["source"] + (f" #{i + 1}" if i else ""),
            "price": price,
            "per": "buy",
            "unitPrice": round(price / conv, 4),
            "minQty": n.get("moq") or "",
            "shop": n.get("shop") or "",
            "location": n.get("location") or "",
            "url": n.get("url") or "",
            "date": date.today().isoformat(),
            "title": n["title"],
            "numIid": n.get("num_iid") or "",
            "note": " | ".join(notes),
        })
    return out


def dry_run_rows(cfg, items, task):
    """不开浏览器的联调模式：造同构假数据，用于验证 → 导入 → 比价 全链路。"""
    results = []
    for it in items:
        conv = float(it.get("conv") or 1) or 1
        base = float(it.get("avg") or 10) or 10
        for i in range(int(cfg.get("top_n") or 3)):
            price = round(base * (0.92 + 0.05 * i), 2)
            results.append({
                "ingId": it.get("ingId"), "ingName": it.get("ingName"), "keyword": it.get("keyword"),
                "source": cfg["source"] + f"(示例) #{i + 1}", "price": price, "per": "buy",
                "unitPrice": round(price / conv, 4), "minQty": f"{10 * (i + 1)}件",
                "shop": f"示例供应商{i + 1}", "location": "浙江 义乌",
                "url": "https://detail.1688.com/offer/10000000.html",
                "date": date.today().isoformat(),
                "title": f"{it.get('ingName')}（dry-run 示例商品）", "numIid": "10000000",
                "note": "dry-run 示例数据，非真实报价，请勿导入正式数据",
            })
    return results


# ======================================================================
# 主流程
# ======================================================================
def load_cfg(args):
    cfg = dict(DEFAULTS)
    # 允许在 config.json 里写 selenium 段覆盖默认值，方便不敲命令行
    cfg_path = args.config
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                user = json.load(f)
            for k, v in (user.get("selenium") or {}).items():
                cfg[k] = v
        except Exception as e:  # noqa: BLE001
            info(f"[提示] 读取 config.json 的 selenium 段失败，使用默认值：{e}")
    if args.delay is not None:
        cfg["delay"] = args.delay
    if args.top_n is not None:
        cfg["top_n"] = args.top_n
    if args.pages is not None:
        cfg["pages"] = args.pages
    if args.headless:
        cfg["headless"] = True
    if args.source:
        cfg["source"] = args.source
    if args.profile:
        cfg["profile_dir"] = args.profile
    if args.browser:
        cfg["browser"] = args.browser
    if args.binary:
        cfg["binary"] = args.binary
    return cfg


def main():
    ap = argparse.ArgumentParser(description="熊猫五福餐厅 · 1688 Selenium 网页抓价")
    ap.add_argument("--task", help="待比价任务.json 路径（默认自动找最新）")
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"), help="配置文件路径")
    ap.add_argument("--out", default=HERE, help="输出目录（默认脚本所在目录）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 种原料")
    ap.add_argument("--keyword", help="只搜这一个关键词（调试用，忽略任务清单）")
    ap.add_argument("--delay", type=float, default=None, help="每次操作间隔秒数（默认 2.5）")
    ap.add_argument("--top-n", type=int, default=None, help="每个关键词取最便宜的前 N 条（默认 3）")
    ap.add_argument("--pages", type=int, default=None, help="尝试翻页数（默认 1）")
    ap.add_argument("--profile", default=None, help="Chrome 用户目录（默认 比价脚本/chrome_profile）")
    ap.add_argument("--source", default=None, help="写入结果的来源标签（默认 1688(网页)）")
    ap.add_argument("--headless", action="store_true", help="无头模式（1688 易拦截，仅备选）")
    ap.add_argument("--browser", default=None, choices=["chrome", "edge", "auto"],
                    help="用哪个浏览器内核（默认 chrome；没装 Chrome 可 --browser edge）")
    ap.add_argument("--binary", default=None, help="直接指定浏览器 exe 路径（自动探测失败时用）")
    ap.add_argument("--no-login-check", action="store_true", help="跳过启动时的登录检查")
    ap.add_argument("--dry-run", action="store_true", help="不开浏览器，仅验证输出链路")
    args = ap.parse_args()

    cfg = load_cfg(args)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    info("=" * 62)
    info("熊猫五福餐厅 · 外接比价（Selenium 网页抓价）")
    info("=" * 62)
    info(f"节奏：每次操作间隔 {cfg['delay']}s（±{cfg.get('jitter', 0)}）"
         f" · 每词取最低 {cfg['top_n']} 条 · 下滑 {cfg['scrolls']} 次 · 翻页 {cfg['pages']}")
    info(f"输出目录：{out_dir}")

    # ---------- 单关键词调试模式 ----------
    if args.keyword:
        task = {"rest": "熊猫五福餐厅", "items": [{
            "ingId": "DEBUG", "ingName": args.keyword, "cat": "调试",
            "unit": "件", "buy": "件", "conv": 1, "avg": 0, "keyword": args.keyword,
        }]}
        items = task["items"]
    else:
        task_path = find_task_file(args.task)
        info(f"任务文件：{task_path}")
        task, items = load_task(task_path)
        if args.limit and args.limit > 0:
            items = items[: args.limit]
        info(f"待抓取原料：{len(items)} 种")

    # ---------- dry-run ----------
    if args.dry_run:
        info("[dry-run] 不启动浏览器，生成示例结果验证链路…")
        results = dry_run_rows(cfg, items, task)
        stats = {"total": len(items), "ok": len(items), "empty": 0, "skip": 0, "engine": "selenium(dry-run)"}
        write_json(out_dir, task, cfg, results, stats)
        write_excel(out_dir, task, cfg, results)
        info(f"\n[dry-run] 完成，共 {len(results)} 条示例报价。")
        return

    # ---------- 真实抓取 ----------
    driver = build_driver(cfg)
    results, skipped = [], []
    stats = {"total": len(items), "ok": 0, "empty": 0, "skip": 0, "blocked": 0,
             "engine": "selenium", "delay": cfg["delay"]}
    try:
        if not args.no_login_check:
            ensure_login(driver, cfg)

        for idx, it in enumerate(items, 1):
            gname = it.get("ingName") or it.get("ingId")
            conv = float(it.get("conv") or 1) or 1
            info(f"[{idx}/{len(items)}] {gname}")

            if conv != 1 and not cfg.get("allow_conv_grab", False):
                info(f"  - 换算率 {conv}≠1，跳过（如需强制抓取，在 config.json 的 selenium 段设 "
                     f"\"allow_conv_grab\": true，并人工核对规格）")
                skipped.append(gname)
                stats["skip"] += 1
                continue

            kw = (it.get("keyword") or gname or "").strip()
            info(f"  - 搜索「{kw}」…")
            rows, status = grab_keyword(driver, cfg, kw)

            if status in ("ok",) and rows:
                got = to_result_items(rows, it, cfg)
                results.extend(got)
                stats["ok"] += 1
                info(f"    √ 取最低 {len(got)} 条：{got[0]['price']} 元/{it.get('buy')}"
                     f"（{got[0]['shop'] or '供应商未知'}）")
            else:
                skipped.append(gname)
                if status == "blocked":
                    stats["blocked"] += 1
                elif status == "empty":
                    stats["empty"] += 1
                else:
                    stats["skip"] += 1
                info(f"    × 无有效结果（{status}）")

            if idx < len(items):
                human_delay(cfg, "下一个关键词前")

            # 每 10 个保存一次中间结果，避免中途崩了白跑
            if idx % 10 == 0 and results:
                write_json(out_dir, task, cfg, results, stats)
                info("    （已保存中间结果）")
    finally:
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass

    write_json(out_dir, task, cfg, results, stats)
    write_excel(out_dir, task, cfg, results)

    info("\n" + "-" * 62)
    info(f"完成：成功 {stats['ok']} 种 · 无结果 {stats['empty']} 种 · "
         f"跳过 {stats['skip']} 种 · 被拦截 {stats['blocked']} 种 · 共 {len(results)} 条报价")
    if skipped:
        info("未抓到报价：" + "、".join(skipped[:20]) + ("…" if len(skipped) > 20 else ""))
    if stats["blocked"]:
        info("提示：出现滑块/登录拦截时，请在浏览器里手动处理；也可调大 --delay（如 4~5s）降低频率。")
    info(f"下一步：回到系统「外接比价」页点击「导入比价结果」，选择 {RESULT_NAME}")
    info("-" * 62)


if __name__ == "__main__":
    main()
