import json
import math
from pathlib import Path

from app.services.campus_data import load_campus, places_by_name
from app.services.robot_simulator import ROUTES

ROOT = Path(__file__).resolve().parents[1]


def test_campus_relative_layout_and_route_coordinates():
    p = places_by_name()
    assert p['北门']['z'] < p['图书馆']['z'] < p['南门']['z']
    assert p['红旗操场']['x'] < p['图书馆']['x'] < p['主楼A座']['x']
    for name in ['第三教学楼', '第四教学楼', '中油大厦A座']:
        assert p[name]['z'] > p['南门']['z']
    for route in ROUTES.values():
        assert len(route) >= 4
        for point in route:
            assert point == p[point['name']]


def test_osm_south_footprints_are_not_shifted_or_shrunk():
    data = load_campus()
    raw = json.loads((ROOT/'data/sources/cupb-osm-v3.json').read_text(encoding='utf-8'))
    for osm_id in [570430365, 570430366, 570433614]:
        source = next(f for f in raw['elements'] if f['id'] == osm_id)
        feature = next(f for f in data['features'] if f['id'] == 'osm-way-'+str(osm_id))
        ring = feature['geometry']['coordinates'][0]
        assert len(ring) == len(source['geometry'])
        for local, geo in zip(ring, source['geometry']):
            x = (geo['lon']-data['origin']['lng'])*111320*math.cos(math.radians(data['origin']['lat']))/10
            z = (data['origin']['lat']-geo['lat'])*111320/10
            assert math.hypot(x-local[0], z-local[1]) < .001


def test_no_illustrated_geometry_in_geographic_scene():
    data = load_campus()
    assert data['version'] == 4
    assert len({f['id'] for f in data['features']}) == len(data['features'])
    for f in data['features']:
        assert f['properties'].get('source') != 'map.cup.edu.cn'
        if f['id'].startswith('geo-plan-'):
            assert f['properties']['accuracy'] == 'approximate-plan-trace'
