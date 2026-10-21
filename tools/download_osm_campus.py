"""Download public OSM candidate data for CUPB Changping campus.

Run this script on a machine with internet access. It intentionally saves the
raw response and query metadata; it does not claim that the returned boundary
is an authoritative campus boundary.
"""
from __future__ import annotations
import json, pathlib, urllib.parse, urllib.request, urllib.error, datetime, time

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "sources"
OUT.mkdir(parents=True, exist_ok=True)
UA = "cup-campus-twin/0.1 (research; contact project owner)"

def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read()

def main() -> None:
    # 昌平校区位于北京北部；使用较小 bbox，避免整北京查询触发公共节点超时。
    # 名称可能使用中文、英文或简称。
    query = '''[out:json][timeout:60];(
      nwr["name"~"中国石油|石油大学|China University of Petroleum|CUP",i](40.10,116.05,40.35,116.45);
      nwr["amenity"="university"]["name"~"石油|petroleum|CUP",i](40.10,116.05,40.35,116.45);
    );out center tags;'''
    body = urllib.parse.urlencode({"data": query}).encode()
    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
    ]
    raw = None; used_endpoint = None; last_error = None
    for endpoint in endpoints:
        try:
            req = urllib.request.Request(endpoint, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=150) as response:
                raw = response.read(); used_endpoint = endpoint
            break
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            time.sleep(2)
    if raw is None:
        raise RuntimeError(f"所有 Overpass 节点均不可用或超时：{last_error}")
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (OUT / "cupb-candidate-search.json").write_bytes(raw)
    (OUT / "cupb-candidate-search.meta.json").write_text(json.dumps({"source":used_endpoint,"retrieved_at":stamp,"query":query,"license":"ODbL 1.0; see https://www.openstreetmap.org/copyright"},ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Saved raw OSM response to {OUT / 'cupb-candidate-search.json'}")
    print("Review the result before choosing a campus boundary; this is candidate data, not authoritative survey data.")

if __name__ == "__main__": main()
