"""重建中国石油大学（北京）校园地图数据 —— v3「与实地相符」版。

v2 的问题（已查证）：
  * OSM 关系 13644491 的边界只覆盖「东校区 + 南北校区一角」，却把
    昌盛园小区 / 昌平广播电视 / 南环路沿街楼等城区建筑误判为校内；
  * OSM 中文建筑标注位置参差（相对真值偏 40~190 m）；
  * 全校 84 栋楼只取到 21 栋，且无真实楼层 / 高度。

v3 的方案（已用第三方坐标交叉验证）：
  1. 主建筑改用学校官方可视化地图 map.cup.edu.cn 的 3D 建筑源
     （84 栋，含真实轮廓 / 名称 / 高度 / 楼层数）。
     验证：腾讯地图 GCJ-02 坐标解密为 WGS-84 后，与官方建筑质心吻合
     1.8~64 m（南校区→图书馆 1.8 m，北校区→管院公寓北楼 9.7 m），
     而 OSM 对同一点的偏差为 40~90 m 且匹配到无关要素。
  2. 东校区（南环东路 15 号，南环路以南）官方 3D 数据未覆盖，
     用 OSM 建筑补足（腾讯东校区中心 WGS 116.248727,40.214133）。
  3. 道路 / 绿地 / 水体 / 运动场沿用 OSM（主干道位置与官方建筑自洽）。
  4. 三个校区分别打 zone 标签：北校区 / 南校区 / 东校区 / 校外生活区。

v3.1（做程序化建筑细节时补的字段）：
  * properties.levels      官方「楼层数」，82/101 栋有，层高统一 4.0 m
  * properties.min_level   <0 表示有地下层（14 栋）
  * properties.part        building_part=entrance_3d → 官方标注的门体块（南门门房/门柱）
  * properties.floor_area  从 content 里正则出的建筑面积（m²）

坐标：局部米制，原点见 ORIGIN_*，1 单位 = 10 米，x 向东，z 向南。
许可：建筑 © 中国石油大学（北京）可视化位置服务平台；
      路网等 © OpenStreetMap contributors (ODbL 1.0)。
"""
from __future__ import annotations

import json
import math
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / 'data' / 'sources'
OUT = ROOT / 'public' / 'data' / 'campus-local.json'

UA = 'cup-campus-twin/0.3 (research; contact project owner)'

# ---------------------------------------------------------------- 坐标基准
# 三校区整体外接：lon 116.2363..116.2535  lat 40.2120..40.2198
ORIGIN_LAT = 40.2159
ORIGIN_LON = 116.2449
UNIT = 10.0
M = 111320.0
COS = math.cos(math.radians(ORIGIN_LAT))

OFFICIAL_SRC = SRC_DIR / 'cupb-official-3d.json'

# 东校区（南环东路 15 号）范围：由腾讯地图 GCJ-02 解密后的校门坐标圈定
EAST = {'lon0': 116.2443, 'lon1': 116.2536, 'lat0': 40.2118, 'lat1': 40.2160}
EAST_EXCLUDE = ('昌盛园', '昌平', '小区', '酒店', '大宅门', '商务')

# 北 / 南校区分界（府学路以南的南校区北门 lat ≈ 40.21643）
NS_SPLIT_LAT = 40.21643
OFF_CAMPUS_KEYWORDS = ('润杰', '阳光')

ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]

LOG = open(ROOT / '_build_v3_log.txt', 'w', encoding='utf-8')


def log(*a):
    LOG.write(' '.join(str(x) for x in a) + '\n')
    LOG.flush()


def xy(lon, lat):
    return [round((lon - ORIGIN_LON) * M * COS / UNIT, 3),
            round((ORIGIN_LAT - lat) * M / UNIT, 3)]


def local_geom(geom):
    t = geom.get('type')
    c = geom.get('coordinates')
    if t == 'Point':
        return {'type': 'Point', 'coordinates': xy(c[0], c[1])}
    if t == 'LineString':
        return {'type': 'LineString', 'coordinates': [xy(p[0], p[1]) for p in c]}
    if t == 'Polygon':
        return {'type': 'Polygon', 'coordinates': [[xy(p[0], p[1]) for p in ring] for ring in c]}
    if t == 'MultiPolygon':
        return {'type': 'MultiPolygon',
                'coordinates': [[[xy(p[0], p[1]) for p in ring] for ring in poly] for poly in c]}
    return None


# ---------------------------------------------------------------- OSM 拉取
def overpass(query: str, timeout: int = 300, tries: int = 3):
    body = urllib.parse.urlencode({'data': query}).encode()
    last = None
    for _ in range(tries):
        for ep in ENDPOINTS:
            try:
                req = urllib.request.Request(ep, data=body, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    log(f'  OK  {ep}')
                    return json.loads(r.read())
            except Exception as exc:  # noqa: BLE001
                last = f'{type(exc).__name__}: {exc}'
                log(f'  FAIL {ep} -> {last}')
                time.sleep(2)
        time.sleep(5)
    raise RuntimeError(f'Overpass 全部节点失败: {last}')


def fetch_osm(reuse: bool):
    """拉三个校区 + 周边一圈的 OSM 要素（道路 / 绿地 / 水体 / 运动场 / 建筑）。"""
    cache = SRC_DIR / 'cupb-osm-v3.json'
    # 覆盖三校区并外扩 ~120 m
    lon0, lon1 = 116.2348, 116.2551
    lat0, lat1 = 40.2105, 40.2213
    if reuse and cache.exists():
        log('== OSM：复用缓存 ==')
        return json.loads(cache.read_text(encoding='utf-8'))['elements']
    bbox = f'{lat0},{lon0},{lat1},{lon1}'
    log(f'== OSM：拉取 bbox {bbox} ==')
    query = f'''[out:json][timeout:300];
(
  nwr["building"]({bbox});
  way["highway"]({bbox});
  way["landuse"]({bbox});
  way["leisure"]({bbox});
  way["natural"]({bbox});
  way["waterway"]({bbox});
  way["amenity"]({bbox});
  way["barrier"]({bbox});
  way["parking"]({bbox});
  way["sport"]({bbox});
  way["man_made"]({bbox});
  nwr["amenity"]({bbox});
  nwr["leisure"]({bbox});
  nwr["tourism"]({bbox});
);
out body geom;'''
    data = overpass(query)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    log(f'  要素 {len(data.get("elements", []))} 个')
    return data['elements']


def stitch_rings(ways):
    remaining = [list(w) for w in ways]
    rings = []
    while remaining:
        ring = remaining.pop(0)
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for i, w in enumerate(remaining):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += list(reversed(w))[:-1]
                elif w[-1] == ring[0]:
                    ring = list(reversed(w))[:-1] + ring
                elif w[0] == ring[0]:
                    ring = list(reversed(w))[1:] + ring
                else:
                    continue
                remaining.pop(i)
                changed = True
                break
        if len(ring) >= 4:
            rings.append(ring)
    return rings


# ---------------------------------------------------------------- 建筑轮廓内缩
# 官方 84 栋的轮廓彼此有轻微压边：102 栋校内建筑里 68 对轮廓真正相交，
# 但绝大多数只叠了几厘米到半米（内缩 0.5 m 就降到 9 对）。3D 里表现为墙面互相穿透、
# 同一栋楼看起来糊成一坨。这里统一朝质心内缩，让相邻建筑之间留出可见缝隙。
# 剩下的少量相交是真正的连体楼（主楼 A/B/C 座等），保留。
BUILDING_SHRINK_M = 1.0


def poly_area(ring):
    s = 0.0
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        s += a[0] * b[1] - b[0] * a[1]
    return abs(s) / 2


def shrink_ring(ring, du):
    """朝质心内缩 du（数据单位）。限幅 25%，避免细长 / 小轮廓退化成一条线。"""
    n = len(ring)
    if n < 4:
        return ring
    cx = sum(q[0] for q in ring) / n
    cz = sum(q[1] for q in ring) / n
    res = []
    for q in ring:
        vx, vz = q[0] - cx, q[1] - cz
        L = math.hypot(vx, vz)
        if L < 1e-9:
            res.append(list(q))
            continue
        d = min(du, L * 0.25)
        res.append([round(q[0] - vx / L * d, 3), round(q[1] - vz / L * d, 3)])
    return res


def shrink_building(geom, du):
    if not geom:
        return None
    t = geom['type']
    if t == 'Polygon':
        return {'type': 'Polygon', 'coordinates': [shrink_ring(geom['coordinates'][0], du)]}
    if t == 'MultiPolygon':
        return {'type': 'MultiPolygon',
                'coordinates': [[shrink_ring(poly[0], du)] for poly in geom['coordinates']]}
    return geom


# ---------------------------------------------------------------- 几何裁剪
# Overpass 会返回与 bbox 相交的 way 的**完整**几何，南环路 / 府学路这类长干道
# 能延伸出数公里，会撑爆场景包围盒（实测把取景范围拉到 x=211，约 2 km）。
# 故统一裁剪到关注区：三校区外再留 ~150 m 城市背景。
AOI = {'x0': -95.0, 'x1': 95.0, 'z0': -68.0, 'z1': 68.0}


def _clip_segment(a, b):
    """Liang-Barsky：把线段裁到 AOI 矩形内，返回 None 表示完全在外。"""
    x0, x1, z0, z1 = AOI['x0'], AOI['x1'], AOI['z0'], AOI['z1']
    dx, dz = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dz, a[1] - z0), (dz, z1 - a[1])):
        if abs(p) < 1e-12:
            if q < 0:
                return None
        else:
            r = q / p
            if p < 0:
                t0 = max(t0, r)
            else:
                t1 = min(t1, r)
            if t0 > t1:
                return None
    return [a[0] + dx * t0, a[1] + dz * t0], [a[0] + dx * t1, a[1] + dz * t1]


def clip_polyline(points):
    """裁剪折线，返回若干条落在 AOI 内的连续段。"""
    runs = []
    cur = []
    for a, b in zip(points, points[1:]):
        r = _clip_segment(a, b)
        if r is None:
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
            continue
        s, e = r
        if not cur:
            cur = [s]
        elif abs(cur[-1][0] - s[0]) > 1e-6 or abs(cur[-1][1] - s[1]) > 1e-6:
            if len(cur) >= 2:
                runs.append(cur)
            cur = [s]
        cur.append(e)
    if len(cur) >= 2:
        runs.append(cur)
    return runs


def _clip_polygon_half(ring, inside, intersect):
    out = []
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        ia, ib = inside(a), inside(b)
        if ia:
            out.append(a)
            if not ib:
                out.append(intersect(a, b))
        elif ib:
            out.append(intersect(a, b))
    return out


def clip_ring(ring):
    """Sutherland-Hodgman：把环裁到 AOI 矩形内。"""
    x0, x1, z0, z1 = AOI['x0'], AOI['x1'], AOI['z0'], AOI['z1']

    def ix(a, b, v):
        t = (v - a[0]) / (b[0] - a[0]) if abs(b[0] - a[0]) > 1e-12 else 0.0
        return [v, a[1] + (b[1] - a[1]) * t]

    def iz(a, b, v):
        t = (v - a[1]) / (b[1] - a[1]) if abs(b[1] - a[1]) > 1e-12 else 0.0
        return [a[0] + (b[0] - a[0]) * t, v]

    r = ring
    for inside, intersect in (
        (lambda p: p[0] >= x0, lambda a, b: ix(a, b, x0)),
        (lambda p: p[0] <= x1, lambda a, b: ix(a, b, x1)),
        (lambda p: p[1] >= z0, lambda a, b: iz(a, b, z0)),
        (lambda p: p[1] <= z1, lambda a, b: iz(a, b, z1)),
    ):
        r = _clip_polygon_half(r, inside, intersect)
        if len(r) < 3:
            return None
    return r


def clip_local(geom):
    """对已转局部坐标的几何做裁剪。返回 None 或 {type, coordinates}（LineString 可能变多条）。"""
    if not geom:
        return None
    t = geom['type']
    if t == 'Point':
        c = geom['coordinates']
        if AOI['x0'] <= c[0] <= AOI['x1'] and AOI['z0'] <= c[1] <= AOI['z1']:
            return geom
        return None
    if t == 'LineString':
        runs = clip_polyline(geom['coordinates'])
        if not runs:
            return None
        # 只保留最长的一段，保持 LineString 单一几何（前端按单线渲染）
        return {'type': 'LineString', 'coordinates': max(runs, key=len)}
    if t == 'Polygon':
        ring = clip_ring(geom['coordinates'][0])
        return {'type': 'Polygon', 'coordinates': [ring]} if ring else None
    if t == 'MultiPolygon':
        polys = []
        for poly in geom['coordinates']:
            ring = clip_ring(poly[0])
            if ring:
                polys.append([ring])
        return {'type': 'MultiPolygon', 'coordinates': polys} if polys else None
    return geom


def lonlat_centroid(geom):
    """取几何质心（经纬度），对 Point / LineString / Polygon / MultiPolygon 都成立。"""
    t = geom['type']
    c = geom['coordinates']
    if t == 'Point':
        return c[0], c[1]
    if t == 'LineString':
        pts = c
    elif t == 'Polygon':
        pts = c[0]
    elif t == 'MultiPolygon':
        pts = c[0][0]
    else:
        pts = []
    if not pts:
        return 0.0, 0.0
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def osm_geometry(el):
    if el['type'] == 'node':
        if 'lat' not in el:
            return None
        return {'type': 'Point', 'coordinates': [el['lon'], el['lat']]}
    if el['type'] == 'way':
        pts = [[p['lon'], p['lat']] for p in (el.get('geometry') or [])]
        if len(pts) < 2:
            return None
        if pts[0] == pts[-1] and len(pts) >= 4:
            return {'type': 'Polygon', 'coordinates': [pts]}
        return {'type': 'LineString', 'coordinates': pts}
    if el['type'] == 'relation':
        ways = [[[p['lon'], p['lat']] for p in m['geometry']]
                for m in el.get('members', []) if m.get('geometry')]
        rings = stitch_rings(ways)
        if not rings:
            return None
        if len(rings) == 1:
            return {'type': 'Polygon', 'coordinates': [rings[0]]}
        return {'type': 'MultiPolygon', 'coordinates': [[r] for r in rings]}
    return None


GREEN_KEYS = {'grass', 'forest', 'meadow', 'village_green', 'recreation_ground',
              'cemetery', 'allotments', 'farmland', 'greenfield'}
PITCH_LEISURE = {'pitch', 'stadium', 'playground', 'sports_centre', 'track',
                 'golf_course', 'fitness_centre'}


def classify(tags):
    if tags.get('building'):
        return 'building'
    if tags.get('highway'):
        return 'road'
    if tags.get('waterway') or tags.get('natural') == 'water' or tags.get('landuse') == 'reservoir':
        return 'water'
    if tags.get('leisure') in PITCH_LEISURE or tags.get('sport'):
        return 'pitch'
    if tags.get('amenity') == 'parking' or tags.get('parking'):
        return 'parking'
    if tags.get('leisure') in {'garden', 'park'} or tags.get('natural') in {'wood', 'grassland', 'scrub'} \
            or tags.get('landuse') in GREEN_KEYS:
        return 'green'
    if tags.get('barrier'):
        return 'barrier'
    if tags.get('leisure') == 'swimming_pool' or tags.get('amenity') == 'swimming_pool':
        return 'water'
    return 'poi'


def estimate_levels(tags, name):
    raw = tags.get('building:levels')
    try:
        lv = float(str(raw).strip())
        if 1 <= lv <= 60:
            return lv
    except (TypeError, ValueError):
        pass
    h = tags.get('height')
    try:
        hv = float(str(h).replace('m', '').strip())
        if 1 <= hv <= 250:
            return max(1, hv / 3.3)
    except (TypeError, ValueError):
        pass
    b = tags.get('building', '')
    if b in {'residential', 'dormitory', 'apartments'} or '号楼' in name or '公寓' in name:
        return 6
    if b in {'stadium', 'sports_hall'} or '体育馆' in name or '健身' in name:
        return 3
    if '大厦' in name or '研修' in name:
        return 12
    if b == 'university' or '教学楼' in name or '主教' in name or '阶教' in name:
        return 5
    if '图书馆' in name or '办公楼' in name or '办公' in name:
        return 6
    return 4


# ---------------------------------------------------------------- 官方建筑
def load_official():
    log('== 官方 3D 建筑源 ==')
    d = json.loads(OFFICIAL_SRC.read_text(encoding='utf-8'))
    feats = []
    for f in d['features']:
        pr = f.get('properties', {})
        geom = f.get('geometry')
        if not geom or geom.get('type') not in ('Polygon', 'MultiPolygon'):
            continue
        # 高度：官方 height（米）优先，缺失时用「楼层数 × 4」
        h = pr.get('height')
        try:
            h = float(h)
        except (TypeError, ValueError):
            h = None
        lv = pr.get('楼层数') or pr.get('building:levels')
        try:
            lv = int(float(lv))
        except (TypeError, ValueError):
            lv = None
        if h is None:
            h = (lv * 4.0) if lv else 4.0
        if lv is None:
            lv = max(1, round(h / 4.0))

        name = (pr.get('name') or '').strip()
        cat = pr.get('polygon_category')
        btype = pr.get('building') or ''
        # 操场这类非建筑要素按运动场处理
        kind = 'building'
        if cat == 'others' or (name and ('操场' in name or '运动场' in name)):
            kind = 'pitch'
        # 注意：'游泳馆' 是室内游泳馆建筑，不是水体，不能按「游泳」关键字归类

        # 质心
        def flat(c):
            if isinstance(c[0], (int, float)):
                yield c
            else:
                for i in c:
                    yield from flat(i)
        pts = list(flat(geom['coordinates']))
        clon = sum(q[0] for q in pts) / len(pts)
        clat = sum(q[1] for q in pts) / len(pts)

        zone = '南校区' if clat <= NS_SPLIT_LAT else '北校区'
        if any(k in name for k in OFF_CAMPUS_KEYWORDS):
            zone = '校外生活区'

        # v3.1 追加：地下层 / 门门户体块 / 建筑面积。
        # 这三个字段做程序化立面与体块细节时直接用（层数决定窗排数、min_level<0 说明有地下室、
        # building_part=entrance_3d 是官方标注的门的 3D 体块 —— 门房 / 门柱，走专门的门楼配方）。
        ml = pr.get('building:min_level')
        try:
            ml = int(float(ml))
        except (TypeError, ValueError):
            ml = 0
        part = (pr.get('building_part') or '').strip()
        far_m2 = None
        m = re.search(r'(\d+(?:\.\d+)?)\s*平方米', pr.get('content') or '')
        if m:
            far_m2 = float(m.group(1))

        feats.append({
            'id': f"cup-{pr.get('id') or pr.get('newid') or abs(hash(name)) % 10**8}",
            'kind': kind,
            'name': name if name and name != '未知' else '',
            'height': round(h / UNIT, 2),
            'in_campus': True,
            'zone': zone,
            'properties': {
                'source': 'map.cup.edu.cn',
                'levels': lv,
                'building': btype,
                'category': cat,
                'area': pr.get('area'),
                # 新增的三个字段
                'min_level': ml,
                'part': part,
                'floor_area': far_m2,
            },
            'geometry': clip_local(local_geom(geom)),
        })
    feats = [f for f in feats if f['geometry']]
    log(f'  官方要素 {len(feats)} 个（建筑 {sum(1 for f in feats if f["kind"] == "building")} 栋）')
    return feats


# ---------------------------------------------------------------- 主流程
def dedupe_buildings(features):
    """同名且几乎重合的建筑只保留较大的那个（官方数据里有重复记录，如两个相距 6.8 m 的「南门」）。"""
    def rings_of(f):
        g = f['geometry']
        if g['type'] == 'Polygon':
            return [g['coordinates'][0]]
        if g['type'] == 'MultiPolygon':
            return [poly[0] for poly in g['coordinates']]
        return []

    def cen(f):
        rs = rings_of(f)
        if not rs:
            return (0.0, 0.0)
        r = rs[0]
        return (sum(q[0] for q in r) / len(r), sum(q[1] for q in r) / len(r))

    def ar(f):
        return sum(poly_area(r) for r in rings_of(f))

    keep = []
    removed = 0
    for f in features:
        if f['kind'] != 'building' or not f.get('name'):
            keep.append(f)
            continue
        c = cen(f)
        hit = -1
        for i, k in enumerate(keep):
            if k['kind'] == 'building' and k.get('name') == f['name']:
                kc = cen(k)
                # < 1.0 单位 = 10 m
                if math.hypot(c[0] - kc[0], c[1] - kc[1]) < 1.0:
                    hit = i
                    break
        if hit < 0:
            keep.append(f)
        else:
            removed += 1
            if ar(f) > ar(keep[hit]):
                keep[hit] = f
    if removed:
        log(f'  去重重复建筑: {removed} 栋')
    return keep


# ------------------------------------------------- 补录：OSM 漏采的校内道路
# 第三教学楼 / 第四教学楼 / 南广场 北侧之间确有一条校内道路，OSM 与官方
# 地图接口都没有采集，导致三栋地标之间是一片没有路的空地。
# 路线沿建筑北侧空地布设（已用建筑轮廓扫描验证全程无压盖），
# 西端接中石路、东端接南广场东侧支路，使新路并入既有路网而不是孤立悬空。
# 坐标单位同全图：1 单位 = 10 米，x 东、z 南。
EXTRA_ROADS = [
    {
        'id': 'cup-road-jiaoxuelou-n',
        # 与南广场东侧那条既有支路同为 unclassified，渲染宽度一致，看起来是同一条路
        'highway': 'unclassified',
        'line': [
            (-43.60, 3.80),   # 接中石路（燕平路以东段）
            (-43.52, 1.60),
            (-43.48, 0.20),
            (-43.44, -1.20),
            (-42.80, -2.20),  # 第三教学楼东北侧
            (-42.00, -1.80),
            (-41.50, -1.40),
            (-41.00, -1.60),
            (-40.50, -0.60),
            (-40.00, -0.40),
            (-39.50, -0.60),
            (-39.00, -0.60),
            (-38.50, -0.10),
            (-38.00, -0.30),
            (-37.50, -0.50),  # 第四教学楼北侧
            (-37.00, -0.65),
            (-36.00, -0.75),
            (-35.50, -0.86),
            (-34.00, -0.66),
            (-32.60, -0.50),  # 南广场西缘
            (-31.00, -0.66),
            (-29.19, -1.04),  # 接南广场东侧既有支路
        ],
    },
]


def inject_extra_roads(features):
    for i, r in enumerate(EXTRA_ROADS):
        features.append({
            'id': r['id'],
            'kind': 'road',
            'name': '',
            'height': 0.0,
            'in_campus': True,
            'properties': {'highway': r['highway'], 'source': '实地补录'},
            'geometry': {'type': 'LineString', 'coordinates': [list(p) for p in r['line']]},
        })
    if EXTRA_ROADS:
        log(f'  补录校内道路 {len(EXTRA_ROADS)} 条')


# 与官方数据同名、位置却相距过远的 OSM 建筑属于标注错位，直接丢弃。
# 实测：OSM「第三教学楼」离官方位置 186 m，「第四教学楼（逸夫楼）」离 157 m。
GHOST_DIST_UNIT = 5.0  # 5 单位 = 50 m


def norm_name(s):
    """去掉括注后再比较：「第四教学楼（逸夫楼）」应能匹配官方的「第四教学楼」。"""
    s = (s or '').strip()
    for a, b in (('（', '）'), ('(', ')')):
        i = s.find(a)
        if i > 0 and b in s[i:]:
            s = s[:i].strip()
    return s


def drop_ghost_osm_buildings(features):
    def cen(f):
        g = f['geometry']
        if g['type'] == 'Polygon':
            r = g['coordinates'][0]
        elif g['type'] == 'MultiPolygon':
            r = max(g['coordinates'], key=lambda pp: len(pp[0]))[0]
        else:
            return None
        return (sum(q[0] for q in r) / len(r), sum(q[1] for q in r) / len(r))

    official = {}
    for f in features:
        if f['kind'] == 'building' and f.get('name') and str(f.get('id', '')).startswith('cup-'):
            c = cen(f)
            if c:
                official.setdefault(norm_name(f['name']), []).append(c)

    keep, dropped = [], []
    for f in features:
        nm = norm_name(f.get('name'))
        is_osm = str(f.get('id', '')).startswith('osm-')
        # 东校区官方 3D 数据没有覆盖，OSM 是唯一来源，绝不参与幽灵判定
        if f['kind'] == 'building' and nm and is_osm and nm in official \
                and f.get('zone') != '东校区':
            c = cen(f)
            if c and all(math.hypot(c[0] - o[0], c[1] - o[1]) > GHOST_DIST_UNIT for o in official[nm]):
                dropped.append((f.get('name'), f['id']))
                continue
        keep.append(f)

    if dropped:
        log('  剔除与官方位置冲突的 OSM 错位建筑:')
        for nm, fid in dropped:
            log(f'    - {nm} ({fid})')
    return keep


# OSM 的运动场/水体在这片区域整体比真实位置偏 40~90 m，部分直接压在楼上：
#   - OSM「足球场」大如街区，把第三教学楼、中油大厦A/B座、联合纳米实验室全罩进去；
#   - OSM「游泳馆」水面压在青年园公寓3/4/5号楼上；
#   - OSM「体育馆」罩住了红旗操场的看台。
# 官方数据（含「红旗操场」cup-677，与体育馆/看台位置自洽）可信，
# 故规则：OSM 的 pitch/water 轮廓若罩住任何官方建筑质心，整块删除。
def drop_osm_fields_on_buildings(features):
    def ring_of(f):
        g = f['geometry']
        if g['type'] == 'Polygon':
            return g['coordinates'][0]
        if g['type'] == 'MultiPolygon':
            return max(g['coordinates'], key=lambda pp: len(pp[0]))[0]
        return None

    def inside(pt, r):
        n = len(r); c = False; j = n - 1
        for i in range(n):
            xi, zi = r[i][0], r[i][1]
            xj, zj = r[j][0], r[j][1]
            if ((zi > pt[1]) != (zj > pt[1])) and \
                    (pt[0] < (xj - xi) * (pt[1] - zi) / ((zj - zi) or 1e-12) + xi):
                c = not c
            j = i
        return c

    official_c = []
    for f in features:
        if f['kind'] == 'building' and str(f.get('id', '')).startswith('cup-'):
            r = ring_of(f)
            if r:
                official_c.append((sum(q[0] for q in r) / len(r),
                                   sum(q[1] for q in r) / len(r)))

    keep, dropped = [], []
    for f in features:
        if f['kind'] in ('pitch', 'water') and str(f.get('id', '')).startswith('osm-'):
            r = ring_of(f)
            if r and any(inside(c, r) for c in official_c):
                dropped.append((f.get('name') or '(无名场地)', f['id']))
                continue
        keep.append(f)

    if dropped:
        log('  剔除压住官方建筑的 OSM 场地/水体:')
        for nm, fid in dropped:
            log(f'    - {nm} ({fid})')
    return keep


def main():
    import sys
    reuse = '--reuse' in sys.argv
    if not OFFICIAL_SRC.exists():
        raise SystemExit(f'缺少官方数据源 {OFFICIAL_SRC}')

    official = load_official()
    # 官方建筑已覆盖的经纬度范围（用于剔除 OSM 重复建筑）
    off_polys = []
    d = json.loads(OFFICIAL_SRC.read_text(encoding='utf-8'))
    for f in d['features']:
        def flat(c):
            if isinstance(c[0], (int, float)):
                yield c
            else:
                for i in c:
                    yield from flat(i)
        pts = list(flat(f['geometry']['coordinates']))
        off_polys.append((min(q[0] for q in pts), max(q[0] for q in pts),
                          min(q[1] for q in pts), max(q[1] for q in pts)))

    def near_official(lon, lat):
        """该点是否落在某栋官方建筑的 bbox 内（说明官方已覆盖，OSM 不重复添加）。"""
        return any(x0 <= lon <= x1 and y0 <= lat <= y1 for x0, x1, y0, y1 in off_polys)

    try:
        elements = fetch_osm(reuse)
    except Exception as exc:  # noqa: BLE001
        log(f'  OSM 拉取失败，退回旧缓存: {exc}')
        elements = json.loads((SRC_DIR / 'cupb-campus-raw.json').read_text(encoding='utf-8'))['elements']

    features = list(official)
    stats = {'官方建筑': len(official)}
    east_n = 0

    for el in elements:
        tags = el.get('tags', {})
        geom = osm_geometry(el)
        if not geom:
            continue
        kind = classify(tags)
        gtype = geom['type']
        if gtype in ('Polygon', 'MultiPolygon'):
            ring = geom['coordinates'][0][0] if gtype == 'MultiPolygon' else geom['coordinates'][0]
            if len(ring) < 4:
                continue
        elif gtype == 'LineString':
            if len(geom['coordinates']) < 2:
                continue
            if kind in {'road', 'barrier'} and geom['coordinates'][0] == geom['coordinates'][-1] \
                    and len(geom['coordinates']) >= 4:
                geom = {'type': 'Polygon', 'coordinates': [geom['coordinates']]}
        elif gtype != 'Point':
            continue

        # 质心经纬度
        clon, clat = lonlat_centroid(geom)

        name = (tags.get('name') or tags.get('name:zh') or '').strip()
        zone = None
        in_campus = False

        if kind == 'building':
            # 官方已覆盖的位置不重复添加
            if near_official(clon, clat):
                continue
            if any(k in name for k in EAST_EXCLUDE):
                continue
            if EAST['lon0'] <= clon <= EAST['lon1'] and EAST['lat0'] <= clat <= EAST['lat1']:
                zone = '东校区'
                in_campus = True
                east_n += 1
            else:
                # 官方建筑之外、又不属东校区的 OSM 建筑 → 城市背景
                zone = '周边'
                in_campus = False
            height = round(estimate_levels(tags, name) * 3.3 / UNIT, 2)
        else:
            # 道路 / 绿地 / 水体等按是否在任一校区范围内决定
            in_main = 116.2360 <= clon <= 116.2442 and 40.2140 <= clat <= 40.2196
            in_east = EAST['lon0'] <= clon <= EAST['lon1'] and EAST['lat0'] <= clat <= EAST['lat1']
            in_campus = in_main or in_east
            height = 0.0
            if in_east:
                zone = '东校区'
            elif in_main:
                zone = '南校区' if clat <= NS_SPLIT_LAT else '北校区'

        feat = {
            'id': f"osm-{el['type']}-{el['id']}",
            'kind': kind,
            'name': name,
            'height': height,
            'in_campus': in_campus,
            'properties': tags,
            'geometry': local_geom(geom),
        }
        if zone:
            feat['zone'] = zone
        feat['geometry'] = clip_local(feat['geometry'])
        if not feat['geometry']:
            continue
        features.append(feat)
        key = f'{kind}/{zone or "周边"}'
        stats[key] = stats.get(key, 0) + 1

    # 建筑轮廓统一内缩，消除相邻建筑墙面互相穿透
    du = BUILDING_SHRINK_M / UNIT
    for f in features:
        if f['kind'] == 'building':
            f['geometry'] = shrink_building(f['geometry'], du)
    log(f'\n  建筑轮廓内缩 {BUILDING_SHRINK_M} m')
    features = dedupe_buildings(features)
    features = drop_ghost_osm_buildings(features)
    features = drop_osm_fields_on_buildings(features)
    inject_extra_roads(features)

    log('\n== 统计 ==')
    for k in sorted(stats):
        log(f'  {k}: {stats[k]}')
    log(f'  东校区建筑（OSM 补）: {east_n}')
    log(f'  合计 {len(features)}')

    # 三校区边界（用于地面轮廓渲染）
    zones_rings = {
        '北校区': [[116.2380, 40.21643], [116.2440, 40.21643], [116.2440, 40.2199], [116.2360, 40.2199]],
        '南校区': [[116.2380, 40.2140], [116.2440, 40.2140], [116.2440, 40.21643], [116.2380, 40.21643]],
        '东校区': [[116.2443, 40.2118], [116.2536, 40.2118], [116.2536, 40.2160], [116.2443, 40.2160]],
    }

    payload = {
        'version': 3,
        'source': 'map.cup.edu.cn (建筑) + OpenStreetMap (路网/绿地/水体)',
        'origin': {'lat': ORIGIN_LAT, 'lng': ORIGIN_LON},
        'unit_meters': UNIT,
        'axis': {'x': 'east', 'y': 'up', 'z': 'south'},
        'license': '© 中国石油大学（北京）可视化位置服务平台；© OpenStreetMap contributors (ODbL 1.0)',
        'campus': {
            'name': '中国石油大学（北京）',
            'zones': [{'name': k, 'rings': [[xy(p[0], p[1]) for p in v]]} for k, v in zones_rings.items()],
        },
        'features': features,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    log(f'\n写入 {OUT}  ({OUT.stat().st_size / 1024:.1f} KB)')
    log(f'校内建筑 {sum(1 for f in features if f["kind"] == "building" and f["in_campus"])} 栋')


if __name__ == '__main__':
    try:
        main()
    except Exception:  # noqa: BLE001
        import traceback
        LOG.write(traceback.format_exc())
        LOG.flush()
        raise
