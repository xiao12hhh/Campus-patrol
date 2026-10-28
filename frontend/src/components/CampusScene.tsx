import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LocalFeature, Landmark, TOUR_ORDER, labelRank, CATEGORY_COLOR, ringOf } from '../lib/campus';
import { Robot, RobotEvent, VehicleRoute, RouteStop } from '../lib/api';
import * as B from './scene/builders';
import { buildBuildingsDetailed, SharedMats } from './scene/roofkit';
import { buildRoadsPaved, buildRoadside, buildGroundCoverPaved } from './scene/paving';
import { DETAIL_PRESETS, DetailLevel, newBudget, SceneBudget } from './scene/detailcfg';
import { loadTreeTextures, buildTrees as buildTreesPBR } from './scene/trees';
import { TileGround, makeMapLabelSprite, makeFootprintHighlight, MAP_BG } from './scene/tileground';

export type ViewPreset = 'overview' | 'front' | 'top' | 'close';
export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
/** 地图模式 = 官方手绘瓦片地面（观感对齐 map.cup.edu.cn）；孪生模式 = 程序化三维建筑 */
export type ViewMode = 'map' | 'twin';
export type LayerKey =
  | 'buildings' | 'roads' | 'water' | 'pitches' | 'trees' | 'green' | 'parking'
  | 'labels' | 'boundary' | 'robots' | 'routes' | 'lamps';

export interface SceneHandle {
  flyToLandmark(l: Landmark, preset?: ViewPreset): void;
  flyToXY(x: number, z: number, preset?: ViewPreset): void;
  flyToArea(pts: Array<{ x: number; z: number }>): void;
  resetView(): void;
  zoomIn(): void;
  zoomOut(): void;
  toggleLabels(): void;
  fullscreen(): void;
  /** 当前相机位姿，用于生成分享链接 */
  getCameraState(): { pos: number[]; target: number[] };
  /** 直接落位到分享链接里的位姿（不做补间） */
  setCameraState(s: { pos: number[]; target: number[] }): void;
  setQuality(q: Quality): void;
  setAutoQuality(on: boolean): void;
  tour(cmd: 'start' | 'pause' | 'resume' | 'skip' | 'stop'): void;
  screenshot(): void;
}

export const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  buildings: true, roads: true, water: true, pitches: true, trees: true,
  green: true, parking: true,
  labels: true, boundary: true, robots: true, routes: true, lamps: true,
};

interface Props {
  features: LocalFeature[];
  landmarks: Landmark[];
  /** 校区边界环（局部坐标）：v3 起为北 / 南 / 东三校区展开后的环列表 */
  campusRings?: number[][][];
  robots: Robot[];
  events: RobotEvent[];
  routes: VehicleRoute[];
  vrptwClock: number;
  followRobotId: string | null;
  /** 第一人称：跟随视角换成狗头视角（需同时打开 followRobotId） */
  firstPerson?: boolean;
  /** 「点图加点」模式：点击地面即回调坐标，用来快速给任务队列加路点 */
  addPointMode?: boolean;
  onPickPoint?(x: number, z: number): void;
  tod: TimeOfDay;
  layers: Record<LayerKey, boolean>;
  /** 程序化细节密度：决定屋顶设备 / 立面附件 / 路边设施的数量 */
  detail: DetailLevel;
  /** 地图（官方瓦片） / 三维孪生 视图 */
  viewMode: ViewMode;
  /** 当前选中的地标（map 模式下显示轮廓高亮） */
  selectedLandmark: Landmark | null;
  onPickRobot?(id: string): void;
  onPickLandmark?(l: Landmark): void;
  onToggleLayer?(key: LayerKey, visible: boolean): void;
  onTourStation?(index: number, total: number, name: string): void;
  onTourEnd?(): void;
  /** 自动画质升降档时回传给界面，用于显示当前档位 */
  onQualityChange?(q: Quality): void;
  /** 显式取景框（三校区合并范围），缺省时按全部要素自动取景 */
  focusBox?: FocusBox;
  /**
   * 分享链接里的机位（URL ?cam=）。场景内所有"自动取景"（静态几何重建 / 瓦片就绪 /
   * 切视图模式）都要让位给它，否则链接里的视角会被 fitCampus 覆盖掉。
   * 用户一旦自己拖动相机就作废（见 controls 'start' 监听）。
   */
  initialCam?: { pos: number[]; target: number[] } | null;
}

// ---------------------------------------------------------------- 时空氛围
/** 第三人称基准 FOV；第一人称切到 72 广角 */
const BASE_FOV = 45;

const TODS: Record<TimeOfDay, {
  skyTop: string; skyBottom: string; fog: string; ground: string;
  sun: { color: number; intensity: number; pos: [number, number, number] };
  hemi: [number, number, number]; ambient: [number, number];
  windows: number; lamps: boolean;
  /** 地图模式给瓦片乘的染色（官方瓦片是白天画的，夜晚需要压暗） */
  mapTint: number;
}> = {
  dawn: {
    skyTop: '#6f9cc9', skyBottom: '#f6c9a0', fog: '#e3c4a4', ground: '#a9b29c',
    sun: { color: 0xffc9a0, intensity: 2.4, pos: [-70, 26, 45] },
    hemi: [0xcfe4ff, 0x9aa08a, 1.25], ambient: [0x8a8078, 0.6], windows: 0.35, lamps: false,
    mapTint: 0xf2dfc4,
  },
  day: {
    skyTop: '#8fc4e3', skyBottom: '#e9f2ef', fog: '#d9e7e1', ground: '#a5b29c',
    sun: { color: 0xffffff, intensity: 2.9, pos: [45, 85, 35] },
    hemi: [0xbfd9ff, 0x6a7a5f, 1.15], ambient: [0x8a97a3, 0.35], windows: 0, lamps: false,
    mapTint: 0xffffff,
  },
  dusk: {
    skyTop: '#37456f', skyBottom: '#f0a060', fog: '#c9a081', ground: '#8a9679',
    sun: { color: 0xff9a5a, intensity: 2.1, pos: [-85, 15, -25] },
    hemi: [0x9fb0d9, 0x6f6558, 1.0], ambient: [0x6a5c58, 0.55], windows: 0.85, lamps: true,
    mapTint: 0xd8b898,
  },
  night: {
    skyTop: '#050c18', skyBottom: '#0d2136', fog: '#0a1622', ground: '#1e2d27',
    sun: { color: 0x8fb4d9, intensity: 0.85, pos: [-40, 60, -25] },
    hemi: [0x2a4560, 0x0c141c, 0.5], ambient: [0x1a2635, 0.5], windows: 1.0, lamps: true,
    mapTint: 0x5d7086,
  },
};

const ROBOT_COLORS = [0xffb14e, 0x4fe19b, 0x6ea8ff, 0xd78cff, 0xff8a65];
const VEHICLE_COLORS = [0xffbd5a, 0x4e83ff, 0x4fe19b, 0xd78cff, 0xff8a65];
const ROBOT_PHASES = [0, Math.PI, Math.PI, 0];
const TRAIL_MAX = 150; // 机器人轨迹点容量
/** 轨迹带宽（单位，半宽）：0.16 → 3.2 m，贴地视角也能一眼看见走过的路 */
const TRAIL_HALF_W = 0.16;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const mm = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/**
 * 把一串世界坐标点做成贴地的带状网格。
 * WebGL 里 LineBasicMaterial 的 linewidth 恒为 1px，贴地视角看路线细到几乎看不见，
 * 所以路线/轨迹一律用带状三角网画（宽度按世界单位给）。
 */
function makeGroundRibbon(pts: THREE.Vector3[], width: number, color: number, opacity: number) {
  const hw = width / 2;
  const pos: number[] = [];
  const idx: number[] = [];
  const n = pts.length;
  for (let k = 0; k < n; k += 1) {
    const a = pts[k];
    const nxt = pts[Math.min(k + 1, n - 1)];
    const prv = pts[Math.max(k - 1, 0)];
    let dx = nxt.x - prv.x, dz = nxt.z - prv.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
    const nx = -dz * hw, nz = dx * hw;
    pos.push(a.x + nx, 0.13, a.z + nz, a.x - nx, 0.13, a.z - nz);
  }
  for (let k = 0; k < n - 1; k += 1) {
    const a = k * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return mesh;
}

interface RobotVis {
  id: string; group: THREE.Group; parts: B.QuadrupedParts; label: THREE.Sprite;
  /** 已走过的轨迹：贴地带状网格（LW 用线在 WebGL 里最细 1px，贴地视角根本看不清） */
  trail: THREE.Mesh; trailPts: THREE.Vector3[]; lastTrail: THREE.Vector3;
  ring: THREE.Mesh;
  cur: THREE.Vector3; target: THREE.Vector3; prev: THREE.Vector3;
  heading: number; targetHeading: number;
  routeLine: THREE.Line | null;
  pathRibbon: THREE.Mesh | null;
  pathSig: string;
  /** 自定义任务队列的可视化（队列点连线 + 编号立柱），签名不变就不重建 */
  queueGroup: THREE.Group | null; queuePins: THREE.Mesh[]; queuePads: THREE.Mesh[];
  queueSig: string; queueIndex: number;
}

interface AlertVis { group: THREE.Group; ring: THREE.Mesh; born: number; level: string }

interface RouteVis {
  vehicleId: string; color: number;
  curve: THREE.CatmullRomCurve3; tParams: number[];
  stops: Array<{ stop: RouteStop; pos: THREE.Vector3; pin: THREE.Group; ring: THREE.Mesh; dot: THREE.Mesh }>;
  schedule: Array<{ depart: number; arrive: number; end: number }>;
  van: THREE.Group; vanTarget: THREE.Vector3; vanYaw: number; servingIdx: number;
}

interface LabelEntry {
  sprite: THREE.Sprite;
  /** 0=总览可见 1=中距离 2=贴近才显示 */
  rank: number;
  world: THREE.Vector3;
  /** 创建时的世界尺寸，每帧据此重算，避免下限缩放被反复叠加 */
  base: { x: number; y: number };
}

/** 标牌在屏幕上的最小高度（px）。低于此值就放大到下限，否则总览时只有 6px 根本看不清。 */
const LABEL_MIN_PX = 11;
/** 标牌屏幕高度上限（像素）：近处不糊脸 */
const LABEL_MAX_PX = 78;

interface TourState {
  active: boolean; paused: boolean; index: number; phase: 'fly' | 'hold'; phaseT: number;
  fromPos: THREE.Vector3; toPos: THREE.Vector3;
  fromTarget: THREE.Vector3; toTarget: THREE.Vector3;
  holdAngle: number; holdRadius: number; holdY: number;
}

/** 画质档位：高 = 阴影 1024 + 全植被 + DPR2；中 = 阴影 512 + DPR1；低 = 关阴影 + 半数植被 + DPR1 */
export type Quality = 'high' | 'medium' | 'low';
export const QUALITY_LABEL: Record<Quality, string> = { high: '高', medium: '中', low: '低' };
const QUALITY_ORDER: Quality[] = ['low', 'medium', 'high'];

/**
 * 距离 LOD 阈值 —— 单位与 campus-local.json 一致（1 单位 = 10 m）。
 * kits（屋顶设备 / 立面挂机 / 雨水管）在 1.3 km 外基本看不见，roadside（路缘石 / 井盖）更近才值；
 * 关掉它们不影响轮廓与体块，远景依旧清晰。
 */
const LOD_KIT_D = 130;
const LOD_ROADSIDE_D = 85;

function applyLod(E: Engine, layers: Record<LayerKey, boolean>) {
  const d = E.camera.position.distanceTo(E.controls.target);
  const lowish = E.quality === 'low';
  if (E.kit) E.kit.visible = !!layers.buildings && !lowish && d < LOD_KIT_D;
  if (E.roadside) E.roadside.visible = !!layers.roads && !lowish && d < LOD_ROADSIDE_D;
}

/** 应用画质档位。降级顺序：先砍阴影分辨率 → 再关阴影并减半植被 → 同时压 DPR */
function applyQuality(E: Engine, q: Quality) {
  E.quality = q;
  const r = E.renderer;
  const wantSize = q === 'high' ? 1024 : 512;
  if (q === 'high') {
    r.shadowMap.enabled = true;
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  } else if (q === 'medium') {
    r.shadowMap.enabled = true;
    r.setPixelRatio(1);
  } else {
    r.shadowMap.enabled = false;
    r.setPixelRatio(1);
  }
  // 只在阴影图尺寸真的变化时重建贴图（原来每次都 dispose，切换档位会卡一下）
  if (r.shadowMap.enabled && E.sun.shadow.mapSize.x !== wantSize) {
    E.sun.shadow.mapSize.set(wantSize, wantSize);
    const sm = E.sun.shadow.map;
    if (sm) sm.dispose();
    (E.sun.shadow as unknown as { map: unknown }).map = null;
    r.shadowMap.needsUpdate = true;
  }
  // 植被密度：低档隐藏一半（按索引奇偶，保证空间上均匀变稀而不是整片消失）
  E.groups.trees.children.forEach((m, i) => { m.visible = q === 'low' ? i % 2 === 0 : true; });
  // 低画质直接砍掉屋顶设备与路边设施，本帧即可生效，细节 LOD 随后每 0.4 s 复核一次
  if (E.kit && q === 'low') E.kit.visible = false;
  if (E.roadside && q === 'low') E.roadside.visible = false;
  // 注意：这里不能再对全场景材质打 needsUpdate —— 那会强制所有着色器重新编译，
  // 一次几百毫秒，正是"退出第一人称/缩放回来时卡一下"的元凶。
}

interface Engine {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  controls: OrbitControls; sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight; ground: THREE.Mesh; skyMat: THREE.MeshBasicMaterial;
  groups: Record<LayerKey, THREE.Group>;
  facadeMats: THREE.MeshStandardMaterial[];
  lampsBulbs: THREE.InstancedMesh | null; lampGlow: THREE.Points | null;
  robots: Map<string, RobotVis>; robotGroup: THREE.Group;
  alerts: Map<string, AlertVis>; alertGroup: THREE.Group;
  vrptw: RouteVis[]; vrptwDepot: THREE.Group | null;
  tween: { t0: number; dur: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null;
  tour: TourState | null;
  home: { pos: THREE.Vector3; target: THREE.Vector3 } | null;
  followId: string | null;
  raycaster: THREE.Raycaster; pointer: THREE.Vector2;
  landmarks: Landmark[];
  /** 地标标牌：带显示等级，由 updateLabels 按缩放分级 + 屏幕空间避让 */
  labelEntries: LabelEntry[];
  lastFeatures: LocalFeature[] | null;
  /** 上次构建时的细节密度（换了就重建静态几何） */
  lastDetail: DetailLevel | null;
  /** 显式取景框（三校区边界合并后的范围），避免城市背景路网把镜头拉太远 */
  focus: { x0: number; x1: number; z0: number; z1: number } | null;
  /** 分享链接指定的机位：非空时所有自动取景（fitCampus / applyViewMode）都让位 */
  urlCam: { pos: THREE.Vector3; target: THREE.Vector3 } | null;
  /** 第一人称的自由视角偏移（拖拽累积，弧度）：yaw 绕竖轴、pitch 俯仰 */
  fpYaw: number; fpPitch: number;
  /** 画质档位：自动模式下由帧率统计驱动升降（见 applyQuality） */
  quality: Quality;
  autoQuality: boolean;
  fpsAcc: number; fpsFrames: number; lowStreak: number; highStreak: number; qualHold: number;
  frameNo: number;
  /** 程序化细节相关 */
  detail: DetailLevel;
  /** 屋顶设备 + 立面附件（距离 LOD 目标） */
  kit: THREE.Group | null;
  /** 路缘石 + 井盖（距离 LOD 目标） */
  roadside: THREE.Group | null;
  shared: SharedMats | null;
  budget: SceneBudget;
  lodAcc: number;
  /** 宇树 B2 模型原型（异步加载，未就绪/失败时为 null → 回退程序化机器人） */
  dogProto: B.DogProto | null;
  /** loading = GLB 还在拉取（此间不创建机器人，避免建出降级版后无法替换） */
  dogState: 'loading' | 'ok' | 'fail';
  /** 树的 PBR 贴图（异步加载；为 null 时回退旧的程序化方块树） */
  treeTex: Awaited<ReturnType<typeof loadTreeTextures>>;
  treeState: 'loading' | 'ok' | 'fail';
  /** 官方瓦片地面（地图模式） */
  tiles: TileGround;
  /** 当前视图模式 */
  viewMode: ViewMode;
  /** 选中地标的轮廓高亮（map 模式） */
  highlight: THREE.LineLoop | null;
  /** 地面拾取平面（y=0，map 模式下做点选建筑的点在多边形判定） */
  pickPlane: THREE.Plane;
  dispose(): void;
}

/** 真模型的腿比程序化方块长，摆幅要收一收，否则脚会扫进地面 */
const DOG_GAIT = { hip: 0.22, knee: 0.42 };
const GAIT_FALLBACK = { hip: 0.38, knee: 0.55 };

export interface FocusBox { x0: number; x1: number; z0: number; z1: number }

function poseFor(x: number, z: number, h: number, preset: ViewPreset) {
  const vh = B.visualHeight(h);
  const target = B.W(x, vh * 0.45, z);
  let pos: THREE.Vector3;
  switch (preset) {
    // 数据 z 为南，故相机站在目标南侧（z 更大）向北看
    case 'front': pos = B.W(x, vh * 0.7 + 5, z + Math.max(14, vh * 2.2)); break;
    case 'top': pos = B.W(x, Math.max(42, vh * 9), z + 2); break;
    case 'close': pos = B.W(x + 5.5, vh * 0.9 + 1.5, z + 8.5); break;
    default: pos = B.W(x + 16, vh * 4.2 + 6, z + 18);
  }
  return { pos, target };
}

/**
 * 计算把 box 完整装进视锥所需的相机距离（沿 dir 方向从中心后撤）。
 * 对每个包围盒角点求解 d >= |横向偏移| / tan(半视角) + 沿视线方向的投影，取最大值。
 */
function fitDistance(box: THREE.Box3, dir: THREE.Vector3, tanV: number, tanH: number) {
  const target = box.getCenter(new THREE.Vector3());
  const forward = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const v = new THREE.Vector3();
  let d = 1;
  for (let i = 0; i < 8; i++) {
    v.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).sub(target);
    const along = v.dot(dir);
    d = Math.max(d, Math.abs(v.dot(right)) / tanH + along, Math.abs(v.dot(up)) / tanV + along);
  }
  return { dist: d, target };
}

// 默认俯视方向：东南方上空 40° 仰角（x 东、z 南）
const HOME_DIR = new THREE.Vector3(0.542, 0.643, 0.542).normalize();
// 地图模式默认视角：官方地图是"从南侧看"的 2.5D 手绘，相机从南偏东抬起，
// 瓦片上画的建筑立面（朝南）正对镜头，观感与官方截图一致。
const MAP_HOME_DIR = new THREE.Vector3(0.1, 0.77, 0.63).normalize();
/** 地图模式下隐藏的程序化图层（瓦片里都已画好，叠上去反而穿帮） */
const HIDDEN_IN_MAP: LayerKey[] = ['buildings', 'roads', 'water', 'pitches', 'trees', 'green', 'parking', 'lamps', 'boundary'];

/** 简单点在多边形（射线法），map 模式地面点选建筑用。 */
function pointInRing(x: number, z: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 依据真实校园包围盒设定地面尺寸、雾、阴影范围与默认机位，避免手调机位跑偏 */
function fitCampus(E: Engine, immediate: boolean) {
  const mapMode = E.viewMode === 'map' && E.tiles.ready;
  const box = new THREE.Box3();
  for (const k of ['buildings', 'roads', 'water', 'pitches', 'green', 'parking', 'boundary'] as LayerKey[]) {
    if (E.groups[k].children.length) box.expandByObject(E.groups[k]);
  }
  if (box.isEmpty() || !isFinite(box.min.x)) {
    box.setFromCenterAndSize(new THREE.Vector3(0, 4, 0), new THREE.Vector3(120, 8, 90));
  }
  // 有显式取景框时，用它收敛水平范围：OSM 的城市背景路网会延伸出校园很远，
  // 直接按全部要素取景会让三个校区缩成很小一块。
  if (E.focus) {
    const f = E.focus;
    box.min.set(f.x0, 0, f.z0);
    box.max.set(f.x1, Math.max(box.max.y, 6), f.z1);
  }
  if (mapMode) {
    // 地图模式的**取景框仍用内容框**（focus 框，上面已收敛）——
    // 瓦片框是 z16 粒度（每片 ≈ 467 m，全框 2.8 km），拿它取景会把 1 km 的
    // 校园挤成画面中央一小块。瓦片框只用于底板尺寸（tileground 内部）。
    // 这里只抬高视点下限，让 2.5D 手绘图的观感成立。
    box.min.y = 0; box.max.y = Math.max(box.max.y, 8);
  }
  const size = box.getSize(new THREE.Vector3());
  const radius = 0.5 * Math.hypot(size.x, size.z);

  // 地面：略大于校园，配合雾自然过渡到天空
  // 尺寸没变就不重建（resize 时每次都 dispose+new PlaneGeometry 会触发一次 GPU 重新上传）
  const gw = size.x + radius * 1.2;
  const gh = size.z + radius * 1.2;
  const prevSize = E.ground.geometry.userData.size as { w: number; h: number } | undefined;
  if (!prevSize || Math.abs(prevSize.w - gw) > 0.5 || Math.abs(prevSize.h - gh) > 0.5) {
    E.ground.geometry.dispose();
    E.ground.geometry = new THREE.PlaneGeometry(gw, gh);
    E.ground.geometry.userData.size = { w: gw, h: gh };
  }
  E.ground.position.set(box.getCenter(new THREE.Vector3()).x, 0, box.getCenter(new THREE.Vector3()).z);

  const fog = E.scene.fog as THREE.Fog;
  fog.near = radius * (mapMode ? 2.4 : 1.95);
  fog.far = radius * (mapMode ? 7.5 : 8.0);

  const sc = E.sun.shadow.camera;
  sc.left = -radius * 1.1; sc.right = radius * 1.1;
  sc.top = radius * 1.1; sc.bottom = -radius * 1.1;
  sc.near = 1; sc.far = radius * 6;
  sc.updateProjectionMatrix();
  const c = box.getCenter(new THREE.Vector3());
  E.sun.position.set(c.x + radius * 0.55, radius * 1.25, c.z + radius * 0.45);

  const tanV = Math.tan((E.camera.fov * Math.PI) / 360);
  const tanH = tanV * Math.max(0.45, E.camera.aspect);
  const dir = mapMode ? MAP_HOME_DIR : HOME_DIR;
  const { dist, target } = fitDistance(box, dir, tanV, tanH);
  // 地图模式再拉近 8%：fitDistance 是"刚好装下"的距离，官方地图的观感更满一些
  // 三维孪生模式贴近一些（原来 1.04 太远，首屏核心区糊成一块）；地图模式保持官方观感
  const pos = target.clone().add(dir.clone().multiplyScalar(dist * (mapMode ? 0.74 : 0.80)));
  E.home = { pos, target: target.clone() };
  E.controls.minDistance = 3;
  E.controls.maxDistance = dist * 2.6;
  if (immediate) {
    // 分享链接给了机位就落位到它，别用自动取景覆盖（否则链接打开后视角会被重置）
    if (E.urlCam) {
      E.camera.position.copy(E.urlCam.pos);
      E.controls.target.copy(E.urlCam.target);
    } else {
      E.camera.position.copy(pos);
      E.controls.target.copy(target);
    }
    E.controls.update();
  }
}

/**
 * 标牌去重：按显示等级 + 相机距离决定候选集，再做屏幕空间 AABB 避让。
 * 全校 90+ 个标牌一次性全显会叠成 4 层，这里保证任意两个标牌的屏幕矩形不重叠。
 */
function updateLabels(E: Engine) {
  const g = E.groups.labels;
  if (!g.visible) return;
  const list = E.labelEntries;
  if (!list.length) return;

  const cam = E.camera;
  // 镜头离目标越远，能显示的等级越少
  const dist = cam.position.distanceTo(E.controls.target);
  const maxRank = dist > 110 ? 0 : dist > 42 ? 1 : 2;

  const tanV = Math.tan((cam.fov * Math.PI) / 360);
  const aspect = Math.max(0.45, cam.aspect);
  // 排序：重要等级优先占位，同级则离相机近的优先
  const order = list.map((e, i) => ({ i, r: e.rank, d: cam.position.distanceTo(e.world) }));
  order.sort((a, b) => a.r - b.r || a.d - b.d);

  const v = new THREE.Vector3();
  const rects: number[] = []; // 已占位的屏幕矩形，扁平存 [x0,y0,x1,y1,...]（NDC 坐标）
  // 屏幕最小高度对应的 NDC 半高：低于它就等比放大，保证远处也读得出来
  const viewH = E.renderer.domElement.clientHeight || E.renderer.domElement.height || 700;
  const minHalf = LABEL_MIN_PX / viewH;
  const maxHalf = LABEL_MAX_PX / viewH;

  for (const o of order) {
    const e = list[o.i];
    if (e.rank > maxRank) { e.sprite.visible = false; continue; }
    e.sprite.scale.set(e.base.x, e.base.y, 1);
    v.copy(e.world).project(cam);
    // 在相机背后或超出视锥的直接跳过
    if (v.z > 1 || v.z < -1) { e.sprite.visible = false; continue; }
    const d = Math.max(0.001, cam.position.distanceTo(e.world));
    let hw = e.base.x / (2 * d * tanV * aspect);
    let hh = e.base.y / (2 * d * tanV);
    if (hh < minHalf) {
      const f = minHalf / hh;
      hw *= f; hh = minHalf;
      e.sprite.scale.set(e.base.x * f, e.base.y * f, 1);
    }
    // 近处标牌不许糊脸：屏幕占比超过上限就等比缩小（第一人称贴地看时尤其明显）
    if (hh > maxHalf) {
      const f = maxHalf / hh;
      hw *= f; hh = maxHalf;
      e.sprite.scale.set(e.base.x * f, e.base.y * f, 1);
    }
    // 相邻标牌留一点呼吸空间，避免密密麻麻贴在一起
    hw *= 1.15; hh *= 1.6;
    const x0 = v.x - hw, x1 = v.x + hw, y0 = v.y - hh, y1 = v.y + hh;
    // 完全在画面外的不参与占位
    if (x1 < -1.02 || x0 > 1.02 || y1 < -1.02 || y0 > 1.02) { e.sprite.visible = false; continue; }
    let clash = false;
    for (let k = 0; k < rects.length; k += 4) {
      if (x0 < rects[k + 2] && rects[k] < x1 && y0 < rects[k + 3] && rects[k + 1] < y1) { clash = true; break; }
    }
    if (clash) { e.sprite.visible = false; continue; }
    e.sprite.visible = true;
    rects.push(x0, y0, x1, y1);
  }
}

/**
 * 重建地标标牌。两种模式各用一套样式：
 *  map  = 官方地图白底气泡（圆点 + 深灰字），浮在瓦片上画的建筑上方；
 *  twin = 原半透明样式，立在三维护顶上。
 */
function rebuildLabels(E: Engine, landmarks: Landmark[], layers: Record<LayerKey, boolean>) {
  disposeGroupChildren(E.groups.labels);
  E.labelEntries = [];
  for (const l of landmarks) {
    const sprite = E.viewMode === 'map'
      ? makeMapLabelSprite(l.name, CATEGORY_COLOR[l.category] ?? 0x4a90d9)
      : B.makeLabelSprite(l.name);
    const y = E.viewMode === 'map'
      ? 0.9 + Math.min(2.0, B.visualHeight(l.height || 2) * 0.32)   // 贴着瓦片上画的建筑顶
      : B.visualHeight(l.height || 2) + 1.2;
    const world = B.W(l.x, y, l.z);
    sprite.position.copy(world);
    sprite.visible = false; // 由 updateLabels 按等级与重叠情况决定
    E.labelEntries.push({
      sprite, rank: labelRank(l), world: world.clone(),
      base: { x: sprite.scale.x, y: sprite.scale.y },
    });
    E.groups.labels.add(sprite);
  }
  E.groups.labels.visible = layers.labels;
}

/** 应用视图模式：瓦片地面 / 程序化三维场景 的可见性与相机约束切换。 */
function applyViewMode(E: Engine, mode: ViewMode, layers: Record<LayerKey, boolean>) {
  E.viewMode = mode;
  const map = mode === 'map';
  if (E.tiles.ready) E.tiles.setMode(map);
  E.ground.visible = !map || !E.tiles.ready;
  for (const k of HIDDEN_IN_MAP) E.groups[k].visible = map ? false : layers[k];
  // 相机约束：地图是平贴瓦片，压低最大俯角避免"纸片"感；孪生模式恢复自由
  E.controls.maxPolarAngle = map ? THREE.MathUtils.degToRad(76) : Math.PI / 2.05;
  if (E.landmarks.length) rebuildLabels(E, E.landmarks, layers);
  // 两种模式取景范围不同（map 用瓦片框、twin 用校园框），必须重算 home
  fitCampus(E, false);
  if (E.urlCam) {
    // 分享链接指定了机位：落位到链接机位，不要补间回当前模式的默认机位
    E.tween = {
      t0: performance.now() / 1000, dur: 1.2,
      fromPos: E.camera.position.clone(), toPos: E.urlCam.pos.clone(),
      fromTarget: E.controls.target.clone(), toTarget: E.urlCam.target.clone(),
    };
  } else if (E.home) {
    // 并把相机补间落位到当前模式的机位 —— 不落位的话相机还停在另一个模式的
    // 远机位上：孪生模式会看到取景框外的城市建筑 + 被雾吞掉的地面（"浮空黑块"）
    E.tween = {
      t0: performance.now() / 1000, dur: 1.2,
      fromPos: E.camera.position.clone(), toPos: E.home.pos.clone(),
      fromTarget: E.controls.target.clone(), toTarget: E.home.target.clone(),
    };
  }
  if (map && E.tiles.ready) E.tiles.update(E.camera, performance.now() / 1000, true);
}

function disposeDeep(root: THREE.Object3D) {
  root.traverse(o => {
    const any = o as any;
    // 机器人共用同一份宇树 B2 几何/材质，销毁单台时不能把它们 dispose 掉
    if (any.geometry && !any.geometry.userData?.shared) any.geometry.dispose();
    if (any.material) {
      const mats = Array.isArray(any.material) ? any.material : [any.material];
      mats.forEach((m: any) => {
        if (m.userData?.shared) return;
        if (m.map) m.map.dispose();
        if (m.emissiveMap) m.emissiveMap.dispose();
        m.dispose();
      });
    }
  });
}

function disposeGroupChildren(g: THREE.Group) {
  disposeDeep(g);
  g.clear();
}

// ---------------------------------------------------------------- 组件
const CampusScene = forwardRef<SceneHandle, Props>(function CampusScene(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const eng = useRef<Engine | null>(null);
  const cb = useRef(props);
  cb.current = props;
  // 取景框用 ref 持有：fitCampus 在初始化 useEffect 里同步读取，不能依赖渲染时序
  const focusRef = useRef<FocusBox | null>(props.focusBox ?? null);
  focusRef.current = props.focusBox ?? null;
  // 细节密度同理要走 ref：挂载时的 useEffect 只在组件创建时跑一次
  const detailRef = useRef<DetailLevel>(props.detail ?? 'standard');
  detailRef.current = props.detail ?? 'standard';
  // 机器狗 GLB 是异步加载的，加载完 +1 触发机器人重建（否则要等下一次 robots 推送）
  const [dogReady, setDogReady] = useState(0);
  // 树贴图同理，加载完 +1 触发静态几何重建
  const [treeReady, setTreeReady] = useState(0);
  // 官方瓦片清单同理，就绪后按地图模式重挂视图 + 触发一次取景
  const [tilesReady, setTilesReady] = useState(0);

  // ------------------------------------------------ 挂载：渲染器 / 相机 / 灯光 / 循环
  useEffect(() => {
    const el = hostRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#d9e7e1');
    scene.fog = new THREE.Fog('#d9e7e1', 150, 620);

    const camera = new THREE.PerspectiveCamera(BASE_FOV, el.clientWidth / Math.max(1, el.clientHeight), 0.1, 3000);
    camera.position.set(70, 78, 62); // 占位，真实校园加载后由 fitCampus 自动取景
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(el.clientWidth, Math.max(1, el.clientHeight));
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // 阴影隔帧更新（见渲染循环）：阴影几乎只随太阳与机器人变化，每帧重算全场景投影是最大的一笔固定开销
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    el.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 3; controls.maxDistance = 400;
    controls.screenSpacePanning = false;
    controls.target.set(7, 0, 0); // 占位，fitCampus 会覆盖
    // 用户一旦自己动相机，分享链接里的机位就作废（之后各模式的自动取景恢复正常）
    controls.addEventListener('start', () => { if (eng.current) eng.current.urlCam = null; });

    const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x6a7a5f, 1.15);
    const ambient = new THREE.AmbientLight(0x8a97a3, 0.35);
    const sun = new THREE.DirectionalLight(0xffffff, 2.9);
    sun.position.set(45, 85, 35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 10, far: 320 });
    scene.add(hemi, ambient, sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 160),
      new THREE.MeshStandardMaterial({ color: '#a9c78f', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const skyMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 24, 12), skyMat);
    sky.renderOrder = -10;
    scene.add(sky);

    const groups = {} as Record<LayerKey, THREE.Group>;
    (Object.keys(DEFAULT_LAYERS) as LayerKey[]).forEach(k => {
      groups[k] = new THREE.Group();
      scene.add(groups[k]);
    });

    const robotGroup = groups.robots;
    const alertGroup = new THREE.Group();
    scene.add(alertGroup);

    const engine: Engine = {
      renderer, scene, camera, controls, sun, hemi, ambient, ground, skyMat,
      groups, facadeMats: [], lampsBulbs: null, lampGlow: null,
      robots: new Map(), robotGroup, alerts: new Map(), alertGroup,
      vrptw: [], vrptwDepot: null, tween: null, tour: null, home: null, followId: null,
      raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(),
      landmarks: [], labelEntries: [], lastFeatures: null, lastDetail: null, focus: focusRef.current,
      urlCam: null,
    fpYaw: 0, fpPitch: 0,
      quality: 'high', autoQuality: true,
      detail: detailRef.current,
      kit: null, roadside: null, shared: null, budget: newBudget(), lodAcc: 0,
      fpsAcc: 0, fpsFrames: 0, lowStreak: 0, highStreak: 0, qualHold: 0, frameNo: 0,
      dogProto: null,
      dogState: 'loading',
      treeTex: null,
      treeState: 'loading',
      tiles: new TileGround(),
      viewMode: (cb.current.viewMode as ViewMode) || 'map',
      highlight: null,
      pickPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      dispose() {
        engine.shared?.dispose();
        engine.tiles.dispose();
        scene.remove(engine.tiles.group);
        controls.dispose();
        disposeDeep(scene);
        renderer.dispose();
        if (renderer.domElement.parentElement === el) el.removeChild(renderer.domElement);
      },
    };
    eng.current = engine;
    // 调试出口（自动化验证用）：在控制台/CDP 里读相机、跟随与机器狗的真实状态
    (window as unknown as Record<string, unknown>).__scene_debug = {
      cam: () => engine.camera.position.toArray().map(n => +n.toFixed(2)),
      tgt: () => engine.controls.target.toArray().map(n => +n.toFixed(2)),
      follow: () => engine.followId,
      fp: () => cb.current.firstPerson,
      dogState: () => engine.dogState,
      robots: () => Array.from(engine.robots.entries())
        .map(([id, r]) => [id, r.group.position.toArray().map(n => +n.toFixed(2))]),
      controls: () => engine.controls.enabled,
    };
    scene.add(engine.tiles.group);

    // ---- 官方瓦片：异步加载清单与网格，就绪后按当前模式挂载并触发一次取景
    let tilesAlive = true;
    engine.tiles.load().then(() => {
      if (!tilesAlive || !eng.current) return;
      applyViewMode(engine, cb.current.viewMode, cb.current.layers);
      setTilesReady((v) => v + 1);
    }).catch((err) => {
      // 清单拉不到（离线 / 未构建）时保持三维孪生视图可用
      console.warn('[tiles] 官方瓦片清单加载失败，保持三维视图', err);
    });

    // ---- 机器狗真模型：异步加载，完成后触发机器人重建（失败时自动回退程序化版本）
    let dogAlive = true;
    B.loadDogProto().then((p) => {
      if (!dogAlive || !eng.current) return;
      eng.current.dogProto = p;
      eng.current.dogState = p ? 'ok' : 'fail';
      setDogReady((v) => v + 1);
    });

    // ---- 树的 PBR 贴图：异步加载，完成后重建静态几何
    let treeAlive = true;
    loadTreeTextures().then((t) => {
      if (!treeAlive || !eng.current) return;
      eng.current.treeTex = t;
      eng.current.treeState = t ? 'ok' : 'fail';
      setTreeReady((v) => v + 1);
    });

    // ---- 拾取（拖拽超过 6px 视为旋转，不触发点击）
    let downX = 0, downY = 0;
    let dragging = false;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX; downY = e.clientY;
      // 第一人称：按住左键拖拽 = 转头（OrbitControls 在此时是关的，不会抢事件）
      dragging = !!(cb.current.firstPerson && engine.followId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      engine.fpYaw -= (e.clientX - downX) * 0.004;
      engine.fpPitch = Math.max(-1.1, Math.min(1.1, engine.fpPitch - (e.clientY - downY) * 0.003));
      downX = e.clientX; downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (dragging) {
        dragging = false;
        return; // 转头结束不算点击
      }
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      engine.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      engine.raycaster.setFromCamera(engine.pointer, camera);
      // 机器人优先
      const robotHits = engine.raycaster.intersectObjects(robotGroup.children, true);
      for (const h of robotHits) {
        let o: THREE.Object3D | null = h.object;
        while (o && !o.userData.robotId) o = o.parent;
        if (o?.userData.robotId) { cb.current.onPickRobot?.(o.userData.robotId as string); return; }
      }
      // 「点图加点」优先于选建筑：取地面交点，交给上层加进任务队列
      if (cb.current.addPointMode) {
        const pt = engine.raycaster.ray.intersectPlane(engine.pickPlane, new THREE.Vector3());
        if (pt && Math.abs(pt.x) < 400 && Math.abs(pt.z) < 400) {
          cb.current.onPickPoint?.(pt.x, pt.z);
          return;
        }
      }
      if (engine.viewMode === 'map' && engine.tiles.ready) {
        // 地图模式：瓦片是平面，直接在地面上做"点在多边形"判定，比斜射 3D 体块更准
        const pt = engine.raycaster.ray.intersectPlane(engine.pickPlane, new THREE.Vector3());
        if (pt) {
          let best: Landmark | null = null;
          let bestArea = Infinity;
          const feats = engine.lastFeatures ?? [];
          for (const l of engine.landmarks) {
            const f = feats.find(q => q.id === l.id);
            if (!f) continue;
            const ring = ringOf(f);
            if (!ring || !pointInRing(pt.x, pt.z, ring)) continue;
            const a = l.area || 1;
            if (a < bestArea) { bestArea = a; best = l; }
          }
          if (best) { cb.current.onPickLandmark?.(best); return; }
        }
      } else {
        const bHits = engine.raycaster.intersectObjects(groups.buildings.children, true);
        for (const h of bHits) {
          const name = h.object.userData.landmarkName as string | undefined;
          if (!name) continue;
          const l = engine.landmarks.find(m => m.name === name);
          if (l) { cb.current.onPickLandmark?.(l); return; }
        }
      }
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup', onUp);
    // 用户接管视角时结束巡游
    const onUserInteract = () => {
      if (engine.tour?.active) {
        engine.tour = null;
        cb.current.onTourEnd?.();
      }
    };
    controls.addEventListener('start', onUserInteract);
    const onKey = (e: KeyboardEvent) => {
      if (!(cb.current.firstPerson && engine.followId)) return;
      if (e.key === 'r' || e.key === 'R') { engine.fpYaw = 0; engine.fpPitch = 0; }
      if (e.key === 'ArrowLeft') engine.fpYaw += 0.12;
      if (e.key === 'ArrowRight') engine.fpYaw -= 0.12;
      if (e.key === 'ArrowUp') engine.fpPitch = Math.min(1.1, engine.fpPitch + 0.08);
      if (e.key === 'ArrowDown') engine.fpPitch = Math.max(-1.1, engine.fpPitch - 0.08);
    };
    window.addEventListener('keydown', onKey);

    const ro = new ResizeObserver(() => {
      camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, Math.max(1, el.clientHeight));
      if (engine.home) fitCampus(engine, false); // 宽高比变化后重算默认机位
    });
    ro.observe(el);

    // ---- 渲染循环（three r186 已废弃 Clock，用 performance.now 自行计时）
    let raf = 0;
    let prevT = performance.now() / 1000;
    const tmp = new THREE.Vector3();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const nowT = performance.now() / 1000;
      const dt = Math.min(0.1, Math.max(1e-4, nowT - prevT));
      prevT = nowT;
      const t = nowT;
      const E = engine;

      // 阴影隔帧重算：投影贴图是每帧最贵的一笔（全场景 casters 再走一遍深度），
      // 而场景里只有机器狗在动，隔帧更新肉眼看不出来，帧耗时能降一大截。
      E.frameNo = (E.frameNo + 1) % 2;
      if (E.frameNo === 0) E.renderer.shadowMap.needsUpdate = true;

      // 自动画质：每秒统计一次帧率，连续偏低就降档、持续富余就升档。
      // 需要连续多次才动作，避免建筑加载等瞬时卡顿把画质误杀到最低。
      // 切档后 6 秒内不再动作：切档本身要重建阴影图，来回切会更卡。
      if (E.autoQuality) {
        if (E.qualHold > 0) E.qualHold = Math.max(0, E.qualHold - dt);
        E.fpsAcc += dt; E.fpsFrames++;
        if (E.fpsAcc >= 1) {
          const fps = E.fpsFrames / E.fpsAcc;
          E.fpsAcc = 0; E.fpsFrames = 0;
          const i = QUALITY_ORDER.indexOf(E.quality);
          if (fps < 30) { E.lowStreak++; E.highStreak = 0; }
          else if (fps > 55) { E.highStreak++; E.lowStreak = 0; }
          else { E.lowStreak = 0; E.highStreak = 0; }
          if (E.qualHold > 0) { E.lowStreak = 0; E.highStreak = 0; }
          else if (E.lowStreak >= 3 && i > 0) {
            applyQuality(E, QUALITY_ORDER[i - 1]); E.lowStreak = 0; E.qualHold = 6;
            cb.current.onQualityChange?.(QUALITY_ORDER[i - 1]);
          } else if (E.highStreak >= 5 && i < QUALITY_ORDER.length - 1) {
            applyQuality(E, QUALITY_ORDER[i + 1]); E.highStreak = 0; E.qualHold = 6;
            cb.current.onQualityChange?.(QUALITY_ORDER[i + 1]);
          }
        }
      }

      // 距离 LOD：屋顶设备 / 路边设施按相机距离开关，远景省下大量实例
      E.lodAcc += dt;
      if (E.lodAcc > 0.4) { E.lodAcc = 0; applyLod(E, cb.current.layers); }

      // 官方瓦片地面：按相机高度切层级 / 按需加载纹理
      if (E.viewMode === 'map') E.tiles.update(E.camera, t);

      // 相机补间（第一人称接管相机时让位，否则会把相机拽回去）
      const fpActive = !!(cb.current.firstPerson && E.followId);
      if (E.tween && !fpActive) {
        const u = clamp01((t - E.tween.t0) / E.tween.dur);
        const e2 = ease(u);
        camera.position.lerpVectors(E.tween.fromPos, E.tween.toPos, e2);
        E.controls.target.lerpVectors(E.tween.fromTarget, E.tween.toTarget, e2);
        if (u >= 1) E.tween = null;
      }

      // 自动巡游
      const tour = E.tour;
      if (tour?.active && !tour.paused && !E.tween && !fpActive) {
        tour.phaseT += dt;
        if (tour.phase === 'fly') {
          const u = clamp01(tour.phaseT / 2.6);
          const e2 = ease(u);
          camera.position.lerpVectors(tour.fromPos, tour.toPos, e2);
          E.controls.target.lerpVectors(tour.fromTarget, tour.toTarget, e2);
          if (u >= 1) {
            tour.phase = 'hold'; tour.phaseT = 0;
            tour.holdAngle = Math.atan2(camera.position.x - tour.toTarget.x, camera.position.z - tour.toTarget.z);
            tour.holdRadius = Math.hypot(camera.position.x - tour.toTarget.x, camera.position.z - tour.toTarget.z);
            tour.holdY = camera.position.y;
          }
        } else if (tour.phase === 'hold' && tour.phaseT > 6.5) {
          const stations = TOUR_ORDER.map(n => E.landmarks.find(l => l.name === n)).filter(Boolean) as Landmark[];
          tour.index++;
          if (tour.index >= stations.length) {
            E.tour = null;
            cb.current.onTourEnd?.();
          } else {
            enterStation(E, stations, tour.index);
          }
        } else if (tour.phase === 'hold') {
          const a = tour.holdAngle + tour.phaseT * 0.07;
          camera.position.set(
            tour.toTarget.x + Math.sin(a) * tour.holdRadius,
            tour.holdY,
            tour.toTarget.z + Math.cos(a) * tour.holdRadius);
        }
      }

      // 机器人：平滑运动 + 步态 + 轨迹
      for (const rv of E.robots.values()) {
        rv.cur.lerp(rv.target, 1 - Math.pow(0.0005, dt));
        const speed = rv.cur.distanceTo(rv.prev) / Math.max(dt, 1e-4);
        rv.prev.copy(rv.cur);
        rv.group.position.copy(rv.cur);
        let dh = rv.targetHeading - rv.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        rv.heading += dh * (1 - Math.pow(0.01, dt));
        rv.group.rotation.y = rv.heading;

        const amp = clamp01(speed / 0.25);
        const freq = 5 + speed * 9;
        const gait = rv.parts.body.userData.gait || GAIT_FALLBACK;
        rv.parts.legs.forEach((leg, i) => {
          const ph = ROBOT_PHASES[i];
          leg.hip.rotation.x = gait.hip * amp * Math.sin(t * freq + ph);
          leg.knee.rotation.x = gait.knee * amp * Math.max(0, Math.sin(t * freq + ph + Math.PI / 2));
        });
        const baseY = (rv.parts.body.userData.baseY as number) ?? 0.72;
        rv.parts.body.position.y = baseY + 0.035 * amp * Math.sin(2 * t * freq);
        rv.parts.lidar.rotation.y += dt * 5;

        if (rv.cur.distanceTo(rv.lastTrail) > 0.35) {
          rv.trailPts.push(rv.cur.clone());
          if (rv.trailPts.length > TRAIL_MAX) rv.trailPts.shift();
          const pts = rv.trailPts;
          const attr = rv.trail.geometry.attributes.position as THREE.BufferAttribute;
          const arr = attr.array as Float32Array;
          const hw = TRAIL_HALF_W;
          for (let k = 0; k < pts.length; k += 1) {
            const a = pts[k];
            const nxt = pts[Math.min(k + 1, pts.length - 1)];
            const prv = pts[Math.max(k - 1, 0)];
            let dx = nxt.x - prv.x, dz = nxt.z - prv.z;
            const len = Math.hypot(dx, dz);
            if (len < 1e-4) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
            const nx = -dz * hw, nz = dx * hw;
            const o = k * 6;
            arr[o] = a.x + nx; arr[o + 1] = 0.13; arr[o + 2] = a.z + nz;
            arr[o + 3] = a.x - nx; arr[o + 4] = 0.13; arr[o + 5] = a.z - nz;
          }
          attr.needsUpdate = true;
          rv.trail.geometry.setDrawRange(0, Math.max(0, (pts.length - 1) * 6));
          rv.lastTrail.copy(rv.cur);
        }
        const sel = E.followId === rv.id;
        rv.ring.visible = sel;
        if (sel) {
          const s = 1 + 0.12 * Math.sin(t * 4);
          rv.ring.scale.set(s, s, s);
        }
        // 第一人称时把狗本体藏掉，否则相机就贴在模型脸上（名牌是它的子物体一起藏）
        rv.parts.group.visible = !(sel && cb.current.firstPerson);
      }

      // 告警脉冲
      for (const av of E.alerts.values()) {
        const age = t - av.born;
        const s = 1 + 0.4 * Math.sin(t * 3.2);
        av.ring.scale.set(s, s, s);
        (av.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, 0.6 - age * 0.008);
        av.group.position.y = 0.16 + 0.05 * Math.sin(t * 2.5);
      }

      // VRPTW 车辆趋近
      for (const r of E.vrptw) {
        r.van.position.lerp(r.vanTarget, 1 - Math.pow(0.001, dt));
        let dy = r.vanYaw - r.van.rotation.y;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        r.van.rotation.y += dy * (1 - Math.pow(0.001, dt));
        if (r.servingIdx >= 0) {
          const ring = r.stops[r.servingIdx].ring;
          const s = 1 + 0.25 * Math.sin(t * 5);
          ring.scale.set(s, s, s);
        }
      }

      // 跟随 / 第一人称视角
      let firstPerson = false;
      if (E.followId) {
        const rv = E.robots.get(E.followId);
        // 模型还没加载好（软件渲染环境里 GLB 可能一直加载不出来）时，用遥测数据兜底，
        // 至少让第一人称/跟随还有东西可以跟，而不是点了没反应
        const fallback = rv ? null : (cb.current.robots || []).find(r => r.id === E.followId);
        if (rv || fallback) {
          const pos = rv ? rv.group.position : B.W(fallback!.x, 0, fallback!.z);
          const baseYaw = rv ? rv.group.rotation.y : -(fallback!.heading || 0);
          if (cb.current.firstPerson) {
            // 第一人称：相机放在狗头位置，视线方向 = 狗朝向 + 用户拖拽出来的 yaw/pitch 偏移
            firstPerson = true;
            const yaw = baseYaw + E.fpYaw;
            tmp.set(0, 0, -1).applyAxisAngle(Y_AXIS, yaw).normalize();
            const eye = pos.clone().addScaledVector(tmp, 0.3);
            // 眼高 0.3 单位 ≈ 3 m：狗模型缩到 0.42 后约 2.9 m 高，这个高度刚好在"头顶"
            eye.y += 0.3;
            // 离得远（刚进第一人称）直接吸附，慢机器上也不会"慢慢飘过去"
            const gapEye = camera.position.distanceTo(eye);
            camera.position.lerp(eye, gapEye > 2 ? 1 : 1 - Math.pow(1e-7, dt));
            const look = camera.position.clone().addScaledVector(tmp, 10);
            // pitch 用位移换算，10 单位远处抬升 tan(pitch)*10，视觉上线性好控制
            look.y += Math.tan(E.fpPitch) * 10;
            E.controls.target.copy(look);
            camera.lookAt(look);
            E.controls.enabled = false;
          } else {
            // 第三人称跟随：偏移量随狗模型一起缩小（原来按 7 m 高的狗定的 3.2/7.5）
            tmp.set(0, 1.15, 2.7).applyAxisAngle(Y_AXIS, baseYaw);
            const desired = pos.clone().add(tmp);
            // 距离太远（刚切进来/刚重建）直接吸附，否则缓动——避免和 controls.update() 拉锯导致永远跟不近
            const gap = camera.position.distanceTo(desired);
            camera.position.lerp(desired, gap > 6 ? 1 : 1 - Math.pow(0.002, dt));
            E.controls.target.lerp(pos.clone().add(new THREE.Vector3(0, 0.32, 0)), 1 - Math.pow(0.01, dt));
            E.controls.enabled = false;
          }
        } else E.controls.enabled = true;
      } else if (!E.controls.enabled) {
        E.controls.enabled = true;
      }

      // 第一人称用广角，退出时恢复；controls.update() 在第一人称下会跟 lookAt 抢相机，跳过
      const wantFov = firstPerson ? 72 : BASE_FOV;
      if (Math.abs(camera.fov - wantFov) > 0.05) {
        camera.fov = wantFov;
        camera.updateProjectionMatrix();
      }
      if (!firstPerson) E.controls.update();
      updateLabels(E);
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      dogAlive = false;
      treeAlive = false;
      tilesAlive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      controls.removeEventListener('start', onUserInteract);
      engine.dispose();
      eng.current = null;
    };
  }, []);

  function enterStation(E: Engine, stations: Landmark[], index: number) {
    const l = stations[index];
    const { pos, target } = poseFor(l.x, l.z, Math.max(1.2, l.height || 2), 'overview');
    if (!E.tour) {
      E.tour = {
        active: true, paused: false, index, phase: 'fly', phaseT: 0,
        fromPos: E.camera.position.clone(), toPos: pos,
        fromTarget: E.controls.target.clone(), toTarget: target,
        holdAngle: 0, holdRadius: 0, holdY: 0,
      };
    } else {
      E.tour.index = index; E.tour.phase = 'fly'; E.tour.phaseT = 0;
      E.tour.fromPos = E.camera.position.clone(); E.tour.toPos = pos;
      E.tour.fromTarget = E.controls.target.clone(); E.tour.toTarget = target;
    }
    cb.current.onTourStation?.(index, stations.length, l.name);
  }

  // ------------------------------------------------ 静态校园
  useEffect(() => {
    const E = eng.current;
    if (!E || !props.features.length) return;
    E.landmarks = props.landmarks;
    E.detail = cb.current.detail ?? 'standard';
    // 换细节密度时要强制重建几何（设备数量是烘焙进实例化里的），
    // 所以守卫条件要把 detail 一起比，不能只比 features。
    if (E.lastFeatures === props.features && E.lastDetail === E.detail) return;
    E.lastFeatures = props.features;
    E.lastDetail = E.detail;
    // focusBox 是异步加载完 campus 才有的，engine 建立时捕获到的还是 null ——
    // 每次重建静态场景时同步一次，fitCampus 才能拿到收敛框
    E.focus = focusRef.current;

    (Object.keys(E.groups) as LayerKey[]).forEach(k => {
      if (k !== 'robots' && k !== 'routes') disposeGroupChildren(E.groups[k]);
    });
    E.shared?.dispose();
    E.facadeMats.length = 0;
    E.lampsBulbs = null; E.lampGlow = null;
    const budget = newBudget();

    const facades = [0, 1, 2, 3].map(s => B.makeFacade(s));
    const detailed = buildBuildingsDetailed(props.features, facades, E.facadeMats, { detail: E.detail, budget });
    E.groups.buildings.add(detailed.group);
    E.kit = detailed.kit;
    E.shared = detailed.shared;

    const { group: gRoads, lampSpots, treeSpots, centerlines } = buildRoadsPaved(props.features, budget);
    E.groups.roads.add(gRoads);
    const roadside = buildRoadside(centerlines, budget, DETAIL_PRESETS[E.detail]);
    E.roadside = roadside;
    gRoads.add(roadside);

    const { water, pitches } = B.buildWaterAndPitches(props.features);
    E.groups.water.add(water);
    E.groups.pitches.add(pitches);

    // 绿地 / 停车场 / 围墙：程序化铺装版（按分区切铺法，合并成单个几何）
    const { green, parking, barriers } = buildGroundCoverPaved(props.features, budget);
    E.groups.green.add(green);
    E.groups.parking.add(parking);
    E.groups.boundary.add(barriers);

    // 树：贴图就绪后用交叉面片版（无贴图时回退旧的程序化方块树）
    const trees = buildTreesPBR(props.features, treeSpots, centerlines, E.treeTex);
    E.groups.trees.add(trees ?? B.buildTrees(props.features, treeSpots));

    const { group: gLamps, bulbs, glow } = B.buildLamps(lampSpots);
    E.lampsBulbs = bulbs; E.lampGlow = glow;
    E.groups.lamps.add(gLamps);

    E.groups.boundary.add(B.buildBoundary(props.features, props.campusRings));

    rebuildLabels(E, props.landmarks, cb.current.layers);

    // 静态校园建完后按真实包围盒自动取景（地面/雾/阴影/默认机位一次到位）
    fitCampus(E, true);

    // 性能预算实测：draw call / 实例数 / 三角面
    E.budget = budget;
    applyLod(E, cb.current.layers);
    // 预热着色器 + 贴图：编译所有 program，并把名牌的 canvas 贴图先上传到 GPU。
    // 否则第一次拉远/转视角时，新出现的名牌纹理要现场上传，一帧里叠几十张就是几百毫秒的卡顿。
    requestAnimationFrame(() => {
      try {
        E.renderer.compile(E.scene, E.camera);
        for (const e of E.labelEntries) {
          const map = (e.sprite.material as THREE.SpriteMaterial).map;
          if (map) E.renderer.initTexture(map);
        }
      } catch { /* 预热失败不影响渲染 */ }
    });
    console.log(`[scene] 细节=${E.detail} drawcall≈${budget.drawCalls} 实例≈${budget.instances} `
      + `三角面≈${Math.round(budget.triangles / 1000)}k`, budget.byPool);

  }, [props.features, props.landmarks, props.detail, treeReady]);

  // ------------------------------------------------ 视图模式（官方地图 / 三维孪生）
  useEffect(() => {
    const E = eng.current;
    if (!E) return;
    applyViewMode(E, props.viewMode, props.layers);
    // 首次进入地图模式且瓦片刚就绪：直接落位到官方同款机位
    if (props.viewMode === 'map' && E.tiles.ready && E.home) {
      E.tween = {
        t0: performance.now() / 1000, dur: 1.2,
        fromPos: E.camera.position.clone(), toPos: E.home.pos.clone(),
        fromTarget: E.controls.target.clone(), toTarget: E.home.target.clone(),
      };
    }
  }, [props.viewMode, tilesReady]);

  // ------------------------------------------------ 分享链接机位（?cam=）
  // 必须在场景里持有：静态几何重建 / 树贴图就绪 / 瓦片就绪都会调用 fitCampus，
  // 只由 App 在加载后 setCameraState 一次会被这些异步重建覆盖（链接打开视角不对）。
  useEffect(() => {
    const E = eng.current;
    const c = props.initialCam;
    if (!E || !c || c.pos.length !== 3 || c.target.length !== 3) return;
    E.urlCam = { pos: new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2]),
                 target: new THREE.Vector3(c.target[0], c.target[1], c.target[2]) };
    E.tween = null;
    E.camera.position.copy(E.urlCam.pos);
    E.controls.target.copy(E.urlCam.target);
    E.controls.update();
  }, [props.initialCam]);

  // ------------------------------------------------ 选中地标 → map 模式轮廓高亮
  useEffect(() => {
    const E = eng.current;
    if (!E) return;
    if (E.highlight) {
      E.tiles.group.remove(E.highlight);
      E.highlight.geometry.dispose();
      (E.highlight.material as THREE.Material).dispose();
      E.highlight = null;
    }
    const l = props.selectedLandmark;
    if (!l || E.viewMode !== 'map') return;
    const f = (E.lastFeatures ?? []).find(q => q.id === l.id);
    const ring = f && ringOf(f);
    if (!ring) return;
    E.highlight = makeFootprintHighlight(ring);
    E.tiles.group.add(E.highlight);
  }, [props.selectedLandmark, props.viewMode, tilesReady]);

  // ------------------------------------------------ 昼夜氛围
  useEffect(() => {
    const E = eng.current;
    if (!E) return;
    const c = TODS[props.tod];
    E.skyMat.map?.dispose();
    E.skyMat.map = B.makeSkyTexture(c.skyTop, c.skyBottom);
    E.skyMat.needsUpdate = true;
    (E.scene.background as THREE.Color).set(c.skyBottom);
    (E.scene.fog as THREE.Fog).color.set(c.fog);
    // 地图模式下瓦片自带白天光影，地面底色固定官方米色，仅对瓦片整体压色
    (E.ground.material as THREE.MeshStandardMaterial).color.set(
      E.viewMode === 'map' ? MAP_BG : c.ground);
    E.tiles.setTint(c.mapTint);
    E.sun.color.set(c.sun.color);
    E.sun.intensity = c.sun.intensity;
    // 太阳只保留方向，距离按校园尺度缩放，保证阴影相机始终罩住整个校园
    const c0 = E.home?.target ?? new THREE.Vector3(0, 0, 0);
    const dirS = new THREE.Vector3(...c.sun.pos).normalize();
    E.sun.position.copy(c0).add(dirS.multiplyScalar(Math.max(140, E.controls.maxDistance * 0.75)));
    E.sun.target.position.copy(c0);
    E.sun.target.updateMatrixWorld();
    E.hemi.color.set(c.hemi[0]); E.hemi.groundColor.set(c.hemi[1]); E.hemi.intensity = c.hemi[2];
    E.ambient.color.set(c.ambient[0]); E.ambient.intensity = c.ambient[1];
    E.facadeMats.forEach(m => { m.emissiveIntensity = c.windows; });
    if (E.lampsBulbs) (E.lampsBulbs.material as THREE.MeshStandardMaterial).emissiveIntensity = c.lamps ? 2.6 : 0;
    E.lampGlow && (E.lampGlow.visible = c.lamps && props.layers.lamps);
  }, [props.tod, props.features, props.layers.lamps]);

  // ------------------------------------------------ 图层
  useEffect(() => {
    const E = eng.current;
    if (!E) return;
    const mapMode = E.viewMode === 'map';
    (Object.keys(props.layers) as LayerKey[]).forEach(k => {
      E.groups[k].visible = mapMode && (HIDDEN_IN_MAP as string[]).includes(k)
        ? false
        : props.layers[k];
    });
    // 屋顶设备 / 路边设施是 groups 的子物体，额外受距离 LOD 控制，这里同步一次
    applyLod(E, props.layers);
    if (E.lampGlow) E.lampGlow.visible = TODS[props.tod].lamps && props.layers.lamps;
  }, [props.layers, props.tod, props.viewMode, tilesReady]);

  // ------------------------------------------------ 机器人
  useEffect(() => {
    const E = eng.current;
    if (!E) return;
    E.followId = props.followRobotId;
    // GLB 还在加载就不建机器人 —— 建了降级版之后没法原地换成真模型
    if (E.dogState === 'loading') return;
    const seen = new Set<string>();
    props.robots.forEach((r, i) => {
      seen.add(r.id);
      let rv = E.robots.get(r.id);
      if (!rv) {
        const color = ROBOT_COLORS[i % ROBOT_COLORS.length];
        const parts = B.makeQuadruped(E.dogProto, color);
        parts.group.userData.robotId = r.id;
        const label = B.makeLabelSprite(`${r.id} · ${Math.round(r.battery)}%`, { small: true });
        label.position.set(0, E.dogProto ? 0.92 : 1.05, 0);
        parts.group.add(label);
        const ring = new THREE.Mesh(
          E.dogProto ? new THREE.RingGeometry(0.42, 0.52, 40) : new THREE.RingGeometry(0.55, 0.66, 40),
          new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.1;
        ring.visible = false;
        parts.group.add(ring);
        const cur = B.W(r.x, 0, r.z);
        // 轨迹带：预分配 2*TRAIL_MAX 顶点 + 固定索引，更新时只写顶点、改 drawRange
        const trailGeo = new THREE.BufferGeometry();
        trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 6), 3));
        const trailIdx: number[] = [];
        for (let k = 0; k < TRAIL_MAX - 1; k += 1) {
          const a = k * 2;
          trailIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        trailGeo.setIndex(trailIdx);
        trailGeo.setDrawRange(0, 0);
        const trail = new THREE.Mesh(
          trailGeo,
          new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
            depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
          }));
        trail.frustumCulled = false;
        trail.renderOrder = 3;
        E.groups.robots.add(trail);
        let routeLine: THREE.Line | null = null;
        // 规划路线改用"贴地带状网"画真实绕行折线（后端 r.path），直线虚线会穿过楼体
        E.groups.robots.add(parts.group);
        rv = {
          id: r.id, group: parts.group, parts, label, ring, trail, trailPts: [], lastTrail: cur.clone(),
          cur: cur.clone(), target: cur.clone(), prev: cur.clone(),
          heading: -(r.heading || 0), targetHeading: -(r.heading || 0), routeLine,
          queueGroup: null, queuePins: [], queuePads: [], queueSig: '', queueIndex: 0,
          pathRibbon: null, pathSig: '',
        };
        E.robots.set(r.id, rv);
      }
      rv.target.copy(B.W(r.x, 0, r.z));
      rv.targetHeading = -(r.heading || 0);

      // 后端给的绕行折线（栅格 A* 结果）：签名一变就重画一条贴地带，替代原来的直线虚线
      const pth = (r as unknown as { path?: [number, number][] }).path || [];
      const pSig = pth.length ? `${pth.length}:${pth[0][0].toFixed(1)},${pth[0][1].toFixed(1)}` : '';
      const pathPts = pth.map(p => B.W(p[0], 0.13, p[1]));
      if (rv.pathSig !== pSig) {
        rv.pathSig = pSig;
        if (rv.pathRibbon) { E.groups.robots.remove(rv.pathRibbon); disposeDeep(rv.pathRibbon); rv.pathRibbon = null; }
        if (pathPts.length) {
          rv.pathRibbon = makeGroundRibbon([rv.group.position.clone(), ...pathPts], 0.12,
            ROBOT_COLORS[i % ROBOT_COLORS.length], 0.42);
          E.groups.robots.add(rv.pathRibbon);
        }
      } else if (rv.pathRibbon && pathPts.length) {
        // 狗在动，起点跟着挪：每帧只更新首顶点，省得重建几何
        const attr = rv.pathRibbon.geometry.attributes.position as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        arr[0] = rv.group.position.x; arr[1] = 0.13; arr[2] = rv.group.position.z;
        attr.needsUpdate = true;
      }

      // 任务队列可视化：黄色折线 + 编号立柱，已走完的站变绿
      const queue = r.queue || [];
      const sig = queue.map(w => `${w.x.toFixed(2)},${w.z.toFixed(2)}`).join('|');
      if (sig !== rv.queueSig) {
        rv.queueSig = sig;
        if (rv.queueGroup) {
          E.groups.robots.remove(rv.queueGroup);
          disposeDeep(rv.queueGroup);
          rv.queueGroup = null;
          rv.queuePins = [];
          rv.queuePads = [];
        }
        if (queue.length) {
          const g = new THREE.Group();
          // 队列路线也做成贴地带状网格（金色半透明），比 1px 线在贴地视角可读得多
          const pts = [B.W(r.x, 0, r.z), ...queue.map(w => B.W(w.x, 0, w.z))];
          g.add(makeGroundRibbon(pts, 0.24, 0xffd166, 0.75));
          const pins: THREE.Mesh[] = [];
          const pads: THREE.Mesh[] = [];
          queue.forEach((w, i) => {
            const done = i < (r.queue_index ?? 0);
            const color = done ? 0x4fe19b : 0xffd166;
            const pin = new THREE.Mesh(
              new THREE.CylinderGeometry(0.2, 0.2, 1.9, 10),
              new THREE.MeshStandardMaterial({
                color, emissive: done ? 0x1d6b45 : 0x6b4a00, emissiveIntensity: 0.7,
              }));
            pin.position.copy(B.W(w.x, 1.15, w.z));
            const pad = new THREE.Mesh(
              new THREE.RingGeometry(0.5, 0.72, 24),
              new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
            pad.rotation.x = -Math.PI / 2;
            pad.position.copy(B.W(w.x, 0.16, w.z));
            const tag = B.makeLabelSprite(`${i + 1} · ${w.name}`, { small: true });
            tag.position.copy(B.W(w.x, 2.8, w.z));
            g.add(pin, pad, tag);
            pins.push(pin);
            pads.push(pad);
          });
          E.groups.robots.add(g);
          rv.queueGroup = g;
          rv.queuePins = pins;
          rv.queuePads = pads;
          rv.queueIndex = r.queue_index ?? 0;
        }
      } else if (rv.queuePins.length) {
        // 走到第几站的配色变化
        const idx = r.queue_index ?? 0;
        if (rv.queueIndex !== idx) {
          rv.queueIndex = idx;
          rv.queuePins.forEach((pin, i) => {
            const done = i < idx;
            const mat = pin.material as THREE.MeshStandardMaterial;
            mat.color.set(done ? 0x4fe19b : 0xffd166);
            mat.emissive.set(done ? 0x1d6b45 : 0x6b4a00);
          });
          rv.queuePads.forEach((pad, i) => {
            (pad.material as THREE.MeshBasicMaterial).color.set(i < idx ? 0x4fe19b : 0xffd166);
          });
        }
      }
      // 标签与指示灯随状态刷新
      const fresh = B.makeLabelSprite(`${r.id} · ${Math.round(r.battery)}%`, { small: true });
      const oldMap = rv.label.material.map;
      rv.label.material.map = fresh.material.map;
      rv.label.material.needsUpdate = true;
      oldMap?.dispose();
      const eye = rv.parts.group.children.find(c => (c as THREE.Mesh).material &&
        ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive?.getHex() === 0x35e0ff) as THREE.Mesh | undefined;
      if (eye) {
        const m = eye.material as THREE.MeshStandardMaterial;
        m.emissive.set(r.status === '检测中' ? 0xffb14e : r.status === '充电中' || r.status === '返航' ? 0x6ea8ff : r.status === '待命' ? 0x8a97a3 : 0x35e0ff);
      }
    });
    for (const [id, rv] of E.robots) {
      if (seen.has(id)) continue;
      E.groups.robots.remove(rv.parts.group, rv.trail);
      if (rv.routeLine) E.groups.robots.remove(rv.routeLine);
      if (rv.queueGroup) E.groups.robots.remove(rv.queueGroup);
      disposeDeep(rv.parts.group); rv.trail.geometry.dispose();
      if (rv.queueGroup) disposeDeep(rv.queueGroup);
      E.robots.delete(id);
    }
  }, [props.robots, props.followRobotId, dogReady]);

  // ------------------------------------------------ 告警事件
  useEffect(() => {
    const E = eng.current;
    if (!E) return;
    const list = props.events.slice(0, 10);
    const seen = new Set(list.map(e => e.id));
    for (const [id, av] of E.alerts) {
      if (!seen.has(id)) {
        E.alertGroup.remove(av.group);
        disposeDeep(av.group);
        E.alerts.delete(id);
      }
    }
    for (const ev of list) {
      if (E.alerts.has(ev.id)) continue;
      const color = ev.level === 'critical' ? 0xff5f6e : ev.level === 'warning' ? 0xffb14e : 0x34d9e9;
      const group = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.75, 36),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.16, 2.4, 8, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      pillar.position.y = 1.2;
      group.add(ring, pillar);
      group.position.copy(B.W(ev.x, 0.16, ev.z));
      E.alertGroup.add(group);
      E.alerts.set(ev.id, { group, ring, born: performance.now() / 1000, level: ev.level });
    }
  }, [props.events]);

  // ------------------------------------------------ VRPTW
  useEffect(() => {
    const E = eng.current;
    if (!E) return;
    disposeGroupChildren(E.groups.routes);
    E.vrptw = [];
    E.vrptwDepot = null;
    if (!props.routes.length) return;

    const depot = new THREE.Vector3(0, 0.28, 0);
    const dg = new THREE.Group();
    const house = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.9, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x8a6d4e, roughness: 0.8 }));
    house.position.y = 0.45; house.castShadow = true;
    const flagPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 2.4, 6),
      new THREE.MeshStandardMaterial({ color: 0xd8dde2 }));
    flagPole.position.set(0.7, 1.2, 0);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.45),
      new THREE.MeshBasicMaterial({ color: 0xff5f6e, side: THREE.DoubleSide }));
    flag.position.set(1.02, 2.1, 0);
    const dLabel = B.makeLabelSprite('配送站（南门）');
    dLabel.position.set(0, 2.6, 0);
    dg.add(house, flagPole, flag, dLabel);
    E.groups.routes.add(dg);
    E.vrptwDepot = dg;

    props.routes.forEach((route, ri) => {
      const color = VEHICLE_COLORS[ri % VEHICLE_COLORS.length];
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, transparent: true, opacity: 0.9 });
      const pts = [depot, ...route.stops.map(s => B.W(s.x, 0.28, s.z)), depot];
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.12);
      E.groups.routes.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 180, 0.085, 6), mat));

      // 弧长参数映射：每个停靠点在曲线上的 t
      const spaced = curve.getSpacedPoints(640);
      const tParams = [0];
      for (const s of route.stops) {
        const p = B.W(s.x, 0.28, s.z);
        let best = 0, bd = Infinity;
        spaced.forEach((q, i) => {
          const d = q.distanceToSquared(p);
          if (d < bd) { bd = d; best = i; }
        });
        tParams.push(best / (spaced.length - 1));
      }
      tParams.push(1);

      const stops = route.stops.map(s => {
        const pin = new THREE.Group();
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 8), mat.clone());
        cone.rotation.x = Math.PI;
        cone.position.y = 0.62;
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6),
          new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 }));
        dot.position.y = 0.95;
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.55, 0.72, 32),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.1;
        ring.visible = false;
        const label = B.makeLabelSprite(`${s.name} ${s.arrival}`, { small: true });
        label.position.y = 1.8;
        pin.add(cone, dot, ring, label);
        pin.position.copy(B.W(s.x, 0, s.z));
        E.groups.routes.add(pin);
        return { stop: s, pos: B.W(s.x, 0.28, s.z), pin, ring, dot };
      });

      const schedule = route.stops.map((s, k) => ({
        depart: k === 0
          ? Math.min(mm(route.stops[0].time_window[0]) - 20, mm(route.stops[0].arrival) - 1)
          : mm(route.stops[k - 1].service_end),
        arrive: mm(s.arrival),
        end: mm(s.service_end),
      }));

      const van = B.makeVan(color);
      van.position.copy(depot);
      E.groups.routes.add(van);
      E.vrptw.push({
        vehicleId: route.vehicle_id, color, curve, tParams, stops, schedule,
        van, vanTarget: depot.clone(), vanYaw: 0, servingIdx: -1,
      });
    });
  }, [props.routes]);

  // 时间轴驱动车辆
  useEffect(() => {
    const E = eng.current;
    if (!E) return;
    const clock = props.vrptwClock;
    for (const r of E.vrptw) {
      const S = r.schedule;
      const last = S.length - 1;
      r.servingIdx = -1;
      r.stops.forEach((st, k) => {
        st.ring.visible = false;
        const served = clock >= S[k].end;
        const active = clock >= S[k].arrive && clock < S[k].end;
        (st.dot.material as THREE.MeshStandardMaterial).color.set(served ? 0x4fe19b : r.color);
        (st.dot.material as THREE.MeshStandardMaterial).emissiveIntensity = active ? 1.6 : 0.5;
        if (active) { r.servingIdx = k; st.ring.visible = true; }
      });
      const returnMin = Math.max(1, (1 - r.tParams[last + 1]) * r.curve.getLength() * 2);
      if (clock <= S[0].depart || clock >= S[last].end + returnMin) {
        r.vanTarget.set(0, 0.28, 0);
      } else if (clock >= S[last].end) {
        const f = clamp01((clock - S[last].end) / returnMin);
        const t = THREE.MathUtils.lerp(r.tParams[last + 1], 1, f);
        r.vanTarget.copy(r.curve.getPointAt(t));
        const tan = r.curve.getTangentAt(t);
        r.vanYaw = Math.atan2(tan.x, tan.z);
      } else {
        for (let k = 0; k <= last; k++) {
          if (clock >= S[k].depart && clock < S[k].arrive) {
            const f = clamp01((clock - S[k].depart) / Math.max(0.01, S[k].arrive - S[k].depart));
            const t = THREE.MathUtils.lerp(r.tParams[k], r.tParams[k + 1], f);
            r.vanTarget.copy(r.curve.getPointAt(t));
            const tan = r.curve.getTangentAt(t);
            r.vanYaw = Math.atan2(tan.x, tan.z);
            break;
          }
          if (clock >= S[k].arrive && clock < S[k].end) {
            r.vanTarget.copy(r.stops[k].pos);
            break;
          }
        }
      }
    }
  }, [props.vrptwClock, props.routes]);

  // ------------------------------------------------ 对外 API
  useImperativeHandle(ref, () => ({
    flyToLandmark(l, preset = 'overview') {
      const E = eng.current; if (!E) return;
      const { pos, target } = poseFor(l.x, l.z, Math.max(1.2, l.height || 2), preset);
      E.tween = { t0: performance.now() / 1000, dur: 1.7, fromPos: E.camera.position.clone(), toPos: pos, fromTarget: E.controls.target.clone(), toTarget: target };
    },
    flyToXY(x, z, preset = 'overview') {
      const E = eng.current; if (!E) return;
      const { pos, target } = poseFor(x, z, 2, preset);
      E.tween = { t0: performance.now() / 1000, dur: 1.7, fromPos: E.camera.position.clone(), toPos: pos, fromTarget: E.controls.target.clone(), toTarget: target };
    },
    // 把一组平面点（如 VRPTW 全部停靠点）整体框进画面
    flyToArea(pts) {
      const E = eng.current; if (!E || !pts.length) return;
      const box = new THREE.Box3();
      pts.forEach(p => box.expandByPoint(B.W(p.x, 0.5, p.z)));
      box.expandByScalar(5);
      box.min.y = 0; box.max.y = 12;
      const dir = new THREE.Vector3(0.46, 0.66, 0.6).normalize();
      const tanV = Math.tan((E.camera.fov * Math.PI) / 360);
      const tanH = tanV * Math.max(0.45, E.camera.aspect);
      const { dist, target } = fitDistance(box, dir, tanV, tanH);
      E.tween = {
        t0: performance.now() / 1000, dur: 1.7,
        fromPos: E.camera.position.clone(), toPos: target.clone().add(dir.clone().multiplyScalar(dist * 1.06)),
        fromTarget: E.controls.target.clone(), toTarget: target,
      };
    },
    resetView() {
      const E = eng.current; if (!E) return;
      if (!E.home) fitCampus(E, false);
      E.tween = {
        t0: performance.now() / 1000, dur: 1.6,
        fromPos: E.camera.position.clone(), toPos: E.home!.pos.clone(),
        fromTarget: E.controls.target.clone(), toTarget: E.home!.target.clone(),
      };
    },
    zoomIn() {
      const E = eng.current; if (!E) return;
      E.controls.dollyIn(1.24);
      E.controls.update();
    },
    zoomOut() {
      const E = eng.current; if (!E) return;
      E.controls.dollyOut(1.24);
      E.controls.update();
    },
    toggleLabels() {
      const E = eng.current; if (!E) return;
      E.groups.labels.visible = !E.groups.labels.visible;
      cb.current.onToggleLayer?.('labels', E.groups.labels.visible);
    },
    fullscreen() {
      const el = hostRef.current;
      if (!el) return;
      if (document.fullscreenElement) {
        void document.exitFullscreen?.();
      } else {
        void el.requestFullscreen?.();
      }
    },
    getCameraState() {
      const E = eng.current;
      if (!E) return { pos: [0, 0, 0], target: [0, 0, 0] };
      const p = E.camera.position, tg = E.controls.target;
      return {
        pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
        target: [+tg.x.toFixed(1), +tg.y.toFixed(1), +tg.z.toFixed(1)],
      };
    },
    setCameraState(s) {
      const E = eng.current; if (!E) return;
      if (s.pos?.length === 3) E.camera.position.set(s.pos[0], s.pos[1], s.pos[2]);
      if (s.target?.length === 3) E.controls.target.set(s.target[0], s.target[1], s.target[2]);
      E.tween = null;
      E.controls.update();
    },
    setQuality(q) {
      const E = eng.current; if (!E) return;
      applyQuality(E, q);
    },
    setAutoQuality(on) {
      const E = eng.current; if (!E) return;
      E.autoQuality = on;
      E.lowStreak = 0; E.highStreak = 0;
    },
    tour(cmd) {
      const E = eng.current; if (!E) return;
      const stations = TOUR_ORDER.map(n => E.landmarks.find(l => l.name === n)).filter(Boolean) as Landmark[];
      if (!stations.length) return;
      if (cmd === 'start') { E.tour = null; enterStation(E, stations, 0); return; }
      const tour = E.tour;
      if (!tour) return;
      if (cmd === 'pause') tour.paused = true;
      else if (cmd === 'resume') tour.paused = false;
      else if (cmd === 'skip') {
        tour.index++;
        if (tour.index >= stations.length) { E.tour = null; cb.current.onTourEnd?.(); }
        else enterStation(E, stations, tour.index);
      } else if (cmd === 'stop') { E.tour = null; cb.current.onTourEnd?.(); }
    },
    screenshot() {
      const E = eng.current; if (!E) return;
      E.renderer.render(E.scene, E.camera);
      const src = E.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(src, 0, 0);
      const fs = Math.max(12, Math.round(c.width * 0.011));
      ctx.font = `${fs}px sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,.78)';
      ctx.textAlign = 'right';
      ctx.fillText('© 中国石油大学（北京）可视化位置服务平台 · © OpenStreetMap contributors · 石大·智巡', c.width - fs, c.height - fs * 0.8);
      const a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = `cup-campus-${Date.now()}.png`;
      a.click();
    },
  }), []);

  return (
    <div className="scene-wrap" ref={hostRef}>
      <div className="map-brand-chip"><span className="map-brand-mark">石</span><div><b>石大·云游校园</b><small>CHINA UNIVERSITY OF PETROLEUM · CAMPUS EXPLORER</small></div></div>
      <div className="map-explore-chip"><b>校园探索</b><span>展开⌃</span></div>
      <div className="map-compass"><b>N</b><span>▲</span></div>
      <div className="map-tools" aria-label="地图工具">
        <button title="放大" aria-label="放大" onClick={() => eng.current && (eng.current.controls.dollyIn(1.24), eng.current.controls.update())}>＋</button>
        <button title="缩小" aria-label="缩小" onClick={() => eng.current && (eng.current.controls.dollyOut(1.24), eng.current.controls.update())}>−</button>
        <button title="显示/隐藏地名" aria-label="显示或隐藏地名" onClick={() => {
          const E = eng.current;
          if (!E) return;
          E.groups.labels.visible = !E.groups.labels.visible;
          cb.current.onToggleLayer?.('labels', E.groups.labels.visible);
        }}>◈</button>
        <button title="回到校园总览" aria-label="回到校园总览" onClick={() => {
          const E = eng.current;
          if (!E) return;
          if (!E.home) fitCampus(E, false);
          E.tween = {
            t0: performance.now() / 1000, dur: 1.6,
            fromPos: E.camera.position.clone(), toPos: E.home!.pos.clone(),
            fromTarget: E.controls.target.clone(), toTarget: E.home!.target.clone(),
          };
        }}>◉</button>
        <button title="复位视角" aria-label="复位视角" onClick={() => {
          const E = eng.current;
          if (!E) return;
          if (!E.home) fitCampus(E, false);
          E.tween = {
            t0: performance.now() / 1000, dur: 1.6,
            fromPos: E.camera.position.clone(), toPos: E.home!.pos.clone(),
            fromTarget: E.controls.target.clone(), toTarget: E.home!.target.clone(),
          };
        }}>↻</button>
        <button title="全屏" aria-label="全屏" onClick={() => {
          const el = hostRef.current;
          if (!el) return;
          if (document.fullscreenElement) void document.exitFullscreen?.();
          else void el.requestFullscreen?.();
        }}>⛶</button>
      </div>
      <div className="map-status"><span className="map-live-dot"/> 实时校园 · 昌平校区</div>
      <div className="scene-hint">官方手绘底图 · 拖拽旋转 · 滚轮缩放 · 点击建筑或机器人</div>
      <div className="map-attribution">© 中国石油大学（北京）可视化位置服务平台 · © OpenStreetMap contributors · ODbL</div>
    </div>
  );
});

export default CampusScene;
