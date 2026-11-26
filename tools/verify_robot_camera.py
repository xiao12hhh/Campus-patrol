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
            await command('Page.navigate',dict(url='http://127.0.0.1:8765/?m=robot&v=twin&follow=SPOT-01&fp=1'))
            for _ in range(45):
                await asyncio.sleep(1)
                if await evaluate("window.__scene_debug?.dogState()==='ok'"): break
            await asyncio.sleep(3)
            print('GPU', await evaluate("(() => {const gl=document.querySelector('canvas').getContext('webgl2'); const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unknown';})()"),flush=True)
            bounds = await evaluate("(() => {const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height*.6}})()")
            x,y=bounds['x'],bounds['y']
            await command('Input.dispatchMouseEvent',dict(type='mousePressed',x=x,y=y,button='left',clickCount=1))
            await command('Input.dispatchMouseEvent',dict(type='mouseMoved',x=x+120,y=y+45,buttons=1))
            await command('Input.dispatchMouseEvent',dict(type='mouseReleased',x=x+120,y=y+45,button='left',clickCount=1))
            assert await evaluate("Math.abs(window.__scene_debug.look()[0])>.1"), 'Drag look did not rotate'
            await command('Input.dispatchKeyEvent',dict(type='keyDown',key='r',code='KeyR',windowsVirtualKeyCode=82))
            await command('Input.dispatchKeyEvent',dict(type='keyUp',key='r',code='KeyR',windowsVirtualKeyCode=82))
            assert await evaluate("window.__scene_debug.look().every(n=>n===0)"), 'R did not recenter'
            assert await evaluate("window.__scene_debug.modelScale()===.1"), 'Dog size was not reduced'
            await evaluate("window.__frames=[]; window.__last=performance.now(); window.__record=true; function frame(t){if(!window.__record)return;window.__frames.push(t-window.__last);window.__last=t;requestAnimationFrame(frame)};requestAnimationFrame(frame)")
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='退出第一人称').click()")
            await asyncio.sleep(3)
            state = await evaluate("JSON.stringify({follow:window.__scene_debug.follow(),fp:window.__scene_debug.fp(),controls:window.__scene_debug.controls(),cam:window.__scene_debug.cam(),maxFrame:Math.max(...window.__frames),frames:window.__frames.length})")
            await evaluate("window.__record=false")
            print('RETURN_GLOBAL',state,flush=True)
            if '--native-gpu' in sys.argv:
                assert json.loads(state)['maxFrame'] < 150, 'Hardware-accelerated global transition has a long frame'
            assert await evaluate("window.__scene_debug.follow()===null && window.__scene_debug.controls()"), 'Exit first person did not return camera ownership to global controls'
            for _ in range(2):
                await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='机器狗第一人称').click()")
                await asyncio.sleep(1)
                assert await evaluate("window.__scene_debug.fp() && !window.__scene_debug.controls()")
                await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='退出第一人称').click()")
                await asyncio.sleep(1)
                assert await evaluate("window.__scene_debug.follow()===null && window.__scene_debug.controls()")
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='机器狗第一人称').click()")
            await asyncio.sleep(1)
            await evaluate(r"Array.from(document.querySelectorAll('button')).find(b=>b.textContent.replace(/\s/g,'').includes('3D校园浏览')).click()")
            await asyncio.sleep(1)
            assert await evaluate("!window.__scene_debug.fp() && window.__scene_debug.follow()===null && window.__scene_debug.controls()"), 'Module switch retained first-person ownership'
            shot=await command('Page.captureScreenshot',dict(format='png'))
            (ROOT/'_shots'/'robot-global-return.png').write_bytes(base64.b64decode(shot['data']))
            assert not errors, errors
            print('ROBOT CAMERA PASS',flush=True)
    finally:
        for process in [chrome,server]:
            if process:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill()


if __name__ == '__main__': asyncio.run(main())
