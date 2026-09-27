"""Dump 1688 首页 HTML，定位真正的搜索输入框选择器"""
import os, sys, time
sys.stdout.reconfigure(encoding='utf-8')
os.chdir('c:/Users/mingyzhikui/Desktop/餐厅/餐厅系统/比价脚本')
import fetch_quotes_selenium as f

cfg = f.load_cfg(__import__('argparse').Namespace(
    config='config.json', delay=0.5, top_n=None, pages=None,
    headless=False, source=None, profile=None, browser=None, binary=None
))
driver = f.build_driver(cfg)

driver.get('https://www.1688.com/')
time.sleep(8)  # 给 JS 充分时间渲染

# 1) dump 整页 HTML
html = driver.page_source
print('页面 HTML 大小:', len(html))
open('debug/home_dump.html', 'w', encoding='utf-8').write(html)
print('已存: debug/home_dump.html')

# 2) 所有 input
print('\n--- 所有 input 元素 ---')
for i, el in enumerate(driver.find_elements('css selector', 'input')):
    attrs = {}
    for k in ('type','name','id','class','placeholder','aria-label','value'):
        try: attrs[k] = el.get_attribute(k)
        except: pass
    if any(v for v in attrs.values()):
        print(' ', i, attrs)

# 3) 所有 button
print('\n--- 所有 button 元素 ---')
for i, el in enumerate(driver.find_elements('css selector', 'button')):
    txt = (el.text or '').strip()[:20]
    cls = el.get_attribute('class') or ''
    typ = el.get_attribute('type') or ''
    if txt or cls or typ:
        print(' ', i, '|', repr(txt), '| class=', cls[:40], '| type=', typ)

driver.quit()