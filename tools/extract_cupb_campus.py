"""Extract OSM features inside the CUPB university relation and write GeoJSON.

The relation id is taken from the successful candidate search result. Review
the resulting geometry before using it for navigation or safety-sensitive work.
"""
from __future__ import annotations
import json, pathlib, urllib.parse, urllib.request, urllib.error, datetime, time

ROOT=pathlib.Path(__file__).resolve().parents[1]; OUT=ROOT/'data'/'sources'; OUT.mkdir(parents=True,exist_ok=True)
UA='cup-campus-twin/0.1 (research; contact project owner)'; RELATION_ID='13644491'; AREA_ID='3613644491'
# relation center from the successful OSM candidate response; fallback bbox is
# deliberately local to the昌平校区, not a city-wide query.
BBOX='40.195,116.215,40.238,116.275'
ENDPOINTS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter']

def main():
    # 关系对象的 area ID = 3600000000 + relation ID。
    # 直接使用 area()，兼容性比 map_to_area 更好。
    query=f'''[out:json][timeout:120];
area({AREA_ID})->.campus;
(
  way[building](area.campus);
  relation[building](area.campus);
  way[highway](area.campus);
  nwr[entrance](area.campus);
  nwr[amenity](area.campus);
  nwr[leisure](area.campus);
  nwr[natural](area.campus);
  nwr[water](area.campus);
);
out body geom;'''
    fallback_query=f'''[out:json][timeout:120];
(
  way[building]({BBOX});
  way[highway]({BBOX});
  nwr[entrance]({BBOX});
  nwr[amenity]({BBOX});
  nwr[leisure]({BBOX});
  nwr[natural]({BBOX});
  nwr[water]({BBOX});
);
out body geom;'''
    body=urllib.parse.urlencode({'data':query}).encode(); raw=None; endpoint=None; last=None
    print(f'正在从 Overpass 提取 relation {RELATION_ID}（area {AREA_ID}），请稍候...', flush=True)
    for ep in ENDPOINTS:
        print(f'尝试节点: {ep}', flush=True)
        try:
            req=urllib.request.Request(ep,data=body,headers={'User-Agent':UA})
            with urllib.request.urlopen(req,timeout=240) as res: raw=res.read(); endpoint=ep
            break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')[:500]
            last=f'HTTP {exc.code}: {detail}'
            print(f'节点失败: {last}', flush=True); time.sleep(2)
        except (urllib.error.URLError,TimeoutError) as exc:
            last=str(exc); print(f'节点失败: {last}', flush=True); time.sleep(2)
    if raw is None: raise RuntimeError(f'Overpass extraction failed: {last}')
    # Some Overpass instances have stale/missing area indexes for this relation.
    # Retry with a small campus-centered bbox when area extraction is empty.
    if len(json.loads(raw).get('elements', [])) == 0:
        print('area 查询返回 0 个要素，改用昌平校区局部 bbox 提取...', flush=True)
        body=urllib.parse.urlencode({'data':fallback_query}).encode(); raw=None; last=None
        for ep in ENDPOINTS:
            print(f'尝试 bbox 节点: {ep}', flush=True)
            try:
                req=urllib.request.Request(ep,data=body,headers={'User-Agent':UA})
                with urllib.request.urlopen(req,timeout=180) as res: raw=res.read(); endpoint=ep
                break
            except urllib.error.HTTPError as exc:
                last=f'HTTP {exc.code}: {exc.read().decode("utf-8",errors="replace")[:300]}'; print(last,flush=True); time.sleep(2)
            except (urllib.error.URLError,TimeoutError) as exc:
                last=str(exc); print(last,flush=True); time.sleep(2)
        if raw is None: raise RuntimeError(f'Overpass bbox extraction failed: {last}')
    stamp=datetime.datetime.now(datetime.timezone.utc).isoformat(); payload=json.loads(raw)
    (OUT/'cupb-campus-raw.json').write_bytes(raw)
    (OUT/'cupb-campus.meta.json').write_text(json.dumps({'relation_id':RELATION_ID,'area_id':AREA_ID,'bbox':BBOX,'source':endpoint,'retrieved_at':stamp,'query':query,'fallback_query':fallback_query,'license':'ODbL 1.0; see https://www.openstreetmap.org/copyright'},ensure_ascii=False,indent=2),encoding='utf-8')
    features=[]
    for el in payload.get('elements',[]):
        tags=el.get('tags',{})
        if el.get('type')=='way' and el.get('geometry'):
            coords=[[p['lon'],p['lat']] for p in el['geometry']]
            is_polygon=len(coords)>=4 and coords[0]==coords[-1] and any(k in tags for k in ('building','landuse','natural','water','leisure'))
            geometry={'type':'Polygon','coordinates':[coords]} if is_polygon else {'type':'LineString','coordinates':coords}
        elif el.get('type')=='node' and 'lat' in el:
            geometry={'type':'Point','coordinates':[el['lon'],el['lat']]}
        else: continue
        features.append({'type':'Feature','id':f"osm-{el['type']}-{el['id']}",'properties':tags,'geometry':geometry})
    geo={'type':'FeatureCollection','features':features}
    (OUT/'cupb-campus.geojson').write_text(json.dumps(geo,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f'Extracted {len(features)} features from relation {RELATION_ID}')
    print(f'GeoJSON: {OUT / "cupb-campus.geojson"}')

if __name__=='__main__': main()
