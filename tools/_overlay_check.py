# -*- coding: utf-8 -*-
"""把 campus-local.json 的建筑轮廓叠到官方 z19 瓦片上，肉眼核查位置对不对。

输出 _shots/overlay_z19.png（左：纯瓦片；右：叠轮廓+名称）。
"""
import json
import math
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(r'E:\agent-work\数据结构-笔记\校园巡视')
TILES = ROOT / 'public' / 'tiles' / 'cup'
OUT = ROOT / '_shots' / 'overlay_z19.png'

ORIGIN = (40.2159, 116.2449)
UNIT = 10.0
M_PER_DEG = 111320.0
COS0 = math.cos(math.radians(ORIGIN[0]))
Z = 19

import sys

# 取景范围（本地单位）：覆盖北校区 + 中油大厦一带
X0, X1 = -72.0, 12.0
Z0, Z1 = -34.0, 26.0
SCALE = 0.5  # 每个瓦片像素缩放
if len(sys.argv) > 1 and sys.argv[1] == 'crop':
    X0, X1, Z0, Z1 = -62.0, -12.0, -26.0, 6.0
    SCALE = 1.0
    OUT = ROOT / '_shots' / 'overlay_zoom.png'
elif len(sys.argv) > 1 and sys.argv[1] == 'crop2':
    X0, X1, Z0, Z1 = -56.0, -30.0, -22.0, -2.0
    SCALE = 1.5
    OUT = ROOT / '_shots' / 'overlay_zoom2.png'
elif len(sys.argv) > 1 and sys.argv[1] == 'track':
    X0, X1, Z0, Z1 = -50.0, -30.0, -20.0, -6.0
    SCALE = 2.0
    OUT = ROOT / '_shots' / 'track_tiles.png'

def lng_to_x(lng):
    return ((lng - ORIGIN[1]) * M_PER_DEG * COS0) / UNIT

def lat_to_z(lat):
    return ((ORIGIN[0] - lat) * M_PER_DEG) / UNIT

def x_to_lng(x):
    return ORIGIN[1] + x * UNIT / (M_PER_DEG * COS0)

def z_to_lat(z):
    return ORIGIN[0] - z * UNIT / M_PER_DEG

def tile_rect(x, y, z=Z):
    n = 2 ** z
    lon0 = (x / n) * 360 - 180
    lon1 = ((x + 1) / n) * 360 - 180
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lng_to_x(lon0), lng_to_x(lon1), lat_to_z(lat_n), lat_to_z(lat_s)

# 需要的瓦片索引范围
def tile_of(lng, lat, z=Z):
    n = 2 ** z
    tx = int((lng + 180) / 360 * n)
    lat_r = math.radians(lat)
    ty = int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)
    return tx, ty

tx0, ty0 = tile_of(x_to_lng(X0), z_to_lat(Z0))
tx1, ty1 = tile_of(x_to_lng(X1), z_to_lat(Z1))
tx0, tx1 = min(tx0, tx1), max(tx0, tx1)
ty0, ty1 = min(ty0, ty1), max(ty0, ty1)
print('tiles', tx0, tx1, ty0, ty1, (tx1 - tx0 + 1), 'x', (ty1 - ty0 + 1))

TS = 256
tw = int(round(TS * SCALE))
canvas = Image.new('RGB', ((tx1 - tx0 + 1) * tw, (ty1 - ty0 + 1) * tw), (231, 233, 219))
missing = 0
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        p = TILES / str(Z) / str(tx) / f'{ty}.png'
        if not p.exists():
            missing += 1
            continue
        im = Image.open(p).convert('RGBA')
        if SCALE != 1:
            im = im.resize((tw, tw), Image.LANCZOS)
        bg = Image.new('RGBA', (tw, tw), (231, 233, 219, 255))
        bg.alpha_composite(im)
        canvas.paste(bg.convert('RGB'), ((tx - tx0) * tw, (ty - ty0) * tw))
print('missing tiles', missing)

# 本地坐标 → 画布像素
REF = tile_rect(tx0, ty0)
# 用瓦片栅格线性映射（同一层级内 Mercator 在局部近似线性；误差 < 1 单位，够肉眼核查）
X_REF, Z_REF = REF[0], REF[2]
PX_PER_UNIT_X = tw / (REF[1] - REF[0])
PX_PER_UNIT_Z = tw / (REF[3] - REF[2])

def to_px(x, z):
    return ((x - X_REF) * PX_PER_UNIT_X, (z - Z_REF) * PX_PER_UNIT_Z)

print('px per unit', PX_PER_UNIT_X, PX_PER_UNIT_Z)

data = json.loads((ROOT / 'public' / 'data' / 'campus-local.json').read_text(encoding='utf-8'))

def ring_of(f):
    g = f['geometry']
    if g['type'] == 'Polygon':
        return g['coordinates'][0]
    if g['type'] == 'MultiPolygon':
        return g['coordinates'][0][0]
    if g['type'] == 'LineString':
        pts = g['coordinates']
        if len(pts) > 2 and pts[0] == pts[-1]:
            return pts
    return None

right = canvas.copy()
dr = ImageDraw.Draw(right, 'RGBA')
font = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 13)
font_s = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 11)

n = 0
STYLE = {
    'building': ((255, 60, 60, 60), (200, 0, 0, 220), (0, 0, 160, 255)),
    'pitch': ((0, 170, 0, 60), (0, 120, 0, 230), (0, 90, 0, 255)),
    'water': ((0, 90, 255, 60), (0, 60, 200, 230), (0, 40, 160, 255)),
}
for f in data['features']:
    if f['kind'] not in STYLE:
        continue
    if f.get('in_campus') is False:
        continue
    r = ring_of(f)
    if not r:
        continue
    fill, line, txt = STYLE[f['kind']]
    pts = [to_px(p[0], p[1]) for p in r]
    if max(p[0] for p in pts) < 0 or min(p[0] for p in pts) > right.width:
        continue
    if max(p[1] for p in pts) < 0 or min(p[1] for p in pts) > right.height:
        continue
    dr.polygon(pts, fill=fill, outline=line)
    if f.get('name'):
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        dr.text((cx, cy), f['name'], font=font, fill=txt, anchor='mm',
                stroke_width=2, stroke_fill=(255, 255, 255, 230))
        n += 1
print('labeled', n)

# 图书馆 / 三教 标记 + 直线
def find(name):
    for f in data['features']:
        if f['kind'] == 'building' and f.get('name') == name and f.get('in_campus') is not False:
            r = ring_of(f)
            return sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)
    return None

a = find('第三教学楼')
b = find('图书馆')
if a and b:
    pa, pb = to_px(*a), to_px(*b)
    dr.line([pa, pb], fill=(0, 120, 255, 255), width=3)
    for p, t in ((pa, '第三教学楼'), (pb, '图书馆')):
        dr.ellipse([p[0] - 5, p[1] - 5, p[0] + 5, p[1] + 5], fill=(0, 90, 220, 255))
    mid = ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)
    dr.text(mid, '205.5 m', font=font, fill=(0, 90, 220, 255), anchor='mm',
            stroke_width=3, stroke_fill=(255, 255, 255, 240))

combo = Image.new('RGB', (canvas.width * 2 + 12, canvas.height), (255, 255, 255))
combo.paste(canvas, (0, 0))
combo.paste(right, (canvas.width + 12, 0))
combo.save(OUT)
print('saved', OUT, combo.size)
