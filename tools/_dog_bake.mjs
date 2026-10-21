// 机器狗 FBX → 分组减面 → 顶点色烘焙 → Z-up 转 Y-up → GLB
// 关键：整组合并后再 mergeVertices + simplify（逐零件做时碎片壳体焊不拢，减不动）
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as BGU from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';

const SRC = 'E:/agent-work/数据结构-笔记/校园巡视/_models_raw/fbx/fbx.fbx';
const GROUPS = 'E:/agent-work/数据结构-笔记/校园巡视/_models_raw/groups.json';
const OUT_DIR = 'E:/agent-work/数据结构-笔记/校园巡视/public/models';
const OUT_GLB = OUT_DIR + '/unitree_b2.glb';
const OUT_META = OUT_DIR + '/unitree_b2.meta.json';
const LOG = 'E:/agent-work/数据结构-笔记/校园巡视/_models_raw/bake.txt';

const BUDGET = Number(process.env.DOG_BUDGET || 30000);
const BODY_LEN = Number(process.env.DOG_LEN || 1.3);
const SPLIT_Z = 200;
// 顶部传感舱下沉：实测舱底 y≈0.99、机身顶 y≈0.88，中间 0.11 单位只有几根细支架
const TOP_DROP = Number(process.env.DOG_TOP_DROP ?? 0.11);
const TOP_A = 0.9, TOP_B = 1.0;

const L = [];
const say = (s) => L.push(s);
const f2 = (v) => Number(v).toFixed(2);
const f4 = (v) => Number(v).toFixed(4);

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }),
    createElementNS: () => ({ style: {} }),
  };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((b) => {
        this.result = b;
        this.onloadend && this.onloadend();
      });
    }
  };
}

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const groups = JSON.parse(fs.readFileSync(GROUPS, 'utf-8'));
  const groupOf = new Map(groups.map((g) => [g.name, g.group]));

  const buf = fs.readFileSync(SRC);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const root = new FBXLoader().parse(ab, '');
  root.updateMatrixWorld(true);

  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o);
  });

  const srcBox = new THREE.Box3();
  const tb = new THREE.Box3();
  meshes.forEach((m) => {
    m.geometry.computeBoundingBox();
    tb.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
    srcBox.union(tb);
  });
  const srcSize = new THREE.Vector3();
  srcBox.getSize(srcSize);
  const K = BODY_LEN / srcSize.y;
  const groundShift = -srcBox.min.z * K;

  const XF = new THREE.Matrix4().set(
    K, 0, 0, 0,
    0, 0, K, groundShift,
    0, -K, 0, 0,
    0, 0, 0, 1
  );

  const bucket = {};
  const put = (k, m) => ((bucket[k] = bucket[k] || []).push(m), true);
  meshes.forEach((m) => {
    m.geometry.computeBoundingBox();
    const b = new THREE.Box3().copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
    const c = new THREE.Vector3();
    b.getCenter(c);
    const gi = groupOf.get(m.name) || 'body';
    if (gi === 'body') put('body', m);
    else put(gi + (c.z < SPLIT_Z ? '_lo' : '_up'), m);
  });

  const triOf = (m) => (m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3);
  const TOTAL = meshes.reduce((a, m) => a + triOf(m), 0);
  say('meshes = ' + meshes.length + '  总面 = ' + TOTAL + '  预算 = ' + BUDGET);
  say('K = ' + f4(K) + '  groundShift = ' + f4(groundShift));

  await MeshoptSimplifier.ready;

  function compact(posArr, norArr, colArr, newIdx) {
    const remap = new Int32Array(posArr.length / 3).fill(-1);
    const P = [], N = [], C = [], I = new Uint32Array(newIdx.length);
    for (let k = 0; k < newIdx.length; k++) {
      const i = newIdx[k];
      let j = remap[i];
      if (j < 0) {
        j = P.length / 3;
        remap[i] = j;
        P.push(posArr[i * 3], posArr[i * 3 + 1], posArr[i * 3 + 2]);
        if (norArr) N.push(norArr[i * 3], norArr[i * 3 + 1], norArr[i * 3 + 2]);
        if (colArr) C.push(colArr[i * 3], colArr[i * 3 + 1], colArr[i * 3 + 2]);
      }
      I[k] = j;
    }
    return { P: new Float32Array(P), N: norArr ? new Float32Array(N) : null, C: colArr ? new Float32Array(C) : null, I };
  }

  function buildBucket(key) {
    const list = bucket[key] || [];
    if (!list.length) return null;
    const triIn = list.reduce((a, m) => a + triOf(m), 0);
    const target = Math.max(200, Math.round((BUDGET * triIn) / TOTAL));

    let parts = [];
    for (const m of list) {
      let g = m.geometry.clone();
      if (g.index) g = g.toNonIndexed();
      for (const k of Object.keys(g.attributes)) {
        if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      }
      g.applyMatrix4(m.matrixWorld);
      g.applyMatrix4(XF);
      if (!g.attributes.normal) g.computeVertexNormals();
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const col = mat && mat.color ? mat.color : new THREE.Color(0x808080);
      const cnt = g.attributes.position.count;
      const carr = new Float32Array(cnt * 3);
      for (let i = 0; i < cnt; i++) {
        carr[i * 3] = col.r;
        carr[i * 3 + 1] = col.g;
        carr[i * 3 + 2] = col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(carr, 3));
      parts.push(g);
    }
    let merged = BGU.mergeGeometries(parts, false);
    parts = null;
    merged = BGU.mergeVertices(merged, 1e-4);

    // 顶部传感舱靠 4 根细支架撑在机身顶上方约 0.11 单位处，减面后支架更细，
    // 远看像悬空。按高度「渐变下沉」：y<=0.90 不动、y>=1.00 下沉满 TOP_DROP，
    // 中间线性过渡 —— 支架被均匀压短，不会像硬切一刀那样断成两截。
    if (key === 'body' && TOP_DROP > 0) {
      const p = merged.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        const t = Math.min(1, Math.max(0, (y - TOP_A) / (TOP_B - TOP_A)));
        if (t > 0) p.setY(i, y - TOP_DROP * t);
      }
      p.needsUpdate = true;
    }
    const nIn = merged.index.count / 3;

    let idx = merged.index.array;
    let usedErr = 0;
    for (const err of [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1.0]) {
      try {
        const res = MeshoptSimplifier.simplify(
          new Uint32Array(idx),
          new Float32Array(merged.attributes.position.array),
          3,
          Math.max(60, Math.floor(target * 3)),
          err,
          []
        );
        idx = res[0];
        usedErr = err;
        if (idx.length / 3 <= target * 1.2) break;
      } catch (e) {
        say('    ! ' + key + ' err=' + err + ': ' + e.message);
      }
    }

    const c = compact(
      merged.attributes.position.array,
      merged.attributes.normal ? merged.attributes.normal.array : null,
      merged.attributes.color.array,
      idx
    );
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(c.P, 3));
    if (c.N) out.setAttribute('normal', new THREE.BufferAttribute(c.N, 3));
    out.setAttribute('color', new THREE.BufferAttribute(c.C, 3));
    out.setIndex(new THREE.BufferAttribute(c.I, 1));
    out.computeBoundingBox();
    return { geo: out, before: triIn, after: c.I.length / 3, target, usedErr, vertIn: nIn };
  }

  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0.32 });
  const meta = { hips: {}, knees: {}, stats: {} };

  say('');
  say('key       零件   原始面   焊接后   目标    产出    误差');
  for (const key of ['body', 'FL_up', 'FL_lo', 'FR_up', 'FR_lo', 'HL_up', 'HL_lo', 'HR_up', 'HR_lo']) {
    const r = buildBucket(key);
    if (!r) continue;
    let pivot = null;
    if (key !== 'body') {
      const bb = r.geo.boundingBox;
      const ctr = new THREE.Vector3();
      bb.getCenter(ctr);
      pivot = new THREE.Vector3(ctr.x, bb.max.y, ctr.z);
      r.geo.translate(-pivot.x, -pivot.y, -pivot.z);
      const leg = key.split('_')[0];
      if (key.endsWith('_up')) meta.hips[leg] = pivot.toArray().map((v) => +v.toFixed(4));
      else meta.knees[leg] = pivot.toArray().map((v) => +v.toFixed(4));
    }
    const mesh = new THREE.Mesh(r.geo, material);
    mesh.name = key === 'body' ? 'body' : key;
    // 几何已平移到 pivot 原点，必须把 pivot 写进节点的 translation，否则部件全堆在原点
    if (pivot) mesh.position.copy(pivot);
    scene.add(mesh);
    meta.stats[key] = { parts: (bucket[key] || []).length, before: r.before, after: r.after };
    say(
      `${key.padEnd(8)} ${String((bucket[key] || []).length).padStart(4)} ${String(r.before).padStart(9)} ` +
        `${String(r.vertIn).padStart(8)} ${String(r.target).padStart(7)} ${String(r.after).padStart(7)}  ${r.usedErr}`
    );
  }

  const glb = await new Promise((res, rej) => {
    new GLTFExporter().parse(scene, res, rej, { binary: true, onlyVisible: false });
  });
  fs.writeFileSync(OUT_GLB, Buffer.from(glb));
  const kb = fs.statSync(OUT_GLB).size / 1024;
  const totalTris = Object.values(meta.stats).reduce((s, v) => s + v.after, 0);
  meta.totalTris = totalTris;
  meta.bodyLen = BODY_LEN;
  meta.scaleK = +K.toFixed(8);
  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2), 'utf-8');

  say('');
  say('GLB = ' + f2(kb) + ' KB,  总面数 = ' + totalTris);
  say('RESULT: PASS');
} catch (e) {
  say('');
  say('=== FAILED ===');
  say(String((e && e.stack) || e));
  say('RESULT: FAIL');
}

fs.writeFileSync(LOG, L.join('\n'), 'utf-8');
