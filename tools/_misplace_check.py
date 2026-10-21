# -*- coding: utf-8 -*-
"""找"建筑压在运动场/水面/绿地/道路上"的错位：建筑轮廓与非建筑面要素的重叠面积。"""
import json
import pathlib

ROOT = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视')
d = json.loads((ROOT / 'public' / 'data' / 'campus-local.json').read_text(encoding='utf-8'))
GRID = 0.1  # 1 m

def rings_of(f):
    g = f['geometry']
    if g['type'] == 'Polygon':
        return [g['coordinates'][0]]
    if g['type'] == 'MultiPolygon':
        return [p[0] for p in g['coordinates']]
    return []

def bbox(r):
    xs = [p[0] for p in r]; zs = [p[1] for p in r]
    return min(xs), min(zs), max(xs), max(zs)

def inside(pt, ring):
    x, y = pt
    c = False
    for i in range(len(ring)):
        x1, y1 = ring[i]; x2, y2 = ring[(i + 1) % len(ring)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-18) + x1:
            c = not c
    return c

def cells(f, x0, z0, w, h):
    rs = rings_of(f)
    if not rs:
        return set()
    out = set()
    for i in range(w):
        for j in range(h):
            p = (x0 + (i + 0.5) * GRID, z0 + (j + 0.5) * GRID)
            if inside(p, rs[0]) and not any(inside(p, hole) for hole in rs[1:]):
                out.add((i, j))
    return out

def overlap(f1, f2):
    r1, r2 = rings_of(f1), rings_of(f2)
    if not r1 or not r2:
        return 0.0
    b1, b2 = bbox(r1[0]), bbox(r2[0])
    x0 = max(b1[0], b2[0]); x1 = min(b1[2], b2[2])
    z0 = max(b1[1], b2[1]); z1 = min(b1[3], b2[3])
    if x1 <= x0 or z1 <= z0:
        return 0.0
    w = int((x1 - x0) / GRID) + 1; h = int((z1 - z0) / GRID) + 1
    return len(cells(f1, x0, z0, w, h) & cells(f2, x0, z0, w, h)) * GRID * GRID * 100

buildings = [f for f in d['features'] if f['kind'] == 'building' and f.get('in_campus') is not False]
others = [f for f in d['features'] if f['kind'] in ('pitch', 'water', 'green', 'parking') and f.get('in_campus') is not False]
print(f'建筑 {len(buildings)}，非建筑面要素 {len(others)}')

hits = []
for b in buildings:
    for o in others:
        a = overlap(b, o)
        if a > 5:
            hits.append((a, b, o))
hits.sort(key=lambda t: -t[0])
print('\n=== 建筑压住运动场/水面/绿地/停车场（重叠 > 5 m²）===')
for a, b, o in hits:
    print(f"  {a:8.1f} m²  {b.get('name') or b['id']:<20} ({b['id']:<18}) 压住 {o['kind']:<8} {o.get('name') or o['id']} ({o['id']})")

# 运动场之间也互相压
print('\n=== 非建筑面要素互相重叠（> 20 m²）===')
n = 0
for i in range(len(others)):
    for j in range(i + 1, len(others)):
        a = overlap(others[i], others[j])
        if a > 20:
            n += 1
            print(f"  {a:8.1f} m²  {others[i]['kind']}:{others[i].get('name') or others[i]['id']} ∩ "
                  f"{others[j]['kind']}:{others[j].get('name') or others[j]['id']}")
print('对数:', n)
