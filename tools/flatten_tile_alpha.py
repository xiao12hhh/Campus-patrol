"""把瓦片的透明像素合成到官方米色底色上（一次性后处理）。

官方 map.cup.edu.cn 的栅格瓦片是带 alpha 的调色板 PNG：有内容的区域正常上色，
内容区之外（校园边缘外）是**透明像素**。官方网页把它叠在白底上显示为白色；
而 three.js 的 MeshBasicMaterial 默认不透明，alpha 被忽略，透明区域会渲染成
**黑色**——这就是场景里"大块黑色区域"的来源。

本脚本遍历 public/tiles/cup 全部 PNG，把 alpha<255 的像素与 #e7e9db（官方
地图底色）做 alpha 合成，输出不透明 RGB。已是不透明（无 alpha 或全不透明）
的文件跳过。download_cup_tiles.py 的下载流程也已加同样的处理。
"""
from __future__ import annotations

import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
TILE_DIR = ROOT / 'public' / 'tiles' / 'cup'
BG = (0xe7, 0xe9, 0xdb)


def flatten(path: pathlib.Path) -> bool:
    im = Image.open(path)
    if im.mode in ('RGB',):
        return False
    rgba = im.convert('RGBA')
    alpha = rgba.getchannel('A')
    lo, hi = alpha.getextrema()
    if lo == 255:
        return False  # 全不透明，无需处理
    base = Image.new('RGBA', rgba.size, BG + (255,))
    out = Image.alpha_composite(base, rgba).convert('RGB')
    out.save(path, optimize=True)
    return True


def main() -> None:
    zooms = [int(a) for a in sys.argv[1:]] or [16, 17, 18, 19]
    done = 0
    for z in zooms:
        zdir = TILE_DIR / str(z)
        if not zdir.is_dir():
            continue
        n = 0
        for p in zdir.rglob('*.png'):
            if flatten(p):
                n += 1
        done += n
        print(f'z{z}: flattened {n}')
    print(f'total {done} tiles flattened')


if __name__ == '__main__':
    main()
