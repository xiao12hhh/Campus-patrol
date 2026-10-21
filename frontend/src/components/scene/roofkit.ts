// 建筑体块的程序化细节 —— 在不逐栋建模的前提下把「一个挤出盒子」升级成
// 「基座 + 主体立面 + 檐口挑檐 + 女儿墙 + 压顶 + 屋顶设备」，
// 远景读得出体块关系，近景有立面层次。
//
// 三条硬约束：
//   1. **draw call 不翻量级** —— 一栋楼的多段体块合并成 1 个 Mesh，只多 1 个材质组（101 栋 → 303）；
//   2. **设备不穿模、不穿屋面** —— 撒点前把轮廓内缩成安全环，再逐件做「离边界距离 > 自身外接半径」判定；
//   3. **设备全实例化** —— 6 类设备各 1 个 InstancedMesh，与建筑栋数无关。
//
// 坐标：数据环是 [x, z]，写入 THREE.Shape 用 (x, -z)，再绕 X 轴 -90° 竖起，
// 于是局部 (x,y,z) → 世界 (x, z, -y)，挤出的 depth 就是世界高度。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LocalFeature, categoryOf, CATEGORY_COLOR } from '../../lib/campus';
import { FacadeSet, visualHeight, mulberry32 } from './builders';
import {
  DETAIL_PRESETS, DetailLevel, M, SceneBudget, countTris,
  FACADE_TILE, TIER_BY_BUILDING, toTex, fbm,
} from './detailcfg';

// ---------------------------------------------------------------- 体块尺寸基准
const PLINTH_H = M(1.2);        // 基座高
const PLINTH_OUT = M(0.22);     // 基座外扩
const CORNICE_T = M(1.1);       // 檐口带厚
const EAVE_OUT = M(0.55);       // 挑檐外挑
const DRIP_GAP = M(0.06);       // 檐口内侧滴水缝（顺带避免与立面共面导致 z-fighting）
const PARAPET_T = M(0.30);      // 女儿墙厚
const PARAPET_H = M(0.90);      // 女儿墙高
const PARAPET_OUT = M(0.03);    // 女儿墙外侧比立面外扩，同样为避开共面
const PARAPET_SINK = M(0.05);   // 往下埋进屋面的深度，用来藏掉底面
const COPING_OUT = M(0.18);     // 压顶出挑
const COPING_T = M(0.12);       // 压顶厚
const EQUIP_MARGIN = M(0.45);   // 设备离女儿墙内侧最小净距

// ---------------------------------------------------------------- 顶点色 AO
const AO_GROUND = 0.55;         // 底部最暗处亮度
const AO_GROUND_H = M(2.4);     // 底部渐隐高度
const AO_EAVE = 0.60;           // 檐下最暗处亮度
const AO_EAVE_H = M(1.6);       // 檐下渐隐高度

// ================================================================ 环几何
export function signedArea(ring: number[][]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return s / 2;
}

function normalizeRing(ring: number[][]): number[][] {
  const r = ring.slice();
  if (r.length > 1) {
    const a = r[0], b = r[r.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) r.pop();
  }
  return r;
}

/**
 * 屋面「可摆设备」的安全环 —— 轮廓向内退掉女儿墙厚度 + 外侧余量 + 最小净距。
 * 导出是为了让离线校验脚本能对每台设备复核「确实落在安全环内」。
 */
export function safeRoofRing(ring: number[][]): number[][] {
  const want = -(PARAPET_T + PARAPET_OUT + EQUIP_MARGIN);
  // 小体量 / 异形屋面全额内缩会退化（offsetRing 会直接退回原环），
  // 那就逐级降低内缩量重试 —— 至少保住一点离墙距离，别让设备贴到墙根上。
  const a0 = Math.abs(signedArea(ring));
  let last = ring;
  for (const k of [1, 0.55, 0.28]) {
    const out = offsetRing(ring, want * k);
    last = out;
    if (Math.abs(signedArea(out)) < a0 * 0.97) return out;  // 确实缩了，够用
  }
  return last;
}

/** 点到环的最短距离 —— 设备离屋面边缘的净距判定。 */
export function distToRing(x: number, z: number, ring: number[][]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], az = ring[j][1], bx = ring[i][0], bz = ring[i][1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}

export function pointInRing(x: number, z: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 环偏移（斜接 + 限幅）。d > 0 外扩、d < 0 内缩。
 * 方向取相邻两条边单位外法线之和（角平分线），长度再除以半角余弦；
 * 限幅 0.35（约 110°）防止极尖的角把自己翻出去。
 */
export function offsetRing(ring: number[][], d: number): number[][] {
  const r = normalizeRing(ring);
  if (r.length < 3 || Math.abs(d) < 1e-9) return r;
  let cx = 0, cz = 0;
  for (const p of r) { cx += p[0]; cz += p[1]; }
  cx /= r.length; cz /= r.length;

  const outward = (ax: number, az: number, bx: number, bz: number): THREE.Vector2 => {
    const dx = bx - ax, dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    const n = new THREE.Vector2(dz / l, -dx / l);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (n.x * (mx - cx) + n.y * (mz - cz) < 0) n.set(-n.x, -n.y);
    return n;
  };

  const out: number[][] = [];
  for (let i = 0; i < r.length; i++) {
    const prev = r[(i - 1 + r.length) % r.length], cur = r[i], next = r[(i + 1) % r.length];
    const nPrev = outward(prev[0], prev[1], cur[0], cur[1]);
    const nCur = outward(cur[0], cur[1], next[0], next[1]);
    const bis = new THREE.Vector2(nPrev.x + nCur.x, nPrev.y + nCur.y);
    if (bis.lengthSq() < 1e-12) bis.copy(nCur); else bis.normalize();
    const cosH = Math.max(0.35, Math.min(1, bis.x * nCur.x + bis.y * nCur.y));
    out.push([cur[0] + bis.x * (d / cosH), cur[1] + bis.y * (d / cosH)]);
  }
  // 退化保护：方向翻转或塌得太厉害就退回原环（宁可不出檐，也不要炸成一团）
  const a0 = signedArea(r), a1 = signedArea(out);
  if (a0 * a1 <= 0 || Math.abs(a1) < Math.abs(a0) * 0.25) return r;
  return out;
}

function shapeFrom(outer: number[][], inner?: number[][]): THREE.Shape {
  const s = new THREE.Shape();
  outer.forEach((p, i) => (i ? s.lineTo(p[0], -p[1]) : s.moveTo(p[0], -p[1])));
  s.closePath();
  if (inner && inner.length > 2) {
    const hole = new THREE.Path();
    inner.forEach((p, i) => (i ? hole.lineTo(p[0], -p[1]) : hole.moveTo(p[0], -p[1])));
    hole.closePath();
    s.holes.push(hole);
  }
  return s;
}

/** 把环从 y0 挤到 y1，旋转到世界坐标（局部 z → 世界 y）。 */
function extrudeUp(outer: number[][], inner: number[][] | undefined, y0: number, y1: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shapeFrom(outer, inner), { depth: Math.max(1e-4, y1 - y0), bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

const slab = (outer: number[][], y0: number, y1: number) => extrudeUp(outer, undefined, y0, y1);
const band = (outer: number[][], inner: number[][], y0: number, y1: number) => extrudeUp(outer, inner, y0, y1);

/**
 * 平面投影 UV —— 檐口 / 女儿墙这类「薄环绕一圈」的体块用 ExtrudeGeometry 自带 UV 会被拉花
 * （它的 v 是挤出厚度方向），所以改成按世界坐标重新投影：
 *   水平面 → (worldX, worldZ)；竖直面 → (沿墙切线长, worldY)。
 * scale = 1 / 贴图代表的米数对应单位数。
 */
function planarUV(g: THREE.BufferGeometry, scale: number) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    if (Math.abs(ny) > 0.7) {
      uv.setXY(i, px * scale, pz * scale);
    } else {
      const l = Math.hypot(nx, nz) || 1;
      const tx = -nz / l, tz = nx / l;
      uv.setXY(i, (px * tx + pz * tz) * scale, py * scale);
    }
  }
  uv.needsUpdate = true;
}

/**
 * 按真实层数重排立面 UV。
 * ExtrudeGeometry 给侧墙的 uv.y = 1 - z_local，故 z_local = 1 - uv.y 就是挤出方向的高度。
 * 把 v 改成 (z_local - z0) * kv 后，`levels` 行窗正好铺满 [z0, z0+span]，窗行数与楼层一一对应。
 */
function retileWall(g: THREE.BufferGeometry, kv: number, z0: number) {
  const side = g.groups.find(x => x.materialIndex === 1);
  if (!side) return;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = side.start; i < side.start + side.count; i++) {
    uv.setY(i, (1 - uv.getY(i) - z0) * kv);
  }
  uv.needsUpdate = true;
}

/** 从带 groups 的挤出体里切出某一段（ExtrudeGeometry：group0 = 顶底盖，group1 = 侧墙）。 */
function sliceGroup(g: THREE.BufferGeometry, matIndex: number): THREE.BufferGeometry {
  const grp = g.groups.find(x => x.materialIndex === matIndex);
  if (!grp) { const e = new THREE.BufferGeometry(); return e; }
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(g.attributes)) {
    const src = g.getAttribute(name) as THREE.BufferAttribute;
    const item = src.itemSize;
    const slice = src.array.slice(grp.start * item, (grp.start + grp.count) * item);
    out.setAttribute(name, new THREE.Float32BufferAttribute(Array.from(slice), item));
  }
  return out;
}

/**
 * 顶点色烘焙 AO —— 「檐口阴影 + 立面层次」的主力手段，运行时零开销。
 * tint 为 null 时只写 AO（立面材质自身带颜色）；有值时连同色调一起写进顶点色，
 * 这样屋面 / 混凝土可以共用同一个白色材质，靠顶点色区分每栋楼的色调。
 */
function paintAO(gs: THREE.BufferGeometry[], tint: THREE.Color | null, tWall: number) {
  for (const g of gs) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const arr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      let ao = 1;
      if (y < AO_GROUND_H) ao *= AO_GROUND + (1 - AO_GROUND) * (y / AO_GROUND_H);
      const below = tWall - y;
      if (below >= 0 && below < AO_EAVE_H) ao *= AO_EAVE + (1 - AO_EAVE) * (below / AO_EAVE_H);
      const t = tint ?? WHITE_ONES;
      arr[i * 3] = t.r * ao; arr[i * 3 + 1] = t.g * ao; arr[i * 3 + 2] = t.b * ao;
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  }
}

const WHITE_ONES = new THREE.Color(1, 1, 1);

// ================================================================ 共用材质
export interface SharedMats {
  felt: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  dispose(): void;
}

function gravelTexture(): HTMLCanvasElement {
  const size = 256;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const nA = fbm(size, 11, 4, 6), nB = fbm(size, 77, 3, 28);
  const d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = nA(x, y) * 0.62 + nB(x, y) * 0.38;
    const g = 118 + (v - 0.5) * 96;
    const i = (y * size + x) * 4;
    d[i] = g; d[i + 1] = g * 0.99; d[i + 2] = g * 0.96; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // 检修走道：几条浅色扁带
  ctx.fillStyle = 'rgba(214,210,202,.30)';
  for (let i = 0; i < 3; i++) ctx.fillRect(0, 42 + i * 84, size, 9);
  return c;
}

function concreteTexture(): HTMLCanvasElement {
  const size = 256;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const nA = fbm(size, 5, 4, 4), nB = fbm(size, 91, 2, 32);
  const d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = nA(x, y) * 0.75 + nB(x, y) * 0.25;
    const g = 214 + (v - 0.5) * 42;
    const i = (y * size + x) * 4;
    d[i] = g; d[i + 1] = g * 0.995; d[i + 2] = g * 0.975; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function makeSharedMats(): SharedMats {
  const feltMap = toTex(gravelTexture(), [2.5, 2.5]);
  const trimMap = toTex(concreteTexture(), [5, 5]);
  const felt = new THREE.MeshStandardMaterial({
    map: feltMap, color: 0xffffff, roughness: 0.96, metalness: 0, vertexColors: true,
  });
  const trim = new THREE.MeshStandardMaterial({
    map: trimMap, color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true,
  });
  return {
    felt, trim,
    dispose() { feltMap.dispose(); trimMap.dispose(); felt.dispose(); trim.dispose(); },
  };
}

// ================================================================ 屋顶设备
export type EquipKind = 'ac' | 'duct' | 'tank' | 'pipe' | 'mech' | 'vent';

export interface EquipDef { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial; castShadow: boolean }

/** 每种设备的底面外接半径与高度 —— 抽出来是为了撒点时不必先建几何。 */
export const SIZE_OF: Record<EquipKind, { r: number; h: number }> = {
  ac: { r: M(1.55), h: M(1.4) },
  duct: { r: M(4.1), h: M(1.5) },
  tank: { r: M(1.35), h: M(3.0) },
  pipe: { r: M(0.35), h: M(2.8) },
  mech: { r: M(3.9), h: M(3.3) },
  vent: { r: M(0.5), h: M(1.3) },
};

/** 按官方 building 类型给的屋面设备配方（权重）。 */
const RECIPES: Record<string, Partial<Record<EquipKind, number>>> = {
  student_bedroom: { ac: 4, vent: 3, tank: 1, duct: 1, pipe: 1, mech: 2 },
  experiment_building: { ac: 3, duct: 3, vent: 4, tank: 2, pipe: 2, mech: 2 },
  teaching: { ac: 3, duct: 2, tank: 1, vent: 1, pipe: 1, mech: 3 },
  administration: { ac: 3, duct: 2, tank: 1, vent: 1, pipe: 1, mech: 3 },
  library: { ac: 3, duct: 2, tank: 1, vent: 1, pipe: 1, mech: 3 },
  canteen: { duct: 5, vent: 4, ac: 2, tank: 1, pipe: 1, mech: 2 },
  service_building: { ac: 3, vent: 2, duct: 1, tank: 1, pipe: 1, mech: 1 },
  gymnasium: { ac: 2, duct: 4, vent: 2, tank: 1, pipe: 1, mech: 2 },
  hospital: { ac: 3, vent: 2, duct: 2, tank: 1, pipe: 1, mech: 2 },
  others: { ac: 2, vent: 2, tank: 1, pipe: 1 },
  default: { ac: 3, vent: 2, duct: 2, tank: 1, pipe: 1, mech: 2 },
};

/**
 * 大件的屋面面积门槛（m²）：楼梯间 / 电梯机房占地约 30 m²、风管长约 8 m，
 * 小屋面塞进去会挤得只剩设备，所以按面积决定放不放。
 */
const MIN_AREA: Partial<Record<EquipKind, number>> = { mech: 700, duct: 350 };

export function makePlantTexture(louver: boolean): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = louver ? '#b9bec4' : '#9aa0a7';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(60,66,74,.5)'; ctx.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.moveTo((size / 4) * i, 0); ctx.lineTo((size / 4) * i, size); ctx.stroke();
  }
  if (louver) {
    ctx.strokeStyle = 'rgba(48,54,60,.45)'; ctx.lineWidth = 1.5;
    for (let y = 6; y < size; y += 5) { ctx.beginPath(); ctx.moveTo(4, y); ctx.lineTo(size - 4, y); ctx.stroke(); }
    ctx.fillStyle = 'rgba(40,44,50,.5)';
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size * 0.26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(152,160,168,.85)';
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size * 0.22, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.strokeStyle = 'rgba(70,76,84,.4)'; ctx.lineWidth = 3;
    for (let x = 10; x < size; x += 22) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke(); }
  }
  const n = fbm(size, 3, 3, 16);
  const img = ctx.getImageData(0, 0, size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = (n(x, y) - 0.5) * 26, i = (y * size + x) * 4;
    d[i] += k; d[i + 1] += k; d[i + 2] += k;
  }
  ctx.putImageData(img, 0, 0);
  return toTex(c, [1, 1]);
}

export function makeEquipDefs(): Record<EquipKind, EquipDef> {
  const acTex = makePlantTexture(true);
  const ductTex = makePlantTexture(false);
  const metal = new THREE.MeshStandardMaterial({ color: 0xc8ccd1, roughness: 0.62, metalness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x6d7379, roughness: 0.8, metalness: 0.2 });

  const merge2 = (parts: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(parts, false)!;
    parts.forEach(p => p.dispose());
    return g;
  };

  // 空调机组：箱体 + 顶上的风机罩
  const ac = merge2((() => {
    const body = new THREE.BoxGeometry(M(2.6), M(1.2), M(1.6));
    const fan = new THREE.CylinderGeometry(M(0.45), M(0.45), M(0.18), 10);
    fan.translate(0, M(0.69), 0);
    return [body, fan];
  })());

  // 风管：矩形主管 + 端头立管
  const duct = merge2((() => {
    const main = new THREE.BoxGeometry(M(8.0), M(0.9), M(1.1));
    const riser = new THREE.BoxGeometry(M(1.0), M(1.4), M(1.0));
    riser.translate(M(-3.2), M(0.6), 0);
    return [main, riser];
  })());

  // 水箱：圆筒 + 顶盖 + 四条支腿
  const tank = merge2((() => {
    const parts: THREE.BufferGeometry[] = [];
    const body = new THREE.CylinderGeometry(M(1.2), M(1.2), M(2.2), 12);
    const cap = new THREE.CylinderGeometry(M(1.26), M(1.26), M(0.16), 12);
    cap.translate(0, M(1.18), 0);
    parts.push(body, cap);
    for (const [dx, dz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
      const leg = new THREE.BoxGeometry(M(0.16), M(0.7), M(0.16));
      leg.translate(M(dx), M(-1.45), M(dz));
      parts.push(leg);
    }
    return parts;
  })());

  // 立管束
  const pipe = merge2([-0.14, 0, 0.14].map((dx, k) => {
    const hgt = [1.0, 0.78, 0.9][k];
    const p = new THREE.CylinderGeometry(M(0.11), M(0.11), M(2.6 * hgt), 6);
    p.translate(M(dx), M(1.3 * hgt), 0);
    return p;
  }));

  // 楼梯间 / 电梯机房：主体 + 出屋面小女儿墙 + 门斗
  const mech = merge2((() => {
    const body = new THREE.BoxGeometry(M(6.0), M(3.0), M(4.6));
    body.translate(0, M(1.5), 0);
    const para = new THREE.BoxGeometry(M(6.3), M(0.35), M(4.9));
    para.translate(0, M(3.15), 0);
    const door = new THREE.BoxGeometry(M(1.4), M(2.1), M(0.2));
    door.translate(M(1.6), M(1.05), M(2.4));
    return [body, para, door];
  })());

  // 排风帽
  const vent = merge2((() => {
    const stack = new THREE.CylinderGeometry(M(0.32), M(0.36), M(1.1), 8);
    stack.translate(0, M(0.55), 0);
    const cap = new THREE.CylinderGeometry(M(0.46), M(0.46), M(0.14), 8);
    cap.translate(0, M(1.17), 0);
    return [stack, cap];
  })());

  return {
    ac: { geo: ac, mat: new THREE.MeshStandardMaterial({ map: acTex, roughness: 0.72, metalness: 0.18 }), castShadow: false },
    duct: { geo: duct, mat: new THREE.MeshStandardMaterial({ map: ductTex, roughness: 0.78, metalness: 0.12 }), castShadow: false },
    tank: { geo: tank, mat: metal, castShadow: false },
    pipe: { geo: pipe, mat: dark, castShadow: false },
    mech: { geo: mech, mat: new THREE.MeshStandardMaterial({ map: ductTex, color: 0xc2c7cd, roughness: 0.85 }), castShadow: true },
    vent: { geo: vent, mat: metal, castShadow: false },
  };
}

// ================================================================ 主构建
export interface BuildingsDetailed {
  group: THREE.Group;
  bboxes: Array<{ x0: number; x1: number; z0: number; z1: number }>;
  /** 屋顶设备 + 立面附件，单独成组便于按距离做 LOD */
  kit: THREE.Group;
  shared: SharedMats;
  equips: Record<EquipKind, EquipDef>;
}

interface Inst { x: number; z: number; y: number; yaw: number; s: number }

export function buildBuildingsDetailed(
  features: LocalFeature[],
  facades: FacadeSet[],
  facadeMats: THREE.MeshStandardMaterial[],
  opts: { detail: DetailLevel; budget: SceneBudget },
): BuildingsDetailed {
  const cfg = DETAIL_PRESETS[opts.detail];
  const shared = makeSharedMats();
  const equips = makeEquipDefs();
  const group = new THREE.Group();
  const kit = new THREE.Group();
  const bboxes: Array<{ x0: number; x1: number; z0: number; z1: number }> = [];
  const edgePos: number[] = [];
  const placed: Record<EquipKind, Inst[]> = { ac: [], duct: [], tank: [], pipe: [], mech: [], vent: [] };
  const wallUnits: Inst[] = [];
  const pipeUnits: Inst[] = [];

  let fi = 0;
  for (const f of features) {
    if (f.kind !== 'building') continue;
    const rings = ringsOfBuilding(f);
    if (!rings.length) continue;

    const p = f.properties || {};
    const outside = f.in_campus === false;
    const cat = categoryOf(f);
    const base = new THREE.Color(outside ? 0x9aa0a8 : CATEGORY_COLOR[cat]);
    const facade = facades[fi++ % facades.length];

    for (const rawRing of rings) {
      const ring = normalizeRing(rawRing);
      if (ring.length < 4) continue;
      // OSM 源（东校区等）没有实测高度，普遍矮一截；保底 1.2（12 m）避免"扁线框"
      const h = p.source === 'map.cup.edu.cn' ? visualHeight(f.height)
        : Math.max(1.2, visualHeight(f.height));
      bboxAdd(bboxes, ring);

      // ---- 校外背景楼：保持原来的简单盒子，不做体块、不放设备
      if (outside) {
        const geo = new THREE.ExtrudeGeometry(shapeFrom(ring), { depth: h, bevelEnabled: false });
        const wall = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.62), roughness: 0.95 });
        const roof = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.34), roughness: 0.95 });
        facadeMats.push(wall);
        const mesh = new THREE.Mesh(geo, [roof, wall]);
        mesh.rotation.x = -Math.PI / 2;
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.userData.landmarkName = (f.name || '').split(';')[0];
        mesh.userData.featureId = f.id;
        group.add(mesh);
        opts.budget.drawCalls += 2;
        opts.budget.triangles += countTris(geo);
        continue;
      }

      // ---- 校内楼：五段体块
      const levels = Math.max(1, Math.round(Number(p.levels) || Math.max(1, h * 10 / 3.6)));
      const hasBasement = (Number(p.min_level) || 0) < 0;
      const isGate = p.part === 'entrance_3d';
      const btype = isGate ? 'part_entrance' : (p.building || 'default');
      const tier = TIER_BY_BUILDING[btype] ?? TIER_BY_BUILDING.default;
      const tall = h >= M(18);

      const plinthH = Math.min(PLINTH_H * tier.plinth * (hasBasement ? 1.35 : 1), h * 0.3);
      const corniceT = Math.min(CORNICE_T, h * 0.22);
      const tWall = Math.max(h * 0.35, h - corniceT);         // 立面顶端（檐口底面）
      const eaveOut = EAVE_OUT * tier.eave * (tall ? 1.25 : 1);
      const parapetH = h < M(5) ? M(0.5) : PARAPET_H * tier.parapet;

      // 主体：一次挤出，之后按材质组切成「顶底盖 → 屋面」和「侧墙 → 立面」
      const bodyGeo = slab(ring, 0, h);
      const span = Math.max(h * 0.3, tWall - plinthH);
      const kv = levels / (FACADE_TILE.rows * FACADE_TILE.ry * span);
      retileWall(bodyGeo, kv, plinthH);
      const feltGeo = sliceGroup(bodyGeo, 0);
      const wallGeo = sliceGroup(bodyGeo, 1);
      planarUV(feltGeo, 2.5);
      planarUV(wallGeo, 2.5);

      const wall = new THREE.MeshStandardMaterial({
        color: base.clone().multiplyScalar(0.92),
        map: facade.map, emissive: new THREE.Color(0xffc27a),
        emissiveMap: facade.emissiveMap, emissiveIntensity: 0,
        roughness: 0.85, vertexColors: true,
      });
      facadeMats.push(wall);

      const trimGeos: THREE.BufferGeometry[] = [];
      if (cfg.blocks) {
        // 檐口挑檐：[外扩环, 立面环+滴水缝] 之间的一圈实体
        trimGeos.push(band(offsetRing(ring, eaveOut), offsetRing(ring, DRIP_GAP), tWall, h));
        // 基座：底部外扩一圈
        trimGeos.push(band(offsetRing(ring, PLINTH_OUT), offsetRing(ring, -M(0.02)), 0, plinthH));
        // 女儿墙：立在屋面上，底边埋进去 5 cm 藏掉底面
        const pOuter = offsetRing(ring, PARAPET_OUT);
        const pInner = offsetRing(ring, -PARAPET_T);
        trimGeos.push(band(pOuter, pInner, h - PARAPET_SINK, h + parapetH));
        // 压顶：比女儿墙两侧各出挑一点的一圈盖板
        trimGeos.push(band(offsetRing(ring, PARAPET_OUT + COPING_OUT),
          offsetRing(ring, -(PARAPET_T + COPING_OUT * 0.6)), h + parapetH, h + parapetH + COPING_T));
      }
      trimGeos.forEach(g => planarUV(g, 5));

      paintAO([feltGeo], new THREE.Color(base).multiplyScalar(0.58), tWall);
      paintAO([wallGeo], null, tWall);
      paintAO(trimGeos, new THREE.Color(1, 1, 1), tWall);

      // 注意：mergeGeometries 的 materialIndex 取自**输入数组下标**，
      // 所以必须先把 4 段装饰几何合成 1 个，再和屋面 / 立面一起合并，
      // 否则会拿到 materialIndex 2..5 而材质数组只有 3 项。
      const trimGeo = trimGeos.length ? mergeGeometries(trimGeos, false) : null;
      trimGeos.forEach(x => x.dispose());
      const parts: THREE.BufferGeometry[] = trimGeo ? [feltGeo, wallGeo, trimGeo] : [feltGeo, wallGeo];
      const geo = mergeGeometries(parts, true)!;
      parts.forEach(x => x.dispose());
      const mats: THREE.MeshStandardMaterial[] = [shared.felt, wall];
      if (trimGeo) mats.push(shared.trim);

      const mesh = new THREE.Mesh(geo, mats);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.landmarkName = (f.name || '').split(';')[0];
      mesh.userData.featureId = f.id;
      group.add(mesh);
      opts.budget.drawCalls += mats.length;
      opts.budget.triangles += countTris(geo);

      // 棱线：只取主体挤出体，保留「相邻建筑边界分明」的效果
      const eg = new THREE.EdgesGeometry(bodyGeo, 25);
      const arr = eg.attributes.position.array as ArrayLike<number>;
      for (let i = 0; i < arr.length; i += 3) edgePos.push(arr[i], arr[i + 2], -arr[i + 1]);
      eg.dispose();
      bodyGeo.dispose();

      // 屋顶设备 / 立面附件
      if (!isGate && cfg.equipPer100m2 > 0) {
        placeEquipment(ring, h, placed, cfg, f.id, p.building || 'default');
      }
      if (cfg.facadeWallAC && btype === 'student_bedroom' && levels >= 3) {
        addWallUnits(ring, tWall, plinthH, wallUnits, f.id);
      }
      if (cfg.facadeDownpipe && h > M(6)) addDownpipes(ring, h, pipeUnits, f.id);
    }
  }

  if (edgePos.length) {
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    group.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
      color: 0x39424d, transparent: true, opacity: 0.45, depthWrite: false,
    })));
    opts.budget.drawCalls += 1;
  }

  const dummy = new THREE.Object3D();
  const emit = (name: string, geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial,
    list: Inst[], castShadow: boolean, scaleOpt?: 'y') => {
    if (!list.length) { geo.dispose(); return; }
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.castShadow = castShadow;
    im.name = name;
    list.forEach((it, i) => {
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(0, it.yaw, 0);
      dummy.scale.setScalar(it.s);
      if (scaleOpt === 'y') dummy.scale.set(1, it.y, 1);
      dummy.position.set(it.x, scaleOpt === 'y' ? 0 : it.y, it.z);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    kit.add(im);
    opts.budget.drawCalls += 1;
    opts.budget.instances += list.length;
    opts.budget.triangles += countTris(geo) * list.length;
    opts.budget.byPool[name] = list.length;
  };

  (Object.keys(placed) as EquipKind[]).forEach(k => {
    const list = placed[k];
    if (!list.length) return;
    const def = equips[k];
    emit(`roof-${k}`, def.geo, def.mat, list, def.castShadow);
  });

  if (wallUnits.length) {
    const g = new THREE.BoxGeometry(M(0.9), M(0.55), M(0.32));
    emit('wall-ac', g, new THREE.MeshStandardMaterial({
      map: makePlantTexture(true), color: 0xdfe3e7, roughness: 0.7, metalness: 0.15,
    }), wallUnits, false);
  }
  if (pipeUnits.length) {
    const g = new THREE.CylinderGeometry(M(0.13), M(0.13), 1, 6);
    g.translate(0, 0.5, 0); // 底面落在 y=0，靠 scale.y 拉到目标高度
    emit('downpipe', g, new THREE.MeshStandardMaterial({ color: 0x7d838a, roughness: 0.75, metalness: 0.2 }),
      pipeUnits, false, 'y');
  }

  group.add(kit);
  return { group, bboxes, kit, shared, equips };
}

// ---------------------------------------------------------------- 撒点 / 立面附件
interface EquipCfg { equipPer100m2: number; equipMaxPerBuilding: number; equipMinRoofArea: number }

/**
 * 在一栋楼屋面上撒设备。
 * 先把轮廓**内缩**（女儿墙厚 + 外侧余量 + 安全净距）得到安全环，
 * 再对每个候选点检查「到安全环边界的距离 > 设备外接半径」，
 * 于是结构上保证了设备既压不到女儿墙、也不会越出屋面。
 */
function placeEquipment(
  ring: number[][], roofY: number,
  out: Record<EquipKind, Inst[]>, cfg: EquipCfg, id: string, btype: string,
) {
  const recipe = RECIPES[btype] ?? RECIPES.default;

  const safe = safeRoofRing(ring);
  const area = Math.abs(signedArea(safe)) * 100;   // 单位² → m²
  if (area < cfg.equipMinRoofArea) return;
  // 大件按面积门槛过滤（小屋面只放空调机组 / 风帽这类小东西）
  const kinds = (Object.keys(recipe) as EquipKind[])
    .filter(k => (recipe[k] || 0) > 0)
    .filter(k => area >= (MIN_AREA[k] ?? 0));
  if (!kinds.length) return;
  const want = Math.max(1, Math.min(cfg.equipMaxPerBuilding, Math.round(area / 100 * cfg.equipPer100m2)));

  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const q of safe) {
    x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
    z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]);
  }

  // 先放大件（楼梯间 / 风管），再放小件，避免大件最后塞不进去
  const sizes: Record<EquipKind, number> = { mech: 5, duct: 4, tank: 3, ac: 2, pipe: 1, vent: 1 };
  const bigs = kinds.filter(k => sizes[k] >= 4);
  const rnd = mulberry32(hashId(id));
  const taken: Array<{ x: number; z: number; r: number }> = [];

  let n = 0, tries = 0;
  const maxTries = want * 60;
  while (n < want && tries < maxTries) {
    tries++;
    const list = (n < Math.max(1, Math.round(want * 0.2)) && bigs.length) ? bigs : kinds;
    const wTot = list.reduce((a, k) => a + (recipe[k] || 0), 0);
    let acc = rnd() * wTot, kind = list[list.length - 1];
    for (const k of list) { acc -= recipe[k] || 0; if (acc <= 0) { kind = k; break; } }

    const def = SIZE_OF[kind];
    // 缩放系数只抽一次：撒点判定用的半径和实际写进实例的缩放必须是同一个值，
    // 否则「离墙距离够」的判定会失效，设备底脚可能越过安全环。
    const s = 0.85 + rnd() * 0.4;
    const rad = def.r * s;
    const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
    if (!pointInRing(x, z, safe)) continue;
    if (distToRing(x, z, safe) < rad) continue;
    let clash = false;
    for (const t of taken) {
      if (Math.hypot(t.x - x, t.z - z) < t.r + rad + M(0.35)) { clash = true; break; }
    }
    if (clash) continue;

    out[kind].push({
      x, z, y: roofY + def.h * 0.5, s,
      yaw: Math.round(rnd() * 4) * (Math.PI / 2) + (rnd() - 0.5) * 0.12,
    });
    taken.push({ x, z, r: rad });
    n++;
  }
}

/** 宿舍立面外挂空调机：沿墙每 9 m、每隔一层挂一台，挂在立面外 0.22 m。 */
function addWallUnits(ring: number[][], tWall: number, plinthH: number, out: Inst[], id: string) {
  const rnd = mulberry32(hashId(id) ^ 0x1234);
  const step = M(9.0);
  const stride = 2;
  const floors = Math.floor((tWall - plinthH) / M(4.0));
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < step * 0.6) continue;
    const nx = (b[1] - a[1]) / len, nz = -(b[0] - a[0]) / len;
    const yaw = Math.atan2(nx, nz);
    const n = Math.floor(len / step);
    for (let k = 0; k <= n; k++) {
      const t = (k + 0.5) / (n + 1);
      const x = a[0] + (b[0] - a[0]) * t + nx * M(0.22);
      const z = a[1] + (b[1] - a[1]) * t + nz * M(0.22);
      for (let fl = 1; fl < floors; fl += stride) {
        const y = plinthH + fl * M(4.0) + M(1.6);
        if (y > tWall - M(1.2)) break;
        if (rnd() < 0.25) continue;
        out.push({ x, z, y, yaw, s: 0.9 + rnd() * 0.2 });
      }
    }
  }
}

/** 雨水管：从檐口落到地面，沿轮廓每 15 m 一根。 */
function addDownpipes(ring: number[][], h: number, out: Inst[], id: string) {
  const rnd = mulberry32(hashId(id) ^ 0x5678);
  const step = M(15);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < step * 0.8) continue;
    const nx = (b[1] - a[1]) / len, nz = -(b[0] - a[0]) / len;
    const n = Math.max(1, Math.floor(len / step));
    for (let k = 0; k <= n; k++) {
      const t = (k + 0.5) / (n + 1);
      out.push({
        x: a[0] + (b[0] - a[0]) * t + nx * M(0.22),
        z: a[1] + (b[1] - a[1]) * t + nz * M(0.22),
        y: h * (0.94 + rnd() * 0.05), yaw: 0, s: 1,
      });
    }
  }
}

// ---------------------------------------------------------------- 小工具
function ringsOfBuilding(f: LocalFeature): number[][][] {
  const g = f.geometry;
  const out: number[][][] = [];
  if (g.type === 'Polygon') out.push(g.coordinates[0] as number[][]);
  else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) out.push(poly[0] as number[][]);
  return out.filter(r => r && r.length >= 4);
}

function bboxAdd(list: Array<{ x0: number; x1: number; z0: number; z1: number }>, ring: number[][]) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const p of ring) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]);
  }
  list.push({ x0: x0 - 0.6, x1: x1 + 0.6, z0: z0 - 0.6, z1: z1 + 0.6 });
}

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
