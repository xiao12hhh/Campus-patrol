// 程序化视觉细节的统一参数表 + 通用画布工具。
//
// 单位约定：campus-local.json 的 unit_meters = 10，即 **1 场景单位 = 10 米**。
// 本文件里所有尺寸都先写成「米」再经 M() 换算，避免到处出现 0.0xx 这种看不出含义的魔法数。

import * as THREE from 'three';

export type DetailLevel = 'lean' | 'standard' | 'rich';

export const DETAIL_LABEL: Record<DetailLevel, string> = {
  lean: '简约', standard: '标准', rich: '丰富',
};

/** 1 场景单位 = 10 米 */
export const UNIT_M = 10;
/** 米 → 场景单位 */
export const M = (metres: number) => metres / UNIT_M;

// ---------------------------------------------------------------- 参数表
export interface DetailCfg {
  /** 是否生成基座 / 檐口 / 女儿墙这些体块（关掉就退回原来的纯盒子） */
  blocks: boolean;
  /** 屋顶设备：每 100 m² 屋面的件数基准 */
  equipPer100m2: number;
  /** 单栋楼设备上限 */
  equipMaxPerBuilding: number;
  /** 小于这个屋面面积就不放设备（m²） */
  equipMinRoofArea: number;
  /** 立面：宿舍 / 教学楼等是否挂外机、雨水管 */
  facadeWallAC: boolean;
  facadeDownpipe: boolean;
  /** 地面：路缘石 / 井盖 */
  curb: boolean;
  manhole: boolean;
}

export const DETAIL_PRESETS: Record<DetailLevel, DetailCfg> = {
  lean: {
    blocks: true, equipPer100m2: 0.8, equipMaxPerBuilding: 8, equipMinRoofArea: 600,
    facadeWallAC: false, facadeDownpipe: false, curb: true, manhole: false,
  },
  standard: {
    blocks: true, equipPer100m2: 1.4, equipMaxPerBuilding: 16, equipMinRoofArea: 260,
    facadeWallAC: true, facadeDownpipe: true, curb: true, manhole: true,
  },
  rich: {
    blocks: true, equipPer100m2: 2.4, equipMaxPerBuilding: 28, equipMinRoofArea: 120,
    facadeWallAC: true, facadeDownpipe: true, curb: true, manhole: true,
  },
};

/** 按建筑类型给的体块与设备配方（对应官方源的 building 字段）。 */
export interface TierRecipe { eave: number; parapet: number; plinth: number }

export const TIER_BY_BUILDING: Record<string, TierRecipe> = {
  administration: { eave: 1.35, parapet: 1.15, plinth: 1.3 }, // 主楼：出檐深、女儿墙高
  teaching: { eave: 1.25, parapet: 1.05, plinth: 1.2 },
  library: { eave: 1.3, parapet: 1.1, plinth: 1.4 },
  experiment_building: { eave: 1.0, parapet: 0.95, plinth: 1.0 },
  student_bedroom: { eave: 0.9, parapet: 0.85, plinth: 0.9 },
  canteen: { eave: 1.1, parapet: 0.9, plinth: 1.1 },
  gymnasium: { eave: 1.5, parapet: 1.0, plinth: 1.2 },
  hospital: { eave: 1.0, parapet: 0.95, plinth: 1.1 },
  service_building: { eave: 0.95, parapet: 0.85, plinth: 0.9 },
  part_entrance: { eave: 1.8, parapet: 0.7, plinth: 1.0 },    // 校门：挑檐最深
  default: { eave: 1.0, parapet: 0.9, plinth: 1.0 },
};

// ---------------------------------------------------------------- 画布工具
export interface SceneBudget {
  drawCalls: number; instances: number; triangles: number;
  byPool: Record<string, number>;
}

export function newBudget(): SceneBudget {
  return { drawCalls: 0, instances: 0, triangles: 0, byPool: {} };
}

/** 把几何面数累加进预算表。 */
export function countTris(geo: THREE.BufferGeometry): number {
  const pos = geo.getAttribute('position');
  if (!pos) return 0;
  return geo.index ? geo.index.count / 3 : pos.count / 3;
}

// ---------------------------------------------------------------- 立面贴图分格
/**
 * 立面窗贴图的排版参数 —— builders.makeFacade 用它画，roofkit 用它反算 UV。
 * 两边必须一致，否则「窗行数 = 真实层数」对不上。
 *   cols/rows：一张贴图里几列几行窗
 *   rx/ry：贴图重复一次覆盖多少场景单位（1 单位 = 10 m）
 * 于是默认一个窗格 = 20m/6 ≈ 3.3 m 宽，20m/5 = 4 m 高 —— 正好是这组数据的层高。
 */
export const FACADE_TILE = { cols: 6, rows: 5, rx: 0.5, ry: 0.5 };

// ---------------------------------------------------------------- 画布工具
/** 建一块正方形离屏画布并返回 ctx。 */
export function mk(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/**
 * 逐像素写一张贴图。fn 返回 [r,g,b] 或灰度值，写进 ImageData。
 * 比在 canvas 上画上万条 line/rect 快得多，且能做真噪声。
 */
export function pixels(size: number, fn: (x: number, y: number, r: () => number) => [number, number, number] | number) {
  const [c, ctx] = mk(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  // 固定种子，保证每次刷新贴图一致（不会因为重绘而「跳」）
  let s = 0x9e3779b9;
  const rnd = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = fn(x, y, rnd);
      if (typeof v === 'number') { d[i] = d[i + 1] = d[i + 2] = v; }
      else { d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; }
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, ctx };
}

/** 把画布转成 RepeatWrapping 贴图。repeat 由调用方按需设置。 */
export function toTex(canvas: HTMLCanvasElement, repeat?: [number, number], srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  return t;
}

/** 值噪声 —— 双线性插值的格点随机，比纯白噪声更像材质里有尺度的东西。 */
export function valueNoise(size: number, cells: number, seed = 1) {
  const g = new Float32Array(cells * cells);
  let s = seed * 2654435761 % 2147483647;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const step = size / cells;
  return (x: number, y: number) => {
    const fx = x / step, fy = y / step;
    const x0 = Math.floor(fx) % cells, y0 = Math.floor(fy) % cells;
    const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[y0 * cells + x0], b = g[y0 * cells + x1];
    const c = g[y1 * cells + x0], d = g[y1 * cells + x1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
}

/** 多个八度的 fBm 噪声（0..1）。 */
export function fbm(size: number, seed = 1, octaves = 4, baseCells = 4) {
  const layers: Array<(x: number, y: number) => number> = [];
  let amp = 1, cells = baseCells, total = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push(valueNoise(size, Math.min(64, cells * 2 ** o), seed + o * 101));
    total += amp; amp *= 0.5;
  }
  return (x: number, y: number) => {
    let v = 0, a = 1;
    for (let o = 0; o < layers.length; o++) { v += layers[o](x, y) * a; a *= 0.5; }
    return v / total;
  };
}
