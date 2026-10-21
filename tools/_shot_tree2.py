# -*- coding: utf-8 -*-
"""树近景重拍：高机位俯向机器人旁边的行道树。"""
import json, time
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

url = BASE + '/?tod=day&cam=%.2f,7.5,%.2f,%.2f,1.4,%.2f&_cb=%d' % (x + 11, z + 7, x + 1, z, int(time.time()))
print('url', url)
sys_argv = None
import pathlib, sys
sys.argv = ['shot.py', '1', 'treeview_near2', url]
exec(open(pathlib.Path(__file__).parent / 'shot.py', encoding='utf-8').read())

print(post('/api/robots/missions', {'robot_ids': None, 'action': 'start'}))
