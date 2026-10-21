"""用无头 Chrome 打开场景并截图，验证程序化细节是否渲染出来。

要点（踩过的坑都在这）：
  * 沙箱代理 http_proxy 会把 127.0.0.1 也拦成 502，脚本里用 ProxyHandler({})，
    但 Chrome 自己也要 --proxy-bypass-list 才不会走代理；
  * SwiftShader 软件渲染很慢，整个命令必须给足超时（默认 120s 会被 SIGTERM）；
  * 每次用独立 --user-data-dir，否则命中 HTTP 缓存会拿到旧 bundle。
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视')
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
BASE = 'http://127.0.0.1:8000'

_no_proxy = urllib.request.ProxyHandler({})
_opener = urllib.request.build_opener(_no_proxy)

shots = int(sys.argv[1]) if len(sys.argv) > 1 else 1
tag = sys.argv[2] if len(sys.argv) > 2 else 'detail'

try:
    with _opener.open(BASE + '/', timeout=20) as r:
        print('server', r.status)
except Exception as e:
    print('server FAIL', e)
    sys.exit(1)

profile = pathlib.Path(tempfile.gettempdir()) / f'cup-shot-{int(time.time())}'
out_dir = ROOT / '_shots'
out_dir.mkdir(exist_ok=True)

# 截图脚本：等场景出现 canvas 且渲染若干帧后再截
script = r"""
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const c = document.querySelector('canvas');
    if (c && c.width > 100) break;
    await sleep(500);
  }
  await sleep(22000);
  return JSON.stringify({
    canvas: !!document.querySelector('canvas'),
    w: document.querySelector('canvas')?.width || 0,
    h: document.querySelector('canvas')?.height || 0,
  });
})()
"""

cmd = [
    CHROME,
    '--headless=new',
    '--disable-gpu-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--proxy-bypass-list=<-loopback>',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-logging=stderr',
    '--v=0',
    '--window-size=1600,1000',
    f'--user-data-dir={profile}',
    f'--screenshot={out_dir / (tag + ".png")}',
    '--virtual-time-budget=60000',
    (sys.argv[3] if len(sys.argv) > 3 else BASE + '/?tod=day') + '&_cb=' + str(int(time.time())),
]

print('running chrome...')
t0 = time.time()
proc = None
try:
    proc = subprocess.run(cmd, timeout=420, capture_output=True, text=True, errors='replace')
except subprocess.TimeoutExpired:
    print('chrome timeout (截图可能仍已写出)')
print('elapsed %.1f s' % (time.time() - t0))
if proc is not None:
    for line in (proc.stderr or '').splitlines():
        if '[fit]' in line or 'scene]' in line or '[tiles]' in line:
            print('LOG:', line.strip()[:300])

png = out_dir / (tag + '.png')
if png.exists():
    print('shot', png, '%.1f KB' % (png.stat().st_size / 1024))
else:
    print('no screenshot produced')

shutil.rmtree(profile, ignore_errors=True)
