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
sys.path.insert(0, str(ROOT))
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
            async def click(label):
                assert await evaluate(f"(() => {{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==={json.dumps(label)}); if(!b || b.disabled)return false;b.click();return true;}})()"), label
            async def wait_stage(n):
                for _ in range(25):
                    await asyncio.sleep(.4)
                    if await evaluate(f"document.querySelector('.showcase-heading b')?.textContent === '{n} / 6' && document.querySelector('.showcase-panel')?.getAttribute('aria-busy') === 'false'"): return
                raise AssertionError('Stage did not settle: '+str(n))
            await click('▶ 一键讲解演示')
            await wait_stage(1)
            for stage in range(2,7):
                await click('下一步')
                await wait_stage(stage)
                await asyncio.sleep(2)
                if stage in (2,4):
                    assert await evaluate("window.__scene_debug.follow()==='SPOT-01' && window.__scene_debug.closeThird()"), 'Follow view missing'
                if stage == 3:
                    await click('重播本步')
                    await wait_stage(3)
                    assert await evaluate("!!document.querySelector('.showcase-comparison')")
                shot=await command('Page.captureScreenshot',dict(format='png'))
                (ROOT/'_shots'/f'showcase-{stage}.png').write_bytes(base64.b64decode(shot['data']))
            assert await evaluate("!!document.querySelector('.assistant-panel')"), 'AI panel missing'
            # Simulate an indefinitely pending model response, then recover through the actual UI.
            await evaluate("window.__originalFetch=window.fetch;window.fetch=(url,init)=>String(url).endsWith('/api/assistant/chat')?new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))):window.__originalFetch(url,init)")
            await click('什么是 AVL 平衡二叉树？')
            await asyncio.sleep(.3)
            await click('停止等待')
            await asyncio.sleep(.3)
            await evaluate("window.fetch=window.__originalFetch;delete window.__originalFetch")
            assert await evaluate("!document.querySelector('.assistant-route button').disabled"), 'AI cancellation did not release UI'
            await click('查询路线与距离')
            for _ in range(20):
                await asyncio.sleep(.5)
                if await evaluate("!!document.querySelector('.assistant-map')"): break
            assert await evaluate("!!document.querySelector('.assistant-map')")
            await click('完成演示')
            assert await evaluate("!window.__scene_debug.fp()"), 'Camera retained FP'
            await asyncio.sleep(1)
            assert await evaluate("window.__scene_debug.follow()===null && window.__scene_debug.controls()")
            await evaluate("document.querySelector('.assistant-toggle').click()")
            print('SHOWCASE FLOW PASS',flush=True)
            duration = int(sys.argv[sys.argv.index('--seconds')+1]) if '--seconds' in sys.argv else 60
            async def api(path, body=None):
                def call():
                    req=urllib.request.Request('http://127.0.0.1:8765/api/'+path, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type':'application/json'})
                    return json.load(OP.open(req,timeout=20))
                return await asyncio.to_thread(call)
            await api('navigation/showcase/step', {'step':4})
            await api('navigation/pedestrians', {'count':80})
            await evaluate("Array.from(document.querySelectorAll('.nav-btn')).find(b=>b.innerText.includes('四足')).click()")
            await asyncio.sleep(5)
            await evaluate("window.__soak={last:performance.now(),hist:[],max:0,n:0};function tick(t){const s=window.__soak;if(!s)return;const d=t-s.last;s.last=t;s.n++;s.max=Math.max(s.max,d);s.hist[Math.min(200,Math.floor(d/5))]=(s.hist[Math.min(200,Math.floor(d/5))]||0)+1;requestAnimationFrame(tick)};requestAnimationFrame(tick)")
            from app.services.campus_grid import CampusGrid
            static_grid=CampusGrid()
            started=asyncio.get_running_loop().time()
            samples=[]
            cycle=0
            while asyncio.get_running_loop().time()-started < duration:
                await click('机器狗第一人称')
                await asyncio.sleep(2)
                assert await evaluate("window.__scene_debug.fp() && !window.__scene_debug.controls()")
                await click('退出第一人称')
                await asyncio.sleep(2)
                assert await evaluate("!window.__scene_debug.fp() && window.__scene_debug.follow()===null && window.__scene_debug.controls()")
                await click('近距离第三人称')
                await asyncio.sleep(2)
                assert await evaluate("window.__scene_debug.closeThird() && !!window.__scene_debug.follow()")
                await click('回到全景')
                await asyncio.sleep(2)
                if cycle and cycle % 4 == 0:
                    await api('navigation/pedestrians', {'count':80})
                state=await api('navigation')
                for robot in state['robots']:
                    assert static_grid.segment_clear(robot['x'],robot['z'],robot['x'],robot['z']), ('Robot inside building',robot['id'])
                sample=await evaluate("window.__scene_debug.resources()")
                assert not sample['contextLost'], 'WebGL context lost'
                sample.update(seconds=round(asyncio.get_running_loop().time()-started), positions=[[r['x'],r['z']] for r in state['robots']], waiting=[r['id'] for r in state['robots'] if r.get('yielding_to') or r.get('navigation_blocked')])
                samples.append(sample)
                assert not errors, errors
                if cycle % 4 == 0: print('SOAK',json.dumps(sample),flush=True)
                cycle+=1
                await asyncio.sleep(7)
            frames=await evaluate("window.__soak")
            await evaluate("window.__soak=null")
            assert len(samples)>1
            assert samples[-1]['geometries'] <= max(s['geometries'] for s in samples[:4])+80, 'Geometry count kept growing'
            assert samples[-1]['textures'] <= max(s['textures'] for s in samples[:4])+10, 'Texture count kept growing'
            assert any(s['positions'] != samples[0]['positions'] for s in samples[1:]), 'All robots stopped throughout test'
            ordered=[]
            for bucket,count in enumerate(frames['hist']): ordered.extend([bucket*5]*(count or 0))
            p95=ordered[int(len(ordered)*.95)]
            report={'seconds':round(asyncio.get_running_loop().time()-started),'cycles':cycle,'frames':frames['n'],'p95_frame_ms':p95,'max_frame_ms':round(frames['max'],1),'samples':samples,'errors':errors}
            (ROOT/'_shots'/'showcase-stability.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            assert p95 < 100, ('Sustained slow frames',p95)
            print('SHOWCASE STABILITY PASS',json.dumps({k:v for k,v in report.items() if k not in ('samples','errors')}),flush=True)
    finally:
        for process in [chrome,server]:
            if process:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill()


if __name__ == '__main__': asyncio.run(main())
