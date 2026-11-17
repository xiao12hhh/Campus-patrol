"""Local browser QA: starts the real backend, checks both views and captures PNGs."""
import asyncio
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request

import websockets

ROOT = Path(__file__).resolve().parents[1]
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


async def main():
    server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8765'],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome = None
    try:
        for _ in range(45):
            try:
                if OP.open('http://127.0.0.1:8765/health', timeout=1).status == 200: break
            except Exception: pass
            await asyncio.sleep(1)
        chrome = subprocess.Popen([CHROME, '--headless=new', '--no-proxy-server', '--no-first-run',
            '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
            '--window-size=1600,1000', '--remote-debugging-port=9338',
            '--user-data-dir='+tempfile.mkdtemp(prefix='cup-browser-'), 'about:blank'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(30):
            try:
                pages = json.load(OP.open('http://127.0.0.1:9338/json',timeout=1))
                target = next(p for p in pages if p['type']=='page')
                break
            except Exception: await asyncio.sleep(1)
        async with websockets.connect(target['webSocketDebuggerUrl'],max_size=32*1024*1024) as ws:
            seq = 0
            errors = []
            async def command(method,params=None):
                nonlocal seq
                seq += 1
                await ws.send(json.dumps(dict(id=seq,method=method,params=params or {})))
                while True:
                    msg=json.loads(await ws.recv())
                    if msg.get('method')=='Runtime.exceptionThrown': errors.append(msg['params'])
                    if msg.get('id')==seq: return msg.get('result',{})
            async def evaluate(expression):
                r=await command('Runtime.evaluate',dict(expression=expression,returnByValue=True))
                return r.get('result',{}).get('value')
            await command('Runtime.enable')
            for mode in ['map','twin']:
                await command('Page.navigate',dict(url='http://127.0.0.1:8765/?v='+mode+'&tod=day'))
                for _ in range(45):
                    await asyncio.sleep(1)
                    if await evaluate("!!window.__scene_debug && document.querySelectorAll('.landmark-list button').length > 0"): break
                    if await evaluate("!!window.__scene_debug && document.body.innerText.includes('地理布局')"): break
                await asyncio.sleep(5)
                assert await evaluate("!!document.querySelector('canvas')"), 'Missing canvas'
                state=await evaluate("JSON.stringify({cam:window.__scene_debug.cam(),target:window.__scene_debug.tgt(),text:document.body.innerText.slice(-500)})")
                shot=await command('Page.captureScreenshot',dict(format='png'))
                (ROOT/'_shots'/('geographic-'+mode+'.png')).write_bytes(base64.b64decode(shot['data']))
                assert await evaluate("window.__scene_debug.tgt()[0] < -10"), 'Camera retained placeholder origin'
                print(mode,state,flush=True)
            await evaluate("(() => {const s=document.querySelector('select[aria-label=\"校区范围\"]'); s.value='东校区'; s.dispatchEvent(new Event('change',{bubbles:true}));})()")
            await asyncio.sleep(2)
            assert await evaluate("window.__scene_debug.tgt()[0] > 0"), 'East-campus selector failed'
            await evaluate("Array.from(document.querySelectorAll('.landmark-row')).find(b=>b.querySelector('b').textContent==='图书馆').click()")
            await asyncio.sleep(2)
            assert await evaluate("document.querySelector('.landmark-row.selected b')?.textContent === '图书馆'"), 'Landmark selection failed'
            assert not errors, errors
            print('BROWSER PASS: both views / geographic focus / region switch / landmark selection; no JavaScript exceptions',flush=True)
    finally:
        for process in [chrome,server]:
            if process:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill()


if __name__ == '__main__': asyncio.run(main())
