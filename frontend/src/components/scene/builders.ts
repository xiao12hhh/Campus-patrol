// 场景静态几何与程序化模型构建（纯 three.js，无 React 依赖）。
// 坐标约定：与 campus-local.json 的 axis 完全一致 —— 数据 (x, z) 中 x 向东、z 向南，
// y 向上。three.js 右手系下 x 东 / y 上 时 z 恰好就是南，因此世界坐标与数据坐标一一对应，
// 不做任何取反（早期版本在此把 z 取反，导致整个校园南北镜像）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { LocalFeature, categoryOf, CATEGORY_COLOR, ringOf, lineOf } from '../../lib/campus';
import { FACADE_TILE } from './detailcfg';

export const W = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// 建筑高度：v3 起校内 84 栋楼用的是学校官方 3D 源的**实测高度**（米 → 单位，1 单位 = 10 m），
// 按真高渲染即可，不再做夸张放大（旧版 2.2 倍是为弥补 OSM 缺失 height 标签的估算值）。
// 仅保留极小的下限，避免 1 层门房这类 4 m 建筑退化成薄片。
// 视觉高度压缩：按真实高度渲染时楼群显得过于拥挤（俯视下楼的体量把间距吃光），
// 官方手绘瓦片里楼高也是被压缩的（约为真实感的 0.5~0.6）。0.65 兼顾辨识度与疏朗。
export const HEIGHT_SCALE = 0.65;
const HEIGHT_MIN = 0.35;
export const visualHeight = (h: number) => Math.max(HEIGHT_MIN, (h || 0.4) * HEIGHT_SCALE);

// ---------------------------------------------------------------- 随机数
export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 立面纹理
export interface FacadeSet { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture }

export function makeFacade(seed: number): FacadeSet {
  const rnd = mulberry32(seed * 977 + 13);
  // 分格参数与 roofkit 共用同一份：roofkit 靠它们反算 UV，
  // 让「窗行数 = 官方 levels」，两边必须一致。
  const cols = FACADE_TILE.cols, rows = FACADE_TILE.rows, size = 256;
  const make = (draw: (ctx: CanvasRenderingContext2D, win: number, wy: number, wx: number, ww: number, wh: number) => void) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#e9ece8'; ctx.fillRect(0, 0, size, size);
    // 每层的水平腰线 / 窗台：立面近景层次靠这条线，比纯色块耐看
    const mx = size / cols / 5, my = size / rows / 4;
    const ww = size / cols - mx * 2, wh = size / rows - my * 2;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < cols; i++) {
        draw(ctx, r * cols + i, my + r * size / rows, mx + i * size / cols, ww, wh);
      }
      ctx.fillStyle = 'rgba(116,128,128,.38)';
      ctx.fillRect(0, Math.round(r * size / rows), size, 2);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(FACADE_TILE.rx, FACADE_TILE.ry);
    return t;
  };
  const lit = new Array(cols * rows).fill(0).map(() => rnd() < 0.52);
  const map = make((ctx, _w, wy, wx, ww, wh) => {
    ctx.fillStyle = '#254b5b'; ctx.fillRect(wx, wy, ww, wh);
    ctx.fillStyle = 'rgba(184,222,230,.28)'; ctx.fillRect(wx, wy, ww, wh * 0.3);
    // 窗框竖挺 + 窗台阴影
    ctx.fillStyle = 'rgba(225,234,233,.7)'; ctx.fillRect(wx + ww * 0.46, wy, Math.max(1, ww * 0.065), wh);
    ctx.fillStyle = 'rgba(16,42,52,.42)'; ctx.fillRect(wx, wy + wh, ww, Math.max(1, wh * 0.12));
  });
  const emissiveMap = make((ctx, win, wy, wx, ww, wh) => {
    ctx.fillStyle = lit[win] ? '#ffc98a' : '#0a0c10'; ctx.fillRect(wx, wy, ww, wh);
  });
  return { map, emissiveMap };
}

// ---------------------------------------------------------------- 文本精灵
export function makeLabelSprite(text: string, opts: { small?: boolean } = {}): THREE.Sprite {
  const fs = opts.small ? 22 : 26;
  const pad = 18;
  const c = document.createElement('canvas');
  const ctx0 = c.getContext('2d')!;
  ctx0.font = `600 ${fs}px "Microsoft YaHei", sans-serif`;
  const w = Math.min(340, Math.ceil(ctx0.measureText(text).width) + pad * 2);
  const h = fs + pad * 1.4;
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const r = h / 2.6;
  ctx.fillStyle = 'rgba(251,253,255,.94)';
  ctx.strokeStyle = 'rgba(24,44,64,.28)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(1, 1, w - 2, h - 2, r); ctx.fill(); ctx.stroke();
  ctx.font = `600 ${fs}px "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = '#15293a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false }));
  sprite.renderOrder = 50;
  const k = opts.small ? 0.016 : 0.02;
  sprite.scale.set(w * k, h * k, 1);
  return sprite;
}

// ---------------------------------------------------------------- 水体 / 运动场
const PITCH_COLOR: Record<string, number> = {
  soccer: 0x4e8f4e, basketball: 0xb0754a, tennis: 0x4e7f66,
};

function fillPolygon(ring: number[][], color: number, y: number, opts: { opacity?: number; roughness?: number } = {}) {
  const shape = new THREE.Shape(ring.map(p => new THREE.Vector2(p[0], -p[1])));
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.9, side: THREE.DoubleSide,
    transparent: (opts.opacity ?? 1) < 1, opacity: opts.opacity ?? 1,
  });
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

export function ringLine(ring: number[][], color: number, y: number, opacity = 0.7) {
  const pts = ring.map(p => W(p[0], y, p[1]));
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

function areaOfPoly(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export function buildWaterAndPitches(features: LocalFeature[]) {
  const water = new THREE.Group();
  const pitches = new THREE.Group();
  for (const f of features) {
    const p = f.properties || {};
    const ring = ringOf(f);
    if (!ring) continue;
    const isWater = f.kind === 'water'
      || p.leisure === 'garden' || p.leisure === 'swimming_pool' || p.amenity === 'fountain';
    const isPitch = f.kind === 'pitch' || p.leisure === 'pitch' || p.leisure === 'stadium'
      || p.leisure === 'playground' || p.leisure === 'track';
    if (isWater) {
      water.add(fillPolygon(ring, p.amenity === 'fountain' ? 0x62b8d9 : 0x4aa3c9, 0.04, { opacity: 0.88, roughness: 0.15 }));
      water.add(ringLine(ring, 0x2e7d9e, 0.06, 0.5));
    } else if (isPitch) {
      // 判定顺序：stadium（有标签）→ 有 sport 的球场 → 大面积无名场地按田径场
      // （红旗操场 area≈33；stadium 112/71、足球场 78、网球场 25 都有各自标签先行分流）
      const big = areaOfPoly(ring) > 25;
      const isTrack = big || /操场|田径场/.test(f.name);
      let cx = 0, cz = 0;
      for (const q of ring) { cx += q[0]; cz += q[1]; }
      cx /= ring.length; cz /= ring.length;
      const scaled = (k: number) => ring.map(q => [cx + (q[0] - cx) * k, cz + (q[1] - cz) * k]);
      if (p.leisure === 'stadium') {
        pitches.add(fillPolygon(ring, 0xb06a52, 0.035));            // 跑道（红棕）
        pitches.add(fillPolygon(scaled(0.78), 0x4e8f4e, 0.045));    // 内场草坪
        pitches.add(ringLine(ring, 0xf2f4f6, 0.05, 0.6));
        pitches.add(ringLine(scaled(0.90), 0xf2f4f6, 0.04, 0.6));
        pitches.add(ringLine(scaled(0.78), 0xf2f4f6, 0.04, 0.6));
      } else if (isTrack) {
        // 田径场（红旗操场等）：OSM 常缺 leisure/sport 标签，按名字 + 面积识别
        pitches.add(fillPolygon(ring, 0xb06a52, 0.035));            // 跑道（红棕）
        pitches.add(fillPolygon(scaled(0.78), 0x4e8f4e, 0.045));    // 内场草坪
        pitches.add(ringLine(ring, 0xf2f4f6, 0.05, 0.6));           // 外缘白线
        pitches.add(ringLine(scaled(0.90), 0xf2f4f6, 0.04, 0.6));   // 跑道分道线
        pitches.add(ringLine(scaled(0.78), 0xf2f4f6, 0.04, 0.6));   // 内场边线
      } else {
        const color = PITCH_COLOR[p.sport || ''] ?? 0x6a9a6a;
        pitches.add(fillPolygon(ring, color, 0.035));
        pitches.add(ringLine(ring, 0xf2f4f6, 0.05, 0.55));
      }
    }
  }
  return { water, pitches };
}

// ---------------------------------------------------------------- 树木
function pointInRing(x: number, z: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function buildTrees(features: LocalFeature[], extraSpots: THREE.Vector3[]) {
  const rng = mulberry32(777);
  const blocked: number[][][] = [];
  const waterRings: number[][][] = [];
  for (const f of features) {
    const g = f.geometry;
    // 官方建筑多为 MultiPolygon，需一并纳入「建筑占位」，否则树会长在楼里
    if (f.kind === 'building') {
      if (g.type === 'Polygon') blocked.push(g.coordinates[0]);
      else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) blocked.push(poly[0]);
    }
    if (f.kind === 'poi' || f.kind === 'water') {
      const p = f.properties || {};
      const ring = ringOf(f);
      if (ring && (p.leisure === 'garden' || p.leisure === 'swimming_pool' || p.amenity === 'fountain'
        || p.leisure === 'pitch' || p.leisure === 'stadium' || f.kind === 'water')) waterRings.push(ring);
    }
  }
  const spots: THREE.Vector3[] = [];
  const ok = (v: THREE.Vector3) => {
    for (const ring of blocked) if (pointInRing(v.x, v.z, ring)) return false;
    for (const ring of waterRings) if (pointInRing(v.x, v.z, ring)) return false;
    // v3 三校区合并范围约 x -73..82、z -39..36，留出城市背景余量
    return v.x > -90 && v.x < 98 && v.z > -52 && v.z < 50;
  };
  for (const s of extraSpots) if (ok(s) && rng() < 0.75) spots.push(s);
  // 建筑周边一圈
  for (const ring of blocked) {
    const cx = ring.reduce((a, q) => a + q[0], 0) / ring.length;
    const cz = ring.reduce((a, q) => a + q[1], 0) / ring.length;
    const r = Math.max(...ring.map(q => Math.hypot(q[0] - cx, q[1] - cz)));
    const n = Math.min(14, Math.max(3, Math.floor(r * 1.6)));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng() * 0.4;
      const rr = r + 0.7 + rng() * 0.8;
      const v = W(cx + Math.cos(a) * rr, 0, cz + Math.sin(a) * rr);
      if (ok(v)) spots.push(v);
    }
  }
  const count = Math.min(spots.length, 560);

  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.05, 0.1, 0.55, 5),
    new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 1 }), count);
  const crown = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.5, 0),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), count);
  crown.castShadow = true;

  const m = new THREE.Matrix4();
  const cA = new THREE.Color(0x3b6f34), cB = new THREE.Color(0x6ba348), c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const s = spots[i];
    const sc = 1.0 + rng() * 1.05;
    m.makeScale(1, 1, 1); m.setPosition(s.x, 0.27 * sc, s.z);
    trunk.setMatrixAt(i, m);
    m.makeScale(sc, sc * (0.9 + rng() * 0.5), sc);
    m.setPosition(s.x, (0.55 + 0.32) * sc, s.z);
    crown.setMatrixAt(i, m);
    crown.setColorAt(i, c.copy(cA).lerp(cB, rng()));
  }
  if (crown.instanceColor) crown.instanceColor.needsUpdate = true;
  const group = new THREE.Group();
  group.add(trunk, crown);
  return group;
}

// ---------------------------------------------------------------- 路灯
export function buildLamps(spots: THREE.Vector3[]) {
  const group = new THREE.Group();
  const bulbs = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.09, 6, 5),
    new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xffd9a0, emissiveIntensity: 0 }), spots.length);
  const poles = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.025, 0.035, 1.1, 4),
    new THREE.MeshStandardMaterial({ color: 0x3a4249, roughness: 0.8 }), spots.length);
  const m = new THREE.Matrix4();
  spots.forEach((s, i) => {
    m.identity(); m.setPosition(s.x, 1.1, s.z); bulbs.setMatrixAt(i, m);
    m.identity(); m.setPosition(s.x, 0.55, s.z); poles.setMatrixAt(i, m);
  });
  // 夜间光晕
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,214,150,.9)'); grad.addColorStop(1, 'rgba(255,214,150,0)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const glow = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(spots.map(s => new THREE.Vector3(s.x, 1.12, s.z))),
    new THREE.PointsMaterial({ map: tex, size: 1.7, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffcf8a }));
  glow.visible = false;
  group.add(bulbs, poles, glow);
  return { group, bulbs, glow };
}

// ---------------------------------------------------------------- 校园边界
/** 优先使用 OSM 关系导出的真实边界环；拿不到时退化成校内建筑凸包。 */
export function buildBoundary(features: LocalFeature[], rings?: number[][][]) {
  if (rings?.length) {
    const group = new THREE.Group();
    for (const r of rings) {
      if (r.length < 4) continue;
      group.add(new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(r.map(q => W(q[0], 0.12, q[1]))),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 })));
      // 半透明填充，区分「校内 / 校外」
      const shape = new THREE.Shape(r.map(q => new THREE.Vector2(q[0], -q[1])));
      const fill = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color: 0x6fbf8a, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
      fill.rotation.x = -Math.PI / 2;
      fill.position.y = 0.015;
      group.add(fill);
    }
    return group;
  }

  const pts: number[][] = [];
  for (const f of features) {
    if (f.kind !== 'building' || f.in_campus === false) continue;
    const ring = ringOf(f);
    if (ring) for (let i = 0; i < ring.length; i += 2) pts.push(ring[i]);
  }
  if (pts.length < 8) return new THREE.Group();
  // 凸包（monotone chain，数据平面 x/z）
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: number[][] = [], upper: number[][] = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.concat(upper);
  let cx = 0, cz = 0;
  for (const q of hull) { cx += q[0]; cz += q[1]; }
  cx /= hull.length; cz /= hull.length;
  const scaled = hull.map(q => [cx + (q[0] - cx) * 1.16, cz + (q[1] - cz) * 1.16]);
  const line = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(scaled.map(q => W(q[0], 0.12, q[1]))),
    new THREE.LineBasicMaterial({ color: 0xf5f8fa, transparent: true, opacity: 0.65 }));
  const group = new THREE.Group();
  group.add(line);
  return group;
}

// ---------------------------------------------------------------- 四足机器人
export interface QuadrupedParts {
  group: THREE.Group;
  body: THREE.Mesh;
  lidar: THREE.Mesh;
  legs: Array<{ hip: THREE.Group; knee: THREE.Group }>;
}

// 降级版（GLB 没加载出来时用）。新的正式版见下方 makeQuadruped(proto, color)。
export function makeQuadrupedFallback(color: number): QuadrupedParts {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.6, metalness: 0.4 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.34, 1.4), mat);
  body.position.y = 0.72; body.castShadow = true;
  // 供渲染循环读取：躯干基准高度 + 该模型适用的步态幅度
  body.userData.baseY = 0.72;
  body.userData.gait = { hip: 0.38, knee: 0.55 };
  group.add(body);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.26, 0.34), mat);
  head.position.set(0, 0.74, -0.82); head.castShadow = true;
  group.add(head);
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x0b1016, emissive: 0x35e0ff, emissiveIntensity: 1.6 }));
  eye.position.set(0, 0.76, -1.0);
  group.add(eye);

  const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.1, 10),
    new THREE.MeshStandardMaterial({ color: 0x39424c, emissive: 0x9adfff, emissiveIntensity: 0.8 }));
  lidar.position.set(0, 0.95, 0.1);
  group.add(lidar);

  const legs: Array<{ hip: THREE.Group; knee: THREE.Group }> = [];
  const legPos: Array<[number, number, number]> = [
    [-0.28, 0.62, -0.5], [0.28, 0.62, -0.5], [-0.28, 0.62, 0.5], [0.28, 0.62, 0.5]];
  for (const [x, y, z] of legPos) {
    const hip = new THREE.Group(); hip.position.set(x, y, z);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.12), dark);
    upper.position.y = -0.25; upper.castShadow = true;
    hip.add(upper);
    const knee = new THREE.Group(); knee.position.y = -0.5;
    const lower = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.09), mat);
    lower.position.y = -0.25; lower.castShadow = true;
    knee.add(lower);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), dark);
    foot.position.y = -0.5;
    knee.add(foot);
    hip.add(knee);
    group.add(hip);
    legs.push({ hip, knee });
  }
  return { group, body, lidar, legs };
}

// ------------------------------------------------- 宇树 B2 真模型（GLB）
// 部件顺序（gltfpack 会丢 node 名，但 scene.children 顺序稳定）:
//   [body, FL_up, FL_lo, FR_up, FR_lo, HL_up, HL_lo, HR_up, HR_lo]
const DOG_PARTS = 9;
const DOG_LEGS = ['FL', 'FR', 'HL', 'HR'];

/** 机器狗模型整体缩放：模型是按「看得见」放大做的，缩到 0.42 后约 2.9 m 高，
 *  与 20~40 m 的教学楼放在一起比例不刺眼；第一人称的相机高度也按这个缩放取值。 */
export const DOG_SCALE = 0.42;

export interface DogProto {
  geos: THREE.BufferGeometry[];
  mat: THREE.MeshStandardMaterial;
  hips: Record<string, number[]>;
  knees: Record<string, number[]>;
  bodyTop: number;
  size: [number, number, number];
}

let dogCache: DogProto | null | undefined; // undefined = 还没加载过

/** 加载并缓存机器狗原型。失败返回 null，场景自动回退到程序化版本。 */
export async function loadDogProto(base = '/models/unitree_b2'): Promise<DogProto | null> {
  if (dogCache !== undefined) return dogCache;
  try {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder); // -cc 走的是 EXT_meshopt_compression
    const [gltf, meta] = await Promise.all([
      new Promise<any>((res, rej) => loader.load(base + '.glb', res, undefined, rej)),
      fetch(base + '.meta.json').then((r) => r.json()),
    ]);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o: any) => {
      if (o.isMesh) meshes.push(o);
    });
    if (meshes.length !== DOG_PARTS) throw new Error('部件数应为 ' + DOG_PARTS + '，实得 ' + meshes.length);

    // gltfpack 量化后 position / normal / color 都是 Int16|Uint8 normalized，
    // 直接 applyMatrix4 会把结果写回整数数组导致精度崩坏 —— 先转成 Float32
    gltf.scene.updateMatrixWorld(true);
    const geos = meshes.map((m) => {
      const g = m.geometry.clone();
      for (const key of ['position', 'normal', 'color'] as const) {
        const a = g.attributes[key];
        if (!a || a.array instanceof Float32Array) continue;
        const n = a.count, item = a.itemSize;
        const out = new Float32Array(n * item);
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < item; k++) out[i * item + k] = a.getComponent(i, k);
        }
        g.setAttribute(key, new THREE.BufferAttribute(out, item));
      }
      // node 上挂着量化补偿 scale 与 pivot 平移，烘进顶点后才能只靠 hips/knees 重新装配
      g.applyMatrix4(m.matrixWorld);
      return g;
    });
    // 腿的上下段转成「以关节为原点」，装配时再用 hips / knees 摆回去
    DOG_LEGS.forEach((leg, i) => {
      const h = meta.hips[leg];
      const k = meta.knees[leg];
      geos[1 + i * 2].translate(-h[0], -h[1], -h[2]);
      geos[2 + i * 2].translate(-k[0], -k[1], -k[2]);
    });

    geos[0].computeBoundingBox();
    const bb = geos[0].boundingBox!;
    // 顶点色来自 FBX 的纯色材质，原厂灰直接复用，不做染色
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0.32 });
    // 三台机器人共享几何与材质，销毁单台时不能 dispose
    geos.forEach((g) => (g.userData.shared = true));
    mat.userData.shared = true;

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const sz = new THREE.Vector3();
    box.getSize(sz);

    dogCache = {
      geos,
      mat,
      hips: meta.hips,
      knees: meta.knees,
      bodyTop: bb.max.y,
      size: [sz.x, sz.y, sz.z],
    };
  } catch (e) {
    console.warn('[dog] GLB 加载失败，回退程序化机器人:', e);
    dogCache = null;
  }
  return dogCache;
}

/** 用 GLB 组装机器人。proto 为 null 时回退到程序化版本。 */
export function makeQuadruped(proto: DogProto | null, color: number): QuadrupedParts {
  if (!proto) return makeQuadrupedFallback(color);

  const group = new THREE.Group();
  // 模型导出后头朝 +Z，而场景约定（与 heading = atan2 一致）为头朝 -Z，这里整体掉头
  const wrap = new THREE.Group();
  wrap.rotation.y = Math.PI;
  wrap.scale.setScalar(DOG_SCALE);
  group.add(wrap);

  const body = new THREE.Mesh(proto.geos[0], proto.mat);
  body.castShadow = true;
  // GLB 里躯干的几何自带高度，节点基准就是 0。
  // knee 必须为负：真模型的膝朝正方向弯会把脚蹬进地面 3.3 cm（离线实测），
  // 取负号后最坏情况 -0.005，肉眼看不出来
  body.userData.baseY = 0;
  body.userData.gait = { hip: 0.26, knee: -0.48 };
  wrap.add(body);

  const legs: Array<{ hip: THREE.Group; knee: THREE.Group }> = [];
  DOG_LEGS.forEach((leg, i) => {
    const h = proto.hips[leg];
    const k = proto.knees[leg];
    const hip = new THREE.Group();
    hip.position.set(h[0], h[1], h[2]);
    const knee = new THREE.Group();
    // knee 挂在 hip 下，所以位置要相对髋
    knee.position.set(k[0] - h[0], k[1] - h[1], k[2] - h[2]);
    const up = new THREE.Mesh(proto.geos[1 + i * 2], proto.mat);
    const lo = new THREE.Mesh(proto.geos[2 + i * 2], proto.mat);
    up.castShadow = true;
    lo.castShadow = true;
    hip.add(up);
    knee.add(lo);
    hip.add(knee);
    wrap.add(hip);
    legs.push({ hip, knee });
  });

  // 顶部雷达：兼作状态指示灯（CampusScene 靠 emissive === 0x35e0ff 找到它）
  const lidar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.105, 0.06, 12),
    new THREE.MeshStandardMaterial({
      color: 0x39424c, emissive: 0x35e0ff, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.5,
    })
  );
  lidar.position.set(0, proto.bodyTop + 0.03, 0.28); // 机身前部（wrap 内 +Z 为前）
  wrap.add(lidar);

  return { group, body, lidar, legs };
}

// ---------------------------------------------------------------- VRPTW 车辆
export function makeVan(color: number) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.25 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.95), mat);
  body.position.y = 0.38; body.castShadow = true;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.3, 0.3), mat);
  cab.position.set(0, 0.34, 0.58); cab.castShadow = true;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x9fd6ef, roughness: 0.1, metalness: 0.6 }));
  glass.position.set(0, 0.38, 0.74);
  const wheelGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.08, 10);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.9 });
  for (const [x, z] of [[-0.27, 0.32], [0.27, 0.32], [-0.27, -0.3], [0.27, -0.3]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.12, z);
    g.add(w);
  }
  g.add(body, cab, glass);
  return g;
}

// ---------------------------------------------------------------- 天空
export function makeSkyTexture(top: string, bottom: string) {
  const c = document.createElement('canvas'); c.width = 2; c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top); grad.addColorStop(1, bottom);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
