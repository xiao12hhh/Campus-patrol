# 一次性探测：找出所有「图书馆」「第三教学楼」要素，并算 VRPTW 口径距离
import json, math, heapq
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
data = json.loads((ROOT / 'public' / 'data' / 'campus-local.json').read_text(encoding='utf-8'))
origin = data['origin']
out = []
def P(*a):
    out.append(' '.join(str(x) for x in a))

def centroid(ring):
    xs = [p[0] for p in ring]; zs = [p[1] for p in ring]
    return (sum(xs) / len(xs), sum(zs) / len(zs))

def area(ring):
    s = 0.0
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        s += a[0] * b[1] - b[0] * a[1]
    return abs(s) / 2

hits = {}
roads = []
for f in data['features']:
    nm = (f.get('name') or '').split(';')[0].strip()
    g = f['geometry']
    if f['kind'] == 'building' and nm and ('图书馆' in nm or '第三教学楼' in nm):
        ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
        c = centroid(ring)
        hits.setdefault(nm, []).append((c, area(ring), f.get('in_campus'), f.get('zone'), f['id']))
    if f['kind'] == 'road' and g['type'] == 'LineString':
        roads.append(g['coordinates'])

P('origin', origin)
for nm, lst in hits.items():
    for c, a, inc, zn, fid in lst:
        P(f'[{nm}] id={fid} 质心=({c[0]:.2f},{c[1]:.2f}) 面积={a:.1f} in_campus={inc} zone={zn}')
P('道路条数', len(roads))

# 选一个主校区的图书馆（x 最小 = 最西，即主校区的那个）
def pick(nm, key):
    lst = hits.get(nm)
    if not lst:
        return None
    return sorted(lst, key=key)[0][0]

A = pick('第三教学楼', lambda t: t[0][0])
B = pick('图书馆', lambda t: t[0][0])
P()
P('采用 第三教学楼 =', (round(A[0], 2), round(A[1], 2)))
P('采用 图书馆     =', (round(B[0], 2), round(B[1], 2)))

straight = math.hypot(A[0] - B[0], A[1] - B[1]) * 10
P(f'真实直线距离 = {straight:.1f} m')

LAT_M = 111320.0
cosf = math.cos(origin['lat'] * math.pi / 180)
def to_ll(x, z):
    return (origin['lat'] - (z * 10) / LAT_M, origin['lng'] + (x * 10) / (LAT_M * cosf))
la, lb = to_ll(*A), to_ll(*B)
solver = math.hypot((la[0] - lb[0]) * 111000, (la[1] - lb[1]) * 111000)
P(f'求解器口径距离 = {solver:.1f} m   (东西向被放大 1/cos40 = {1/cosf:.3f} 倍)')
P(f'前端 toLatLng 是否与求解器一致 -> 求解器把真实东西向 {abs(A[0]-B[0])*10:.0f} m 放大成 {abs(A[0]-B[0])*10/cosf:.0f} m')

# ---------- 路网距离 ----------
def seg_pt(p, a, b):
    ax, az = a; bx, bz = b; px, pz = p
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    q = (ax + t * dx, az + t * dz)
    return math.hypot(px - q[0], pz - q[1]) * 10, q, (a, b)

def snap(p):
    best = (1e18, None, None)
    for path in roads:
        for i in range(len(path) - 1):
            d, q, se = seg_pt(p, path[i], path[i + 1])
            if d < best[0]:
                best = (d, q, se)
    return best

nodes = {}
def nid(p):
    k = (round(p[0], 1), round(p[1], 1))
    if k not in nodes:
        nodes[k] = len(nodes)
    return nodes[k]

adj = {}
def link(u, v, w):
    adj.setdefault(u, []).append((v, w))
    adj.setdefault(v, []).append((u, w))

for path in roads:
    for i in range(len(path) - 1):
        u, v = nid(path[i]), nid(path[i + 1])
        if u != v:
            link(u, v, math.hypot(path[i][0] - path[i + 1][0], path[i][1] - path[i + 1][1]) * 10)

def attach(p):
    d, q, (s, e) = snap(p)
    n = nid(q)
    link(n, nid(s), math.hypot(q[0] - s[0], q[1] - s[1]) * 10)
    link(n, nid(e), math.hypot(q[0] - e[0], q[1] - e[1]) * 10)
    return n, d

na, da = attach(A)
nb, db = attach(B)
INF = float('inf')
dist = [INF] * len(nodes); dist[na] = 0
pq = [(0.0, na)]
while pq:
    d, u = heapq.heappop(pq)
    if d > dist[u]:
        continue
    for v, w in adj.get(u, []):
        nd = d + w
        if nd < dist[v]:
            dist[v] = nd
            heapq.heappush(pq, (nd, v))
net = dist[nb]
P()
P(f'吸附距离: 三教 {da:.1f} m / 图书馆 {db:.1f} m')
P(f'路网距离(吸附点起算) = {net:.1f} m' if net < INF else '路网不连通')
if net < INF:
    P(f'路网距离(两端加上吸附) = {net + da + db:.1f} m')

(ROOT / '_dist_probe_out.txt').write_text('\n'.join(out), encoding='utf-8')
