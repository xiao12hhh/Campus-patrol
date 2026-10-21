"""下载 map.cup.edu.cn 官方手绘 2.5D 栅格瓦片。

官方「可视化位置服务平台」的底图是预渲染瓦片：
  https://map.cup.edu.cn/gis-server//upload/raster/2/{z}/{x}/{y}.png
覆盖范围约 lon 116.235~116.247 / lat 40.212~40.221（主校区 + 南校区 + 润杰/阳光生活区 +
红旗操场），出界瓦片为纯色 #e7e9db 占位或 404。

本脚本：
1. 以 z17 已知覆盖矩形为基准，逐层外扩扫描 z16~z19；
2. 下载所有返回 200 的瓦片（含纯色占位，成本极低），404 记为缺失；
3. 输出 public/tiles/cup/{z}/{x}/{y}.png 与 manifest.json（供前端瓦片地面使用）。

数据来源：中国石油大学（北京）可视化位置服务平台，仅用于教学演示，保留署名。
"""
from __future__ import annotations

import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / 'public' / 'tiles' / 'cup'
UA = 'cup-campus-twin/1.0 (course project; tiles © cup.edu.cn map service)'
BASE = 'https://map.cup.edu.cn/gis-server//upload/raster/2/{z}/{x}/{y}.png'

# z17 实测覆盖（内容 + 少量占位），外扩 1 圈作为扫描范围
Z17_X0, Z17_X1, Z17_Y0, Z17_Y1 = 107856, 107859, 49516, 49519


def scan_range(z: int) -> tuple[int, int, int, int]:
    """z17 覆盖矩形换算到目标层级（外扩 1 圈）。z>=17 放大，z<17 缩小。"""
    if z >= 17:
        f = 2 ** (z - 17)
        return (Z17_X0 - 1) * f, (Z17_X1 + 1) * f + f - 1, (Z17_Y0 - 1) * f, (Z17_Y1 + 1) * f + f - 1
    f = 2 ** (17 - z)
    return (Z17_X0 - 1) // f, (Z17_X1 + 1) // f, (Z17_Y0 - 1) // f, (Z17_Y1 + 1) // f


def fetch(url: str, tries: int = 3) -> bytes | None:
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(1.5 * (i + 1))
        except Exception:
            time.sleep(1.5 * (i + 1))
    raise RuntimeError('download failed: ' + url)


def flatten_alpha(data: bytes) -> bytes:
    """官方瓦片带 alpha（内容区外透明），合成到米色底，避免 three.js 渲染成黑块。"""
    import io

    from PIL import Image

    im = Image.open(io.BytesIO(data))
    if im.mode == 'RGB':
        return data
    rgba = im.convert('RGBA')
    base = Image.new('RGBA', rgba.size, (0xE7, 0xE9, 0xDB, 255))
    out = Image.alpha_composite(base, rgba).convert('RGB')
    buf = io.BytesIO()
    out.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def main() -> None:
    zooms = [int(a) for a in sys.argv[1:]] or [16, 17, 18, 19]
    manifest = {'provider': 'map.cup.edu.cn', 'base': BASE, 'levels': {}}
    total = ok = miss = 0
    for z in zooms:
        x0, x1, y0, y1 = scan_range(z)
        saved = missing = 0
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                total += 1
                p = OUT_DIR / str(z) / str(x) / f'{y}.png'
                if p.exists():
                    saved += 1
                    ok += 1
                    continue
                data = fetch(BASE.format(z=z, x=x, y=y))
                if data is None:
                    missing += 1
                    miss += 1
                else:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(flatten_alpha(data))
                    saved += 1
                    ok += 1
                time.sleep(0.08)  # 限速，对校园服务友好
        manifest['levels'][str(z)] = {
            'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1,
            'saved': saved, 'missing': missing,
        }
        print(f'z{z}: saved={saved} missing={missing}')
    (OUT_DIR / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'TOTAL ok={ok} miss={miss} of {total}')
    print('done ->', OUT_DIR)


if __name__ == '__main__':
    main()
