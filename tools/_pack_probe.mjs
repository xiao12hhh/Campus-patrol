import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK = path.join(os.tmpdir(), 'dogpack');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const SRC = 'E:/agent-work/数据结构-笔记/校园巡视/public/models/unitree_b2.glb';
fs.copyFileSync(SRC, path.join(WORK, 'in.glb'));

const LOG = path.join(WORK, 'probe.txt');
const L = [];
const say = (s) => L.push(s);

// 关键：进到 ASCII 目录，emscripten FS 才认得路径
process.chdir(WORK);
say('cwd = ' + process.cwd());
say('files = ' + fs.readdirSync(WORK).join(' | '));

try {
  const mod = await import('gltfpack');
  say('exports = ' + Object.keys(mod).join(','));
  await mod.pack(['-i', 'in.glb', '-o', 'A.glb', '-kn', '-km']);
  say('A ok, size = ' + (fs.existsSync('A.glb') ? fs.statSync('A.glb').size / 1024 : -1) + ' KB');
} catch (e) {
  say('try1 fail: ' + (e && e.message ? e.message : String(e)));
}

fs.writeFileSync(LOG, L.join('\n'), 'utf-8');
