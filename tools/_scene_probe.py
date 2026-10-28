"""读回 __scene_debug：确认 ?follow= / ?fp=1 到底有没有生效、相机落在哪。
用法： python tools/_scene_probe.py "http://127.0.0.1:8000/?m=robot&v=twin&tod=day&follow=SPOT-01&fp=1"
"""
import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9334
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/"


def http_json(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return json.load(op.open(f"http://127.0.0.1:{PORT}{path}", timeout=10))


async def main():
    profile = tempfile.mkdtemp(prefix="sceneprobe-")
    proc = subprocess.Popen([
        CHROME, f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check",
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
            except Exception:
                continue
            if ws_url:
                break
        if not ws_url:
            print("no target")
            return
        async with websockets.connect(ws_url, max_size=8 * 1024 * 1024) as ws:
            seq = [0]

            async def ev(expr):
                seq[0] += 1
                await ws.send(json.dumps({"id": seq[0], "method": "Runtime.evaluate",
                                          "params": {"expression": expr, "returnByValue": True}}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == seq[0]:
                        return msg.get("result", {}).get("result", {}).get("value")

            probe = ("(() => { const d = window.__scene_debug; if (!d) return 'NO_HOOK';"
                     " return JSON.stringify({cam: d.cam(), tgt: d.tgt(), follow: d.follow(),"
                     " fp: d.fp(), dog: d.dogState(), ctl: d.controls(), robots: d.robots()}); })()")
            for i in range(6):
                await asyncio.sleep(2.0)
                v = await ev(probe)
                print(f"t+{(i + 1) * 2}s:", v)
                if i == 4:
                    seq[0] += 1
                    await ws.send(json.dumps({"id": seq[0], "method": "Page.captureScreenshot",
                                              "params": {"format": "png"}}))
                    while True:
                        msg = json.loads(await ws.recv())
                        if msg.get("id") == seq[0]:
                            import base64
                            data = msg["result"]["data"]
                            with open("_shots/fp_probe.png", "wb") as f:
                                f.write(base64.b64decode(data))
                            print("screenshot -> _shots/fp_probe.png")
                            break
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


asyncio.run(main())
