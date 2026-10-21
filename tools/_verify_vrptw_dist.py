# 验证：VRPTW 距离口径改动后
# 1) 第三教学楼 <-> 图书馆 = 380 m
# 2) 完整 10 个任务点仍可求解，并对比新旧总里程
import json, math, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.models.schemas import VRPTWRequest
from app.services.vrptw_solver import solve, travel_m, planar_m, DETOUR_FACTOR
import app.services.vrptw_solver as vs

out = []
def P(*a):
    out.append(' '.join(str(x) for x in a))

P('OR-Tools 可用：', vs.pywrapcp is not None, ' | DETOUR_FACTOR =', DETOUR_FACTOR)

data = json.loads((ROOT / 'public' / 'data' / 'campus-local.json').read_text(encoding='utf-8'))
ORIGIN = data['origin']
LAT_M = 111320.0
COS = math.cos(ORIGIN['lat'] * math.pi / 180)

def to_ll(x, z):
    return (ORIGIN['lat'] - (z * 10) / LAT_M, ORIGIN['lng'] + (x * 10) / (LAT_M * COS))

# 复刻前端 toLandmarks 的取点规则：in_campus != False，building 需有名字，同名只取第一个
def centroid(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))

by_name = {}
for f in data['features']:
    if f.get('in_campus') is False or f['kind'] != 'building':
        continue
    nm = (f.get('name') or '').split(';')[0].strip()
    if not nm or nm in by_name:
        continue
    g = f['geometry']
    ring = g['coordinates'][0] if g['type'] == 'Polygon' else (g['coordinates'][0][0] if g['type'] == 'MultiPolygon' else None)
    if ring:
        by_name[nm] = centroid(ring)

# ---- 1) 标定点核对
A = by_name['第三教学楼']; B = by_name['图书馆']
P()
P(f'第三教学楼 {tuple(round(v,2) for v in A)}  图书馆 {tuple(round(v,2) for v in B)}')
la, lb = to_ll(*A), to_ll(*B)
P(f'直线距离(米制)      = {planar_m(la, lb):.1f} m')
P(f'改动后行程距离      = {travel_m(la, lb):.1f} m   <-- 目标 380 m')
P(f'改动前求解器口径    = {math.hypot((la[0]-lb[0])*111000, (la[1]-lb[1])*111000):.1f} m')

# ---- 2) 完整求解（照抄前端 App.tsx 的 JOB_DEFS / 车辆配置）
JOB_DEFS = [
    ('主楼A座', 20, ['08:20', '09:40'], 10),
    ('图书馆', 15, ['08:30', '09:50'], 8),
    ('第三教学楼', 20, ['09:00', '10:30'], 8),
    ('中油大厦A座', 30, ['08:30', '10:30'], 12),
    ('第四教学楼', 15, ['09:20', '10:40'], 8),
    ('东教学楼', 15, ['08:10', '09:30'], 8),
    ('教学实验中心', 12, ['09:00', '10:30'], 6),
    ('国际交流中心', 10, ['08:00', '09:00'], 6),
    ('汇才学生公寓1号楼', 25, ['08:10', '09:30'], 10),
    ('实验楼', 12, ['09:10', '10:40'], 6),
]
jobs = []
miss = []
for i, (name, demand, tw, service) in enumerate(JOB_DEFS):
    c = by_name.get(name)
    if not c:
        miss.append(name); continue
    lat, lng = to_ll(*c)
    jobs.append({'id': f'J-{i+1:02d}', 'name': name, 'lat': lat, 'lng': lng,
                 'demand': demand, 'service_minutes': service, 'time_window': tw})
P(); P('未匹配到坐标的任务点：', miss or '无')

req = VRPTWRequest.model_validate({
    'depot': {'id': 'depot', **dict(zip(('lat', 'lng'), to_ll(0, 0))), },
    'vehicles': [
        {'id': 'V-01', 'capacity': 80, 'start_time': '08:00', 'end_time': '12:00'},
        {'id': 'V-02', 'capacity': 80, 'start_time': '08:00', 'end_time': '12:00'},
        {'id': 'V-03', 'capacity': 60, 'start_time': '08:00', 'end_time': '12:00'},
    ],
    'jobs': jobs,
})
res = solve(req)
P(); P('求解结果：', json.dumps({k: res[k] for k in ('total_distance_km', 'vehicle_count', 'on_time_rate', 'solver')}, ensure_ascii=False))
for r in res['routes']:
    P(f"  {r['vehicle_id']}  {r['distance_km']} km  " + ' -> '.join(s['name'] for s in r['stops']))

# ---- 3) 旧口径对比
old = vs.DETOUR_FACTOR
vs.DETOUR_FACTOR = 1.0
res_old = solve(req)
vs.DETOUR_FACTOR = old
P(); P(f"同一请求：新口径 {res['total_distance_km']} km / 纯直线(已修 cos) {res_old['total_distance_km']} km")

# 原代码口径：dlat*111000 / dlng*111000（经度未收缩）且无绕路系数
_keep = vs.travel_m
vs.travel_m = lambda a, b: math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 111000)
res_legacy = solve(req)
vs.travel_m = _keep
P(f"原代码口径（经度未收缩、纯直线）：{res_legacy['total_distance_km']} km")
P(f"单点距离对照：三教<->图书馆 原 {math.hypot((la[0]-lb[0])*111000,(la[1]-lb[1])*111000):.0f} m -> 现 {travel_m(la, lb):.0f} m")

(ROOT / '_dist_verify_out.txt').write_text('\n'.join(out), encoding='utf-8')
