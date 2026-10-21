"""看看官方源里 building_part / min_level 那几条，判断怎么落到场景里。"""
import json, pathlib

p = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视\data\sources\cupb-official-3d.json')
d = json.loads(p.read_text(encoding='utf-8'))


def flat(c):
    if isinstance(c[0], (int, float)):
        yield c
    else:
        for i in c:
            yield from flat(i)


for f in d['features']:
    pr = f.get('properties') or {}
    if pr.get('building_part') or pr.get('building:min_level') not in (None, '0'):
        pts = list(flat(f['geometry']['coordinates']))
        xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
        print('%-18s part=%-12s min_level=%-4s levels=%-3s h=%-4s 类别=%s' % (
            pr.get('name'), pr.get('building_part'), pr.get('building:min_level'),
            pr.get('楼层数'), pr.get('height'), pr.get('polygon_category')))
        print('    bbox lon %.5f~%.5f lat %.5f~%.5f  点数 %d  type=%s' % (
            min(xs), max(xs), min(ys), max(ys), len(pts), f['geometry']['type']))

print('\n--- 有 min_level != 0 的（地下层）---')
n = 0
for f in d['features']:
    pr = f.get('properties') or {}
    ml = pr.get('building:min_level')
    if ml not in (None, '0'):
        n += 1
print('共', n, '栋')
print('\n--- building_part 非空的 ---')
for f in d['features']:
    pr = f.get('properties') or {}
    if pr.get('building_part'):
        print(' ', pr.get('name'), '|', pr.get('building_part'), '| h=', pr.get('height'))
