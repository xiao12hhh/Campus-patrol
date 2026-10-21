"""Convert OSM GeoJSON lon/lat coordinates to a local campus coordinate file.

Output units are 10 metres per Three.js unit. X is east, Z is south and Y is
height. The origin is the OSM relation center for CUPB Changping campus.
"""
from __future__ import annotations
import json, math, pathlib

ROOT=pathlib.Path(__file__).resolve().parents[1]
SRC=ROOT/'data'/'sources'/'cupb-campus.geojson'
OUT=ROOT/'public'/'data'/'campus-local.json'
ORIGIN_LAT=40.21605; ORIGIN_LON=116.244796; UNIT=10.0

def xy(lon:float,lat:float):
    meters_per_deg=111320.0
    x=(lon-ORIGIN_LON)*meters_per_deg*math.cos(math.radians(ORIGIN_LAT))/UNIT
    z=(ORIGIN_LAT-lat)*meters_per_deg/UNIT
    return [round(x,3),round(z,3)]

def height(props):
    raw=props.get('height')
    try: return max(1.5,float(str(raw).replace('m','').strip())/UNIT)
    except (TypeError,ValueError): pass
    try: return max(1.5,float(props.get('building:levels'))*3.2/UNIT)
    except (TypeError,ValueError): return 2.0

def main():
    source=json.loads(SRC.read_text(encoding='utf-8')); features=[]
    for f in source.get('features',[]):
        geom=f.get('geometry') or {}; props=f.get('properties') or {}; typ=geom.get('type'); coords=geom.get('coordinates')
        if typ=='Point': local={'type':'Point','coordinates':xy(coords[0],coords[1])}
        elif typ=='LineString': local={'type':'LineString','coordinates':[xy(p[0],p[1]) for p in coords]}
        elif typ=='Polygon': local={'type':'Polygon','coordinates':[[xy(p[0],p[1]) for p in ring] for ring in coords]}
        else: continue
        kind='building' if props.get('building') else 'road' if props.get('highway') else 'poi'
        features.append({'id':f.get('id'),'kind':kind,'name':props.get('name') or props.get('name:zh') or '', 'height':height(props) if kind=='building' else 0, 'properties':props, 'geometry':local})
    OUT.parent.mkdir(parents=True,exist_ok=True)
    out={'version':1,'source':'data/sources/cupb-campus.geojson','origin':{'lat':ORIGIN_LAT,'lng':ORIGIN_LON},'unit_meters':UNIT,'axis':{'x':'east','y':'up','z':'south'},'features':features}
    OUT.write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f'Converted {len(features)} features to {OUT}')

if __name__=='__main__': main()
