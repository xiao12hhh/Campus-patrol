# 探测：8000 端口后端是否在跑，以及它加载的是新代码还是旧代码
import json, socket
from urllib.request import build_opener, ProxyHandler, Request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out = []
def P(*a):
    out.append(' '.join(str(x) for x in a))

s = socket.socket()
s.settimeout(1.5)
live = s.connect_ex(('127.0.0.1', 8000)) == 0
s.close()
P('8000 端口可连接：', live)
if not live:
    P('后端未运行，改完的代码下次启动自然生效')
else:
    op = build_opener(ProxyHandler({}))  # 绕过沙箱代理，否则本地请求会 502
    try:
        r = json.loads(op.open('http://127.0.0.1:8000/health', timeout=4).read())
        P('health:', r)
    except Exception as e:
        P('health 失败:', e)

    # 三教 = depot，图书馆 = 唯一任务点 -> 总里程 = 2 × 两点距离
    import math
    ORIGIN = (40.2159, 116.2449)
    LM = 111320.0
    CF = math.cos(ORIGIN[0] * math.pi / 180)
    def to_ll(x, z):
        return (ORIGIN[0] - (z * 10) / LM, ORIGIN[1] + (x * 10) / (LM * CF))
    SJ = to_ll(-44.46, -7.23)      # 第三教学楼
    TS = to_ll(-25.15, -14.28)     # 图书馆
    P(f'用点：三教={tuple(round(v, 6) for v in SJ)} 图书馆={tuple(round(v, 6) for v in TS)}')
    body = {
        'depot': {'id': 'depot', 'lat': SJ[0], 'lng': SJ[1]},
        'vehicles': [{'id': 'V-1', 'capacity': 100, 'start_time': '08:00', 'end_time': '18:00'}],
        'jobs': [{'id': 'J-1', 'name': '图书馆', 'lat': TS[0], 'lng': TS[1], 'demand': 1,
                  'service_minutes': 5, 'time_window': ['08:00', '18:00']}],
    }
    req = Request('http://127.0.0.1:8000/api/vrptw/solve', data=json.dumps(body).encode(),
                  headers={'Content-Type': 'application/json'})
    try:
        r = json.loads(op.open(req, timeout=8).read())
        km = r['total_distance_km']
        P(f"后端返回总里程 = {km} km（往返两趟）-> 单程 {km * 500:.0f} m")
        P('口径判断：', '新代码（380 m/趟）已生效' if km > 0.65 else '仍是旧代码（262 m/趟），需要重启后端')
    except Exception as e:
        P('solve 调用失败:', e)

(ROOT / '_backend_check_out.txt').write_text('\n'.join(out), encoding='utf-8')
