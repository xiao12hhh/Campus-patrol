# -*- coding: utf-8 -*-
"""校验：幽灵建筑是否清除、新路是否加入且不与建筑相交。"""
import json, os, traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGP = os.path.join(ROOT, 'tools', '_verify.log')
LOG = open(LOGP, 'w', encoding='utf-8')
def p(s=''):
    LOG.write(str(s) + '\n')

try:
    d = json.load(open(os.path.join(ROOT, 'public', 'data', 'campus-local.json'), encoding='utf-8'))
    feats = d['features']

    p('要素总数: %d' % len(feats))
    p('校内建筑: %d' % sum(1 for f in feats if f.get('kind') == 'building' and f.get('in_campus')))

    for kw in ('第三教学楼', '第四教学楼', '南广场', '图书馆'):
        hit = [(f.get('id'), f.get('kind')) for f in feats if kw in str(f.get('name') or '')]
        p('  含「%s」: %s' % (kw, hit))

    def rings(f):
        g = f.get('geometry') or {}
        c = g.get('coordinates') or []
        if g.get('type') == 'Polygon':
            return [c[0]]
        if g.get('type') == 'MultiPolygon':
            return [pp[0] for pp in c]
        return []

    def inside(ring, x, z):
        n = len(ring); c = False; j = n - 1
        for i in range(n):
            xi, zi = ring[i][0], ring[i][1]
            xj, zj = ring[j][0], ring[j][1]
            if ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / ((zj - zi) or 1e-12) + xi):
                c = not c
            j = i
        return c

    blocks = [r for f in feats if f.get('kind') == 'building' for r in rings(f)]
    p('\n障碍建筑轮廓: %d' % len(blocks))

    new_road = None
    for f in feats:
        if f.get('id') == 'cup-road-jiaoxuelou-n':
            new_road = f
    p('新路存在: %s' % (new_road is not None))

    if new_road:
        line = new_road['geometry']['coordinates']
        p('新路点数: %d' % len(line))
        tot_bad = 0
        p('\n各段采样点压建筑统计 (起点x, 起点z, 压中/采样):')
        for a, b in zip(line, line[1:]):
            n = max(2, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / 0.1))
            bad = 0
            for k in range(n + 1):
                t = k / n
                x = a[0] + (b[0] - a[0]) * t
                z = a[1] + (b[1] - a[1]) * t
                for r in blocks:
                    xs = [q[0] for q in r]; zs = [q[1] for q in r]
                    if x < min(xs) or x > max(xs) or z < min(zs) or z > max(zs):
                        continue
                    if inside(r, x, z):
                        bad += 1
                        break
            p('   (%7.2f,%7.2f)  %d/%d' % (a[0], a[1], bad, n + 1))
            tot_bad += bad
        p('压盖总点数: %d -> %s' % (tot_bad, 'OK 无压盖' if tot_bad == 0 else '仍需调整'))

        p('\n沿路到最近建筑轮廓顶点的距离（米）:')
        for a, b in zip(line, line[1:]):
            n = max(2, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / 0.2))
            mn = 1e9
            for k in range(n + 1):
                t = k / n
                x = a[0] + (b[0] - a[0]) * t
                z = a[1] + (b[1] - a[1]) * t
                for r in blocks:
                    for q in r:
                        dd = (q[0] - x) ** 2 + (q[1] - z) ** 2
                        if dd < mn:
                            mn = dd
            p('   (%7.2f,%7.2f) -> 最近 %.1f m' % (a[0], a[1], (mn ** 0.5) * 10))
except Exception:
    p(traceback.format_exc())
LOG.close()
