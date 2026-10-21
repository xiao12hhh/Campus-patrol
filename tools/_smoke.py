"""冒烟：后端托管的前端 + 数据是否可用。"""
import json, urllib.request, pathlib

ROOT = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视')
BASE = 'http://127.0.0.1:8000'
out = []

# 本机有沙箱代理（http_proxy=127.0.0.1:61119），会把 127.0.0.1 的请求也拦成 502
_no_proxy = urllib.request.ProxyHandler({})
_opener = urllib.request.build_opener(_no_proxy)


def get(p):
    r = urllib.request.Request(BASE + p, headers={'User-Agent': 'smoke/1'})
    with _opener.open(r, timeout=60) as resp:
        return resp.status, resp.read()

for path in ['/', '/data/campus-local.json', '/api/robots', '/api/robots/events']:
    try:
        st, body = get(path)
        out.append(f'{st}  {path}  {len(body)} bytes')
        if path == '/data/campus-local.json':
            d = json.loads(body)
            out.append(f'   version={d["version"]} origin={d["origin"]} license={d.get("license")}')
            out.append(f'   zones={[z["name"] for z in d["campus"]["zones"]]}')
            out.append(f'   features={len(d["features"])}')
            kinds = {}
            for f in d['features']:
                kinds[f['kind']] = kinds.get(f['kind'], 0) + 1
            out.append(f'   kinds={kinds}')
            nb = [f for f in d['features'] if f['kind'] == 'building' and f.get('in_campus')]
            out.append(f'   校内建筑={len(nb)}')
            zs = {}
            for f in nb:
                zs[f.get('zone')] = zs.get(f.get('zone'), 0) + 1
            out.append(f'   分区={zs}')
            named = sum(1 for f in nb if f.get('name'))
            out.append(f'   具名={named}')
            out.append('   样例: ' + ', '.join(f['name'] for f in nb[:12] if f.get('name')))
    except Exception as e:
        out.append(f'FAIL {path}: {type(e).__name__}: {e}')

(ROOT / '_smoke_result.txt').write_text('\n'.join(out), encoding='utf-8')
# 控制台默认 GBK，遇到 © 会崩；结果已写文件，这里忽略编码错误即可
try:
    print('\n'.join(out))
except UnicodeEncodeError:
    print('(控制台编码问题，结果见 _smoke_result.txt)')
