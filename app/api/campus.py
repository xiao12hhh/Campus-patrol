import math
from fastapi import APIRouter
from app.services.campus_data import load_campus, places_by_name

router = APIRouter(prefix='/api/campus', tags=['campus'])
LAYERS = ['buildings', 'roads', 'water', 'robots', 'vehicles', 'routes', 'alerts']

@router.get('/config')
def config():
    data = load_campus()
    return dict(tile_provider='local-vector', origin=data['origin'], unit_meters=data['unit_meters'],
                coordinate_system='WGS84-local-x-east-z-south', models=[], layers=LAYERS,
                provenance=data.get('provenance', {}))

@router.get('/layers')
def layers():
    return [dict(id=x, visible=True) for x in LAYERS]

@router.get('/pois')
def pois():
    data = load_campus()
    lat, lng = data['origin']['lat'], data['origin']['lng']
    unit = data['unit_meters']
    return [dict(id=name, name=name, type='landmark',
                 lat=lat-p['z']*unit/111320,
                 lng=lng+p['x']*unit/(111320*math.cos(math.radians(lat))))
            for name, p in places_by_name().items()]
