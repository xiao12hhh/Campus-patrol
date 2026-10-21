from fastapi import APIRouter
router=APIRouter(prefix="/api/campus",tags=["campus"])
@router.get('/config')
def config(): return {"tile_provider":"amap","tile_template":"https://webrd0{1-4}.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}","origin":{"lat":39.98,"lng":116.35},"coordinate_system":"local-enu","models":[],"default_camera":{"x":30,"y":35,"z":38},"layers":["buildings","roads","water","robots","vehicles","routes","alerts"]}
@router.get('/layers')
def layers(): return [{"id":x,"visible":True} for x in ["buildings","roads","water","robots","vehicles","routes","alerts"]]
@router.get('/pois')
def pois(): return [{"id":"building-1","name":"主教学楼","type":"building","lat":39.977,"lng":116.348},{"id":"gate-east","name":"东门","type":"gate","lat":39.98,"lng":116.36}]
