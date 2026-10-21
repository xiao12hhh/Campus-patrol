// 离线校验：在 Node 里跑一遍新的程序化场景构建，
// 核对性能预算，并逐台复核屋顶设备确实落在屋面安全环内（不穿女儿墙、不越屋面）。
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { LocalFeature } from '../frontend/src/lib/campus';
import { buildBuildingsDetailed, SIZE_OF, safeRoofRing, distToRing, pointInRing } from '../frontend/src/components/scene/roofkit';
import { buildRoadsPaved, buildRoadside, buildGroundCoverPaved } from '../frontend/src/components/scene/paving';
import { makeFacade } from '../frontend/src/components/scene/builders';
import { DETAIL_PRESETS, newBudget, DetailLevel } from '../frontend/src/components/scene/detailcfg';

// ---- canvas 桩：场景里的贴图都是 canvas 画的，Node 里给个空壳即可
const noop = () => { };
function stubCtx(size: number) {
  return new Proxy({} as any, {
    get(_t, k) {
      if (k === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop: noop });
      if (k === 'measureText') return () => ({ width: 100 });
      return noop;
    },
    set() { return true; },
  });
}
(globalThis as any).document = {
  createElement(tag: string) {
    if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
    return { width: 0, height: 0, getContext: () => stubCtx(256) };
  },
};

// 打包产物在 tools/_probe_out/probe.mjs，所以数据路径要往上退两级
const data = JSON.parse(readFileSync(new URL('../../public/data/campus-local.json', import.meta.url), 'utf-8'));
const features = data.features as LocalFeature[];
console.log(`数据 version=${data.version} 要素=${features.length}`);

function run(level: DetailLevel) {
  const budget = newBudget();
  const facadeMats: THREE.MeshStandardMaterial[] = [];
  const facades = [0, 1, 2, 3].map(s => makeFacade(s));

  const t0 = Date.now();
  const res = buildBuildingsDetailed(features, facades, facadeMats, { detail: level, budget });
  const tBuild = Date.now() - t0;

  const t1 = Date.now();
  const roads = buildRoadsPaved(features, budget);
  roads.group.add(buildRoadside(roads.centerlines, budget, DETAIL_PRESETS[level]));
  buildGroundCoverPaved(features, budget);
  const tPave = Date.now() - t1;

  console.log(`\n=== ${level} ===`);
  console.log(`建筑构建 ${tBuild} ms | 铺装构建 ${tPave} ms`);
  console.log(`drawcall≈${budget.drawCalls} 实例=${budget.instances} 三角面≈${Math.round(budget.triangles / 1000)}k`);
  console.log(`各类数量:`, budget.byPool);

  // ---- 逐台复核设备是否落在安全环内
  const rings: number[][][] = [];
  for (const f of features) {
    if (f.kind !== 'building' || f.in_campus === false) continue;
    const g = f.geometry;
    if (g.type === 'Polygon') rings.push(g.coordinates[0]);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) rings.push(poly[0]);
  }
  const cache = new Map<number, number[][]>();
  const safeOf = (ring: number[][]) => {
    if (!cache.has(ring.length)) cache.set(ring.length, [] as any);
    return safeRoofRing(ring);
  };

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), scl = new THREE.Vector3();
  let checked = 0, bad = 0, outside = 0;
  res.kit.children.forEach(im => {
    if (!(im instanceof THREE.InstancedMesh)) return;
    // 只复核屋顶设备（立面挂机 / 雨水管本来就在墙外侧，不参与这条约束）
    if (!im.name.startsWith('roof-')) return;
    const name = im.name.replace('roof-', '');
    const rad = SIZE_OF[name as keyof typeof SIZE_OF]?.r ?? 0;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      m.decompose(pos, q, scl);
      // 落点可能在轮廓边缘（内缩退化到几乎为零时会贴墙），用 6 cm 容差兜一下归属
      const home = rings.find(r => pointInRing(pos.x, pos.z, r))
        ?? rings.find(r => distToRing(pos.x, pos.z, r) < 0.06);
      if (!home) {
        outside++;
        if (outside <= 3) {
          // 打印离它最近的建筑，判断是真越界还是「轮廓本身有洞」
          let best = Infinity, bi = -1;
          rings.forEach((r, k) => {
            const d = distToRing(pos.x, pos.z, r);
            const inside = pointInRing(pos.x, pos.z, r);
            const score = inside ? -1 : d;
            if (score < best) { best = score; bi = k; }
          });
          console.log(`  越界样本 ${name}: (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)}) y=${pos.y.toFixed(2)} `
            + `最近轮廓 #${bi} 距离=${best.toFixed(3)} 点数=${rings[bi]?.length}`);
        }
        continue;
      }
      const r = rad * Math.max(scl.x, scl.z);
      const d = distToRing(pos.x, pos.z, safeOf(home));
      checked++;
      if (d < r - 1e-6) bad++;
    }
  });
  console.log(`设备核验: 复核 ${checked} 台，越界 ${bad} 台，不在任何建筑轮廓内 ${outside} 台`);

  // ---- NaN 检查：should必经 retile 后的 uv 不能出现 NaN
  let nanUv = 0;
  res.group.traverse(o => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const uv = g?.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!uv) return;
    for (let i = 0; i < uv.count * 2; i++) if (!Number.isFinite((uv.array as Float32Array)[i])) { nanUv++; break; }
  });
  console.log(`含 NaN 的 uv 缓冲: ${nanUv}`);
  return { budget, bad, outside, nanUv };
}

const std = run('standard');
run('lean');
run('rich');

const okGood = std.bad === 0 && std.outside === 0 && std.nanUv === 0;
console.log(`\n结论: ${okGood ? 'PASS' : 'FAIL'}`);

// ---- 追加：道路/绿地 merge 诊断（排查"路不渲染"） ----
{
  const budget = newBudget();
  // 拦截 mergeSafe 内部：直接数 buckets + 手动 merge
  const { group } = buildRoadsPaved(features, budget);
  console.log('[roads] group children =', group.children.length);
  group.children.forEach(m => {
    const g = m.geometry as any;
    console.log(`  - ${m.name}: tris=${(g.index ? g.index.count : g.attributes.position.count) / 3 | 0} pos=${!!g.attributes.position} uv=${!!g.attributes.uv} idx=${!!g.index}`);
  });
  const gc = buildGroundCoverPaved(features, budget);
  console.log('[ground] green children =', gc.green.children.length, 'parking =', gc.parking.children.length);
}
