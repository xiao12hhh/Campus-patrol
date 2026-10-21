# -*- coding: utf-8 -*-
"""综合校验：红旗操场保留、无场地/水体压官方建筑、新路仍无压盖。"""
import json, os, traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = open(os.path.join(ROOT, 'tools', '_verify.log'), 'w', encoding='utf-8')
def p(s=''):
    LOG.write(str(s) + '\n')

try:
    d = json.load(open(os.path.join(ROOT, 'public', 'data', 'campus-local.json'), encoding='utf-8'))
    feats = d['features']
    p('要素总数: %d' % len(feats))

    def ring_of(f):
        g = f.get('geometry') or {}
        c = g.get('coordinates') or []
        if g.get('type') == 'Polygon':
            return c[0]
        if g.get('type') == 'MultiPolygon':
            return max(c, key=lambda pp: len(pp[0]))[0]
        return None

    def inside(pt, r):
        n = len(r); c = False; j = n - 1
        for i in range(n):
            xi, zi = r[i][0], r[i][1]
            xj, zj = r[j][0], r[j][1]
            if ((zi > pt[1]) != (zj > pt[1])) and \
                    (pt[0] < (xj - xi) * (pt[1] - zi) / ((zj - zi) or 1e-12) + xi):
                c = not c
            j = i
        return c

    def cen(f):
        r = ring_of(f)
        if not r:
            return None
        return (sum(q[0] for q in r) / len(r), sum(q[1] for q in r) / len(r))

    p('\n=== 红旗操场 / 剩余场地 ===')
    for f in feats:
        if f.get('kind') in ('pitch', 'water') and f.get('in_campus'):
            nm = f.get('name') or (f.get('properties') or {}).get('name') or '(无名)'
            c = cen(f)
            r = ring_of(f)
            xs = [q[0] for q in r]; zs = [q[1] for q in r]
            p('  %-6s %-10s %-24s c=(%7.2f,%7.2f) bbox x[%5.1f,%5.1f] z[%6.1f,%6.1f]'
              % (f.get('kind'), nm, f.get('id'), c[0], c[1], min(xs), max(xs), min(zs), max(zs)))

    official_c = []
    for f in feats:
        if f.get('kind') == 'building' and str(f.get('id', '')).startswith('cup-'):
            c = cen(f)
            if c:
                official_c.append(c)

    bad = 0
    for f in feats:
        if f.get('kind') not in ('pitch', 'water'):
            continue
        r = ring_of(f)
        if not r:
            continue
        for c in official_c:
            if inside(c, r):
                bad += 1
                p('  !! %s (%s) 仍压住官方建筑 c=(%.2f,%.2f)' % (f.get('name'), f.get('id'), c[0], c[1]))
    p('\n场地/水体压官方建筑: %d -> %s' % (bad, 'OK' if bad == 0 else 'FAIL'))

    new_road = next((f for f in feats if f.get('id') == 'cup-road-jiaoxuelou-n'), None)
    blocks = [r for f in feats if f.get('kind') == 'building' for r in [ring_of(f)] if r]
    if new_road:
        line = new_road['geometry']['coordinates']
        tot = 0
        for a, b in zip(line, line[1:]):
            n = max(2, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / 0.1))
            for k in range(n + 1):
                t = k / n
                pt = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                for r in blocks:
                    xs = [q[0] for q in r]; zs = [q[1] for q in r]
                    if pt[0] < min(xs) or pt[0] > max(xs) or pt[1] < min(zs) or pt[1] > max(zs):
                        continue
                    if inside(pt, r):
                        tot += 1
                        break
        p('补录道路压建筑点: %d -> %s' % (tot, 'OK' if tot == 0 else 'FAIL'))

    ghost = [f.get('id') for f in feats if '第三教学楼' in str(f.get('name') or '')
             or '第四教学楼' in str(f.get('name') or '')]
    p('三教/四教现存: %s' % ghost)
except Exception:
    p(traceback.format_exc())
LOG.close()
print('ok')
