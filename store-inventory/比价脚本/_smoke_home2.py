"""
真实浏览器烟测：走「首页搜索框」路径，验证：
1) 1688 搜索框能被脚本找到
2) 输入关键词后，新窗口打开搜索结果页
3) 搜索框不再被改成乱码
4) 能命中商品卡片
"""
import os, sys, time
sys.stdout.reconfigure(encoding='utf-8')
os.chdir('c:/Users/mingyzhikui/Desktop/餐厅/餐厅系统/比价脚本')
import fetch_quotes_selenium as f

cfg = f.load_cfg(__import__('argparse').Namespace(
    config='config.json', delay=0.8, top_n=None, pages=None,
    headless=False, source=None, profile=None, browser=None, binary=None
))
driver = f.build_driver(cfg)

print('=== 走首页搜索：东古一品鲜 ===')
ok = f.search_via_homepage(driver, cfg, '东古一品鲜')
print('  search_via_homepage 返回:', ok)
print('  当前 URL:', driver.current_url)
print('  当前窗口数:', len(driver.window_handles))

# 等结果加载
time.sleep(6)
print('  URL (6s 后):', driver.current_url)

# 看输入框
try:
    inp = driver.find_element('css selector', '#alisearch-input, textarea[name="keywords"]')
    print('  首页搜索框 value:', repr(inp.get_attribute('value')))
except Exception:
    print('  首页搜索框: 不在当前窗口（说明已切到搜索结果）')

# 看结果页是否含「空空如也」
try:
    body = driver.find_element('css selector', 'body').text
    print('  结果页含「空空如也」:', '空空如也' in body)
    print('  结果页含「东古」:', '东古' in body)
except Exception as e:
    print('  body 读取失败:', e)

# 找商品卡片
rows, used_sel = f.collect_page(driver, cfg)
print('  命中商品卡片数:', len(rows), '(选择器:', used_sel or '无', ')')
f.debug_shot(driver, 'v2_homepage')

driver.quit()