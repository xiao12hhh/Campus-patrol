import {constrainFollowCamera} from '../frontend/src/lib/followCamera';
import {solveLeg,footCycle} from '../frontend/src/lib/legIK';
import { robotCollision, advanceRobot, motionHeading, travelPhase, labelWorldHeight } from '../frontend/src/lib/robotMotion';
// 离线校验：在 Node 里跑一遍新的程序化场景构建，
// 核对性能预算，并逐台复核屋顶设备确实落在屋面安全环内（不穿女儿墙、不越屋面）。
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { LocalFeature } from '../frontend/src/lib/campus';
import { buildBuildingsDetailed, SIZE_OF, safeRoofRing, distToRing, pointInRing, offsetRing } from '../frontend/src/components/scene/roofkit';
import { buildRoadsPaved, buildRoadside, buildGroundCoverPaved } from '../frontend/src/components/scene/paving';
import { makeFacade } from '../frontend/src/components/scene/builders';
import { DETAIL_PRESETS, newBudget, DetailLevel, FACADE_TILE } from '../frontend/src/components/scene/detailcfg';

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
const lean = run('lean');
const rich = run('rich');

const okGood = [std, lean, rich].every(r => r.bad === 0 && r.outside === 0 && r.nanUv === 0);
if (!okGood) process.exitCode = 1;
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

// 回归：源轮廓、世界坐标边线、官方楼层数不得被视觉处理改变。
{
  const assert = (ok: boolean, why: string) => { if (!ok) throw new Error(why); };
  const ring = [[10,20],[14,20],[14,23],[10,23],[10,20]];
  const sample: LocalFeature = { id: 'regression', name: '教学楼', kind: 'building',
    height: 2.4, in_campus: true, geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { source: 'map.cup.edu.cn', levels: '6', building: 'teaching' } };
  const result = buildBuildingsDetailed([sample], [makeFacade(0)], [], {detail:'lean', budget:newBudget()});
  const mesh = result.group.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;
  const g = mesh.geometry, pos = g.getAttribute('position'), uv = g.getAttribute('uv');
  const side = g.groups[1];
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, minV=Infinity, maxV=-Infinity;
  for(let i=side.start;i<side.start+side.count;i++) {
    minX=Math.min(minX,pos.getX(i)); maxX=Math.max(maxX,pos.getX(i));
    minY=Math.min(minY,pos.getY(i)); maxY=Math.max(maxY,pos.getY(i));
    minV=Math.min(minV,uv.getY(i)); maxV=Math.max(maxV,uv.getY(i));
  }
  assert(Math.abs(minX-10)<1e-5 && Math.abs(maxX-14)<1e-5, '建筑轮廓被缩放');
  assert(Math.abs(maxY-2.4)<1e-5, '建筑高度被压缩');
  // 可见立面在基座和檐口之间，六层窗必须精确铺满此范围。
  const visibleSpan = 2.4 - .045 - .12 * 1.2;
  const windowRows = (maxV-minV)/(maxY-minY)*visibleSpan*FACADE_TILE.ry*FACADE_TILE.rows;
  assert(Math.abs(windowRows-6)<1e-5, '窗格 UV 不符合六层楼高');
  const lines = result.group.children.find(o => (o as THREE.LineSegments).isLineSegments) as THREE.LineSegments;
  lines.geometry.computeBoundingBox();
  const box = lines.geometry.boundingBox!;
  assert(Math.abs(box.min.z-20)<1e-5 && Math.abs(box.max.z-23)<1e-5 && Math.abs(box.max.y-2.4)<1e-5,
    '边线重复旋转，脱离建筑');
  const concave = [[0,0],[4,0],[4,1],[1,1],[1,4],[0,4]];
  for (const input of [concave, [...concave].reverse()]) {
    const inset=offsetRing(input,-.1);
    assert(inset.every(p => pointInRing(p[0],p[1],concave)), '凹轮廓内缩方向错误');
  }
  console.log('[regression] footprint / height / six floors / edges / concave winding PASS');
}

{
  const feature: LocalFeature = {id:'wall',kind:'building',name:'wall',height:1,properties:{},
    geometry:{type:'Polygon',coordinates:[[[0,-4],[.05,-4],[.05,4],[0,4],[0,-4]]]}};
  const clear=robotCollision([feature]);
  if(clear({x:-1,z:0},{x:1,z:0})) throw new Error('Renderer interpolates through thin wall');
  const queue=[{x:-1,z:5},{x:1,z:5},{x:1,z:0}];
  let point={x:-1,z:0};
  for(let i=0;i<1000 && queue.length;i++) {
    const next=advanceRobot(point,queue,.3,clear);
    if(!clear(point,next)) throw new Error('Renderer cuts across patrol corner');
    point=next;
  }
  if(queue.length || Math.hypot(point.x-1,point.z)>0.001) throw new Error('Telemetry queue stalled');
  console.log('[robot-motion] thin walls / ordered corner interpolation PASS');
}

{
  // At 60 FPS a 0.35-unit/s stream must cover each sample evenly in one second.
  let point={x:0,z:0}; const queue=[{x:.35,z:0}];
  const speeds:number[]=[];
  for(let frame=0;frame<60;frame++) {
    const next=advanceRobot(point,queue,.35/60,()=>true);
    speeds.push(Math.hypot(next.x-point.x,next.z-point.z)*60);point=next;
  }
  if(Math.abs(point.x-.35)>1e-6 || Math.max(...speeds)-Math.min(...speeds)>.001)
    throw new Error('Robot movement pulses between telemetry samples instead of moving steadily');
  console.log('[robot-motion] steady 60 FPS telemetry playback PASS');
}

{
  for(const [dx,dz] of [[1,0],[0,1],[-1,0],[0,-1]]) {
    const yaw=motionHeading(dx,dz);
    if(Math.abs(-Math.sin(yaw)-dx)>1e-8 || Math.abs(-Math.cos(yaw)-dz)>1e-8) throw new Error('Model facing differs from travel');
  }
  const one=travelPhase(0,.35), many=Array.from({length:60}).reduce<number>(p=>travelPhase(p,.35/60),0);
  if(Math.abs(one-many)>1e-8 || travelPhase(one,0)!==one) throw new Error('Gait depends on frame rate or continues while stopped');
  console.log('[robot-motion] heading / distance-driven gait PASS');
}

{
  const upper={y:-.5,z:.15},lower={y:-.45,z:-.2};
  for(let i=0;i<100;i++) {
    const c=footCycle(i/100*Math.PI*2);
    const target={y:-.8+c.lift*.1,z:c.stride*.2};
    const result=solveLeg(upper,lower,target);
    const rotate=(p:{y:number;z:number},a:number)=>({y:p.y*Math.cos(a)-p.z*Math.sin(a),z:p.y*Math.sin(a)+p.z*Math.cos(a)});
    const u=rotate(upper,result.hip),l=rotate(lower,result.hip+result.knee);
    if(Math.hypot(u.y+l.y-target.y,u.z+l.z-target.z)>1e-6) throw new Error('IK foot misses ground target');
    if(i<50 && c.lift!==0) throw new Error('Stance foot lifts from ground');
  }
  console.log('[robot-IK] forward verification / planted stance PASS');
}

{
  for(const depth of [.15,.5,2,10,100]) {
    const world=labelWorldHeight(depth,50,900,20);
    const pixels=world/(2*depth*Math.tan(25*Math.PI/180))*900;
    if(Math.abs(pixels-20)>1e-8) throw new Error('Robot label grows with camera zoom');
  }
  console.log('[robot-label] projected 20px across camera distances PASS');
}

{
  const focus=new THREE.Vector3(0,.05,0);
  const wall=new THREE.Mesh(new THREE.BoxGeometry(3,2,.02),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  wall.position.set(0,1,.09);wall.updateMatrixWorld(true);
  const hit=(direction:THREE.Vector3,length:number)=>new THREE.Raycaster(focus,direction,0,length).intersectObject(wall)[0]?.distance;
  for(const initial of [new THREE.Vector3(0,.23,.42),focus.clone()]) {
    const result=constrainFollowCamera(focus,initial,hit);
    if(result.distanceTo(focus)<.22-1e-6)throw Error('Follow camera was squeezed into the robot body');
    const direction=result.clone().sub(focus).normalize();
    const distance=hit(direction,result.distanceTo(focus));
    if(distance!==undefined && distance<result.distanceTo(focus)-.01)throw Error('Follow camera crossed a wall');
  }
  console.log('[follow-camera] wall clearance / body exclusion PASS');
}
