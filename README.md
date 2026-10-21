# 石大·智巡：3D 校园数字孪生、四足机器人巡检与 VRPTW

本项目在原有单文件视觉原型基础上，升级为可本地启动的前后端系统：

- **前端**：React + TypeScript + Vite + Three.js，提供可旋转/缩放的 3D 校园场景。
- **后端**：FastAPI，提供校园配置、机器人任务、WebSocket 状态流和 VRPTW 求解接口。
- **算法**：优先使用 Google OR-Tools；未安装 OR-Tools 时自动使用可解释的贪心降级求解，保证演示可运行。
- **GIS**：高德/天地图兼容的瓦片配置接口；无 Key 时仍可使用本地 3D 场景。

## 官方地图模式（默认视图）

顶部「**官方地图 / 三维孪生**」切换。**官方地图模式**直接使用学校
[可视化位置服务平台](https://map.cup.edu.cn/)（map.cup.edu.cn）的**手绘 2.5D 栅格瓦片**做地面，
观感与官方地图一致；**三维孪生模式**保留程序化三维建筑（roofkit / paving / PBR 树）。
机器狗、巡检路线、VRPTW 路线在两种视图下都正常叠加。

### 瓦片管线（离线，一次性）

```text
tools/download_cup_tiles.py     下载官方瓦片 z16~z19 → public/tiles/cup/{z}/{x}/{y}.png
                                （官方覆盖 lon 116.235~116.247：主校区 + 南校区 + 润杰/阳光生活区 + 红旗操场；
                                  出界瓦片为纯色 #e7e9db 占位或 404）
tools/bake_east_tiles.py        东校区（官方未覆盖）用 OSM 矢量按官方画风烘焙补丁瓦片：
                                底色 #e7e9db / 亮路面+灰 casing / 草地 #cfedcf / 水体 #97c1cb
                                建筑 = 东南阴影 + footprint 墙体 + 北移屋顶（伪 2.5D）+ 南立面窗带 + 行道树
                                同名 preview 子命令输出东校区预览大图
public/tiles/cup/tiles.json     逐层级瓦片存在清单（前端按需建 mesh，不发 404 请求）
```

### 前端（`frontend/src/components/scene/tileground.ts`）

- **精确对齐**：瓦片是 Web Mercator（XYZ），校园数据是局部米制（x 东 / z 南 / 1 单位 = 10 m，
  原点 40.2159, 116.2449）。每片瓦片四角 lon/lat → 局部矩形逐片换算，
  不做线性近似（纬度 40° 处两投影差 cos(40°)，直接平铺会错位几十米）。
  已用官方矢量轮廓叠瓦片验证：footprint 南边缘与画中建筑基座重合，楼顶向北偏移。
- **LOD**：按相机高度切层级（<240 m 用 z19，<520 m z18，<1.05 km z17，更远 z16），
  只给视锥内瓦片加载纹理，LRU 上限 140 张（全部瓦片 ~960 张 ≈ 240 MB 不能全驻留）。
- **底板**：瓦片覆盖区外的大底板取官方底色 #e7e9db，地图模式接管原绿色地面。
- **昼夜**：瓦片是白天画的，dawn/dusk/night 用乘色压暗（`TODS.*.mapTint`）。
- **交互**：地图模式下点选建筑改用**地面点在多边形判定**（比斜射 3D 体块准），
  选中显示青色轮廓高亮；隐藏的程序化建筑仍参与孪生模式拾取。
- **相机**：地图模式限制最大俯角 76°，避免平视时"纸片"感；默认机位从南侧看向校园，
  与官方地图 2.5D 画的立面方向一致。

### 踩坑记录（重要）

- **OSM 路网缺口手工补**：OSM 对南校区/元山前路一带覆盖不全——南北校区之间的
  "元山前路"主路（南校区北缘 z≈+5.5，五教/石亿年华超市以北）、南门正对的南北路
  （南广场 → 南门 → 元山前路 → 南校区）、青年园西路（4教与南广场之间）都缺失。
  `tools/add_manual_roads.py` 从官方 z19 瓦片描点反算坐标（误差 ≈ 0.3 m），幂等地追加
  `manual-` 前缀要素；数据版本号 `DATA_VERSION` 相应 bump 穿透浏览器缓存。
  注意元山前路不在北校区南门内侧（z≈-1）——那是南门内侧集散路，别混淆；
  判定锚点：南门/南校区北门两栋门房建筑（官方源）的 z 坐标 ≈ -6 与元山前路无关，
  真正的元山前路以官方图底部的"元山路"黄字路名为准（z≈+5.5）。
- **网球场位置**：OSM 的网球场坐标偏西 5.7/偏南 1.7 单位（跑到红旗操场西南 110 m 外），
  `add_manual_roads.py` 按用户指认整体平移回红旗操场西南侧（紧挨操场）。
- **田径场渲染**：OSM 的 pitch 常缺 leisure/sport 标签（红旗操场就是一块无名绿地）。
  `buildWaterAndPitches` 按判定顺序分流：`leisure=stadium`（有标签）→ 有 sport 的球场
  （足球/网球/篮球各有配色）→ **面积 >25 units² 或名字含"操场/田径场"** 的无名场地按
  田径场画：红棕跑道环带 + 内缩 0.78 的足球草坪 + 三圈白色分道线。
- **官方瓦片是带 alpha 的调色板 PNG**：内容区外是透明像素，官方网页叠在白底上看不出来；
  three.js 不透明材质会把它渲染成**大块黑色**。`tools/flatten_tile_alpha.py` 把全部瓦片的
  透明像素合成到 #e7e9db 底色（下载脚本也已内置该处理）。
- **取景框被东校区拉宽**：三校区合并框（含东校区）宽 200+ 单位，默认视野下主校区缩成
  一小块。`App.tsx` 的 focusBox 按"环质心 x<15"排除东校区环（东 ≈ +34，南/北 ≈ -33/-37）。
  曾有一个真 bug：`Engine.focus` 只在引擎创建时捕获一次，而 campus 数据那时还没加载
  （永远是 null）——现在静态场景每次重建时同步。
- **切视图必须落位相机**：地图/孪生两模式取景范围不同，`applyViewMode` 里若只重算 home
  不 tween 落位，相机停在另一模式的远机位上，会看到取景框外的城市建筑 + 被雾吞掉
  的地面（看起来像"浮空黑块"）。
- **`paving.ts` ribbon 三角面绕序**：顶点顺序 (西,北,东) 的叉积法线朝下，正面被剔除——
  **路从上空完全消失**，只剩侧面一条细线（此 bug 存在了多个版本）。正确绕序是
  (西,东,西北)，法线朝 +y。`tools/probe_scene.ts` 末尾附带道路/绿地 merge 诊断。
- **曝光补偿**：day 光照总曝光约 2×，E.ground 底板色、草地顶点色要按"显示目标的一半"
  给（旧色 #a9c78f 曝光后就是荧光黄绿）；树冠叶贴图本身偏暗，instanceColor 支持 >1
  的浮点乘法强行提亮。

### 署名

瓦片底图 © 中国石油大学（北京）可视化位置服务平台（map.cup.edu.cn）；
矢量数据 © OpenStreetMap contributors（ODbL）；仅用于教学演示。

## 启动

### 最快：双击

直接双击项目根目录下的 **`start.bat`**。它会调用 `start.ps1`，自动找可用的 Python、拉起后端、等端口就绪后帮你打开浏览器 —— 全程不用敲命令。

### 命令行

```powershell
.\start.ps1            # 生产模式：只跑后端，一个端口全搞定
.\start.ps1 -Dev       # 开发模式：额外起 Vite，前端热更新
```

首次运行前装依赖（只需一次）：

```powershell
npm install
pip install -r requirements.txt
```

`start.ps1` 会按下面的顺序挑 Python，找不到 fastapi 就直接报错并给出安装命令，不会卡在半路：

1. `%USERPROFILE%\.workbuddy\binaries\python\envs\default`（本项目实际使用的托管环境）
2. 项目下的 `.venv` / `venv`
3. 系统 `python`

如果不想用脚本，等价的一条命令是：

```powershell
C:\Users\31054\.workbuddy\binaries\python\envs\default\Scripts\python.exe -m uvicorn app.main:app --port 8000
```

### 地址

| 用途 | 地址 |
| --- | --- |
| 前端（生产模式，推荐） | http://127.0.0.1:8000 |
| 前端（开发模式，热更新） | http://127.0.0.1:5173 |
| API 文档 | http://127.0.0.1:8000/docs |
| 健康检查 | http://127.0.0.1:8000/health |

生产模式下 FastAPI 同源托管 `dist/`，`/api` 与 `/ws` 都不需要代理。**改了前端代码要重新 `vite build`**，否则生产模式看到的还是旧页面（脚本发现 `dist/` 不存在时会自动构建一次）。

> **注意**：`start.ps1` 必须以 **UTF-8 BOM** 保存。PowerShell 5.1 读无 BOM 的 `.ps1` 会按 GBK 解析，中文注释会变成乱码并导致脚本解析失败。

## 局域网访问（不再只限本机）

开发环境已经配置为监听 `0.0.0.0`。启动后，在运行项目电脑上执行：

```powershell
ipconfig
```

找到 IPv4 地址，例如 `192.168.1.23`。同一局域网的其他电脑访问：

```text
http://192.168.1.23:5173
```

如果访问失败，需要在 Windows 防火墙中允许 Node.js/Vite 的 TCP 5173 端口；后端 API 通过 Vite 代理，不需要额外暴露 8000 端口。

## 公网部署（推荐生产方式）

1. 准备一台云服务器或校园服务器，绑定域名，例如 `campus.example.com`。
2. 在服务器安装 Docker，执行：

```bash
npm run build
docker compose up -d --build
```

3. 使用 Nginx、Caddy 或云负载均衡把域名转发到容器 `8000` 端口，并配置 HTTPS。
4. 前端生产环境不再写死 `localhost`：默认请求当前域名下的 `/api` 和 `/ws`，同一个域名即可完成 HTTP 和 WebSocket 通信。

也可以直接使用示例 `nginx.conf.example` 做反向代理。WebSocket 必须保留 `Upgrade` 和 `Connection: upgrade` 请求头。

## 真实地图和校园模型接入

默认视图已是官方手绘瓦片地图（见上文「官方地图模式」）；三维孪生视图为程序化建模。
`/api/campus/config` 仍预留 GIS 配置。继续完善建议分三步：

1. **底图**：申请高德/天地图 Key，把瓦片模板和校园原点写入 `/api/campus/config`；底图只作为平面纹理或 GIS 图层，不承担机器人坐标。
2. **校园模型**：把建筑导出为 GLB/GLTF 放入 `public/models`，在 `CampusScene` 中用 `GLTFLoader` 加载；模型坐标统一转换到校园局部 ENU 坐标。
3. **业务点位**：将建筑、门、巡检点、配送点写入 `data/campus.json`，前端启动时通过 `/api/campus/pois` 加载，不再硬编码建筑数组。

坐标建议统一为：

```text
经纬度 WGS84/GCJ-02 → 校园原点 → 局部 ENU（米） → Three.js x/y/z
```

不要直接把经纬度当作 Three.js 坐标，否则校园范围会出现比例失真、机器人和路线无法对齐的问题。

## 程序化视觉细节（建筑体块 + 地面铺装）

在不逐栋手工建模的前提下，用程序化几何 + 实例化 + Canvas 生成 PBR 贴图把观感推向"精模"。相关代码集中在三个文件：

```text
frontend/src/components/scene/detailcfg.ts   可调参数与三档预设（lean / standard / rich）
frontend/src/components/scene/roofkit.ts     建筑体块：勒脚/檐口/女儿墙/压顶 + 屋面设备
frontend/src/components/scene/paving.ts      地面铺装：车行道/人行道/广场/草地/路缘石/井盖
```

### 建筑（roofkit.ts）

每栋校内建筑由 5 个体块沿高度堆叠后**合并成 1 个 Mesh**（3 个材质组：屋面 / 墙面 / 线脚），不是 5 个 draw call：

| 体块 | 说明 |
| --- | --- |
| 勒脚 plinth | 底部外扩 `PLINTH_OUT`，深色线脚，拉开"落地"重量感 |
| 主体 wall | 原轮廓挤出，侧墙 UV 按真实层数重排（`retileWall`） |
| 檐口 cornice | 顶部外挑 `EAVE_OUT`，下沿留 `DRIP_GAP` 滴水缝 |
| 女儿墙 parapet | 沿屋面内缩环向上挤出，带 `PARAPET_SINK` 沉降避免同面 z-fighting |
| 压顶 coping | 女儿墙再外挑一圈，形成三重水平线 |

- **层数驱动**：`levels`（官方数据 82/101 栋有值）决定窗格行数，窗行与真实楼层对齐，不再是等距平铺。
- **檐口阴影**：底部与檐下的 AO 直接烘进**顶点色**（`paintAO`），运行时零开销。
- **屋面设备**：6 种 InstancedMesh（空调机组 / 风管 / 水箱 / 管道束 / 楼梯间电梯机房 / 通风帽），按建筑类型配方（`RECIPES`）与屋面面积阈值（`MIN_AREA`）投放，在**内缩安全环**上做带碰撞检测的泊松采样 —— 因此设备不会穿女儿墙、不会穿屋面。
- **分材质分档**：`TIER_BY_BUILDING` 按功能（行政 / 教学楼 / 学生宿舍 / 门廊 …）缩放线脚比例与细节密度。

### 地面（paving.ts）

- 139 条道路按等级**合并为 4 个 Mesh**（虚线车行道 / 实线车行道 / 人行道 / 广场），不是 139 个。
- 路面几何用 `ribbon()` 手写三角带，UV 按**物理米数**生成，接缝/磨损/污渍靠 `destination-out` 在 Canvas 贴图上挖出，再 `deriveGray` 从亮度反推 bump / roughness。
- 路缘石（合并 Mesh）+ 井盖（InstancedMesh，仅校内、间距 30 m）作为路侧细节。
- 草地 / 停车场按区域（`PAVE_BY_ZONE`）切换铺法与色偏，只改 UV 缩放与旋转，不增加 draw call。

### 可调参数

- **代码**：改 `detailcfg.ts` 的 `DETAIL_PRESETS` / `TIER_BY_BUILDING`，或 `roofkit.ts` 顶部常量（`PLINTH_H`、`EAVE_OUT`、`PARAPET_H`、`EQUIP_MARGIN` …）、`paving.ts` 的 `CURB_H` / `MANHOLE_R` / `DASH_PERIOD`。
- **界面**：右上角"图层"菜单里的 **细节** 下拉（简约 / 标准 / 丰富），实时重建，无需改代码重启。

### 性能预算（standard 档，实测）

| 指标 | 数值 |
| --- | --- |
| draw call（静态校园部分） | ≈ 99 |
| 实例总数 | 2195 |
| 三角面 | ≈ 149 k |
| 实例分布 | 屋面 678（ac 167 / duct 76 / tank 59 / pipe 118 / mech 72 / vent 186）、壁挂空调 480、雨落管 556、井盖 481 |

LOD：建筑细节在相机距离 > 130 单位、路侧细节 > 85 单位时整组隐藏；画质切到"低"时直接关掉这两组。远景靠轮廓 + 檐口/压顶水平线仍能读出体块关系。

### 离线校验

无需打开浏览器即可验证几何正确性（`tools/probe_scene.ts` + `tools/probe.vite.config.ts`）：

```powershell
npx vite build --config tools/probe.vite.config.ts
node tools/_probe_out/probe_scene.js
```

脚本在无 DOM 环境下构建三种细节档位的场景，断言：所有屋面设备实例落在安全环内（容差 6 cm）、UV 无 NaN、统计 draw call / 实例 / 三角面。当前输出 `PASS`。

## 机器狗真实模型（宇树 B2）

巡检机器人从程序化方块狗替换为 **宇树 Unitree B2 真实模型**（来源：用户提供的 890012.zip 内 FBX，206 Mesh / 287 万三角面）。

**离线烘焙管线**（`tools/_dog_bake.mjs` → `_dog_pack.mjs`，一次运行，产物入库）：

1. FBXLoader 解析 → 按"四象限 + 高度"规则把 206 个零件分到 9 桶（body + 4 腿 × 上下段），四组腿面数偏差 < 0.1%。
2. 每桶合并 → `mergeVertices` 焊接 → `MeshoptSimplifier` 分级误差减面（287 万 → 7.2 万面）。
3. 原厂灰烘焙进**顶点色**；Z-up（Rhino 原生）转 Y-up；按场景比例 `1 单位 = 10 m` 缩放。
4. 顶部传感舱整体渐变下沉 `TOP_DROP=0.11`，消除"悬空"观感。
5. gltfpack CLI（必须走 CLI，JS API 读不到文件）`-kn -km -cc` 量化压缩 → `public/models/unitree_b2.glb`（400 KB）+ lite 版（340 KB），关节坐标在 `unitree_b2.meta.json`。

**运行时接入**（`builders.ts` + `CampusScene.tsx`）：

- `loadDogProto()` 模块级缓存加载 GLB（MeshoptDecoder 解压），几何/材质标 `userData.shared`，多机器人共享、dispose 时跳过。
- 摆腿是程序化的：读 `body.userData.gait = {hip, knee}` 做正弦摆动，knee 用**负号**才不穿地（`_dog_rigcheck.mjs` 扫 48 相位 × 4 腿验证过）。
- 多只狗靠头顶状态名牌区分，机身保持原厂灰。

## 树木（Megascans 栗树贴图 + 交叉面片）

行道树/绿地树替换为 PBR 树：树干 6 棱柱（trunk 三张贴图）+ 树冠交叉面片（`frontend/src/components/scene/trees.ts`），全部 InstancedMesh，两千多棵只占 2 个 draw call。

- **布置**：行道树沿道路中心线两侧等距成对（间距 ≈ 9 m，主干道双侧、支路单侧），另在建筑周边/绿地散点，避开建筑/水面/运动场，上限 2600 棵。
- **叶丛贴图**：Megascans 单叶 atlas 不能直接用（3 片面片上只有 8 片稀疏大叶，远看像黑飞虫）。`tools/_leaf_cluster.py` 把 8 片叶子逐片随机旋转/缩放/翻转叠放 66 次，合成覆盖率 ~82% 的密集叶丛 `public/textures/tree/leaf_cluster.png`（325 KB，256 色量化）。**透明区 RGB 渗成叶片平均色（color bleed）**，否则 mipmap 会把黑色混进来，alphaTest 后整片树发黑。
- **树冠封顶**：交叉面片是竖直平面，俯视时近乎侧棱、全是背光黑边。树冠几何里加两层**水平叶盖面片**（法线朝上），高空看才是绿色树团；配弱自发光（`emissiveMap` 同贴图）托起掠射暗部。
- 实例色只做浅色系微变（`0xc4dba4 ~ 0xf4f8e2`），不要用深绿去乘贴图，会越乘越黑。

> **踩坑提醒**：`vite build` 必须在**项目根目录**执行（配置 `vite.config.ts` 在根，`root:'frontend'`、`outDir:'../dist'`）。在 `frontend/` 子目录里跑会找不到配置，产物写到 `frontend/dist` 而根 `dist` 纹丝不动——表现为"改了代码截图永远不变"。

## 公开数据下载脚本

当前执行环境无法直接访问外网，因此没有把未经核验的 OSM 结果伪装成真实校园数据。你可以在能访问互联网的电脑上运行：

```powershell
python tools/download_osm_campus.py
```

脚本会把 Overpass 原始响应和查询元数据保存到：

```text
data/sources/cupb-candidate-search.json
data/sources/cupb-candidate-search.meta.json
```

这一步只做“中国石油大学（北京）”候选对象检索。拿到结果后，需要人工确认昌平校区边界，再使用研究记录中的校园区域 Overpass 查询提取建筑和道路；OSM 数据必须保留 `© OpenStreetMap contributors` 署名，并遵守 ODbL 和 Overpass 服务使用政策。

候选结果已经发现学校关系 ID `13644491` 后，可以在联网电脑继续运行：

```powershell
python tools/extract_cupb_campus.py
```

脚本会生成：

```text
data/sources/cupb-campus-raw.json
data/sources/cupb-campus.geojson
data/sources/cupb-campus.meta.json
```

其中 GeoJSON 包含关系范围内的建筑、道路、出入口、设施、绿地和水体等公开 OSM 要素。导入 Three.js 前仍需检查关系范围是否只覆盖昌平校区，并进行局部 ENU 坐标转换。

在 Windows PowerShell 中读取中文 GeoJSON 时，请显式指定 UTF-8，避免 `ConvertFrom-Json` 因系统默认编码导致解析失败：

```powershell
$json = [IO.File]::ReadAllText((Resolve-Path 'data\sources\cupb-campus.geojson'), [Text.Encoding]::UTF8)
$g = $json | ConvertFrom-Json
$g.features.Count
```

也可以直接用 Python 检查：

```powershell
python -c "import json; d=json.load(open('data/sources/cupb-campus.geojson',encoding='utf-8')); print(len(d['features']))"
```

也可以分别运行：

```powershell
python -m uvicorn app.main:app --reload --port 8000
npm run dev
```

## 三大模块边界

1. **3D 校园数字孪生**：建筑、道路、点位、底图、相机和图层；不执行机器人任务或车辆求解。
2. **四足机器人巡检**：多机状态、任务下发、进度、轨迹和告警；首期使用仿真状态 + WebSocket 契约，可替换为 ROS/ROS2 网关。
3. **VRPTW 车辆路径规划**：车辆容量、时间窗、服务时间和配送顺序求解；结果以路线和时间轴回写到 3D 场景，不控制机器人。

## 接口

```text
GET  /api/campus/config
GET  /api/campus/layers
GET  /api/campus/pois
GET  /api/robots
GET  /api/robots/{robot_id}
POST /api/robots/missions
POST /api/robots/missions/{mission_id}/{start|pause|cancel}
WS   /ws/robots
POST /api/vrptw/solve
GET  /api/vrptw/examples
```

## 前端交互

### 模块一：3D 校园浏览
- 左侧地标列表（支持"三教/学活/研修大厦"等别名搜索），点击飞行到对应建筑。
- 选中地标后可用"全貌 / 正面 / 俯视 / 近景"四种预设视角。
- 底部"开始自动巡游"：按图书馆 → 主教 → … → 足球场的顺序巡游，支持暂停/继续/下一站/结束；手动拖拽会自动结束巡游。
- 右上角晨光/日间/黄昏/夜景四种光照氛围，夜景下建筑窗户发光、路灯点亮。
- "图层"菜单可单独开关建筑/道路/植被/水体/运动场/标注/校界/路灯等；同菜单内的"细节"下拉可切换简约/标准/丰富三档程序化细节密度（详见上文"程序化视觉细节"）。
- "截图"导出带 `© OpenStreetMap contributors` 署名的 PNG。

### 模块二：四足机器人巡检
- 3 台仿真四足机器人沿校园真实坐标路线巡逻，状态机：巡检中 → 检测中 → 返航 → 充电中。
- 点击场景中的机器人或右侧列表切换选中，再点一次开启跟随视角。
- 检测点位按概率生成巡检事件（消防通道占用/门窗未关闭/设备温度异常等），底部滚动条与右侧事件流实时更新（WebSocket）。
- "下发巡检 / 全员暂停"调用后端任务接口。

### 模块三：VRPTW 车辆路径规划
- 10 个配送任务点直接使用真实地标坐标，3 辆车、容量 + 时间窗 + 服务时长约束。
- 点击"求解最优路径"调用后端求解，路线以彩色管道回写 3D 场景，配送站位于南门。
- 底部时间轴播放器（播放/暂停、4×/8×/16× 倍速、拖动）按时刻驱动车辆沿曲线行驶；到站服务有脉冲指示。
- 右侧显示每辆车的甘特图：时间窗（底色块）、到达时刻（刻度）、当前时间（红线）。

- 顶部支持标注和夜景切换；原始根目录 `index.html` 保留为离线视觉参考入口。

## 后续替换真实资源

- 将校园 GLB/GLTF 放入 `public/models`，在 `CampusScene` 中接入 `GLTFLoader`。
- 在 `/api/campus/config` 配置真实原点、模型清单和高德/天地图瓦片 Key。
- 将 `RobotSimulator` 替换为 ROS/ROS2 边缘网关适配器。
- 将示例 VRPTW 输入替换为业务订单/配送任务数据。
