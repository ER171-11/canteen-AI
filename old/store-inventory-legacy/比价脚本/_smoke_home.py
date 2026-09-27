"""
真实浏览器烟测：验证"首页搜索框"路径不再触发 1688 关键词改写。
不需要登录——只验证搜索栏的 input/button 选择器是否真的能在首页找到，
并验证搜完之后关键词不会被改写成乱码。
"""
import os, sys, time
from urllib.parse import quote
sys.stdout.reconfigure(encoding='utf-8')
os.chdir('c:/Users/mingyzhikui/Desktop/餐厅/餐厅系统/比价脚本')
import fetch_quotes_selenium as f

cfg = f.load_cfg(__import__('argparse').Namespace(
    config='config.json', delay=0.5, top_n=None, pages=None,
    headless=False, source=None, profile=None, browser=None, binary=None
))
print('=== 配置载入 ===', {k: cfg[k] for k in ('browser','delay','pages','top_n')})

print('\n=== 启动浏览器（不登录态测）===')
driver = f.build_driver(cfg)

print('\n=== A) 直跳搜索 URL（旧的反爬路径）===')
driver.get('https://s.1688.com/selloffer/offer_search.htm?keywords=' + quote('东古一品鲜'))
time.sleep(6)
try:
    inp = driver.find_element('css selector', "input[placeholder*='搜索'], input[name='keywords'], #search-key, input.header-search-input")
    print('  搜索框输入值:', repr(inp.get_attribute('value')))
except Exception as e:
    print('  没找到搜索框:', e)
body = driver.find_element('css selector','body').text
print('  是否含「空空如也」:', '空空如也' in body)
f.debug_shot(driver, 'test_direct')

print('\n=== B) 走首页搜索框（新的反爬绕过路径）===')
ok = f.search_via_homepage(driver, cfg, '东古一品鲜')
print('  search_via_homepage 返回:', ok)
time.sleep(6)
try:
    inp = driver.find_element('css selector', "input[placeholder*='搜索'], input[name='keywords'], #search-key, input.header-search-input")
    print('  搜索框输入值:', repr(inp.get_attribute('value')))
except Exception as e:
    print('  没找到搜索框:', e)
body = driver.find_element('css selector','body').text
print('  是否含「空空如也」:', '空空如也' in body)
print('  URL:', driver.current_url)
f.debug_shot(driver, 'test_homepage')

driver.quit()
print('\n=== 完成，看 比价脚本/debug/ 下的 test_direct_*.png / test_homepage_*.png ===')