"""Build the geographic scene; never mix illustrated-map coordinates with WGS84.

Main-campus footprints are traced from the plan already embedded in grid-map.html,
registered to OSM relation 13644491's four main-campus corners. This restores
relative layout, not survey accuracy. South-campus known footprints and east campus
use OSM directly. The illustrated source is retained separately and is not mutated.
"""
import copy
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/sources/cupb-display-layout.json'
OUT = ROOT / 'public/data/campus-local.json'
old = json.loads(SOURCE.read_text(encoding='utf-8'))
raw = json.loads((ROOT/'data/sources/cupb-osm-v3.json').read_text(encoding='utf-8'))['elements']
boundary = json.loads((ROOT/'data/sources/cupb-boundary.json').read_text(encoding='utf-8'))['elements'][0]

def xy(lon, lat):
    return [round((lon-116.2449)*111320*math.cos(math.radians(40.2159))/10, 3),
            round((40.2159-lat)*111320/10, 3)]

# Plan-image rectangle and corresponding OSM campus perimeter corners.
NW, NE = (116.238541,40.2195691), (116.2441575,40.2197617)
SW, SE = (116.2386346,40.2156561), (116.2443254,40.2157437)
def project(p):
    u, v = (p[0]-55)/490, (p[1]-110)/430
    return xy(*[(1-v)*((1-u)*NW[i]+u*NE[i])+v*((1-u)*SW[i]+u*SE[i]) for i in range(2)])

def rect(x0,y0,x1,y1):
    return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]

features = []
def add(name, ring, kind='building', height=None, building='teaching', **props):
    matches = [f for f in old['features'] if f['name']==name and f['properties'].get('source')=='map.cup.edu.cn']
    ref = matches[0] if matches else None
    h = height if height is not None else ref['height'] if ref else 1.6
    levels = max(1, round(h*10/4))
    pts = [project(p) for p in ring]; pts.append(pts[0])
    features.append(dict(id='geo-plan-'+str(len(features)), name=name, kind=kind,
        height=h if kind=='building' else 0, in_campus=True,
        zone='南校区' if sum(p[1] for p in ring)/len(ring)>550 else '北校区',
        geometry=dict(type='Polygon',coordinates=[pts]), properties=dict(
            source='campus-plan-georeferenced', accuracy='approximate-plan-trace',
            height_source='official-map-field' if ref and height is None else 'estimated',
            levels=levels, **({'building':building,'category':'building'} if kind=='building' else {}), **props)))

# Traced outlines, including setbacks and open courts (never filled-in courtyards).
add('校医院', [[109,132],[164,128],[164,141],[127,145],[127,155],[164,153],[164,166],[109,169]], building='hospital')
add('基础楼B座', [[188,129],[244,125],[251,183],[233,199],[226,181],[235,176],[230,143],[203,145],[208,177],[192,179]])
add('基础楼A座',rect(200,204,221,247))
add('第二教学楼',[[331,168],[367,132],[396,162],[361,198]])
add('化工楼D座',[[367,119],[396,104],[419,126],[398,143]],building='experiment_building')
add('化工楼A座',[[430,169],[460,139],[484,163],[454,193]],building='experiment_building')
add('化工楼B座',[[483,174],[511,202],[511,222],[498,236],[470,207]],building='experiment_building')
add('化工楼C座',[[423,182],[451,209],[429,243],[400,216]],building='experiment_building')
add('图书馆',[[251,254],[280,222],[304,223],[337,255],[327,273],[316,264],[316,250],[304,238],[304,271],[318,283],[311,294],[277,294],[266,281],[279,269],[279,239],[266,252],[267,265],[257,273]],building='library')
add('草堂接待所',[[58,254],[157,257],[157,270],[112,272],[111,285],[138,287],[138,320],[60,316],[60,289],[75,289],[75,304],[100,305],[100,274],[58,272]],building='service_building')
add('国际交流中心',[[158,260],[199,260],[202,315],[151,319],[151,303],[185,302],[184,274],[158,274]],building='administration')
add('工程楼A座',rect(500,261,525,346),building='experiment_building')
add('工程楼B座',[[449,346],[525,351],[525,373],[467,371]],building='experiment_building')
add('工程实验西楼',[[402,313],[418,301],[440,322],[424,337]],building='experiment_building')
add('第二食堂',[[349,351],[384,345],[411,367],[386,392],[369,378],[356,390],[341,373]],building='canteen')
add('第一食堂',[[411,379],[444,410],[426,434],[394,410]],building='canteen')
add('学生活动中心',[[342,420],[393,420],[420,444],[402,453],[342,450]],building='service_building')
add('主楼A座',[[464,428],[528,429],[528,460],[459,460],[459,445],[464,445]],building='administration')
add('主楼B座',[[418,476],[438,476],[438,490],[510,490],[510,479],[529,479],[529,525],[420,525]],building='administration')
add('主楼C座',rect(510,461,529,478),building='administration')
add('体育馆',[[179,362],[196,348],[218,350],[242,369],[231,381],[222,378],[214,397],[193,401],[177,391]],height=1.2,building='gymnasium')
add('游泳馆',rect(188,409,253,456),height=1.0,building='gymnasium')
for i,y in enumerate([183,222]):
    add('北区宿舍'+str(i+1),rect(101,y,171,y+13),height=2.0,building='student_bedroom')
for name,ring in [
    ('青年园西区北楼',rect(192,468,250,485)),('青年园西区南楼',rect(193,515,278,531)),
    ('青年园西区连廊',rect(193,486,205,514)),('青年园东区北楼',rect(347,466,401,482)),
    ('青年园东区南楼',rect(322,514,405,530)),('青年园东区连廊',rect(394,483,406,513))]:
    add(name,ring,height=2.4,building='student_bedroom')
add('地质楼',[[258,636],[270,623],[284,623],[284,638],[305,638],[305,631],[335,631],[335,640],[359,640],[359,654],[392,654],[392,670],[273,674],[273,667],[255,667]],building='experiment_building')
for name,ring in [('北门',rect(264,105,277,112)),('东门',rect(537,383,546,393)),('南门',rect(292,531,309,537)),('南校区北门',rect(367,559,380,568))]:
    add(name,ring,height=.45,building='service_building',part='entrance_3d')
add('红旗操场',[[60,408],[70,390],[88,382],[131,382],[151,394],[164,417],[164,493],[153,518],[134,532],[91,532],[69,516],[60,495]],'pitch',leisure='pitch')
add('网球场',rect(80,332,139,369),'pitch',sport='tennis',leisure='pitch')
add('篮球场',[[481,102],[532,98],[533,177],[481,130]],'pitch',sport='basketball',leisure='pitch')

# Greens and paths are plan-derived; names below describe routes, not official road names.
for box in [(234,125,258,185),(273,123,309,183),(175,322,236,338),(258,369,276,450),(311,369,328,450),(444,251,482,318),(322,293,369,316),(64,541,398,547)]:
    add('',rect(*box),'green',landuse='grass')
def road(name, pts, highway='service'):
    features.append(dict(id='geo-road-'+str(len(features)),name=name,kind='road',height=0,in_campus=True,zone='北校区',
        geometry=dict(type='LineString',coordinates=[project(p) for p in pts]),
        properties=dict(source='campus-plan-georeferenced',accuracy='approximate-plan-trace',highway=highway)))
for name,pts,hw in [
    ('北门轴线',[[267,109],[267,193],[235,223]],'pedestrian'),
    ('图书馆环路',[[294,202],[350,258],[294,317],[236,260],[294,202]],'pedestrian'),
    ('校园中轴路',[[294,317],[294,455],[300,540]],'pedestrian'),
    ('西侧校园路',[[177,115],[178,249],[148,281],[153,324],[173,377],[177,540]],'service'),
    ('东侧校园路',[[540,188],[540,540]],'service'),
    ('北区东西路',[[177,249],[236,260]],'service'),
    ('图书馆东路',[[350,258],[377,238],[491,240],[540,240]],'service'),
    ('文体横路',[[150,324],[239,324],[294,348],[332,324],[382,324]],'service'),
    ('东门路',[[294,400],[329,400],[375,405],[401,377],[455,390],[540,390]],'service'),
    ('宿舍区路',[[177,462],[294,462],[417,462],[448,475]],'service'),
    ('南门连接路',[[300,540],[300,552],[378,552],[378,570]],'service'),
    ('南校区路',[[138,575],[138,690],[400,690],[400,572],[246,572],[246,616]],'service'),
    ('教学区步道',[[315,193],[334,215],[361,235],[389,252]],'footway'),
]: road(name,pts,hw)

# Keep only genuinely geographic context. Remove old hand-drawn roads, moved tennis
# courts, and all illustrated footprints. Restore the three wrongly deleted OSM buildings.
for f in old['features']:
    if f['properties'].get('source')=='map.cup.edu.cn' or f['id'].startswith('manual-'): continue
    # Main-campus contents are replaced as a set, to avoid conflicting roads/green blocks.
    g=f['geometry']; c=g['coordinates']
    if g['type']=='Point': c=[c]
    while c and isinstance(c[0][0],list): c=c[0]
    if not c: continue
    cx=sum(p[0] for p in c)/len(c); cz=sum(p[1] for p in c)/len(c)
    if -54<cx<-4 and -44<cz<3: continue
    features.append(copy.deepcopy(f))

south_ids={570430365:'中油大厦A座',570430366:'第三教学楼',570433614:'第四教学楼'}
for e in raw:
    if e.get('id') not in south_ids: continue
    name=south_ids[e['id']]
    features=[f for f in features if str(e['id']) not in f['id']]
    ref=next((f for f in old['features'] if f['name']==name),None)
    features.append(dict(id='osm-way-'+str(e['id']),kind='building',name=name,in_campus=True,zone='南校区',
        height=ref['height'] if ref else 2.4,
        properties=dict(source='OpenStreetMap',accuracy='osm-footprint',building='teaching',levels=(ref or {}).get('properties',{}).get('levels',6)),
        geometry=dict(type='Polygon',coordinates=[[xy(p['lon'],p['lat']) for p in e['geometry']]])))

zones=[]
for m in boundary['members']:
    if m.get('role')!='outer' or not m.get('geometry'): continue
    name={208801927:'东校区',47655362:'北校区',1018987820:'南校区'}.get(m['ref'])
    if name: zones.append(dict(name=name,rings=[[xy(p['lon'],p['lat']) for p in m['geometry']]]))

data=dict(version=4,origin=old['origin'],unit_meters=10,axis=old['axis'],license=old['license'],
    campus=dict(name='中国石油大学（北京）昌平校区',zones=zones),features=features,
    provenance=dict(layout='WGS84 boundary + registered campus plan',
        plan='public/grid/grid-map.html embedded north/south campus plan',
        reference='https://www.cup.edu.cn/jjc/xygh/index.htm',
        osm_snapshot='2026-09-22',precision='Plan-traced buildings are approximate; not survey-grade.',
        registration=dict(image_rect=[55,110,545,540],corners_wgs84=[NW,NE,SW,SE])))
OUT.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
print('Geographic campus:',len(features),'features;',sum(f['kind']=='building' for f in features),'buildings')
