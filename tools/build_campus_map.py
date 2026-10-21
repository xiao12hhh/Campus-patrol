"""重新构建中国石油大学（北京）校园地图数据。

旧版问题：直接依赖 OSM 关系 13644491 的 area() 索引，只取到 20 栋建筑，
且完全缺失绿地 / 停车场 / 人行道 / 水体等要素，导致 3D 场景"与实际不符"。

本脚本改为：
1. 取回关系边界的真实闭合环（不再依赖 area 索引）；
2. 按校园外接矩形 + 缓冲带向 Overpass 拉取全量要素（建筑 / 道路 / 绿地 /
   水体 / 运动场 / 停车场 / POI …）；
3. 用真实边界环做点在多边形判定，区分"校内 / 校外"；
4. 输出 public/data/campus-local.json（含真实边界环）。

数据许可：© OpenStreetMap contributors，ODbL 1.0。
"""
from __future__ import annotations

import json
import math
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / 'data' / 'sources'
OUT = ROOT / 'public' / 'data' / 'campus-local.json'

UA = 'cup-campus-twin/0.2 (research; contact project owner)'
RELATION_ID = '13644491'
# 校园外接矩形缓冲（米）：校外保留一圈城市背景，避免校园悬空
BUFFER_M = 160
ORIGIN_LAT = 40.21605
ORIGIN_LON = 116.244796
UNIT = 10.0  # 1 three.js 单位 = 10 米

ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]

LOG = open(ROOT / '_build_map_log.txt', 'w', encoding='utf-8')


def log(*a):
    LOG.write(' '.join(str(x) for x in a) + '\n')
    LOG.flush()


def overpass(query: str, timeout: int = 300, tries: int = 3):
    body = urllib.parse.urlencode({'data': query}).encode()
    last = None
    for attempt in range(tries):
        for ep in ENDPOINTS:
            try:
                req = urllib.request.Request(ep, data=body, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    log(f'  OK  {ep}')
                    return json.loads(r.read()), ep
            except Exception as exc:  # noqa: BLE001
                last = f'{type(exc).__name__}: {exc}'
                log(f'  FAIL {ep} -> {last}')
                time.sleep(2)
        time.sleep(5)
    raise RuntimeError(f'Overpass 全部节点失败: {last}')


# ------------------------------------------------------------------ 1) 校园边界
def fetch_boundary():
    log('== 1) 取回校园关系边界 ==')
    data, _ = overpass(f'[out:json][timeout:120];rel({RELATION_ID});out geom;')
    (SRC_DIR / 'cupb-boundary.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    ways = []
    for el in data.get('elements', []):
        for m in el.get('members', []):
            if m.get('role') == 'outer' and m.get('geometry'):
                ways.append([[p['lon'], p['lat']] for p in m['geometry']])
    rings = stitch_rings(ways)
    log(f'  outer way {len(ways)} 条 -> 拼接出 {len(rings)} 个闭合环')
    for r in rings:
        log(f'    环点数 {len(r)}')
    return rings


def stitch_rings(ways):
    """把若干条首尾相连的 way 拼成闭合环（OSM multipolygon 常见拆分方式）。"""
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


# ------------------------------------------------------------------ 2) 全量要素
def fetch_features(lon0, lon1, lat0, lat1):
    bbox = f'{lat0},{lon0},{lat1},{lon1}'
    log(f'== 2) 拉取 bbox {bbox} 全量要素 ==')
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
    data, ep = overpass(query)
    (SRC_DIR / 'cupb-campus-raw.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    log(f'  要素 {len(data.get("elements", []))} 个（来源 {ep}）')
    return data['elements']


# ------------------------------------------------------------------ 3) 几何工具
def overpass_geometry(el):
    """Overpass `out geom` 返回的不是 GeoJSON：
    - node  -> 直接带 lat/lon
    - way   -> geometry: [{lat,lon}, ...]
    - relation -> members[].geometry（按 role 拼环）
    统一转成 GeoJSON geometry。"""
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
        ways = []
        for m in el.get('members', []):
            g = m.get('geometry')
            if g:
                ways.append([[p['lon'], p['lat']] for p in g])
        rings = stitch_rings(ways)
        if not rings:
            return None
        if len(rings) == 1:
            return {'type': 'Polygon', 'coordinates': [rings[0]]}
        return {'type': 'MultiPolygon', 'coordinates': [[r] for r in rings]}
    return None


def point_in_rings(lon, lat, rings):
    for ring in rings:
        if point_in_ring(lon, lat, ring):
            return True
    return False


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    for i, j in zip(range(n), [n - 1] + list(range(n - 1))):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < ((xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
    return inside


def xy(lon, lat):
    m = 111320.0
    x = (lon - ORIGIN_LON) * m * math.cos(math.radians(ORIGIN_LAT)) / UNIT
    z = (ORIGIN_LAT - lat) * m / UNIT
    return [round(x, 3), round(z, 3)]


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
        return {'type': 'MultiPolygon', 'coordinates': [[[xy(p[0], p[1]) for p in ring] for ring in poly] for poly in c]}
    return None


# ------------------------------------------------------------------ 4) 分类
GREEN_KEYS = {
    'grass', 'forest', 'meadow', 'village_green', 'recreation_ground', 'cemetery',
    'allotments', 'farmland', 'greenfield',
}
PITCH_LEISURE = {'pitch', 'stadium', 'playground', 'sports_centre', 'track', 'golf_course', 'fitness_centre'}


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


def estimate_levels(tags, kind_name):
    """OSM 多数建筑缺 height/levels，按建筑类型与名称做保守估计（README 已声明为估算）。"""
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
    name = kind_name or ''
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
    if b in {'roof', 'yes', 'school', 'college'}:
        return 4
    return 4


def main():
    import sys
    reuse = '--reuse' in sys.argv
    if reuse and (SRC_DIR / 'cupb-boundary.json').exists():
        log('== 1) 复用已缓存的校园边界 ==')
        data = json.loads((SRC_DIR / 'cupb-boundary.json').read_text(encoding='utf-8'))
        ways = []
        for el in data.get('elements', []):
            for m in el.get('members', []):
                if m.get('role') == 'outer' and m.get('geometry'):
                    ways.append([[p['lon'], p['lat']] for p in m['geometry']])
        rings = stitch_rings(ways)
    else:
        rings = fetch_boundary()
    if not rings:
        raise SystemExit('未能取到校园边界环')
    lon_all = [p[0] for r in rings for p in r]
    lat_all = [p[1] for r in rings for p in r]
    lon0, lon1 = min(lon_all), max(lon_all)
    lat0, lat1 = min(lat_all), max(lat_all)
    dlon = (BUFFER_M / (111320.0 * math.cos(math.radians(ORIGIN_LAT))))
    dlat = BUFFER_M / 111320.0
    log(f'校园外接: lon {lon0:.5f}..{lon1:.5f} lat {lat0:.5f}..{lat1:.5f}')
    log(f'  尺寸 {(lon1-lon0)*111320*math.cos(math.radians(ORIGIN_LAT)):.0f} m x {(lat1-lat0)*111320:.0f} m')

    if reuse and (SRC_DIR / 'cupb-campus-raw.json').exists():
        log('== 2) 复用已缓存的 Overpass 原始数据 ==')
        elements = json.loads((SRC_DIR / 'cupb-campus-raw.json').read_text(encoding='utf-8'))['elements']
        log(f'  要素 {len(elements)} 个')
    else:
        elements = fetch_features(lon0 - dlon, lon1 + dlon, lat0 - dlat, lat1 + dlat)

    features = []
    stats = {}
    for el in elements:
        tags = el.get('tags', {})
        geom = el.get('geometry')
        geom = overpass_geometry(el)
        if not geom:
            continue
        kind = classify(tags)
        gtype = geom['type']
        # 面要素必须是闭合多边形；线要素按线处理
        if gtype in ('Polygon', 'MultiPolygon'):
            ring = geom['coordinates'][0][0] if gtype == 'MultiPolygon' else geom['coordinates'][0]
            if len(ring) < 4:
                continue
        elif gtype == 'LineString':
            if len(geom['coordinates']) < 2:
                continue
            # 闭合的线要素（如被标成 highway 的环形路）也可视为面
            if kind in {'road', 'barrier'} and geom['coordinates'][0] == geom['coordinates'][-1] \
                    and len(geom['coordinates']) >= 4:
                geom = {'type': 'Polygon', 'coordinates': [geom['coordinates']]}
        elif gtype != 'Point':
            continue

        # 位置（用于内外判定）
        if gtype == 'Point':
            clon, clat = geom['coordinates']
        elif gtype == 'MultiPolygon':
            pts = geom['coordinates'][0][0]
            clon = sum(p[0] for p in pts) / len(pts)
            clat = sum(p[1] for p in pts) / len(pts)
        else:
            pts = geom['coordinates'][0] if gtype == 'Polygon' else geom['coordinates']
            clon = sum(p[0] for p in pts) / len(pts)
            clat = sum(p[1] for p in pts) / len(pts)
        in_campus = point_in_rings(clon, clat, rings)

        name = tags.get('name') or tags.get('name:zh') or ''
        # 关系边界偶有缺口（例如"中国石油大学体育馆"落在环外），
        # 名字里明确带校名的要素一律补回校内。
        if not in_campus and ('中国石油大学' in name or '石油大学' in name):
            in_campus = True
        height = 0.0
        if kind == 'building':
            height = round(estimate_levels(tags, name) * 3.3 / UNIT, 2)
        lg = local_geom(geom)
        if not lg:
            continue
        feat = {
            'id': f"osm-{el['type']}-{el['id']}",
            'kind': kind,
            'name': name,
            'height': height,
            'in_campus': in_campus,
            'properties': tags,
            'geometry': lg,
        }
        features.append(feat)
        key = f"{kind}{'/校内' if in_campus else '/校外'}"
        stats[key] = stats.get(key, 0) + 1

    log('\n== 3) 分类统计 ==')
    for k in sorted(stats):
        log(f'  {k}: {stats[k]}')
    log(f'  合计 {len(features)}')

    payload = {
        'version': 2,
        'source': 'data/sources/cupb-campus-raw.json',
        'origin': {'lat': ORIGIN_LAT, 'lng': ORIGIN_LON},
        'unit_meters': UNIT,
        'axis': {'x': 'east', 'y': 'up', 'z': 'south'},
        'license': '© OpenStreetMap contributors (ODbL 1.0)',
        'campus': {
            'name': '中国石油大学（北京）',
            'relation_id': RELATION_ID,
            'rings': [[xy(p[0], p[1]) for p in ring] for ring in rings],
        },
        'features': features,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')
    size_kb = OUT.stat().st_size / 1024
    log(f'\n写入 {OUT}  ({size_kb:.1f} KB)')
    log(f'校内建筑 {sum(1 for f in features if f["kind"] == "building" and f["in_campus"])} 栋')


if __name__ == '__main__':
    try:
        main()
    except Exception:  # noqa: BLE001
        import traceback
        LOG.write(traceback.format_exc())
        LOG.flush()
        raise
