"""补 OSM 缺失的校园主路 + 修正偏移的网球场（数据修补，幂等）。

v2（按高德地图方位全面修正）：
  上一版把"元山前路"描到了北校区南门内侧集散路（z≈-1~2），整体错位 60m+。
  本次以官方 z19 瓦片为基准重新描点——元山前路在 z≈+5.5（南门门房/南校区
  北门以南），配套南北路按官方图上的铺装带走向。

  * 元山前路：南北校区之间的东西主路（高德：北1门—南门—南校区北门一线）
  * 南门南北路：南广场正南，穿南门过元山前路进南校区（4教和南广场之间的连接路）
  * 青年园西路：4教/青年园公寓西侧、健身房一带，向南接元山前路
  * 网球场：OSM 坐标偏西 5.7/偏南 1.7 单位；v3 起整体定位到红旗操场正北侧
    （官方地图上 6 片场地所在处，中心 (-39.0, -18.6)），不再压跑道与看台

坐标约定：1 单位 = 10 m，x 向东、z 向南。
"""
from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data' / 'campus-local.json'

# (id, name, highway, 坐标点列 [(x, z), ...])
MANUAL_ROADS = [
    # 元山前路：东西主路（官方图底部黄字"元山路"处，z≈5.5，基本水平）
    ('manual-yuanshan', '元山前路', 'primary', [
        (-62.0, 5.0), (-48.0, 5.3), (-38.0, 5.5), (-30.0, 5.6),
        (-20.0, 5.7), (-10.0, 5.9), (0.0, 6.1), (8.0, 6.3),
    ]),
    # 南门南北路：南广场正南 → 南门 → 元山前路 → 南校区北门 → 南校区内
    ('manual-southgate', '南门路', 'residential', [
        (-29.8, 1.0), (-29.9, -1.0), (-29.9, 2.0), (-29.9, 4.0),
        (-30.1, 6.0), (-30.4, 7.5), (-30.8, 9.5),
    ]),
    # 青年园路：南校区北门 → 游泳馆（机器人巡线所走的公路，用户指认位置）
    ('manual-qingnianyuan-west', '青年园路', 'residential', [
        (-38.2, -4.6), (-37.0, -7.0), (-35.6, -9.4), (-34.0, -11.4),
    ]),
]

# 网球场：官方瓦片里球场画在红旗操场**东北侧**（看台以东、翠宫招待所以西、体育馆以北），
# 但官方底图是 2.5D 透视画法，画中位置不能直接当坐标用，所以按"矢量数据之间的空档"定位：
#   看台 x -44.78~-39.19   翠宫招待所 x -36.54~-30.43 (南缘 z=-16.14)   红旗操场北缘 z=-15.85
# 空档 = x -40.6~-37.3, z -20.0~-16.7（东/西各留 ≥6 m 间距，南边离跑道 ≥8 m）。
# 尺寸收成 33×33 m（原来 OSM 那条 80×33 m 是硬塞进跑道/看台才出问题的）。
#   v3 修正：上一版把球场按"操场西南侧"放到 (-42.5,-15.0)，实测压住跑道 971 m²、
#   与看台重叠 398 m²，三维孪生里就是"场地和看台叠在跑道上、位置错了"。
TENNIS_RECT = {'x0': -40.6, 'x1': -37.3, 'z0': -20.0, 'z1': -16.7}


def main() -> None:
    d = json.loads(DATA.read_text(encoding='utf-8'))
    feats = [f for f in d['features'] if not str(f.get('id', '')).startswith('manual-')]

    # 网球场绝对定位（幂等）：直接写成固定矩形，不受脚本重复执行影响
    for f in feats:
        p = f.get('properties') or {}
        if f['kind'] == 'pitch' and p.get('sport') == 'tennis':
            x0, x1 = TENNIS_RECT['x0'], TENNIS_RECT['x1']
            z0, z1 = TENNIS_RECT['z0'], TENNIS_RECT['z1']
            f['geometry'] = {'type': 'Polygon', 'coordinates': [[
                [x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0],
            ]]}
            f.setdefault('properties', {})['note'] = '位置按官方底图方位人工定位（红旗操场东北侧空档）'

    for fid, name, hw, pts in MANUAL_ROADS:
        feats.append({
            'id': fid,
            'kind': 'road',
            'name': name,
            'height': 0,
            'in_campus': True,
            'zone': '北校区',
            'properties': {'highway': hw, 'source': 'manual-traced', 'note': 'OSM 缺失，从官方瓦片描点补齐'},
            'geometry': {'type': 'LineString', 'coordinates': [[x, z] for x, z in pts]},
        })
    d['features'] = feats
    DATA.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
    print(f'features now {len(feats)} (roads: {len(MANUAL_ROADS)} manual, tennis -> {TENNIS_RECT})')


if __name__ == '__main__':
    main()
