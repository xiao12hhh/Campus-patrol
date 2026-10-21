# -*- coding: utf-8 -*-
import json, urllib.request

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
data = json.loads(opener.open('http://127.0.0.1:8000/api/robots', timeout=10).read().decode('utf-8'))
robots = data if isinstance(data, list) else data.get('robots', [])
out = []
for r in robots:
    out.append('%s x=%s z=%s heading=%s status=%s' % (r.get('id'), r.get('x'), r.get('z'), r.get('heading'), r.get('status')))
open(r'E:\agent-work\数据结构-笔记\校园巡视\_robots.txt', 'w', encoding='utf-8').write('\n'.join(out))
print('ok')
