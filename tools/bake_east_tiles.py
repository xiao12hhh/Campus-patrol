"""为官方瓦片未覆盖的区域（主要是东校区）烘焙同风格 2.5D 瓦片。

官方 map.cup.edu.cn 的手绘瓦片只画到东校区西缘（z17 到 lon≈116.2463，
z19 到 lon≈116.2492 且大片纯色占位），东校区（体育馆 / 游泳馆 / 东教学楼 …）
在官方底图上是空白。本脚本用 campus-local.json 的 OSM 矢量数据，
按官方瓦片的绘图语言（采样自官方瓦片）程序化烘焙补丁瓦片：

  底色 #e7e9db · 道路 #eceae2 + 白色边线 · 草地 #cfedcf · 水体 #97c1cb
  建筑 = 东南阴影 + footprint 墙色 + 北移屋顶（伪 2.5D）
  行道树 = 深绿圆 + 浅绿高光 + 小阴影

烘焙对象：兴趣框（INTEREST）内"缺失或纯色占位"的瓦片，逐瓦片渲染；
跨瓦片要素通过给每张瓦片扩一层缓冲区（TILE_PAD px）保证连续。
输出直接写入 public/tiles/cup/{z}/{x}/{y}.png（不覆盖已有官方瓦片），
并把补丁清单合并进 manifest.json 的 levels[z].patch。

用法：
  python tools/bake_east_tiles.py          # 烘焙全部层级
  python tools/bake_east_tiles.py 19       # 只烘 z19
  python tools/bake_east_tiles.py preview  # 生成一张东校区预览大图
"""
from __future__ import annotations

import json
import math
import os
import pathlib
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[1]
TILE_DIR = ROOT / 'public' / 'tiles' / 'cup'
DATA = ROOT / 'public' / 'data' / 'campus-local.json'

# ---------------------------------------------------------------- 坐标基准（与 build_campus_v3.py 完全一致）
ORIGIN_LAT, ORIGIN_LON, UNIT, M = 40.2159, 116.2449, 10.0, 111320.0
COS = math.cos(math.radians(ORIGIN_LAT))

# 兴趣框（geographic）：三校区 + 缓冲。补丁只烘这个框内缺瓦片的区域。
INTEREST = {'lon0': 116.2440, 'lon1': 116.2580, 'lat0': 40.2093, 'lat1': 40.2228}

# ---------------------------------------------------------------- 官方风格常量（采样自官方瓦片）
BG = (0xe7, 0xe9, 0xdb)          # 底色
ROAD = (0xf6, 0xf5, 0xf0)        # 路面（比底色亮，接近纸白）
ROAD_CASE = (0xdb, 0xd8, 0xcb)   # 路缘描边（比底色暗一点）
ROAD_MINOR = (0xef, 0xee, 0xe8)  # 支路路面
GRASS = (0xcf, 0xed, 0xcf)       # 草地
GRASS_DARK = (0xbe, 0xe3, 0xc1)  # 草地暗部
WATER = (0x97, 0xc1, 0xcb)       # 水体
PARKING = (0xe9, 0xe8, 0xe0)     # 停车场
WALL_LIGHT = (0xf9, 0xf7, 0xf3)  # 建筑墙/主色（米白，明显亮于底色）
WALL_TINT = (0xf0, 0xed, 0xe5)   # 建筑侧影
WALL_BRICK = (0xe6, 0xc2, 0xa4)  # 砖色宿舍
WALL_EDGE = (0xb5, 0xb0, 0x9c, 120)  # 建筑描边
ROOF_DARK = (0xd2, 0xcf, 0xba)   # 深色屋顶
ROOF_BLUE = (0x9d, 0xc3, 0xd4)   # 体育馆蓝屋顶
ROOF_TINT = (0xe6, 0xe3, 0xd6)   # 浅灰屋顶
SHADOW = (0x8e, 0x96, 0x84)      # 阴影（alpha 叠加）
TREE = (0x67, 0xa3, 0x59)        # 树冠
TREE_LIGHT = (0x8c, 0xc2, 0x72)  # 树冠高光
PITCH_RUN = (0xd8, 0x9a, 0x8a)   # 跑道
PITCH_GRASS = (0x9f, 0xd2, 0x9c) # 球场草

# 伪 2.5D 位移系数（z19 像素）
LEAN_PER_M = 0.55      # 屋顶北移：每米楼高 0.55 px（z19）
SHADOW_PER_M = 0.45    # 阴影东南移：每米楼高 0.45 px（z19）

TILE = 256
TILE_PAD = 96          # 渲染瓦片时的外扩缓冲（px），保证跨瓦片要素被裁剪连续


def local2geo(x, z):
    return ORIGIN_LAT - z * UNIT / M, ORIGIN_LON + x * UNIT / (M * COS)


def geo2local(lat, lon):
    return (lon - ORIGIN_LON) * M * COS / UNIT, (ORIGIN_LAT - lat) * M / UNIT


def tile2lonlat(z, x, y):
    n = 2.0 ** z
    lon0 = x / n * 360 - 180
    lon1 = (x + 1) / n * 360 - 180
    lat0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon0, lat0, lon1, lat1  # 西北角、东南角


def lonlat2pix(z, lon, lat):
    """地理 → 全局 Web Mercator 像素坐标（z 层级，256px/瓦片）。"""
    n = 2.0 ** z
    xt = (lon + 180) / 360 * n * TILE
    la = math.radians(lat)
    yt = (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * n * TILE
    return xt, yt


def local2pix(z, x, zz):
    lat, lon = local2geo(x, zz)
    return lonlat2pix(z, lon, lat)


# ---------------------------------------------------------------- 数据加载
def ring_of(f):
    g = f['geometry']
    if g['type'] == 'Polygon':
        return g['coordinates'][0]
    if g['type'] == 'MultiPolygon':
        return g['coordinates'][0][0]
    return None


def load_features():
    d = json.loads(DATA.read_text(encoding='utf-8'))
    feats = []
    for f in d['features']:
        g = f['geometry']
        # 预换算几何（local → z19 全局像素 + 保留 local），所有层级渲染时从 local 重算
        feats.append(f)
    return d, feats


def classify_building(f):
    p = f.get('properties') or {}
    bt = p.get('building') or ''
    name = f.get('name') or ''
    if bt in ('student_bedroom', 'residential'):
        return 'dorm'
    if '体育馆' in name or '游泳' in name:
        return 'gym'
    if '食堂' in name or '餐厅' in name:
        return 'service'
    if '教学' in name or '实验' in name or '楼' in name:
        return 'teach'
    return 'teach'


WALL_STYLE = {
    'dorm': (WALL_BRICK, ROOF_TINT),
    'gym': (WALL_LIGHT, ROOF_BLUE),
    'service': (WALL_TINT, ROOF_DARK),
    'teach': (WALL_LIGHT, ROOF_TINT),
}


def shifted_poly(pts, dx, dy):
    return [(px + dx, py + dy) for px, py in pts]


def draw_map(img: Image.Image, z: int, ox: int, oy: int, feats) -> None:
    """把矢量要素画到 img 上。img 覆盖全局像素 [ox, ox+w] × [oy, oy+h]。"""
    scale = 2 ** (z - 19)            # z19 时 1，每降一层像素减半
    lean_k = LEAN_PER_M * scale
    shadow_k = SHADOW_PER_M * scale
    dr = ImageDraw.Draw(img, 'RGBA')

    def P(lx, lz):
        gx, gy = local2pix(z, lx, lz)
        return gx - ox, gy - oy

    def clip_poly(pts):
        return pts  # PIL 自带裁剪；用缓冲区保证跨界连续

    # ---- 绿地 / 水体 / 运动场 / 停车场（平面色块） ----
    for f in feats:
        ring = ring_of(f)
        if not ring:
            continue
        if f['kind'] == 'green':
            dr.polygon([P(*p) for p in ring], fill=GRASS)
        elif f['kind'] == 'water':
            dr.polygon([P(*p) for p in ring], fill=WATER)
        elif f['kind'] == 'parking':
            dr.polygon([P(*p) for p in ring], fill=PARKING)
        elif f['kind'] == 'pitch':
            p_ = f.get('properties') or {}
            fill = PITCH_GRASS if p_.get('leisure') == 'pitch' else GRASS
            if 'run' in (p_.get('sport') or '') or p_.get('leisure') == 'track':
                fill = PITCH_RUN
            dr.polygon([P(*q) for q in ring], fill=fill)

    # ---- 道路（深色 casing → 亮色路面，接近官方的白路灰边） ----
    roads = []
    for f in feats:
        if f['kind'] != 'road':
            continue
        p_ = f.get('properties') or {}
        hw = p_.get('highway') or ''
        if hw in ('footway', 'path', 'steps', 'pedestrian'):
            w, col = 2.6 * scale, ROAD_MINOR
        elif hw in ('primary', 'secondary'):
            w, col = 10 * scale, ROAD
        elif hw == 'tertiary':
            w, col = 8 * scale, ROAD
        else:
            w, col = 6 * scale, ROAD
        roads.append((f, w, col))
    roads.sort(key=lambda r: r[1])  # 窄路先画，宽路压上
    for f, w, col in roads:
        g = f['geometry']
        pts = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates']
        line = [P(*p) for p in pts]
        if len(line) < 2:
            continue
        dr.line(line, fill=ROAD_CASE, width=int(w + 2.6 * scale), joint='curve')
        dr.line(line, fill=col, width=max(1, int(w)), joint='curve')

    # ---- 建筑（阴影一次合成 → 墙体 → 北移屋顶 + 窗带） ----
    buildings = []
    for f in feats:
        if f['kind'] != 'building':
            continue
        ring = ring_of(f)
        if not ring or len(ring) < 3:
            continue
        h_m = (f.get('height') or 0.4) * UNIT
        buildings.append((f, ring, h_m))
    buildings.sort(key=lambda b: b[2])  # 矮的先画，高的压上（也近似前后关系）

    # 所有阴影先攒到一个 overlay，再一次合成（避免逐栋全图 compose）
    shadow_ov = Image.new('RGBA', img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow_ov)
    roofs = []
    for f, ring, h_m in buildings:
        pts = [P(*p) for p in ring]
        lean = lean_k * h_m
        roof = shifted_poly(pts, 0, -lean)
        shadow = shifted_poly(roof, shadow_k * h_m * 0.9, shadow_k * h_m)
        sd.polygon(shadow, fill=SHADOW + (115,))
        roofs.append((f, pts, roof, lean))
    img.paste(Image.alpha_composite(img.convert('RGBA'), shadow_ov).convert('RGB'), (0, 0))
    dr = ImageDraw.Draw(img, 'RGBA')

    for f, pts, roof, lean in roofs:
        style = WALL_STYLE[classify_building(f)]
        # 墙体 = footprint（南部会露出，形成"南立面"）
        dr.polygon(pts, fill=style[0], outline=WALL_EDGE, width=max(1, int(1.1 * scale)))
        # 屋顶
        dr.polygon(roof, fill=style[1])
        # 南立面窗带：沿屋顶边缘向 footprint 画短竖线
        if lean > 2:
            for i in range(1, len(roof)):
                a, b = roof[i - 1], roof[i]
                steps = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / max(2.0, 2.4 * scale)))
                for s in range(steps + 1):
                    t = s / steps
                    px, py = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                    dr.line([(px, py), (px, py + lean * 0.72)],
                            fill=(0x74, 0x82, 0x8c, 165), width=max(1, int(1.0 * scale)))

    # ---- 行道树（沿主路两侧撒点） ----
    rnd = random.Random(20260927)
    trees = []
    px2unit = 0.0298 / scale  # 1 px（该层级）≈ 0.298 m ≈ 0.0298 unit @z19
    for f, w, col in roads:
        if w < 4 * scale:
            continue
        g = f['geometry']
        pts = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates']
        gap_units = 0.9 + rnd.random() * 0.3   # 每 9~12 m 一棵
        acc = rnd.random()
        for i in range(1, len(pts)):
            ax, az = pts[i - 1]
            bx, bz = pts[i]
            seg = math.hypot(bx - ax, bz - az)  # local 单位
            if seg < 1e-6:
                continue
            acc += seg
            while acc >= gap_units:
                acc -= gap_units
                t = min(1.0, max(0.0, 1 - acc / seg))
                lx, lz = ax + (bx - ax) * t, az + (bz - az) * t
                nx, nz = -(bz - az) / seg, (bx - ax) / seg
                off = (w * 0.5 + 3.5 * scale) * px2unit
                trees.append((lx + nx * off, lz + nz * off))
                trees.append((lx - nx * off, lz - nz * off))
    r_tree = max(1.8, 4.3 * scale)
    for lx, lz in trees:
        gx, gy = P(lx, lz)
        dr.ellipse([gx + r_tree * 0.25 - r_tree * 0.6, gy + r_tree * 0.3 - r_tree * 0.45,
                    gx + r_tree * 0.25 + r_tree * 0.6, gy + r_tree * 0.3 + r_tree * 0.45],
                   fill=SHADOW + (75,))
        dr.ellipse([gx - r_tree, gy - r_tree, gx + r_tree, gy + r_tree], fill=TREE)
        dr.ellipse([gx - r_tree * 0.55, gy - r_tree * 0.6, gx + r_tree * 0.12, gy - r_tree * 0.05],
                   fill=TREE_LIGHT)


def is_solid(img: Image.Image) -> bool:
    return len(img.convert('RGB').getcolors(65536) or []) == 1


def tile_needed(z, x, y) -> bool:
    """瓦片在兴趣框内（与其相交）且当前缺失或为纯色。"""
    lon0, lat0, lon1, lat1 = tile2lonlat(z, x, y)
    if lon1 < INTEREST['lon0'] or lon0 > INTEREST['lon1'] or lat1 < INTEREST['lat0'] or lat0 > INTEREST['lat1']:
        return False
    p = TILE_DIR / str(z) / str(x) / f'{y}.png'
    if not p.exists():
        return True
    return is_solid(Image.open(p))


def features_near(feats, lon0, lat0, lon1, lat1, pad_local=2.5):
    """框选附近要素（local 单位外扩 pad）。"""
    lx0, lz0 = geo2local(lat1, lon0)
    lx1, lz1 = geo2local(lat0, lon1)
    lx0 -= pad_local; lx1 += pad_local; lz0 -= pad_local; lz1 += pad_local
    out = []
    for f in feats:
        g = f['geometry']
        xs, zs = [], []

        def walk(c):
            if isinstance(c[0], (int, float)):
                xs.append(c[0]); zs.append(c[1])
            else:
                for q in c:
                    walk(q)

        walk(g['coordinates'])
        if not xs:
            continue
        if min(xs) > lx1 or max(xs) < lx0 or min(zs) > lz1 or max(zs) < lz0:
            continue
        out.append(f)
    return out


def bake(z: int, manifest: dict) -> int:
    n = 2 ** z
    # 兴趣框覆盖的瓦片范围
    fx0, fy0 = [int(v) for v in lonlat2pix(z, INTEREST['lon0'], INTEREST['lat1'])]
    fx1, fy1 = [int(v) for v in lonlat2pix(z, INTEREST['lon1'], INTEREST['lat0'])]
    tx0, tx1, ty0, ty1 = fx0 // TILE, fx1 // TILE, fy0 // TILE, fy1 // TILE
    count = 0
    d, feats = load_features()
    for x in range(tx0, tx1 + 1):
        for y in range(ty0, ty1 + 1):
            if not tile_needed(z, x, y):
                continue
            lon0, lat0, lon1, lat1 = tile2lonlat(z, x, y)
            # 缓冲后的渲染范围
            pad = TILE_PAD * (2 ** (19 - z))
            bx0, by0 = lonlat2pix(z, lon0, lat0)
            w = int(TILE + pad * 2)
            img = Image.new('RGB', (w, w), BG)
            ox, oy = int(bx0) - pad, int(by0) - pad
            sub = features_near(feats, lon0 - 0.003, lat0 - 0.002, lon1 + 0.003, lat1 + 0.002)
            draw_map(img, z, ox, oy, sub)
            # 裁出正式瓦片
            tile_img = img.crop((pad, pad, pad + TILE, pad + TILE))
            p = TILE_DIR / str(z) / str(x)
            p.mkdir(parents=True, exist_ok=True)
            tile_img.save(p / f'{y}.png', optimize=True)
            count += 1
    return count


def preview():
    """东校区预览大图（z17 分辨率，4x4 瓦片）。"""
    z = 17
    d, feats = load_features()
    lon0, lon1 = 116.2460, 116.2560
    lat0, lat1 = 40.2110, 40.2190
    gx0, gy0 = [int(v) for v in lonlat2pix(z, lon0, lat1)]
    gx1, gy1 = [int(v) for v in lonlat2pix(z, lon1, lat0)]
    w, h = gx1 - gx0, gy1 - gy0
    pad = TILE_PAD * 4
    img = Image.new('RGB', (w + pad * 2, h + pad * 2), BG)
    sub = features_near(feats, lon0 - 0.004, lat0 - 0.003, lon1 + 0.004, lat1 + 0.003, pad_local=6)
    draw_map(img, z, gx0 - pad, gy0 - pad, sub)
    img = img.crop((pad, pad, pad + w, pad + h))
    out = ROOT / '_shots' / 'east_patch_preview.png'
    img.save(out)
    print('preview ->', out, img.size)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'preview':
        preview()
        return
    zooms = [int(a) for a in sys.argv[1:]] or [16, 17, 18, 19]
    mpath = TILE_DIR / 'manifest.json'
    manifest = json.loads(mpath.read_text(encoding='utf-8'))
    manifest.setdefault('levels', {})
    for z in zooms:
        c = bake(z, manifest)
        lvl = manifest['levels'].setdefault(str(z), {})
        lvl['patched'] = c
        print(f'z{z}: baked {c} patch tiles')
    mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    print('manifest updated')


if __name__ == '__main__':
    main()
