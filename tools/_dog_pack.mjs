// bake 之后：放到 ASCII 临时目录 → gltfpack 多档压缩 → 校验 → 拷回 public/models
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'E:/agent-work/数据结构-笔记/校园巡视';
const SRC = ROOT + '/public/models/unitree_b2.glb';
const DST = ROOT + '/public/models';
const WORK = path.join(os.tmpdir(), 'dogpack2');
const NODE = process.execPath;
const CLI = ROOT + '/node_modules/gltfpack/cli.js';

const L = [];
const say = (s) => L.push(s);

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.copyFileSync(SRC, path.join(WORK, 'in.glb'));
say('输入 ' + (fs.statSync(SRC).size / 1024).toFixed(1) + ' KB');

const variants = [
  { tag: 'full', args: ['-kn', '-km', '-cc'] },
  { tag: 'si50', args: ['-kn', '-km', '-cc', '-si', '0.5'] },
  { tag: 'si30', args: ['-kn', '-km', '-cc', '-si', '0.3'] },
  { tag: 'si20', args: ['-kn', '-km', '-cc', '-si', '0.2'] },
];

for (const v of variants) {
  const out = v.tag + '.glb';
  try {
    execFileSync(NODE, [CLI, '-i', 'in.glb', '-o', out, ...v.args], { cwd: WORK, stdio: 'pipe' });
    say(`  ${v.tag.padEnd(6)} ${v.args.slice(2).join(' ').padEnd(12)} -> ${(fs.statSync(path.join(WORK, out)).size / 1024).toFixed(1).padStart(8)} KB`);
  } catch (e) {
    say('  ' + v.tag + ' FAIL: ' + (e.stderr ? e.stderr.toString('utf8').slice(0, 300) : e.message));
  }
}

// 拷回项目：full 为正式模型，si50 为轻量版
fs.copyFileSync(path.join(WORK, 'full.glb'), DST + '/unitree_b2.glb');
fs.copyFileSync(path.join(WORK, 'si50.glb'), DST + '/unitree_b2_lite.glb');
say('');
say('已拷回 public/models: unitree_b2.glb / unitree_b2_lite.glb');

// ---- 校验 ----
globalThis.document = globalThis.document || {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }),
  createElementNS: () => ({ style: {} }),
};
globalThis.self = globalThis.self || globalThis;
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');

say('');
say('档      体积     面数    部件(按 scene.children 顺序)');
for (const v of variants) {
  const p = path.join(WORK, v.tag + '.glb');
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  try {
    const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));
    let tri = 0;
    const seq = [];
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        const t = o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
        tri += t;
        seq.push(t);
      }
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const sz = new THREE.Vector3();
    box.getSize(sz);
    say(
      `${v.tag.padEnd(6)} ${(fs.statSync(p).size / 1024).toFixed(0).padStart(6)} KB ${String(tri).padStart(7)}   ` +
        `[${seq.join(',')}]  bbox=${sz.toArray().map((x) => x.toFixed(3)).join('x')} minY=${box.min.y.toFixed(3)}`
    );
  } catch (e) {
    say(v.tag + ' verify FAIL: ' + e.message);
  }
}

fs.writeFileSync(path.join(WORK, 'result.txt'), L.join('\n'), 'utf-8');
