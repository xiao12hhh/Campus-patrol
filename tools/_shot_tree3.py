# -*- coding: utf-8 -*-
"""调亮树冠后重拍总览确认。"""
import json, time, pathlib, sys
import urllib.request

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BASE = 'http://127.0.0.1:8000'


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    return opener.open(req, timeout=10).read().decode('utf-8')


url = BASE + '/?tod=day&_cb=%d' % int(time.time())
sys.argv = ['shot.py', '1', 'treeview_final', url]
exec(open(pathlib.Path(__file__).parent / 'shot.py', encoding='utf-8').read())
