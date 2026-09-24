"""诊断脚本：搜索一个关键词，逐条打印 CARD_SEL 的命中数，并验证解析结果。

用法（在 比价脚本 目录下）：
    python _smoke_cards.py                 # 默认关键词 donggu
    python _smoke_cards.py 冬菇
1688 改版导致抓不到商品时，跑这个脚本看：
  - 哪条选择器能命中、命中多少
  - 命中的卡片能否解析出 标题/价格
  - debug/ 下会存一份 HTML，可按真实 class 更新 CARD_SEL
"""
import os
import sys
import time
import argparse

sys.stdout.reconfigure(encoding='utf-8')
os.chdir(os.path.dirname(os.path.abspath(__file__)))

import fetch_quotes_selenium as f  # noqa: E402

KW = (sys.argv[1] if len(sys.argv) > 1 else 'donggu').strip()

cfg = f.load_cfg(argparse.Namespace(
    config='config.json', delay=1.0, top_n=None, pages=None,
    headless=False, source=None, profile=None, browser=None, binary=None
))
driver = f.build_driver(cfg)

try:
    f.ensure_login(driver, cfg)
    if not f.search_via_homepage(driver, cfg, KW):
        driver.get(f.SEARCH_URL.format(kw=f.quote(KW)))
        print('（首页搜索框未命中，改用 URL 直跳）')
    time.sleep(float(cfg.get('page_timeout') or 25))

    os.makedirs('debug', exist_ok=True)
    html = driver.page_source or ''
    open('debug/cards_dump.html', 'w', encoding='utf-8').write(html)
    print(f'页面 HTML 大小: {len(html)}  → debug/cards_dump.html')

    print('\n--- CARD_SEL 逐条命中情况 ---')
    for sel in f.CARD_SEL:
        try:
            els = driver.find_elements('css selector', sel)
        except Exception as e:  # noqa: BLE001
            print(f'  [ERR ] {sel}  ({e.__class__.__name__})')
            continue
        if not els:
            print(f'  [ -- ] {sel}  → 0')
            continue
        pruned = f.drop_containers(driver, els, sel)
        print(f'  [ OK ] {sel}  → {len(els)} 个，去容器后 {len(pruned)} 个')

    print('\n--- 解析结果（走 iter_card_candidates 的兜底顺序）---')
    hit = False
    for els, sel in f.iter_card_candidates(driver):
        rows = f.parse_cards(els)
        print(f'  选择器 {sel}: 元素 {len(els)} 个 → 解析出 {len(rows)} 条')
        if rows:
            hit = True
            for r in rows[:5]:
                print(f'    · ¥{r["price"]} / {r["price_unit"] or "-"} | {r["title"][:40]}')
            break
    if not hit:
        print('  !! 所有选择器都解析失败——请打开 debug/cards_dump.html 按真实 class 更新 CARD_SEL')
        f.debug_shot(driver, 'smoke_empty_' + f.re.sub(r'\W+', '', KW)[:12])
finally:
    driver.quit()
