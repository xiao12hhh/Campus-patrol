"""量一下建筑数据的量级，给工艺细节定参数用。"""
import json, pathlib, statistics as st

p = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视\public\data\campus-local.json')
d = json.loads(p.read_text(encoding='utf-8'))
print('unit_meters =', d['unit_meters'], '| version', d['version'], '| axis', d.get('axis'))
print('features =', len(d['features']))


def ring_of(f):
    g = f['geometry']
    if g['type'] == 'Polygon':
        return g['coordinates'][0]
    if g['type'] == 'MultiPolygon':
        return g['coordinates'][0][0]
    return None


def area(r):
    s = 0
    for i in range(len(r) - 1):
        a, b = r[i], r[i + 1]
        s += a[0] * b[1] - b[0] * a[1]
    return abs(s) / 2


bs = [f for f in d['features'] if f['kind'] == 'building' and f.get('in_campus')]
print('校内建筑', len(bs))

hs = [f['height'] for f in bs if f.get('height')]
print('height raw: min %.2f max %.2f median %.2f' % (min(hs), max(hs), st.median(hs)))
cnt = sum(1 for f in bs if (f.get('properties') or {}).get('楼层数'))
print('带楼层数标签的建筑', cnt)

# 用楼高/层数反推每层米数，判断 height 字段单位
rows = []
for f in bs:
    p_ = f.get('properties') or {}
    fl = p_.get('楼层数')
    try:
        fl = int(float(fl))
    except Exception:
        continue
    if f.get('height') and fl >= 2:
        rows.append(f['height'] / fl)
if rows:
    print('height/楼层数 = %.3f (中位)  -> 若 units=10m 则每层 %.1f m' % (st.median(rows), st.median(rows) * 10))

areas = sorted(area(ring_of(f)) for f in bs if ring_of(f))
print('屋顶面积(平方单位): min %.2f 中位 %.2f max %.2f  合计 %.1f'
      % (min(areas), st.median(areas), max(areas), sum(areas)))

pts = [len(ring_of(f)) for f in bs if ring_of(f)]
print('轮廓点数: min %d 中位 %d max %d 合计 %d' % (min(pts), st.median(pts), max(pts), sum(pts)))

named = [f for f in bs if f.get('name')]
named.sort(key=lambda f: -f.get('height', 0))
print('\n最高的 12 栋:')
for f in named[:12]:
    p_ = f.get('properties') or {}
    print('  %-22s h=%.2f 层=%s type=%s area=%.1f pts=%d'
          % (f['name'][:22], f.get('height', 0), p_.get('楼层数'), p_.get('building'),
             area(ring_of(f) or [[0, 0]]), len(ring_of(f) or [])))

# 道路
roads = [f for f in d['features'] if f['kind'] == 'road']
per_cls = {}
for f in roads:
    k = (f.get('properties') or {}).get('highway', '?')
    per_cls[k] = per_cls.get(k, 0) + 1
print('\n道路按类型:', per_cls)
print('道路条数', len(roads))

# 绿地/停车场/运动场
for kind in ('green', 'parking', 'pitch', 'water', 'barrier'):
    ks = [f for f in d['features'] if f['kind'] == kind]
    print('%-8s %d  面积合计 %.1f' % (kind, len(ks), sum(area(ring_of(f) or [[0, 0]]) for f in ks)))

# 分区
zs = {}
for f in bs:
    zs[f.get('zone')] = zs.get(f.get('zone'), 0) + 1
print('分区:', zs)
