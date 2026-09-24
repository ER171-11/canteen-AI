import re
html = open('debug/home_dump.html', encoding='utf-8').read()
print('--- placeholders ---')
for m in re.finditer(r'placeholder="([^"]*)"', html):
    if m.group(1).strip():
        print(' ', m.group(1))
print()
print('--- searchBtn 前后 800 字 ---')
idx = html.find('searchBtn')
print(html[max(0, idx-800): idx+200])
print()
print('--- 找含 search/关键词 的 input ---')
for m in re.finditer(r'<(input|textarea)[^>]{0,400}>', html, re.I):
    tag = m.group(0)
    if 'search' in tag.lower() or '关键词' in tag or 'keyword' in tag.lower():
        print(' ', tag[:300])
        print('---')