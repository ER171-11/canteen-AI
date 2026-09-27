import re
h = open('debug/result_dump.html', encoding='utf-8').read()
print('-- title --')
s=set()
for m in re.finditer(r'class="([^"]*(?:title|subject)[^"]*)"', h, re.I):
    v=m.group(1)
    if v not in s:
        s.add(v)
        if len(s)<=20: print(v[:120])
print('-- price --')
s=set()
for m in re.finditer(r'class="([^"]*price[^"]*)"', h, re.I):
    v=m.group(1)
    if v not in s:
        s.add(v)
        if len(s)<=15: print(v[:120])