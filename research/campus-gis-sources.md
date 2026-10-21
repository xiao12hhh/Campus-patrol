# 中国石油大学（北京）昌平校区：公开 GIS / 三维数据来源研究

更新时间：2026-09-22

## 结论摘要

- **首选数据源：OpenStreetMap（OSM）+ Overpass API。** OSM 数据可公开查询和下载，数据库许可为 ODbL 1.0；适合获取校园边界（若已绘制）、建筑轮廓、道路、出入口、绿地和水体等矢量要素。是否已经存在“中国石油大学（北京）昌平校区”的完整校园要素，必须以实际查询结果为准，本文件不假设其存在。
- **批量离线备选：Geofabrik China PBF。** 用于不依赖实时 API 的 OSM 数据处理；下载后在本地用 osmium/osm2pgsql/QGIS 筛选昌平范围。该页面是下载入口，不代表其中一定含有完整校园建筑细节。
- **官方来源：学校官网。** 中国石油大学（北京）官网（[cup.edu.cn](https://www.cup.edu.cn/)）是核对校名、校区范围、校园地图/规划图和联系学校获取授权模型的第一方入口。官网是否公开可下载的 CAD/GLB/倾斜摄影数据需要人工在“学校概况/校园地图/信息公开”等栏目确认；不要把网页图片或宣传图当作可直接用于导航的测绘数据。
- **当前仓库的坐标只应视为演示占位。** `data/campus.json` 和 `app/api/campus.py` 使用 `origin={lat:39.98,lng:116.35}`，并没有来源元数据。接入真实数据前，应保存原始来源、抓取时间、坐标参考系和授权信息，并重新测定校园原点。

## 可直接使用的公开端点和查询

### 1. Overpass：按名称检索大学对象

将下面查询提交到任一公开 Overpass 实例（例如 [overpass-api.de](https://overpass-api.de/api/interpreter)）：

```overpass
[out:json][timeout:60];
(
  nwr["name"~"中国石油大学|石油大学"](39.90,116.20,40.10,116.50);
  nwr["amenity"="university"]["name"~"石油"](39.90,116.20,40.10,116.50);
);
out center tags;
```

这个查询只检索北京北部的宽范围，并返回节点、道路和关系的中心点及标签。结果为空并不证明校园不存在，只表示当前 OSM 数据没有匹配的标签/范围。

### 2. Overpass：获取校园内建筑、道路和 POI（在确认校园边界后）

推荐先从上一个查询或 Nominatim 结果得到 `area`/关系 ID，再替换 `<AREA_ID>`；不要直接把未经核实的经纬度当作校界：

```overpass
[out:json][timeout:120];
area(<AREA_ID>)->.campus;
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
out body geom;
```

`out body geom` 会返回几何坐标，可转换为 GeoJSON，再投影到校园局部 ENU。若没有校区 area 关系，可改用人工核验的 bbox，但必须把 bbox 来源记录在项目数据清单中。

### 3. Nominatim：仅用于候选地点/边界发现

查询入口：[nominatim.openstreetmap.org](https://nominatim.openstreetmap.org/)。示例（需遵守实例的使用政策并设置有效 `User-Agent`）：

```text
https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=10&q=%E4%B8%AD%E5%9B%BD%E7%9F%B3%E6%B2%B9%E5%A4%A7%E5%AD%A6%20%E6%98%8C%E5%B9%B3%E6%A0%A1%E5%8C%BA
```

Nominatim 返回的 `boundingbox`/`polygon_geojson` 只能作为候选结果；在导入机器人导航前应人工在 OSM 或学校资料中核对。

### 4. OSM 原始 API（小范围，不适合批量抓取）

API 说明：[OSM API v0.6](https://wiki.openstreetmap.org/wiki/API_v0.6)。确认 bbox 后可使用：

```text
https://api.openstreetmap.org/api/0.6/map?bbox=<left>,<bottom>,<right>,<top>
```

该接口有面积/请求限制；校园数据批量导出优先使用 Overpass 或 Geofabrik。

## 授权、署名和服务限制

- OSM 数据版权与 ODbL 条款：[openstreetmap.org/copyright](https://www.openstreetmap.org/copyright)。发布由 OSM 数据生成的地图/数据库时应保留 `© OpenStreetMap contributors` 署名，并按 ODbL 要求处理衍生数据库。
- OSM 公共瓦片有明确的使用政策：[operations.osmfoundation.org/policies/tiles](https://operations.osmfoundation.org/policies/tiles/)。生产环境不要把 `tile.openstreetmap.org` 当作无条件的高并发底图服务；应使用合规的第三方瓦片供应商或自建缓存，并展示署名。
- Overpass/Nominatim 是社区公共服务，不应高频轮询或把服务当作稳定生产数据库。建议一次性下载、缓存原始响应并在 `data/sources/` 保存查询时间与 URL。

## 三维模型的现实边界

OSM/Overpass 通常只能提供二维/带高度属性的建筑和道路几何，**不会保证**昌平校区的可直接使用 GLB/GLTF、室内模型、纹理或测绘级高程。若需要真实三维模型：

1. 先用 OSM 矢量作为底图和导航骨架；
2. 通过学校官网公开渠道或校方书面授权获取 BIM/CAD/倾斜摄影/GLB；
3. 在模型元数据中记录授权范围、坐标参考系、版本和脱敏要求；
4. 将 WGS84/CGCS2000/GCJ-02 等来源坐标统一转换为项目局部 ENU，再写入 `data/campus.json` 的 `origin` 和 POI。

## 对本仓库的具体建议

- 新增 `data/sources/`，保存：Overpass QL、原始 JSON/GeoJSON、下载时间、来源 URL、许可证和转换脚本版本。
- 暂不把当前 `39.98,116.35` 原点或示例建筑坐标当作真实校园数据；在 UI 中标注为“演示数据”。
- 导入流程：OSM/Overpass → GeoJSON → （必要时）CGCS2000/WGS84/GCJ-02 核验 → 局部 ENU 米制坐标 → Three.js / `campus.json`。
- 若 OSM 查询无完整校园要素，继续使用程序化示例场景，同时向学校信息化/保卫/资产管理部门申请可公开使用的建筑与道路数据；不要从搜索引擎图片或未授权地图服务抓取模型。

## 来源索引（第一方/规范页面）

1. OpenStreetMap Copyright / ODbL：<https://www.openstreetmap.org/copyright>
2. OSM API v0.6 规范：<https://wiki.openstreetmap.org/wiki/API_v0.6>
3. Overpass API 规范：<https://wiki.openstreetmap.org/wiki/Overpass_API>
4. Overpass 公共实例：<https://overpass-api.de/api/interpreter>
5. Nominatim 服务入口与政策：<https://nominatim.openstreetmap.org/>
6. OSM 公共瓦片使用政策：<https://operations.osmfoundation.org/policies/tiles/>
7. Geofabrik China 下载入口：<https://download.geofabrik.de/asia/china.html>
8. 中国石油大学（北京）官网：<https://www.cup.edu.cn/>

