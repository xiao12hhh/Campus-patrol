"""取几个地标的局部坐标，给近距离截图定机位。"""
import json, pathlib

p = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视\public\data\campus-local.json')
d = json.loads(p.read_text(encoding='utf-8'))

want = ['主楼A座', '第三教学楼', '汇才学生公寓5号楼', '图书馆']
for f in d['features']:
    if f.get('name') in want and f['kind'] == 'building':
        g = f['geometry']
        ring = g['coordinates'][0][0] if g['type'] == 'MultiPolygon' else g['coordinates'][0]
        xs = [q[0] for q in ring]; zs = [q[1] for q in ring]
        print('%-14s center=(%.1f, %.1f) h=%s levels=%s' % (
            f['name'], sum(xs) / len(xs), sum(zs) / len(zs), f.get('height'),
            (f.get('properties') or {}).get('levels')))
