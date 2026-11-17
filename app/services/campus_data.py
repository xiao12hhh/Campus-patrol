"""One coordinate source for the API and simulation."""
import json
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parents[2] / 'public/data/campus-local.json'


def load_campus():
    return json.loads(DATA_PATH.read_text(encoding='utf-8'))


def places_by_name():
    result = {}
    for f in load_campus()['features']:
        if not f.get('name') or not f.get('in_campus'):
            continue
        g = f['geometry']
        if g['type'] not in ('Polygon', 'MultiPolygon'):
            continue
        ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
        if ring[0] == ring[-1]:
            ring = ring[:-1]
        result.setdefault(f['name'], dict(name=f['name'], x=sum(p[0] for p in ring)/len(ring),
                                         z=sum(p[1] for p in ring)/len(ring)))
    return result
