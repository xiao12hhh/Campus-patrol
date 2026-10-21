// 地面程序化铺装 —— 车行道 / 人行道 / 广场 / 草地的分材质贴图 + 路缘石 / 井盖 / 标线。
//
// 要点：
//   * 贴图全部运行时用 canvas 画（map + bumpMap + roughnessMap 三件套），不依赖外部素材；
//   * **按道路等级合并**：139 条路各一个 Mesh 改成 3~4 个合并几何，draw call 从 139 降到 4；
//   * UV 以「米」为单位写进几何（不是 0..1），所以贴图的世界尺寸与区域无关；
//     各校区给不同的砖块尺寸 / 铺法角度 / 色调，靠 uv 重标定实现，既掉不了画质也不加 draw call。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LocalFeature, ringOf, lineOf } from '../../lib/campus';
import { W, mulberry32 } from './builders';
import { M, SceneBudget, countTris, toTex, fbm } from './detailcfg';

// ---------------------------------------------------------------- 分区铺法
export interface PaveStyle { grassTile: number; paveTile: number; rot: number; tint: number }

/**
 * 按区域范围切换铺法 —— 键是 features[].zone。
 *   grassTile / paveTile：一张贴图代表多少米（越小图案越密）
 *   rot：铺装角度（弧度），非 0 就是斜铺
 *   tint：整体明暗，拉开各校区成色差异
 */
export const PAVE_BY_ZONE: Record<string, PaveStyle> = {
  '北校区': { grassTile: 3.0, paveTile: 1.2, rot: 0, tint: 1.0 },
  '南校区': { grassTile: 3.6, paveTile: 1.0, rot: Math.PI / 4, tint: 0.97 },
  '东校区': { grassTile: 2.6, paveTile: 0.9, rot: 0, tint: 1.04 },
  'default': { grassTile: 4.0, paveTile: 1.5, rot: 0, tint: 0.94 },
};

export const paveStyleOf = (zone?: string) => PAVE_BY_ZONE[zone || ''] ?? PAVE_BY_ZONE.default;

// ---------------------------------------------------------------- 道路宽度（1 单位 = 10 m）
const ROAD_WIDTH: Record<string, number> = {
  primary: 2.0, secondary: 1.6, tertiary: 1.35, tertiary_link: 1.0,
  residential: 1.05, unclassified: 0.95, living_street: 0.9,
  service: 0.65, proposed: 0.7,
  pedestrian: 0.8, footway: 0.5, path: 0.4,
};

const VEH_DASH = new Set(['primary', 'secondary', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street']);
const VEH_PLAIN = new Set(['service', 'proposed']);

const DASH_PERIOD = M(14);  // 标线贴图纵向周期：14 m 一片（一段虚线 + 一段空），远看不碎
const CURB_H = M(0.15);     // 路缘石顶面高出路面
const CURB_W = M(0.18);     // 路缘石宽
const MANHOLE_R = M(0.36);  // 井盖半径（0.72 m 直径）

// ================================================================ 贴图
interface PaveMaps { map: THREE.Texture; bumpMap?: THREE.Texture; roughnessMap?: THREE.Texture }

function cvs(size = 256) {
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  return { c, ctx: c.getContext('2d')! };
}

function lcg(seed: number) {
  let s = seed % 2147483647; if (s <= 0) s += 2147483646;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** 在已有底图上叠一层可变色的噪声（保持原亮度中心，只做颗粒感）。 */
function grain(ctx: CanvasRenderingContext2D, size: number, amp: number, seed: number) {
  const img = ctx.getImageData(0, 0, size, size);
  const nA = fbm(size, seed, 3, 6), nB = fbm(size, seed + 991, 2, 28);
  const d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = (nA(x, y) - 0.5) * amp + (nB(x, y) - 0.5) * amp * 0.6;
    const i = (y * size + x) * 4;
    d[i] += k; d[i + 1] += k; d[i + 2] += k;
  }
  ctx.putImageData(img, 0, 0);
}

/** 一块「有色 + 颗粒」的底图。 */
function baseFill(ctx: CanvasRenderingContext2D, size: number, base: number, amp: number, seed: number) {
  const img = ctx.createImageData(size, size);
  const nA = fbm(size, seed, 4, 4), nB = fbm(size, seed + 991, 3, 24);
  const d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = nA(x, y) * 0.72 + nB(x, y) * 0.28;
    const g = base + (v - 0.5) * amp;
    const i = (y * size + x) * 4;
    d[i] = g; d[i + 1] = g * 0.995; d[i + 2] = g * 0.98; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** 路面补丁 / 开挖回填：几块不规则的深浅色斑。 */
function patches(ctx: CanvasRenderingContext2D, size: number, seed: number, n = 7) {
  const r = lcg(seed);
  for (let i = 0; i < n; i++) {
    const cx = r() * size, cy = r() * size, rr = size * (0.06 + r() * 0.16);
    const dark = r() > 0.5;
    const grad = ctx.createRadialGradient(cx, cy, rr * 0.2, cx, cy, rr);
    grad.addColorStop(0, dark ? 'rgba(38,42,48,.5)' : 'rgba(150,158,166,.26)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    for (let a = 0; a <= 12; a++) {
      const th = (a / 12) * Math.PI * 2;
      const rr2 = rr * (0.7 + r() * 0.5);
      const px = cx + Math.cos(th) * rr2, py = cy + Math.sin(th) * rr2;
      a ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
}

/** 裂纹：几条带分叉的折线。 */
function cracks(ctx: CanvasRenderingContext2D, size: number, seed: number, n = 3, color = 'rgba(24,27,31,.7)') {
  const r = lcg(seed);
  ctx.strokeStyle = color;
  for (let i = 0; i < n; i++) {
    let x = r() * size, y = r() * size;
    ctx.lineWidth = 0.8 + r() * 1.2;
    ctx.beginPath(); ctx.moveTo(x, y);
    const steps = 4 + Math.floor(r() * 6);
    for (let k = 0; k < steps; k++) {
      x += (r() - 0.5) * size * 0.22; y += (r() - 0.5) * size * 0.22;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** 由彩色 map 反推 bump / roughness：把明度重映射成灰度图。 */
function deriveGray(srcCanvas: HTMLCanvasElement, map: (lum: number) => number): THREE.Texture {
  const size = srcCanvas.width;
  const src = srcCanvas.getContext('2d')!.getImageData(0, 0, size, size).data;
  const { c, ctx } = cvs(size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const lum = src[i * 4] * 0.3 + src[i * 4 + 1] * 0.59 + src[i * 4 + 2] * 0.11;
    const v = Math.max(0, Math.min(255, map(lum)));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTex(c, [1, 1], false);
}

const asPaveMaps = (canvas: HTMLCanvasElement, bump?: (l: number) => number, rough?: (l: number) => number): PaveMaps => {
  // 只放真正生成的键 —— 显式塞 undefined 会让 three 报 "parameter has value of undefined"
  const out: PaveMaps = { map: toTex(canvas, [1, 1]) };
  if (bump) out.bumpMap = deriveGray(canvas, bump);
  if (rough) out.roughnessMap = deriveGray(canvas, rough);
  return out;
};

/** 沥青 —— 车行道底图；withMarks 时再叠一层路面标线。 */
function asphaltMaps(withMarks: boolean): PaveMaps {
  const S = 256;
  const { c, ctx } = cvs(S);
  // 亮度 132：官方地图的车行道是"亮白路"，浅色在草地上一眼可辨，
  // 也让机器狗的巡检路线（沿路网）有清晰的底衬
  baseFill(ctx, S, 148, 18, withMarks ? 13 : 41);
  patches(ctx, S, 17, withMarks ? 6 : 9);
  cracks(ctx, S, 23, withMarks ? 2 : 4);
  // 轮迹带：沿车行方向（贴图 v 方向）的两道磨光痕迹
  ctx.fillStyle = 'rgba(126,133,141,.16)';
  ctx.fillRect(S * 0.22, 0, S * 0.1, S);
  ctx.fillRect(S * 0.68, 0, S * 0.1, S);
  if (withMarks) {
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillRect(S * 0.5 - S * 0.014, S * 0.08, S * 0.028, S * 0.38);
    ctx.strokeStyle = 'rgba(226,222,208,.4)'; ctx.lineWidth = S * 0.012;
    ctx.beginPath();
    ctx.moveTo(S * 0.055, 0); ctx.lineTo(S * 0.055, S);
    ctx.moveTo(S * 0.945, 0); ctx.lineTo(S * 0.945, S);
    ctx.stroke();
    // 标线磨损：用 destination-out 抠掉一部分漆
    ctx.globalCompositeOperation = 'destination-out';
    const r = lcg(911);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.25 + r() * 0.4})`;
      ctx.fillRect(S * 0.5 - S * 0.02, r() * S, S * 0.04, S * 0.012 * (1 + r() * 2));
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  return asPaveMaps(c, (l) => 128 + (l - 148) * 1.0, (l) => 195 + (l - 148) * 0.9);
}

/** 人行道砖 —— 板缝 + 逐块色差 + 缺角破损 + 水渍。 */
function slabMaps(cols: number): PaveMaps {
  const S = 256, cell = S / cols;
  const { c, ctx } = cvs(S);
  ctx.fillStyle = '#b9b8b2'; ctx.fillRect(0, 0, S, S);
  const r = lcg(313);
  for (let y = 0; y < cols; y++) for (let x = 0; x < cols; x++) {
    const k = (r() - 0.5) * 26;
    ctx.fillStyle = `rgba(${168 + k},${167 + k},${161 + k},.75)`;
    ctx.fillRect(x * cell + 1.2, y * cell + 1.2, cell - 2.4, cell - 2.4);
  }
  grain(ctx, S, 16, 77);
  // 板缝
  ctx.strokeStyle = 'rgba(96,96,93,.85)'; ctx.lineWidth = 1.6;
  for (let i = 0; i <= cols; i++) {
    const p = i * cell;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke();
  }
  // 污渍 / 树池水痕
  const r2 = lcg(1009);
  for (let i = 0; i < 10; i++) {
    const cx = r2() * S, cy = r2() * S, rr = S * (0.05 + r2() * 0.13);
    const g2 = ctx.createRadialGradient(cx, cy, 1, cx, cy, rr);
    g2.addColorStop(0, 'rgba(78,72,60,.30)'); g2.addColorStop(1, 'rgba(78,72,60,0)');
    ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
  }
  // 缺角砖
  ctx.fillStyle = 'rgba(70,68,64,.5)';
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(r2() * cols) * cell, y = Math.floor(r2() * cols) * cell;
    ctx.beginPath();
    ctx.moveTo(x, y + cell * 0.7); ctx.lineTo(x + cell * 0.55, y + cell); ctx.lineTo(x, y + cell);
    ctx.fill();
  }
  return asPaveMaps(c, (l) => (l > 152 ? 152 : 96 + (l - 96) * 0.45), (l) => 200 + (l - 168) * 1.2);
}

/** 广场花岗岩 —— 大块石材 + 火烧面细麻点。 */
function plazaMaps(): PaveMaps {
  const S = 256, cols = 4, cell = S / cols;
  const { c, ctx } = cvs(S);
  ctx.fillStyle = '#c3c0b8'; ctx.fillRect(0, 0, S, S);
  const r = lcg(51);
  for (let y = 0; y < cols; y++) for (let x = 0; x < cols; x++) {
    const k = (r() - 0.5) * 22;
    ctx.fillStyle = `rgba(${196 + k},${193 + k},${184 + k},.8)`;
    ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
  }
  grain(ctx, S, 14, 61);
  ctx.strokeStyle = 'rgba(132,130,124,.55)'; ctx.lineWidth = 1.2;
  for (let i = 0; i <= cols; i++) {
    const p = i * cell;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke();
  }
  return asPaveMaps(c, (l) => 128 + (l - 196) * 1.6, (l) => 176 + (l - 196) * 0.6);
}

/** 停车场位：沥青底 + 车位线（一个 tile = 6 m）。 */
function parkingMaps(): PaveMaps {
  const S = 256;
  const { c, ctx } = cvs(S);
  baseFill(ctx, S, 70, 24, 61);
  patches(ctx, S, 83, 5);
  ctx.strokeStyle = 'rgba(232,226,208,.6)'; ctx.lineWidth = S * 0.018;
  ctx.beginPath();
  ctx.moveTo(0, S * 0.5); ctx.lineTo(S, S * 0.5);
  for (let i = 0; i <= 2; i++) { const x = S * (0.25 + i * 0.25); ctx.moveTo(x, 0); ctx.lineTo(x, S); }
  ctx.stroke();
  return asPaveMaps(c, (l) => 128 + (l - 70) * 1.3, (l) => 210 + (l - 70) * 0.8);
}

/** 草地 —— 多尺度色斑 + 枯黄斑（作为灰度基准，实际颜色由顶点色给）。 */
function grassMaps(): PaveMaps {
  const S = 256;
  const { c, ctx } = cvs(S);
  const img = ctx.createImageData(S, S);
  const nA = fbm(S, 7, 4, 3), nB = fbm(S, 29, 3, 12), nC = fbm(S, 131, 2, 40);
  const d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = nA(x, y) * 0.55 + nB(x, y) * 0.32 + nC(x, y) * 0.13;
    const g = 150 + v * 74;
    const i = (y * S + x) * 4;
    d[i] = g; d[i + 1] = g * 0.99; d[i + 2] = g * 0.96; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const r = lcg(4099);
  for (let i = 0; i < 6; i++) {
    const cx = r() * S, cy = r() * S, rr = S * (0.08 + r() * 0.16);
    const g2 = ctx.createRadialGradient(cx, cy, 1, cx, cy, rr);
    g2.addColorStop(0, 'rgba(158,150,88,.3)'); g2.addColorStop(1, 'rgba(158,150,88,0)');
    ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
  }
  return asPaveMaps(c, (l) => 128 + (l - 150) * 1.1);
}

/** 井盖 —— 铸铁圆盖 + 放射状防滑槽 + 边缘凸起。 */
function manholeTexture(): THREE.Texture {
  const S = 128;
  const { c, ctx } = cvs(S);
  ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillRect(0, 0, S, S);
  ctx.beginPath(); ctx.arc(S / 2, S / 2, S * 0.47, 0, Math.PI * 2);
  ctx.fillStyle = '#5c6167'; ctx.fill();
  ctx.strokeStyle = '#82888e'; ctx.lineWidth = 3; ctx.stroke();
  ctx.strokeStyle = 'rgba(40,44,48,.55)'; ctx.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(S / 2 + Math.cos(a) * S * 0.14, S / 2 + Math.sin(a) * S * 0.14);
    ctx.lineTo(S / 2 + Math.cos(a) * S * 0.42, S / 2 + Math.sin(a) * S * 0.42);
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(S / 2, S / 2, S * 0.1, 0, Math.PI * 2);
  ctx.strokeStyle = '#8d9398'; ctx.lineWidth = 2; ctx.stroke();
  return toTex(c, [1, 1]);
}

// ================================================================ 几何辅助
/** uv 重标定：除以贴图代表的米数，可选旋转 —— 按分区切换铺法就靠它。 */
function rescaleUV(g: THREE.BufferGeometry, tileMeters: number, rot: number) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return;
  const k = 1 / (tileMeters / 10);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, (u * cs - v * sn) * k, (u * sn + v * cs) * k);
  }
  uv.needsUpdate = true;
}

function tintVertices(g: THREE.BufferGeometry, c: THREE.Color) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
}

function shapeGeom(ring: number[][]): THREE.BufferGeometry {
  return new THREE.ShapeGeometry(new THREE.Shape(ring.map(p => new THREE.Vector2(p[0], -p[1]))));
}

function mergeSafe(list: THREE.BufferGeometry[]) {
  try { return mergeGeometries(list, false); } catch { return null; }
}

/**
 * 路面条带：手搓三角面而不是 ExtrudeGeometry，顺手把 UV 写成物理尺度 ——
 *   车行道：u 横向 0..1（标线永远在正中间，与路宽无关），v 沿路线每 8 m 一个周期
 *   人行道：u / v 都按米计，路宽变化时砖块尺寸不会跟着变形
 * 这样同一种材质能同时服务宽窄不同的路。
 */
function ribbon(pts: THREE.Vector3[], width: number, opts: { across: 'uv01' | 'metres'; period: number }) {
  const pos: number[] = [], uv: number[] = [];
  const half = width / 2;
  const uEnd = opts.across === 'uv01' ? 1 : width / M(1.0);
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let nx = (b.z - a.z), nz = -(b.x - a.x);
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    const seg = a.distanceTo(b);
    const ax1 = a.x + nx * half, az1 = a.z + nz * half;
    const ax2 = a.x - nx * half, az2 = a.z - nz * half;
    const bx1 = b.x + nx * half, bz1 = b.z + nz * half;
    const bx2 = b.x - nx * half, bz2 = b.z - nz * half;
    const v0 = acc / opts.period, v1 = (acc + seg) / opts.period;
    // 绕序必须让叉积法线朝上(+y)，否则正面剔除——路从上空看会"消失"只剩侧面细线
    pos.push(ax1, a.y, az1, ax2, a.y, az2, bx1, b.y, bz1);
    uv.push(0, v0, uEnd, v0, 0, v1);
    pos.push(ax2, a.y, az2, bx2, b.y, bz2, bx1, b.y, bz1);
    uv.push(uEnd, v0, uEnd, v1, 0, v1);
    acc += seg;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// ================================================================ 道路
export interface Centerline { pts: THREE.Vector3[]; width: number; hw: string; inCampus: boolean }

export interface RoadsResult {
  group: THREE.Group;
  lampSpots: THREE.Vector3[];
  treeSpots: THREE.Vector3[];
  centerlines: Centerline[];
}

export function buildRoadsPaved(features: LocalFeature[], budget: SceneBudget): RoadsResult {
  const dashMat = new THREE.MeshStandardMaterial({ ...asphaltMaps(true), roughness: 0.92, metalness: 0 });
  const plainMat = new THREE.MeshStandardMaterial({ ...asphaltMaps(false), roughness: 0.95, metalness: 0 });
  const walkMat = new THREE.MeshStandardMaterial({ ...slabMaps(4), roughness: 0.9, metalness: 0 });
  const plazaMat = new THREE.MeshStandardMaterial({ ...plazaMaps(), roughness: 0.88, metalness: 0 });

  const buckets: Record<'dash' | 'plain' | 'walk' | 'plaza', THREE.BufferGeometry[]> =
    { dash: [], plain: [], walk: [], plaza: [] };
  const lampSpots: THREE.Vector3[] = [];
  const treeSpots: THREE.Vector3[] = [];
  const centerlines: Centerline[] = [];
  const rng = mulberry32(4242);
  let i = 0;

  for (const f of features) {
    if (f.kind !== 'road') continue;
    const line = lineOf(f);
    if (!line || line.length < 2) continue;
    const hw = f.properties?.highway || 'service';
    const width = ROAD_WIDTH[hw] ?? 0.55;
    const y = 0.05 + (i % 12) * 0.0035;
    const pts = line.map(p => W(p[0], y, p[1]));

    if (f.properties?.area === 'yes') {
      const ring = ringOf(f);
      if (ring) {
        const g = shapeGeom(ring);
        g.rotateX(-Math.PI / 2);
        g.translate(0, y, 0);
        const st = paveStyleOf(f.zone);
        rescaleUV(g, st.paveTile, st.rot);
        buckets.plaza.push(g);
      }
      i++;
      continue;
    }

    const kind = VEH_DASH.has(hw) ? 'dash' : VEH_PLAIN.has(hw) ? 'plain' : 'walk';
    buckets[kind].push(ribbon(pts, width, {
      across: kind === 'walk' ? 'metres' : 'uv01',
      period: kind === 'walk' ? M(1.0) : DASH_PERIOD,
    }));
    centerlines.push({ pts, width, hw, inCampus: f.in_campus !== false });

    // 行道树 + 路灯采样：只在校内撒（校外城市路网很长，撒了全是远处背景树），
    // 间距放宽到 4.2，树离路边至少 0.6 —— 树冠不再盖住路面
    if (f.in_campus !== false) {
      const lampable = hw === 'residential' || hw === 'unclassified' || hw === 'pedestrian';
      let acc = 0, li = 0;
      for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s], b = pts[s + 1];
        const seg = a.distanceTo(b);
        for (let d = 0.9; d < seg; d += 4.2) {
          const t = d / seg;
          const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
          const nx = (b.z - a.z), nz = -(b.x - a.x);
          const nl = Math.hypot(nx, nz) || 1;
          const side = rng() > 0.5 ? 1 : -1;
          const off = width / 2 + 0.6 + rng() * 0.3;
          treeSpots.push(new THREE.Vector3(px + (nx / nl) * off * side, 0, pz + (nz / nl) * off * side));
          acc += 4.2;
          if (lampable && acc > 5.5) {
            acc = 0; li++;
            const lside = li % 2 ? 1 : -1;
            const loff = width / 2 + 0.25;
            lampSpots.push(new THREE.Vector3(px + (nx / nl) * loff * lside, 1.1, pz + (nz / nl) * loff * lside));
          }
        }
      }
    }
    i++;
  }

  const group = new THREE.Group();
  const emit = (name: string, list: THREE.BufferGeometry[], mat: THREE.MeshStandardMaterial) => {
    if (!list.length) return;
    const g = list.length === 1 ? list[0] : mergeSafe(list);
    if (!g) return;
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = name;
    group.add(mesh);
    budget.drawCalls += 1;
    budget.triangles += countTris(g);
  };
  emit('road-dash', buckets.dash, dashMat);
  emit('road-plain', buckets.plain, plainMat);
  emit('road-walk', buckets.walk, walkMat);
  emit('road-plaza', buckets.plaza, plazaMat);

  return { group, lampSpots, treeSpots, centerlines };
}

// ================================================================ 路缘石 / 井盖
export function buildRoadside(centerlines: Centerline[], budget: SceneBudget,
  opt: { curb: boolean; manhole: boolean }): THREE.Group {
  const group = new THREE.Group();

  if (opt.curb) {
    const pos: number[] = [];
    for (const cl of centerlines) {
      if (!VEH_DASH.has(cl.hw) && !VEH_PLAIN.has(cl.hw)) continue;
      for (const sgn of [1, -1]) {
        for (let s = 0; s < cl.pts.length - 1; s++) {
          const a = cl.pts[s], b = cl.pts[s + 1];
          let nx = (b.z - a.z), nz = -(b.x - a.x);
          const l = Math.hypot(nx, nz) || 1; nx = nx / l * sgn; nz = nz / l * sgn;
          const inA = { x: a.x + nx * cl.width / 2, z: a.z + nz * cl.width / 2 };
          const inB = { x: b.x + nx * cl.width / 2, z: b.z + nz * cl.width / 2 };
          const outA = { x: inA.x + nx * CURB_W, z: inA.z + nz * CURB_W };
          const outB = { x: inB.x + nx * CURB_W, z: inB.z + nz * CURB_W };
          const yT = a.y + CURB_H, yB = 0;
          pos.push(inA.x, yT, inA.z, outA.x, yT, outA.z, inB.x, yT, inB.z);
          pos.push(inB.x, yT, inB.z, outA.x, yT, outA.z, outB.x, yT, outB.z);
          pos.push(outA.x, yT, outA.z, outA.x, yB, outA.z, outB.x, yT, outB.z);
          pos.push(outB.x, yT, outB.z, outA.x, yB, outA.z, outB.x, yB, outB.z);
        }
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xcfccc6, roughness: 0.85 }));
      mesh.receiveShadow = true; mesh.name = 'curb';
      group.add(mesh);
      budget.drawCalls += 1;
      budget.triangles += countTris(g);
    }
  }

  if (opt.manhole) {
    const spots: THREE.Vector3[] = [];
    const rnd = mulberry32(20240923);
    const step = M(30);
    for (const cl of centerlines) {
      // 只在校内道路布井盖：校外那 89 段城市道路又长又远，撒上去只会白白堆实例
      if (!cl.inCampus) continue;
      if (!VEH_DASH.has(cl.hw) && !VEH_PLAIN.has(cl.hw)) continue;
      let acc = 0;
      for (let s = 0; s < cl.pts.length - 1; s++) {
        const a = cl.pts[s], b = cl.pts[s + 1];
        const seg = a.distanceTo(b);
        const room = Math.max(0, cl.width - MANHOLE_R * 2.6);
        let d = (step - acc % step) % step;
        for (; d < seg; d += step) {
          const t = d / seg;
          const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
          let nx = (b.z - a.z), nz = -(b.x - a.x);
          const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
          const off = (rnd() - 0.5) * room;
          spots.push(new THREE.Vector3(px + nx * off, a.y + M(0.02), pz + nz * off));
        }
        acc += seg;
      }
    }
    if (spots.length) {
      const g = new THREE.CircleGeometry(MANHOLE_R, 12);
      g.rotateX(-Math.PI / 2);
      const im = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({
        map: manholeTexture(), roughness: 0.7, metalness: 0.35, transparent: true,
      }), spots.length);
      const dummy = new THREE.Object3D();
      spots.forEach((p, k) => {
        dummy.position.copy(p);
        dummy.rotation.set(0, mulberry32(k * 977 + 3)() * Math.PI * 2, 0);
        dummy.updateMatrix();
        im.setMatrixAt(k, dummy.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
      im.receiveShadow = true; im.name = 'manhole';
      group.add(im);
      budget.drawCalls += 1;
      budget.instances += spots.length;
      budget.triangles += countTris(g) * spots.length;
      budget.byPool.manhole = spots.length;
    }
  }
  return group;
}

// ================================================================ 地表覆盖
const GREEN_BY_LANDUSE: Record<string, number> = {
  forest: 0x5e7a55, wood: 0x5e7a55, grass: 0x6f8462, meadow: 0x77896a,
  village_green: 0x728563, recreation_ground: 0x728563, garden: 0x6a8060,
  park: 0x6a8060, cemetery: 0x5f7358, allotments: 0x677a5e, farmland: 0x7d8563,
};

export function buildGroundCoverPaved(features: LocalFeature[], budget: SceneBudget) {
  const green: THREE.Group = new THREE.Group();
  const parking: THREE.Group = new THREE.Group();
  const barriers: THREE.Group = new THREE.Group();

  const grassMat = new THREE.MeshStandardMaterial({
    ...grassMaps(), color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true,
  });
  const parkMat = new THREE.MeshStandardMaterial({ ...parkingMaps(), roughness: 0.94, metalness: 0 });

  const grassGeos: THREE.BufferGeometry[] = [];
  const parkGeos: THREE.BufferGeometry[] = [];

  for (const f of features) {
    if (f.kind === 'green') {
      const ring = ringOf(f);
      if (!ring || ring.length < 4) continue;
      const p = f.properties || {};
      const st = paveStyleOf(f.zone);
      const g = shapeGeom(ring);
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0.02, 0);
      rescaleUV(g, st.grassTile, st.rot);
      const c = new THREE.Color(GREEN_BY_LANDUSE[p.landuse || p.natural || p.leisure || 'grass'] ?? 0x86a86f);
      c.multiplyScalar(st.tint);
      tintVertices(g, c);
      grassGeos.push(g);
    } else if (f.kind === 'parking') {
      const ring = ringOf(f);
      if (!ring || ring.length < 4) continue;
      const st = paveStyleOf(f.zone);
      const g = shapeGeom(ring);
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0.03, 0);
      rescaleUV(g, 6, st.rot);
      parkGeos.push(g);
      barriers.add(new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(ring.map(p => W(p[0], 0.04, p[1]))),
        new THREE.LineBasicMaterial({ color: 0x70767d, transparent: true, opacity: 0.5 })));
      budget.drawCalls += 1;
    } else if (f.kind === 'barrier') {
      const line = lineOf(f);
      if (!line || line.length < 2) continue;
      barriers.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(line.map(p => W(p[0], 0.09, p[1]))),
        new THREE.LineBasicMaterial({ color: 0x8d949c, transparent: true, opacity: 0.55 })));
      budget.drawCalls += 1;
    }
  }

  // 草地全部合成 1 个几何：uv 已按分区烘焙好，所以「不同铺法」不需要额外 draw call
  if (grassGeos.length) {
    const g = grassGeos.length === 1 ? grassGeos[0] : mergeSafe(grassGeos);
    if (g) {
      const mesh = new THREE.Mesh(g, grassMat);
      mesh.receiveShadow = true; mesh.name = 'green';
      green.add(mesh);
      budget.drawCalls += 1;
      budget.triangles += countTris(g);
    }
  }
  if (parkGeos.length) {
    const g = parkGeos.length === 1 ? parkGeos[0] : mergeSafe(parkGeos);
    if (g) {
      const mesh = new THREE.Mesh(g, parkMat);
      mesh.receiveShadow = true; mesh.name = 'parking';
      parking.add(mesh);
      budget.drawCalls += 1;
      budget.triangles += countTris(g);
    }
  }
  return { green, parking, barriers };
}
