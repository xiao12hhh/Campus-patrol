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
            assert await evaluate("!!document.querySelector('svg[aria-label] polygon')"), 'Building overlay missing'
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='分配三机巡检子区').click()")
            await asyncio.sleep(3)
            assert await evaluate("document.body.innerText.includes('站分区循环')"), 'Allocation did not reach UI'
            # Pick a free location through the actual SVG coordinate conversion.
            xy = await evaluate("(() => {const svg=document.querySelector('svg[aria-label]'); const p=svg.createSVGPoint();p.x=-60;p.y=-40;const q=p.matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y};})()")
            await command('Input.dispatchMouseEvent',dict(type='mousePressed',button='left',clickCount=1,**xy))
            await command('Input.dispatchMouseEvent',dict(type='mouseReleased',button='left',clickCount=1,**xy))
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='添加障碍并重规划').click()")
            await asyncio.sleep(3)
            assert await evaluate("document.body.innerText.includes('移除 / 恢复通行')"), 'Obstacle creation failed'
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='移除 / 恢复通行').click()")
            await asyncio.sleep(3)
            assert not await evaluate("document.body.innerText.includes('移除 / 恢复通行')"), 'Obstacle removal failed'
            assert await evaluate("window.__scene_debug.pedestrianCount()===36"), 'People missing from 3D scene'
            before_people=await evaluate("window.__scene_debug.pedestrianPositions()")
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='开启行人走动').click()")
            await asyncio.sleep(5)
            after_people=await evaluate("window.__scene_debug.pedestrianPositions()")
            assert before_people != after_people, 'Pedestrians do not move visually'
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='暂停行人走动').click()")

            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='近距离第三人称').click()")
            await asyncio.sleep(3)
            assert await evaluate("window.__scene_debug.closeThird() && !window.__scene_debug.fp() && window.__scene_debug.follow()!==null && !window.__scene_debug.controls()"), 'Close third-person not active'
            bounds = await evaluate("(() => {const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()")
            await command('Input.dispatchMouseEvent',dict(type='mousePressed',button='left',clickCount=1,**bounds))
            await command('Input.dispatchMouseEvent',dict(type='mouseMoved',buttons=1,x=bounds['x']+80,y=bounds['y']))
            await command('Input.dispatchMouseEvent',dict(type='mouseReleased',button='left',clickCount=1,x=bounds['x']+80,y=bounds['y']))
            assert await evaluate("Math.abs(window.__scene_debug.look()[0])>.1"), 'Third person drag failed'
            await asyncio.sleep(1)
            feet=await evaluate("window.__scene_debug.feet()")
            print('FOOT HEIGHTS', feet, flush=True)
            assert all(y > -.025 and y < .2 for y in feet), 'Feet penetrate ground or float too high'
            close_shot=await command('Page.captureScreenshot',dict(format='png'))
            (ROOT/'_shots'/'close-third-person.png').write_bytes(base64.b64decode(close_shot['data']))
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='回到全景').click()")
            await asyncio.sleep(2)
            assert await evaluate("window.__scene_debug.follow()===null && window.__scene_debug.controls()"), 'Global camera not restored'
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='清空行人').click()")
            await asyncio.sleep(3)
            assert await evaluate("window.__scene_debug.pedestrianCount()===0"), 'Clear people not reflected in scene'
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重新随机生成行人').click()")
            await asyncio.sleep(3)
            assert await evaluate("window.__scene_debug.pedestrianCount()===36"), 'Regenerate failed'
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='一键复位演示').click()")
            await asyncio.sleep(2)
            assert await evaluate("document.body.innerText.includes('电量冻结')")
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='放置固定施工障碍').click()")
            await asyncio.sleep(2)
            assert await evaluate("!!document.querySelector('polyline[stroke-dasharray]')"), 'Before-route overlay missing'
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='开始演示').click()")
            await asyncio.sleep(2)
            await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='近距离第三人称').click()")
            positions_before=await evaluate("window.__scene_debug.robots()")
            lifted=False
            for _ in range(15):
                await asyncio.sleep(.15)
                feet=await evaluate("window.__scene_debug.feet()")
                assert min(feet)>-.025
                lifted = lifted or max(feet)>.025
            assert lifted, 'Walking feet never lift'
            assert positions_before != await evaluate("window.__scene_debug.robots()"), 'Demo robot did not advance'
            shot=await command('Page.captureScreenshot',dict(format='png'))
            (ROOT/'_shots'/'navigation-lab.png').write_bytes(base64.b64decode(shot['data']))
            assert not errors, errors
            print('NAVIGATION LAB PASS',flush=True)
    finally:
        for process in [chrome,server]:
            if process:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill()


if __name__ == '__main__': asyncio.run(main())
