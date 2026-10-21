"""确认 campus-local.json 里有没有 levels（层数），以及和 height 是否自洽。"""
import json, pathlib, collections

p = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视\public\data\campus-local.json')
d = json.loads(p.read_text(encoding='utf-8'))
bs = [f for f in d['features'] if f['kind'] == 'building' and f.get('in_campus')]

have = [f for f in bs if (f.get('properties') or {}).get('levels')]
print('校内建筑 %d，带 levels 的 %d' % (len(bs), len(have)))

c = collections.Counter((f['properties']['levels']) for f in have)
print('levels 分布:', dict(sorted(c.items(), key=lambda kv: str(kv[0]))))

print('\n抽样 15 栋（name / height / levels / 每层层高 m / building）:')
for f in have[:15]:
    pr = f['properties']
    lv = pr['levels']
    if isinstance(lv, str):
        try:
            lv = int(float(lv))
        except Exception:
            lv = None
    h = f.get('height') or 0
    pm = (h * 10 / lv) if lv else 0
    print('  %-20s h=%-5s lv=%-4s %.2f m/层  %s' % (f.get('name', '')[:20], h, lv, pm, pr.get('building')))

# levels 的类型
print('\nlevels 类型:', set(type(f['properties']['levels']).__name__ for f in have))
# key 汇总
keys = collections.Counter()
for f in bs:
    for k in (f.get('properties') or {}):
        keys[k] += 1
print('properties key:', dict(keys))
