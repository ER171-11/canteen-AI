import re
html = open('debug/result_dump.html', encoding='utf-8').read()
print('size:', len(html))
seen = set()
for p in ['offer','card','product','item']:
    n=0
    for m in re.finditer('class="([^"]*'+p+'[^"]*)"', html):
        v=m.group(1)
        if v not in seen:
            seen.add(v); n+=1
            if n<=8: print(p,'|',v[:100])
    print()
print('-- href=offer --')
for m in re.finditer(r'href="([^"]*?offer/\d+\.html[^"]*)"', html):
    print(' ',m.group(1)[:120])
print('-- data-* attr near price --')
for m in re.finditer(r'>([A-Za-z0-9]+-[A-Za-z0-9]+)</g>', html):
    pass
# 用更稳的：找 priceSpan