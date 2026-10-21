# -*- coding: utf-8 -*-
"""树模块截图：总览 + 机器人近旁的行道树近景。
流程：探活 → 暂停 → 取坐标 → 两张截图 → 恢复巡检。"""
import json, pathlib, sys, time
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


try:
    with opener.open(BASE + '/', timeout=15) as r:
        print('server', r.status)
except Exception as e:
    print('server FAIL', e)
    sys.exit(1)

print(post('/api/robots/missions', {'robot_ids': None, 'action': 'pause'}))
time.sleep(1.5)
r = robots()[0]
x, z = float(r['x']), float(r['z'])
print('paused at', r['id'], '%.2f %.2f' % (x, z))

cb = str(int(time.time()))
ROOT = str(pathlib.Path(__file__).parent)
EXEC = open(pathlib.Path(__file__).parent / 'shot.py', encoding='utf-8').read()

# 1) 总览：默认视角看全局树密度
sys.argv = ['shot.py', '1', 'treeview_overview', BASE + '/?tod=day&_cb=' + cb]
exec(EXEC)

# 2) 近景：站在机器人旁边 8 单位外平视树冠（树冠中心约 y=1.5）
url = BASE + '/?tod=day&cam=%.2f,2.2,%.2f,%.2f,1.6,%.2f&_cb=%s' % (x + 9, z + 5, x + 2, z, cb)
print('near url', url)
sys.argv = ['shot.py', '1', 'treeview_near', url]
exec(EXEC)

print(post('/api/robots/missions', {'robot_ids': None, 'action': 'start'}))
