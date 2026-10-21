import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK = path.join(os.tmpdir(), 'dogpack');
const LOG = path.join(WORK, 'verify.txt');
const L = [];
const say = (s) => L.push(s);

globalThis.document = globalThis.document || {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => null }),
  createElementNS: () => ({ style: {} }),
};
globalThis.self = globalThis.self || globalThis;

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');

for (const f of ['A.glb', 'B.glb', 'C.glb', 'D.glb']) {
  const p = path.join(WORK, f);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  try {
    const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));
    const names = [];
    let tri = 0;
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        const t = o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
        tri += t;
        names.push(o.name + '=' + t);
      }
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const sz = new THREE.Vector3();
    box.getSize(sz);
    say('');
    say(`--- ${f}  (${(fs.statSync(p).size / 1024).toFixed(1)} KB) ---`);
    say('  mesh 数 = ' + names.length + '   总面 = ' + tri);
    say('  ' + names.join('  '));
    say('  bbox size = ' + sz.toArray().map((v) => v.toFixed(3)).join(' x '));
    say('  bbox min  = ' + box.min.toArray().map((v) => v.toFixed(3)).join(', '));
  } catch (e) {
    say(f + ' FAIL: ' + e.message);
  }
}

fs.writeFileSync(LOG, L.join('\n'), 'utf-8');
