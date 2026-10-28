"""回归：路点落在建筑质心（贴墙）时，狗会不会卡死不动。

用法： python tools/_stuck_probe.py [seconds]
"""
import json
import math
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8000"
OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get_robots():
    return {r["id"]: r for r in json.load(OP.open(f"{BASE}/api/robots", timeout=8))}


def post(path, payload):
    req = urllib.request.Request(f"{BASE}{path}", method="POST",
                                data=json.dumps(payload).encode(),
                                headers={"Content-Type": "application/json"})
    return OP.open(req, timeout=8).read()


def main():
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 45
    watch_all = len(sys.argv) > 2 and sys.argv[2] == "all"
    if watch_all:
        print("观察全部机器人（不再下发队列）")
    else:
        # 故意用建筑质心当路点：目标贴在墙上，最容易卡
        post("/api/robots/queue", {
            "robot_id": "SPOT-01", "mode": "replace",
            "waypoints": [
                {"x": -46.75, "z": -11.44, "name": "中油大厦A座"},
                {"x": -25.15, "z": -14.28, "name": "图书馆"},
            ],
        })
        print("queue set")

    prev = {}
    stall = {}
    worst = {}
    moved_total = {}
    for i in range(seconds):
        for rid, r in get_robots().items():
            p = (r["x"], r["z"])
            moved_total.setdefault(rid, 0.0)
            worst.setdefault(rid, 0)
            stall.setdefault(rid, 0)
            moving = r["status"] in ("巡检中", "返航")
            if rid in prev and moving:
                d = math.hypot(p[0] - prev[rid][0], p[1] - prev[rid][1]) * 10  # 1 单位 = 10 m
                moved_total[rid] += d
                if d < 0.2:
                    stall[rid] += 1
                    worst[rid] = max(worst[rid], stall[rid])
                else:
                    stall[rid] = 0
            if rid == "SPOT-01":
                print(f"t={i:02d}s moved={moved_total[rid]:6.0f}m pos=({p[0]:7.2f},{p[1]:7.2f}) "
                      f"{r['status']:5s} path={len(r.get('path') or []):2d} "
                      f"qidx={r.get('queue_index')} stalls={stall[rid]}")
            prev[rid] = p
        time.sleep(1)

    print()
    for rid in sorted(worst):
        print(f"{rid:8s} 总位移 {moved_total[rid]:5.0f} m，最长连续停滞 {worst[rid]} 个采样")
    bad = [rid for rid, w in worst.items() if w > 6]
    print("RESULT:", "PASS" if not bad else f"FAIL（{', '.join(bad)} 卡死超过 6 秒）")


main()
