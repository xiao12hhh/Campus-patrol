"""稳定性回归：断掉后端 → 头部是否变"断开/重连" → 重启后端 → 是否自动恢复。

用法： python tools/_stability_probe.py
"""
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9335
URL = "http://127.0.0.1:8000/?m=robot&v=twin&tod=day"


def http_json(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return json.load(op.open(f"http://127.0.0.1:{PORT}{path}", timeout=10))


def backend_pids():
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue"
                          " | Select-Object -ExpandProperty OwningProcess -Unique"],
                         capture_output=True, text=True).stdout
    return [int(x) for x in re.findall(r"\d+", out)]


def stop_backend():
    for pid in backend_pids():
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
    time.sleep(1.5)


def start_backend():
    subprocess.Popen([PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"],
                     cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(30):
        time.sleep(1.0)
        try:
            op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            op.open("http://127.0.0.1:8000/api/robots", timeout=3).read()
            return True
        except Exception:
            continue
    return False


async def main():
    if not backend_pids():
        print("后端没在跑，先拉起")
        start_backend()

    profile = tempfile.mkdtemp(prefix="stability-")
    proc = subprocess.Popen([
        CHROME, f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check",
        "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion",
        "--window-size=1600,1000", "--window-position=-2600,-2600", URL,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = True
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

            read = ("(() => { const h = document.querySelector('header .live');"
                    " const card = document.querySelector('.crash');"
                    " const dbg = window.__scene_debug;"
                    " return JSON.stringify({ live: h ? h.textContent.trim().slice(0, 22) : null,"
                    " crash: !!card, fps: dbg ? 1 : 0 }); })()")

            await asyncio.sleep(9)
            print("1) 正常态:", await ev(read))

            stop_backend()
            await asyncio.sleep(7)
            s = await ev(read)
            print("2) 杀掉后端 7s:", s)
            if "断开" not in (s or ""):
                ok = False
                print("   ✗ 头部没有显示断开")

            up = start_backend()
            print("3) 后端重启:", "ok" if up else "fail")
            await asyncio.sleep(10)
            s = await ev(read)
            print("4) 恢复后:", s)
            if "在线" not in (s or ""):
                ok = False
                print("   ✗ 没有自动恢复到在线")
            if '"crash":true' in (s or ""):
                ok = False
                print("   ✗ 触发了错误边界")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
    print("RESULT:", "PASS" if ok else "FAIL")


asyncio.run(main())
