// 验证宇树 B2 组装后的几何：脚底是否贴地、步态最大摆幅时是否穿地、朝向是否正确
import fs from 'node:fs';
import * as THREE from 'three';

const OUT = 'E:/agent-work/数据结构-笔记/校园巡视/_models_raw/rig_check.txt';
const MODEL = 'E:/agent-work/数据结构-笔记/校园巡视/public/models/unitree_b2.glb';
const META = 'E:/agent-work/数据结构-笔记/校园巡视/public/models/unitree_b2.meta.json';

const L = [];
const say = (s) => L.push(s);
const f3 = (v) => Number(v).toFixed(3);

globalThis.document = globalThis.document || {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }),
  createElementNS: () => ({ style: {} }),
};
globalThis.self = globalThis.self || globalThis;
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');

const buf = fs.readFileSync(MODEL);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));
const meta = JSON.parse(fs.readFileSync(META, 'utf-8'));

const meshes = [];
gltf.scene.traverse((o) => {
  if (o.isMesh) meshes.push(o);
});
say('部件数 = ' + meshes.length + ' (应为 9)');

// 与 builders.loadDogProto 同款处理：节点矩阵烘进顶点，腿段再转到关节原点
gltf.scene.updateMatrixWorld(true);
const geos = meshes.map((m) => {
  const g = m.geometry.clone();
  for (const key of ['position', 'normal', 'color']) {
    const a = g.attributes[key];
    if (!a || a.array instanceof Float32Array) continue;
    const n = a.count, item = a.itemSize;
    const out = new Float32Array(n * item);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < item; k++) out[i * item + k] = a.getComponent(i, k);
    }
    g.setAttribute(key, new THREE.BufferAttribute(out, item));
  }
  g.applyMatrix4(m.matrixWorld);
  return g;
});
['FL', 'FR', 'HL', 'HR'].forEach((leg, i) => {
  const h = meta.hips[leg];
  const k = meta.knees[leg];
  geos[1 + i * 2].translate(-h[0], -h[1], -h[2]);
  geos[2 + i * 2].translate(-k[0], -k[1], -k[2]);
});
meshes.forEach((m, i) => (m.geometry = geos[i]));

// ---- 按 CampusScene 的方式组装 ----
const group = new THREE.Group();
const wrap = new THREE.Group();
wrap.rotation.y = Math.PI; // 转为头朝 -Z
group.add(wrap);

const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
const body = new THREE.Mesh(meshes[0].geometry, mat);
wrap.add(body);

const LEG = ['FL', 'FR', 'HL', 'HR'];
const PHASES = [0, Math.PI, Math.PI, 0];
const legs = [];
LEG.forEach((leg, i) => {
  const h = meta.hips[leg];
  const k = meta.knees[leg];
  const hip = new THREE.Group();
  hip.position.set(h[0], h[1], h[2]);
  const knee = new THREE.Group();
  knee.position.set(k[0] - h[0], k[1] - h[1], k[2] - h[2]);
  const up = new THREE.Mesh(meshes[1 + i * 2].geometry, mat);
  const lo = new THREE.Mesh(meshes[2 + i * 2].geometry, mat);
  hip.add(up);
  knee.add(lo);
  hip.add(knee);
  wrap.add(hip);
  legs.push({ leg, hip, knee, lo });
});
group.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(group);
const sz = new THREE.Vector3();
box.getSize(sz);
say('');
say('整体 bbox size = ' + sz.toArray().map(f3).join(' x '));
say('整体 bbox min  = ' + box.min.toArray().map(f3).join(', '));
say('整体 bbox max  = ' + box.max.toArray().map(f3).join(', '));

// ---- 朝向：头应在 -Z。用「机身质心 z」与「头部最高部件 z」比较来判 ----
// 头部外壳在原始模型 target z≈+0.54，转 180° 后应落在 -Z
const bodyBox = new THREE.Box3().setFromObject(body);
say('');
say('躯干 bbox z = ' + f3(bodyBox.min.z) + ' .. ' + f3(bodyBox.max.z) + '   (对称则无方向信息)');
// 用几何不对称性判断：躯干含头部，取 z 方向上「截面积」分布
say('躯干 bbox y = ' + f3(bodyBox.min.y) + ' .. ' + f3(bodyBox.max.y));

// ---- 静止时四足最低点 ----
say('');
say('静止姿态各腿最低点:');
let minRest = Infinity;
legs.forEach((l) => {
  const b = new THREE.Box3().setFromObject(l.lo);
  minRest = Math.min(minRest, b.min.y);
  say(`  ${l.leg}  min.y = ${f3(b.min.y)}   (髋 y=${f3(l.hip.position.y)} 膝 y=${f3(l.hip.position.y + l.knee.position.y)})`);
});
say('  静止最低 = ' + f3(minRest) + (Math.abs(minRest) < 0.01 ? '  ✓ 贴地' : '  !! 未贴地'));

// ---- 扫一遍步态相位，找最低点（穿地检查）----
function lowestDuringGait(gait) {
  let worst = Infinity;
  let worstInfo = '';
  const N = 48;
  for (let s = 0; s < N; s++) {
    const t = (s / N) * 2 * Math.PI;
    legs.forEach((l, i) => {
      const p = PHASES[i];
      l.hip.rotation.x = gait.hip * Math.sin(t + p);
      l.knee.rotation.x = gait.knee * Math.max(0, Math.sin(t + p + Math.PI / 2));
    });
    group.updateMatrixWorld(true);
    for (let f = 0; f < 4; f++) {
      // precise=true：逐顶点算包围盒。默认的 AABB-of-AABB 在旋转后会明显高估，
      // 会把没穿地的姿态误报成穿地
      const b = new THREE.Box3().setFromObject(legs[f].lo, true);
      if (b.min.y < worst) {
        worst = b.min.y;
        worstInfo = `${legs[f].leg} @phase=${f3(t)}`;
      }
    }
  }
  return { worst, worstInfo };
}

say('');
say('步态穿地检查（负值 = 脚扫进地面，正值 = 抬离地面）:');
for (const g of [
  { name: 'hip+ knee+  0.22/0.42', hip: 0.22, knee: 0.42 },
  { name: 'hip+ knee-  0.22/0.42', hip: 0.22, knee: -0.42 },
  { name: 'hip- knee-  0.22/0.42', hip: -0.22, knee: -0.42 },
  { name: 'hip+ knee-  0.30/0.55', hip: 0.30, knee: -0.55 },
  { name: 'hip+ knee-  0.16/0.30', hip: 0.16, knee: -0.30 },
]) {
  const r = lowestDuringGait(g);
  say(`  ${g.name.padEnd(24)} 最低 ${f3(r.worst).padStart(7)}   (${r.worstInfo})  ${r.worst < -0.01 ? '!! 穿地' : 'ok'}`);
}

fs.writeFileSync(OUT, L.join('\n'), 'utf-8');
