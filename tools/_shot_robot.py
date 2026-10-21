# -*- coding: utf-8 -*-
"""全员暂停 → 等位置稳定 → 查坐标 → 怼近截图 → 恢复巡检"""
import json, math, pathlib, sys, time
import urllib.request

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BASE = 'http://127.0.0.1:8000'


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    return opener.open(req, timeout=10).read().decode('utf-8')


def robots():
    d = json.loads(opener.open(BASE + '/api/robots', timeout=10).read().decode('utf-8'))
    return d if isinstance(d, list) else d.get('robots', [])


print(post('/api/robots/missions', {'robot_ids': None, 'action': 'pause'}))
time.sleep(1.5)
rs = robots()
r = rs[0]
x, z = float(r['x']), float(r['z'])
print('paused at', r['id'], '%.2f %.2f' % (x, z))

# 从南边上方看过去（避开北边主楼）
url = BASE + '/?m=robot&tod=day&cam=%.2f,%.2f,%.2f,%.2f,0.5,%.2f' % (x + 2.6, 1.7, z + 2.6, x, z)
print('url', url)

sys.argv = ['shot.py', '1', 'dogpaused', url]
exec(open(pathlib.Path(__file__).parent / 'shot.py', encoding='utf-8').read())

print(post('/api/robots/missions', {'robot_ids': None, 'action': 'start'}))
