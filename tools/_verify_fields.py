"""校验 v3.1 回填字段是否落到 campus-local.json。"""
import json, pathlib, collections

p = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视\public\data\campus-local.json')
d = json.loads(p.read_text(encoding='utf-8'))
bs = [f for f in d['features'] if f['kind'] == 'building' and f.get('in_campus')]
print('校内建筑', len(bs))

lv = [f for f in bs if (f.get('properties') or {}).get('levels')]
ml = [f for f in bs if (f.get('properties') or {}).get('min_level', 0) < 0]
parts = [f for f in bs if (f.get('properties') or {}).get('part')]
far = [f for f in bs if (f.get('properties') or {}).get('floor_area')]
print('levels %d | min_level<0 %d | part %d | floor_area %d' % (len(lv), len(ml), len(parts), len(far)))

print('\n有地下层的 14 栋:')
for f in ml[:20]:
    pr = f['properties']
    print('  %-16s levels=%-3s h=%-5s %s m2' % (f.get('name') or '(无名)', pr.get('levels'),
                                                f.get('height'), pr.get('floor_area')))

print('\npart（官方门体块）:')
for f in parts:
    pr = f['properties']
    r = f['geometry']['coordinates'][0][0] if f['geometry']['type'] == 'MultiPolygon' else f['geometry']['coordinates'][0]
    xs = [q[0] for q in r]; zs = [q[1] for q in r]
    print('  %-8s part=%-12s h=%-4s %.1f x %.1f m' % (f.get('name') or '(无名)', pr.get('part'),
                                                      f.get('height'), (max(xs) - min(xs)) * 10, (max(zs) - min(zs)) * 10))

print('\n随机抽样 8 栋完整属性:')
for f in bs[:8]:
    print('  %-16s %s' % (f.get('name') or '(无名)', json.dumps(f['properties'], ensure_ascii=False)))
