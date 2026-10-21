# -*- coding: utf-8 -*-
"""审计 campus-local.json 里建筑的位置：三教/图书馆距离、重叠、与官方源对比。

只读脚本，输出写到 _pos_audit_out.txt。
"""
import json
import math
import pathlib

ROOT = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视')
DATA = ROOT / 'public' / 'data' / 'campus-local.json'

d = json.loads(DATA.read_text(encoding='utf-8'))
print('version', d.get('version'), 'unit_m', d.get('unit_meters'), 'origin', d.get('origin'))
print('axis', d.get('axis'))
feats = d['features']
print('features', len(feats))

def ring_of(f):
    g = f['geometry']
    if g['type'] == 'Polygon':
        return g['coordinates'][0]
    if g['type'] == 'MultiPolygon':
        return g['coordinates'][0][0]
    return None

def centroid(ring):
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    return sum(xs) / len(xs), sum(zs) / len(zs)

buildings = [f for f in feats if f['kind'] == 'building']
print('buildings', len(buildings))

named = []
for f in buildings:
    if not f.get('name'):
        continue
    r = ring_of(f)
    if not r:
        continue
    cx, cz = centroid(r)
    named.append((f, r, cx, cz))

print('\n=== 名称含 图书馆 / 教学楼 / 主楼 ===')
for f, r, cx, cz in named:
    n = f['name']
    if any(k in n for k in ('图书馆', '教学楼', '主楼', '阶教')):
        print(f"  {n:<28} id={f['id']:<12} c=({cx:7.2f},{cz:7.2f}) h={f.get('height')} zone={f.get('zone')} area={len(r)}pts in={f.get('in_campus')}")

# OSM 原始经纬度（若保留在 properties）
print('\n=== 关键建筑 raw 经纬度（如有）===')
for f, r, cx, cz in named:
    if any(k in f['name'] for k in ('第三教学楼', '图书馆')):
        p = f.get('properties') or {}
        print(' ', f['name'], f['id'], {k: v for k, v in p.items() if k in ('lat', 'lon', 'center', 'level', 'levels', 'height', 'building')})

def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1]) * 10.0

def find(name, exact=True):
    hits = [(f, cx, cz) for f, r, cx, cz in named if (f['name'] == name if exact else name in f['name'])]
    return hits

for a, b in [('第三教学楼', '图书馆'), ('第三教学楼', '第四教学楼'), ('主楼A座', '图书馆'),
             ('图书馆', '第一食堂'), ('第三教学楼', '第一食堂')]:
    ha, hb = find(a), find(b)
    if ha and hb:
        print(f"\n{a} {ha[0][1]:.2f},{ha[0][2]:.2f}  <->  {b} {hb[0][1]:.2f},{hb[0][2]:.2f}  = {dist(ha[0][1:], hb[0][1:]):.1f} m")

# ---------- 重叠检测（校内建筑两两相交）----------
def poly_area(ring):
    s = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2

def seg_int(p1, p2, p3, p4):
    def o(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-12 else (1 if v > 0 else -1)
    o1, o2, o3, o4 = o(p1, p2, p3), o(p1, p2, p4), o(p3, p4, p1), o(p3, p4, p2)
    return o1 != o2 and o3 != o4

def polys_intersect(r1, r2):
    # 快速包围盒
    b1 = (min(p[0] for p in r1), min(p[1] for p in r1), max(p[0] for p in r1), max(p[1] for p in r1))
    b2 = (min(p[0] for p in r2), min(p[1] for p in r2), max(p[0] for p in r2), max(p[1] for p in r2))
    if b1[2] < b2[0] or b2[2] < b1[0] or b1[3] < b2[1] or b2[3] < b1[1]:
        return False
    for i in range(len(r1)):
        for j in range(len(r2)):
            if seg_int(r1[i], r1[(i + 1) % len(r1)], r2[j], r2[(j + 1) % len(r2)]):
                return True
    # 内含
    def inside(pt, ring):
        x, y = pt
        c = False
        for i in range(len(ring)):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % len(ring)]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-18) + x1:
                c = not c
        return c
    return inside(r1[0], r2) or inside(r2[0], r1)

inside_b = [(f, r, cx, cz) for f, r, cx, cz in named if f.get('in_campus') is not False]
print(f'\n=== 重叠检测：{len(inside_b)} 栋有名字的校内建筑 ===')
cnt = 0
for i in range(len(inside_b)):
    for j in range(i + 1, len(inside_b)):
        f1, r1, _, _ = inside_b[i]
        f2, r2, _, _ = inside_b[j]
        if polys_intersect(r1, r2):
            cnt += 1
            print(f"  OVERLAP {f1['name']} <-> {f2['name']}")
print('overlap pairs:', cnt)
