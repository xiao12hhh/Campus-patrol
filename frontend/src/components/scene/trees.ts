// 场景树木：栗树 PBR 贴图（来自 95.zip） + 交叉面片树冠。
// 每棵树 = 树干(12 三角形) + 3 片交叉面片(6 三角形)，全部走 InstancedMesh，
// 整片林子只占 2 个 draw call，两千多棵也不掉帧。
//
// 树冠贴图 leaf_cluster.png 由 tools/_leaf_cluster.py 离线合成：
// 把 Megascans 单叶 atlas 的 8 片叶子逐片随机旋转/缩放/叠放到 1024 画布
// （覆盖率 ~82%），RGBA 自带 alpha，配 alphaTest 二值化，避免半透明排序。
import * as THREE from 'three';
import { LocalFeature, ringOf } from '../../lib/campus';
import { mulberry32 } from './builders';

export interface TreeTex {
  /** 合成叶丛（RGB+alpha），交叉面片直接 alphaTest 抠形 */
  leafCluster: THREE.Texture;
  trunkDiffuse: THREE.Texture;
  trunkNormal: THREE.Texture;
  trunkRough: THREE.Texture;
}

/** 与 paving.ts 的 Centerline 结构兼容（避免跨模块耦合类型） */
export interface TreeCenterline {
  pts: THREE.Vector3[];
  /** 半路宽（场景单位） */
  hw: number;
  inCampus: boolean;
}

export interface TreeOptions {
  /** 行道树间距（场景单位，1 单位 = 10 m）。0.9 ≈ 9 m 一棵，接近真实行道树 */
  spacing?: number;
  /** 上限，防止极端数据下爆炸 */
  max?: number;
  /** 相机远时可整体关掉（由 CampusScene 的 LOD 控制） */
  seed?: number;
}

// 树的尺度（场景单位，1 单位 = 10 m）
const TRUNK_R0 = 0.10;   // 根部半径
const TRUNK_R1 = 0.075;  // 梢部半径
const TRUNK_H = 1.05;
const CROWN_Y = 1.42;    // 树冠中心高度
const CROWN_W = 1.28;    // 面片宽（收窄，树冠不压路面）
const CROWN_H = 1.24;    // 面片高
const CROWN_PLANES = 3;  // 交叉面片数

let texCache: TreeTex | null | undefined; // undefined = 还没加载

function loadTex(url: string, srgb: boolean): Promise<THREE.Texture> {
  return new Promise((res, rej) => {
    new THREE.TextureLoader().load(
      url,
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = 4;
        res(t);
      },
      undefined,
      rej
    );
  });
}

/** 加载树贴图（模块级缓存）。失败返回 null，场景回退到程序化方块树。 */
export async function loadTreeTextures(base = '/textures/tree'): Promise<TreeTex | null> {
  if (texCache !== undefined) return texCache;
  try {
    const [leafCluster, trunkDiffuse, trunkNormal, trunkRough] = await Promise.all([
      loadTex(`${base}/leaf_cluster.png`, true),
      loadTex(`${base}/trunk_diffuse.jpg`, true),
      loadTex(`${base}/trunk_normal.jpg`, false),
      loadTex(`${base}/trunk_rough.jpg`, false),
    ]);
    texCache = { leafCluster, trunkDiffuse, trunkNormal, trunkRough };
  } catch (e) {
    console.warn('[tree] 贴图加载失败，回退程序化树:', e);
    texCache = null;
  }
  return texCache;
}

function pointInRing(x: number, z: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 树干：略带锥度的六棱柱 */
function trunkGeo() {
  return new THREE.CylinderGeometry(TRUNK_R1, TRUNK_R0, TRUNK_H, 6, 1, true);
}

/**
 * 树冠：N 片绕 Y 轴均布的交叉面片。
 * 交叉面片从任何水平角度看都有体积感，且几何固定，可以直接塞进 InstancedMesh
 * （billboard 需要每帧朝相机，无法实例化）。
 */
function crownGeo() {
  const geos: THREE.BufferGeometry[] = [];
  // 竖直交叉面片：水平视角有体积感
  for (let k = 0; k < CROWN_PLANES; k++) {
    const g = new THREE.PlaneGeometry(CROWN_W, CROWN_H);
    g.rotateY((k / CROWN_PLANES) * Math.PI);
    g.translate(0, CROWN_Y, 0);
    geos.push(g);
  }
  // 水平封顶面片：俯视时竖直面片近乎侧棱、全是背光黑边，
  // 加两层朝上的叶盖，高空看才是官网那种绿色树团
  for (let k = 0; k < 2; k++) {
    const g = new THREE.PlaneGeometry(CROWN_W * (1.15 - k * 0.18), CROWN_H * (1.15 - k * 0.18));
    g.rotateX(-Math.PI / 2);
    g.rotateY(k * Math.PI * 0.5);
    g.translate(0, CROWN_Y + CROWN_H * (0.32 + k * 0.16), 0);
    geos.push(g);
  }
  const merged = new THREE.BufferGeometry();
  let vcount = 0;
  geos.forEach((g) => (vcount += g.attributes.position.count));
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  let vo = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i);
      pos[(vo + i) * 3 + 1] = p.getY(i);
      pos[(vo + i) * 3 + 2] = p.getZ(i);
      nor[(vo + i) * 3] = n.getX(i);
      nor[(vo + i) * 3 + 1] = n.getY(i);
      nor[(vo + i) * 3 + 2] = n.getZ(i);
      uv[(vo + i) * 2] = t.getX(i);
      uv[(vo + i) * 2 + 1] = t.getY(i);
    }
    vo += p.count;
    g.dispose();
  }
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return merged;
}

/**
 * 种树。tex 为 null 时返回 null（由调用方回退到旧的程序化方块树）。
 */
export function buildTrees(
  features: LocalFeature[],
  extraSpots: THREE.Vector3[],
  centerlines: TreeCenterline[],
  tex: TreeTex | null,
  opt: TreeOptions = {}
): THREE.Group | null {
  if (!tex) return null;
  // 密度：0.9 间距 + 2600 上限曾把校园盖成黑森林，树冠还压住路面 ——
  // 放宽到 1.5（≈15 m 一棵），上限砍到 1300，总观感是"行道树成排 + 绿地疏点"
  const spacing = opt.spacing ?? 1.5;
  const max = opt.max ?? 1300;
  const rng = mulberry32(opt.seed ?? 777);

  // ---- 阻挡区：建筑 / 水面 / 运动场 ----
  const blocked: number[][][] = [];
  for (const f of features) {
    const g = f.geometry;
    if (f.kind === 'building') {
      if (g.type === 'Polygon') blocked.push(g.coordinates[0]);
      else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) blocked.push(poly[0]);
    }
    if (f.kind === 'poi' || f.kind === 'water') {
      const p = f.properties || {};
      const ring = ringOf(f);
      if (ring && (p.leisure === 'garden' || p.leisure === 'swimming_pool' || p.amenity === 'fountain'
        || p.leisure === 'pitch' || p.leisure === 'stadium' || f.kind === 'water')) blocked.push(ring);
    }
  }
  // 三校区合并范围（留城市背景余量）
  const ok = (v: THREE.Vector3) => {
    if (v.x < -90 || v.x > 98 || v.z < -52 || v.z > 50) return false;
    for (const ring of blocked) if (pointInRing(v.x, v.z, ring)) return false;
    return true;
  };

  const spots: THREE.Vector3[] = [];
  const push = (v: THREE.Vector3) => {
    if (spots.length < max && ok(v)) spots.push(v);
  };

  // ---- 1) 行道树：沿车行道/人行道两侧等距成对布置（对齐官网那种成排效果）----
  for (const cl of centerlines) {
    if (!cl.inCampus) continue;
    for (let i = 1; i < cl.pts.length; i++) {
      const a = cl.pts[i - 1];
      const b = cl.pts[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const nx = -dz / len, nz = dx / len; // 法向
      let s = rng() * spacing * 0.4;
      while (s < len) {
        const t = s / len;
        const px = a.x + dx * t, pz = a.z + dz * t;
        const side = rng() > 0.5 ? 1 : -1;
        // 离路边至少 0.55（5.5 m）：树冠宽 ~1.3，再近就会悬到路面上
        const off = cl.hw + 0.55 + rng() * 0.25;
        // 主干道两侧都种，支路随机只种一侧，避免过于整齐
        const both = cl.hw > 0.30;
        push(new THREE.Vector3(px + nx * off * side, 0, pz + nz * off * side));
        if (both && rng() < 0.55) push(new THREE.Vector3(px - nx * off * side, 0, pz - nz * off * side));
        s += spacing * (0.85 + rng() * 0.45);
      }
    }
  }

  // ---- 2) 原有路侧采样点 + 建筑周边一圈 ----
  for (const s of extraSpots) if (rng() < 0.4) push(s);
  for (const ring of blocked) {
    const cx = ring.reduce((acc, q) => acc + q[0], 0) / ring.length;
    const cz = ring.reduce((acc, q) => acc + q[1], 0) / ring.length;
    const r = Math.max(...ring.map((q) => Math.hypot(q[0] - cx, q[1] - cz)));
    const n = Math.min(6, Math.max(2, Math.floor(r * 0.8)));
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2 + rng() * 0.5;
      const rr = r + 0.6 + rng() * 0.9;
      push(new THREE.Vector3(cx + Math.cos(ang) * rr, 0, cz + Math.sin(ang) * rr));
    }
  }

  if (!spots.length) return null;
  const count = spots.length;

  // ---- 材质 ----
  const trunkMat = new THREE.MeshStandardMaterial({
    map: tex.trunkDiffuse,
    normalMap: tex.trunkNormal,
    roughnessMap: tex.trunkRough,
    roughness: 0.95,
    metalness: 0,
  });
  const leafMat = new THREE.MeshStandardMaterial({
    map: tex.leafCluster,  // RGBA 叶丛图，alpha 通道直接参与 alphaTest
    alphaTest: 0.5,        // 二值化，不走半透明排序
    transparent: false,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
    // 交叉面片是竖直平面，阳光掠射时 N·L≈0 会黑成一坨；
    // 用同张贴图做自发光把暗部托起来（foliage 常规手法）——
    // 强度 0.85 + 偏黄绿的发光色，白天远看是"亮绿树团"而不是黑团
    emissive: new THREE.Color(0x5f7032),
    emissiveMap: tex.leafCluster,
    emissiveIntensity: 1.05,
  });

  const trunk = new THREE.InstancedMesh(trunkGeo(), trunkMat, count);
  const crown = new THREE.InstancedMesh(crownGeo(), leafMat, count);
  trunk.castShadow = true;
  crown.castShadow = false; // 面片投阴影代价大且效果差，只让树干投影

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  // instanceColor 会乘在贴图上：给浅色系微变（而不是深绿），否则整片树发黑
  const cA = new THREE.Color(1.15, 1.32, 0.92);
  const cB = new THREE.Color(1.7, 1.85, 1.35);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const s = spots[i];
    const sc = 0.85 + rng() * 0.55;          // 树高 1.6 ~ 2.4 单位（16~24 m）
    const yaw = rng() * Math.PI * 2;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    // 树干：从地面长起，底部在 y=0
    pos.set(s.x, (TRUNK_H / 2) * sc, s.z);
    scl.set(sc, sc, sc);
    m.compose(pos, q, scl);
    trunk.setMatrixAt(i, m);
    // 树冠：略扁一点更自然
    pos.set(s.x, 0, s.z);
    scl.set(sc, sc * (0.86 + rng() * 0.3), sc);
    m.compose(pos, q, scl);
    crown.setMatrixAt(i, m);
    crown.setColorAt(i, c.copy(cA).lerp(cB, rng()));
  }
  trunk.instanceMatrix.needsUpdate = true;
  crown.instanceMatrix.needsUpdate = true;
  if (crown.instanceColor) crown.instanceColor.needsUpdate = true;

  const group = new THREE.Group();
  group.add(trunk, crown);
  group.userData.treeCount = count;
  return group;
}
