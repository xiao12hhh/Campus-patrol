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
            '--disable-gpu-sandbox', '--enable-unsafe-swiftshader',
            *([] if '--native-gpu' in sys.argv else ['--use-angle=swiftshader']),
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
            await command('Page.navigate',dict(url='http://127.0.0.1:8765/?m=robot'))
            for _ in range(40):
                await asyncio.sleep(1)
                if await evaluate("document.body.innerText.includes('AVL 协同巡检实验')"): break
            await asyncio.sleep(3)
            await evaluate("document.querySelector('.assistant-toggle').click()")
            for _ in range(15):
                await asyncio.sleep(1)
                if await evaluate("document.querySelectorAll('.assistant-route option').length > 0"): break
            assert await evaluate("document.querySelectorAll('.assistant-route option').length > 0")
            await evaluate("document.querySelector('.assistant-route button').click()")
            for _ in range(20):
                await asyncio.sleep(1)
                if await evaluate("!!document.querySelector('.assistant-map')"): break
            assert await evaluate("!!document.querySelector('.assistant-map')"), 'Route missing'
            assert await evaluate("document.querySelector('.assistant-messages').innerText.includes('地图计算')")
            await evaluate("Array.from(document.querySelectorAll('.assistant-knowledge button')).find(b=>b.textContent.includes('AVL')).click()")
            for _ in range(20):
                await asyncio.sleep(.3)
                if await evaluate("!!document.querySelector('.assistant-sources')"): break
            assert await evaluate("document.querySelector('.assistant-messages').innerText.includes('heapq')"), 'Project implementation missing'
            await evaluate("document.querySelector('.assistant-sources').open=true")
            assert await evaluate("document.querySelector('.assistant-sources').innerText.includes('app/services/avl.py')")
            await evaluate("(() => {const input=document.querySelector('input[aria-label=\"向校园助手提问\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'它的复杂度呢？');input.dispatchEvent(new Event('input',{bubbles:true}));})()")
            await asyncio.sleep(.2)
            await evaluate("document.querySelector('.assistant-panel form').requestSubmit()")
            for _ in range(20):
                await asyncio.sleep(.3)
                if await evaluate("document.querySelectorAll('.assistant-sources').length===2"): break
            assert await evaluate("document.querySelectorAll('.assistant-sources').length===2"), 'Contextual follow-up failed'
            shot=await command('Page.captureScreenshot',dict(format='png'))
            (ROOT/'_shots'/'assistant.png').write_bytes(base64.b64decode(shot['data']))
            assert not errors, errors
            print('ASSISTANT BROWSER PASS',flush=True)
    finally:
        for process in [chrome,server]:
            if process:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill()


if __name__ == '__main__': asyncio.run(main())
