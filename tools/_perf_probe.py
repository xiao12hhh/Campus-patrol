"""帧耗时探针：真 GPU 有头 Chrome + CDP，跑"跟随 → 第一人称 → 退出 → 复位"序列，
记录长帧并与当前动作对号入座。用法： python tools/_perf_probe.py [url]
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9333
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/?m=robot&v=twin&tod=day"

JS_INSTALL = r"""
(() => {
  window.__perf = { mark: 'boot', frames: [], marks: [], count: 0, drop: 0 };
  const P = window.__perf;
  let last = performance.now();
  const tick = (ts) => {
    const d = ts - last; last = ts;
    P.count++;
    if (d > 45) { P.frames.push({ d: Math.round(d), mark: P.mark }); }
    if (d > 120) P.drop++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__setMark = (m) => { P.mark = m; P.marks.push({ m, t: Math.round(performance.now()) }); };
  window.__clickText = (t) => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes(t));
    if (!b) return 'MISS:' + t;
    b.click(); return 'OK:' + t;
  };
  return 'installed';
})()
"""


def http_json(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return json.load(op.open(f"http://127.0.0.1:{PORT}{path}", timeout=10))


async def main():
    profile = tempfile.mkdtemp(prefix="perfch-")
    proc = subprocess.Popen([
        CHROME, f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
        "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion",
        "--window-size=1600,1000", "--window-position=-2600,-2600", URL,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        ws_url = None
        for _ in range(40):
            time.sleep(0.5)
            try:
                pages = [t for t in http_json("/json") if t.get("type") == "page"]
                pages.sort(key=lambda t: 0 if "8000" in t.get("url", "") else 1)
                if pages and pages[0].get("webSocketDebuggerUrl"):
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    print("target:", pages[0].get("url"))
            except Exception:
                continue
            if ws_url:
                break
        if not ws_url:
            print("no debug target")
            return

        async with websockets.connect(ws_url, max_size=32 * 1024 * 1024) as ws:
            seq = [0]

            async def ev(expr, await_promise=False):
                seq[0] += 1
                await ws.send(json.dumps({
                    "id": seq[0], "method": "Runtime.evaluate",
                    "params": {"expression": expr, "returnByValue": True,
                               "awaitPromise": await_promise},
                }))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == seq[0]:
                        r = msg.get("result", {}).get("result", {})
                        return r.get("value")

            await asyncio.sleep(3.0)          # 等场景建完
            for _ in range(40):
                ready = await ev("document.querySelectorAll('button').length")
                if isinstance(ready, int) and ready > 5:
                    break
                await asyncio.sleep(0.5)
            print("buttons:", await ev("document.querySelectorAll('button').length"),
                  "canvas:", await ev("!!document.querySelector('canvas')"))
            print(await ev(JS_INSTALL))

            async def phase(mark, seconds, click=None):
                if click:
                    print("click:", await ev(f"window.__clickText({json.dumps(click)})"))
                await ev(f"window.__setMark({json.dumps(mark)})")
                await asyncio.sleep(seconds)

            await phase("idle", 3)
            await phase("follow", 4, click="SPOT-01")
            await phase("fp", 5, click="机器狗第一人称")
            await phase("exitfp", 5, click="退出第一人称")
            await phase("reset", 5, click="复位")

            data = await ev("JSON.stringify(window.__perf)")
            info = await ev("JSON.stringify({toolbar: (document.querySelector('.toolbar, .top-bar, header')||{}).textContent})")
            P = json.loads(data)
            print("\n=== frames:", P["count"], " long(>45ms):", len(P["frames"]), " harddrop(>120ms):", P["drop"])
            marks = P["marks"]
            for i, f in enumerate(P["frames"]):
                print(f"  {f['d']:5d} ms  @{f['mark']}")
            print("\nmarks:", [(m["m"], m["t"]) for m in marks])
            if info:
                print("toolbar:", (json.loads(info).get("toolbar") or "").strip()[:160])
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


asyncio.run(main())
