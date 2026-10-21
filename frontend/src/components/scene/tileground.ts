// 官方地图瓦片地面：把 map.cup.edu.cn 的手绘 2.5D 栅格瓦片铺成本地 ENU 坐标系的地平面。
//
// 数据流：tools/download_cup_tiles.py 下载官方瓦片 + tools/bake_east_tiles.py
// 烘焙东校区补丁 → public/tiles/cup/{z}/{x}/{y}.png + tiles.json（瓦片存在清单）。
//
// 坐标：瓦片是 Web Mercator（XYZ），校园数据是局部米制（x 东 / z 南 / 1 单位 = 10 m）。
// 两套投影逐瓦片精确换算（每片四角 lon/lat → 局部矩形），不做线性近似——
// 纬度 40° 处 Mercator 与等距投影差 cos(40°)，直接平铺会把建筑错位几十米。
//
// LOD：按相机高度切层级（z16~z19），只给视锥内的瓦片加载纹理，LRU 控制显存
// （全部瓦片约 960 张 × 256 KB ≈ 240 MB，不能全驻留）。
import * as THREE from 'three';

export const ORIGIN = { lat: 40.2159, lng: 116.2449 };
const UNIT = 10;
const M_PER_DEG = 111320;
const COS0 = Math.cos((ORIGIN.lat * Math.PI) / 180);

/** 官方地图底色（占位瓦片 / 瓦片覆盖区外的地面色）。 */
export const MAP_BG = 0xe7e9db;

export function lngToLocalX(lng: number): number {
  return ((lng - ORIGIN.lng) * M_PER_DEG * COS0) / UNIT;
}
export function latToLocalZ(lat: number): number {
  return ((ORIGIN.lat - lat) * M_PER_DEG) / UNIT;
}

interface LevelMeta { x0: number; x1: number; y0: number; y1: number; tiles: string[] }
interface TileManifest { levels: Record<string, LevelMeta> }

/** 瓦片 (z,x,y) 在本地坐标系的矩形（xw~xe 东向，zn~zs 北→南）。 */
function tileLocalRect(z: number, x: number, y: number) {
  const n = Math.pow(2, z);
  const lon0 = (x / n) * 360 - 180;
  const lon1 = ((x + 1) / n) * 360 - 180;
  const latN = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const latS = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { xw: lngToLocalX(lon0), xe: lngToLocalX(lon1), zn: latToLocalZ(latN), zs: latToLocalZ(latS) };
}

interface TileEntry { mesh: THREE.Mesh; z: number; x: number; y: number; box: THREE.Box3 }

/** 层级切换阈值：相机高度（1 单位 = 10 m）低于阈值就用更高清的层级。 */
const LEVEL_BY_HEIGHT: Array<{ h: number; z: number }> = [
  { h: 24, z: 19 }, { h: 52, z: 18 }, { h: 105, z: 17 }, { h: Infinity, z: 16 },
];
const MAX_TEXTURES = 140;

export class TileGround {
  readonly group = new THREE.Group();
  /** 瓦片覆盖区域（本地单位），供 map 模式取景 / 底板尺寸使用 */
  readonly box = { x0: 0, x1: 0, z0: 0, z1: 0 };
  ready = false;

  private entries: TileEntry[] = [];
  private byKey = new Map<string, TileEntry>();
  private geo = new THREE.PlaneGeometry(1, 1);
  private placeholder: THREE.MeshBasicMaterial;
  private base: THREE.Mesh;
  private mats = new Map<string, THREE.MeshBasicMaterial>();
  private loader = new THREE.TextureLoader();
  private lru: string[] = [];
  private level = -1;
  private frustum = new THREE.Frustum();
  private mat4 = new THREE.Matrix4();
  private fades: Array<{ mat: THREE.MeshBasicMaterial; t0: number }> = [];
  private baseUrl: string;

  constructor(baseUrl = '/tiles/cup') {
    this.baseUrl = baseUrl;
    this.placeholder = new THREE.MeshBasicMaterial({ color: MAP_BG });
    // 底板：铺满瓦片覆盖区 + 外扩，瓦片缺失/出界处露出的就是官方底色
    this.base = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: MAP_BG }));
    this.base.rotation.x = -Math.PI / 2;
    this.base.renderOrder = -1;
    this.group.add(this.base);
    this.group.visible = false;
  }

  async load() {
    const res = await fetch(`${this.baseUrl}/tiles.json`);
    const manifest = (await res.json()) as TileManifest;
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const zs of Object.keys(manifest.levels)) {
      const z = +zs;
      const lvl = manifest.levels[zs];
      for (const key of lvl.tiles) {
        const [xs, ys] = key.split(',');
        const x = +xs, y = +ys;
        const r = tileLocalRect(z, x, y);
        const mesh = new THREE.Mesh(this.geo, this.placeholder);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set((r.xw + r.xe) / 2, 0, (r.zn + r.zs) / 2);
        mesh.scale.set(r.xe - r.xw, r.zs - r.zn, 1);
        mesh.userData.tileKey = `${z}/${x}/${y}`;
        mesh.visible = false;
        this.group.add(mesh);
        this.entries.push({
          mesh, z, x, y,
          box: new THREE.Box3(
            new THREE.Vector3(r.xw, -0.1, r.zn),
            new THREE.Vector3(r.xe, 0.1, r.zs)),
        });
        this.byKey.set(`${z}/${x}/${y}`, this.entries[this.entries.length - 1]);
        if (z === 16) {
          bx0 = Math.min(bx0, r.xw); bx1 = Math.max(bx1, r.xe);
          bz0 = Math.min(bz0, r.zn); bz1 = Math.max(bz1, r.zs);
        }
      }
    }
    this.box.x0 = bx0; this.box.x1 = bx1; this.box.z0 = bz0; this.box.z1 = bz1;
    // 底板略大于覆盖区即可：过大时远端被雾染成天色，会出现一块突兀的"色斑菱形"
    const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
    const sx = (bx1 - bx0) * 1.04 + 6, sz = (bz1 - bz0) * 1.04 + 6;
    this.base.position.set(cx, -0.02, cz);
    this.base.scale.set(sx, sz, 1);
    this.ready = true;
  }

  /** 每帧调用：切层级 + 视锥内瓦片加载纹理 + 淡入 + LRU 回收。 */
  update(camera: THREE.PerspectiveCamera, t: number, force = false) {
    if (!this.ready || !this.group.visible) return;
    const h = camera.position.y;
    let z = LEVEL_BY_HEIGHT[LEVEL_BY_HEIGHT.length - 1].z;
    for (const rule of LEVEL_BY_HEIGHT) {
      if (h < rule.h) { z = rule.z; break; }
    }
    if (z !== this.level || force) {
      this.level = z;
      for (const e of this.entries) e.mesh.visible = e.z === z;
    }
    // 视锥内瓦片按需加载（包围盒在 load() 里预计算，避免每帧 setFromObject）
    this.mat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.mat4);
    for (const e of this.entries) {
      if (e.z !== this.level || !e.mesh.visible) continue;
      const key = `${e.z}/${e.x}/${e.y}`;
      if (this.mats.has(key)) continue;
      if (!this.frustum.intersectsBox(e.box)) continue;
      this.loadTexture(e, key, t);
    }
    // 纹理淡入
    for (let i = this.fades.length - 1; i >= 0; i--) {
      const f = this.fades[i];
      const u = Math.min(1, (t - f.t0) / 0.35);
      f.mat.opacity = u;
      if (u >= 1) { f.mat.transparent = false; f.mat.opacity = 1; this.fades.splice(i, 1); }
    }
    // LRU：超出上限时释放最久未访问的纹理
    while (this.lru.length > MAX_TEXTURES) {
      const key = this.lru.shift()!;
      // 当前层的不能放
      if (+key.split('/')[0] === this.level) { this.lru.push(key); break; }
      const mat = this.mats.get(key)!;
      const entry = this.byKey.get(key);
      if (entry) entry.mesh.material = this.placeholder;
      mat.map?.dispose();
      mat.dispose();
      this.mats.delete(key);
    }
  }

  touch(key: string) {
    const i = this.lru.indexOf(key);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(key);
  }

  private loadTexture(e: TileEntry, key: string, t: number) {
    const mat = new THREE.MeshBasicMaterial({ color: MAP_BG });
    this.mats.set(key, mat);
    e.mesh.material = mat;
    this.loader.load(
      `${this.baseUrl}/${key}.png`,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        mat.map = tex;
        mat.color.set(0xffffff);
        mat.transparent = true;
        mat.opacity = 0;
        this.fades.push({ mat, t0: t });
        mat.needsUpdate = true;
        this.touch(key);
      },
      undefined,
      () => { /* 404 等：保持底色 */ },
    );
  }

  /** 昼夜氛围染色（乘色）。day = 原色。 */
  setTint(color: number) {
    this.placeholder.color.set(color);
    for (const m of this.mats.values()) m.color.set(color === 0xffffff ? 0xffffff : color);
    (this.base.material as THREE.MeshBasicMaterial).color.set(color === 0xffffff ? MAP_BG : color);
  }

  setMode(on: boolean) {
    this.group.visible = on;
    if (on) this.level = -1; // 强制下一帧重建层级
  }

  dispose() {
    for (const m of this.mats.values()) { m.map?.dispose(); m.dispose(); }
    this.mats.clear();
    this.placeholder.dispose();
    (this.base.material as THREE.Material).dispose();
    this.geo.dispose();
    this.group.clear();
  }
}

// ---------------------------------------------------------------- 官方风格标签
/** 官方地图样式的地名气泡：白底圆角 + 左侧分类色圆点 + 深灰粗体字。 */
export function makeMapLabelSprite(text: string, colorHex: number): THREE.Sprite {
  const fs = 26;
  const padX = 16, padL = 34;      // padL：左侧圆点区
  const h = 42;
  const c = document.createElement('canvas');
  const ctx0 = c.getContext('2d')!;
  ctx0.font = `600 ${fs}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  const textW = Math.ceil(ctx0.measureText(text).width);
  c.width = Math.min(560, textW + padX * 2 + padL);
  c.height = h;
  const ctx = c.getContext('2d')!;
  // 白底圆角
  const r = h / 2 - 2;
  ctx.beginPath();
  ctx.roundRect(1, 1, c.width - 2, h - 2, r);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,152,140,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // 左侧分类色圆点
  const dotR = 8;
  ctx.beginPath();
  ctx.arc(padL / 2 + 2, h / 2, dotR, 0, Math.PI * 2);
  ctx.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // 文本
  ctx.font = `600 ${fs}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.fillStyle = '#33383f';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padL + 4, h / 2 + 1, c.width - padL - padX);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  const worldH = 2.6;   // 世界高度（单位），updateLabels 会按屏幕高度再缩放
  sp.scale.set((c.width / c.height) * worldH, worldH, 1);
  return sp;
}

/** 选中建筑的轮廓高亮（map 模式放在瓦片上方）。 */
export function makeFootprintHighlight(ring: number[][]): THREE.LineLoop {
  const pts = ring.map(p => new THREE.Vector3(p[0], 0.12, p[1]));
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0x1e9e8a, transparent: true, opacity: 0.95, depthTest: false });
  const loop = new THREE.LineLoop(geo, mat);
  loop.renderOrder = 5;
  return loop;
}
