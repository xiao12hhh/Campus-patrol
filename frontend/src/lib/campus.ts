// 校园数据类型与派生逻辑。
// 坐标约定与 campus-local.json 的 axis 一致：1 单位 = 10 米，x 向东、z 向南、y 向上。
// three.js 右手系下「x 东 / y 上」对应的正是 z 南，故世界坐标与数据坐标一一对应，不做取反。

export type FeatureKind =
  | 'building' | 'road' | 'water' | 'green' | 'pitch' | 'parking' | 'barrier' | 'poi';

export interface LocalFeature {
  id: string;
  kind: FeatureKind;
  name: string;
  height: number;
  /** 是否位于校园范围以内（校外要素作为城市背景渲染） */
  in_campus?: boolean;
  /** 所属校区：北校区 / 南校区 / 东校区 / 校外生活区 / 周边 */
  zone?: string;
  geometry: { type: string; coordinates: any };
  properties: Record<string, string>;
}

export interface CampusZone {
  name: string;
  rings: number[][][];
}

export interface CampusData {
  version: number;
  origin: { lat: number; lng: number };
  unit_meters: number;
  axis?: { x: string; y: string; z: string };
  license?: string;
  campus?: {
    name?: string;
    relation_id?: string;
    /** v2：单一 OSM 关系边界 */
    rings?: number[][][];
    /** v3：按校区拆分的边界（含东校区） */
    zones?: CampusZone[];
  };
  features: LocalFeature[];
}

/** 取全部校区边界环（兼容 v2 的 rings 与 v3 的 zones）。 */
export function campusRingsOf(c?: CampusData['campus']): number[][][] {
  if (c?.zones?.length) return c.zones.flatMap(z => z.rings ?? []);
  return c?.rings ?? [];
}

export type LandmarkCategory =
  | 'teaching' | 'office' | 'library' | 'dorm' | 'lab'
  | 'activity' | 'sports' | 'water' | 'plaza' | 'service';

export interface Landmark {
  id: string;
  name: string;
  x: number;
  z: number;
  category: LandmarkCategory;
  aliases: string[];
  height: number;
  area: number; // 平方单位（100 m²）
}

export const CATEGORY_LABEL: Record<LandmarkCategory, string> = {
  teaching: '教学', office: '办公', library: '图书馆', dorm: '宿舍',
  lab: '实验', activity: '活动', sports: '体育', water: '水景',
  plaza: '广场', service: '服务',
};

export const CATEGORY_COLOR: Record<LandmarkCategory, number> = {
  // 参考校方三维地图：主体为浅灰白/米白，窗带和阴影负责区分体块；
  // 不再按功能把整栋楼涂成棕、红、蓝等“沙盘色”。
  teaching: 0xe8ece9, office: 0xe4e8e6, library: 0xe5e9e7, dorm: 0xe9e5dc,
  lab: 0xe2e7e6, activity: 0xe8e4df, sports: 0xe1e6e4, water: 0x62aaca,
  plaza: 0xd8dcda, service: 0xe6e1d8,
};

const ALIASES: Record<string, string[]> = {
  '主教': ['主教学楼', '综合楼'],
  '阶教': ['阶梯教室'],
  '主楼A座': ['主楼', '主教', '主教学楼'],
  '主楼B座': ['主楼', '主教'],
  '主楼C座': ['主楼', '主教'],
  '第三教学楼': ['三教'],
  '第四教学楼': ['四教'],
  '第四教学楼（逸夫楼）': ['四教', '逸夫楼'],
  '第五教学楼': ['五教'],
  '东教学楼': ['东教'],
  '中油大厦': ['研修大厦'],
  '中油大厦A座': ['中油大厦', '研修大厦'],
  '中油大厦B座': ['中油大厦', '研修大厦'],
  '大学生活动中心': ['学活', '活动中心'],
  '学生活动中心': ['学活', '活动中心'],
  '北区办公室': ['北区办公楼'],
  '实验楼': ['实验楼', '实验室'],
  '图书馆': ['逸夫图书馆'],
  '红旗操场': ['操场', '田径场'],
  '第一食堂': ['一食堂'],
  '第二食堂': ['二食堂'],
  '第三食堂': ['三食堂'],
  '禾苑餐厅': ['禾苑'],
  '汇才学生公寓1号楼': ['汇才1号楼', '汇才一号楼'],
  '汇才学生公寓2号楼': ['汇才2号楼'],
  '汇才学生公寓3号楼': ['汇才3号楼'],
  '汇才学生公寓4号楼': ['汇才4号楼'],
  '汇才学生公寓5号楼': ['汇才5号楼'],
  '汇才学生公寓6号楼': ['汇才6号楼'],
  '汇才学生公寓7号楼': ['汇才7号楼'],
  '润杰学生公寓1号楼': ['润杰1号楼'],
  '润杰学生公寓2号楼': ['润杰2号楼'],
  '润杰学生公寓4号楼': ['润杰4号楼'],
  '润杰学生公寓5号楼': ['润杰5号楼'],
  '润杰学生公寓6号楼': ['润杰6号楼'],
  '阳光学生公寓1号楼': ['阳光1号楼'],
  '国际交流中心': ['国交中心', '国际交流大厦'],
  '青年园公寓1号楼': ['青年园1号楼'],
};

/** 取要素外环：Polygon / MultiPolygon → 首环；闭合 LineString（area=yes）→ 视作环。 */
export function ringOf(f: LocalFeature): number[][] | null {
  const g = f.geometry;
  if (g.type === 'Polygon') return g.coordinates[0] as number[][];
  if (g.type === 'MultiPolygon') return (g.coordinates[0]?.[0] ?? null) as number[][] | null;
  if (g.type === 'LineString') {
    const pts = g.coordinates as number[][];
    const first = pts[0], last = pts[pts.length - 1];
    if (pts.length > 2 && first && last && first[0] === last[0] && first[1] === last[1]) return pts;
  }
  return null;
}

export function lineOf(f: LocalFeature): number[][] | null {
  return f.geometry.type === 'LineString' ? (f.geometry.coordinates as number[][]) : null;
}

export function pointOf(f: LocalFeature): [number, number] | null {
  if (f.geometry.type !== 'Point') return null;
  const c = f.geometry.coordinates as number[];
  return [c[0], c[1]];
}

export function centroidOf(ring: number[][]): [number, number] {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
}

export function areaOf(ring: number[][]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

export function categoryOf(f: LocalFeature): LandmarkCategory {
  const p = f.properties || {};
  const name = f.name || '';
  if (f.kind === 'building') {
    // 官方 3D 源带语义化的 building 类型，优先级高于名称正则
    const bt = p.building || '';
    if (bt === 'student_bedroom' || bt === 'residential') return 'dorm';
    if (bt === 'experiment_building') return 'lab';
    if (bt === 'canteen') return 'service';
    if (/图书馆/.test(name)) return 'library';
    if (/教学楼|逸夫|阶教/.test(name)) return 'teaching';
    if (/号楼|公寓|宿舍/.test(name)) return 'dorm';
    if (/实验/.test(name)) return 'lab';
    if (/活动中心|学活/.test(name)) return 'activity';
    if (/健身|体育馆|游泳/.test(name)) return 'sports';
    if (/食堂|餐厅|超市|快递/.test(name)) return 'service';
    if (/办公|大厦/.test(name)) return 'office';
    if (bt === 'roof') return 'service';
    return 'office';
  }
  if (/pitch|stadium|sports_centre/.test(p.leisure || '')) return 'sports';
  if (/garden|water|swimming_pool|fountain/.test(`${p.leisure || ''}${p.natural || ''}${p.amenity || ''}`)) return 'water';
  if (p.amenity) return 'service';
  return 'service';
}

function displayName(name: string): string {
  return name.split(';')[0].trim();
}

/** 未命名设施按 OSM 标签推断展示名（运动场/球场等）。 */
function inferName(f: LocalFeature, p: Record<string, string>): string {
  const leisure = p.leisure || '';
  const sport = p.sport || '';
  if (leisure === 'stadium') return '田径场';
  if (leisure === 'pitch' || f.kind === 'pitch') {
    if (sport === 'basketball') return '篮球场';
    if (sport === 'soccer') return '足球场';
    if (sport === 'tennis') return '网球场';
    if (sport === 'volleyball') return '排球场';
    if (sport === 'badminton') return '羽毛球场';
    if (leisure === 'pitch') return '运动场';
    if (f.kind === 'pitch') return '运动场';
  }
  if (leisure === 'playground') return '运动场';
  if (p.amenity === 'parking' || f.kind === 'parking') return '停车场';
  if (/stadium/.test(leisure)) return '田径场';
  return '';
}

/** 从要素中提取地标（命名建筑 + 主要设施 POI）。 */
export function toLandmarks(features: LocalFeature[]): Landmark[] {
  const out: Landmark[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    // 地标只收录校内要素，校外建筑属于城市背景
    if (f.in_campus === false) continue;
    if (f.kind === 'building' && !f.name) continue;
    const p = f.properties || {};
    let name = displayName(f.name || '');
    let ring: number[][] | null = null;
    let center: [number, number] | null = null;

    if (f.geometry.type === 'Polygon') {
      ring = f.geometry.coordinates[0] as number[][];
      center = centroidOf(ring);
    } else if (f.geometry.type === 'MultiPolygon') {
      ring = f.geometry.coordinates[0]?.[0] as number[][];
      if (ring) center = centroidOf(ring);
    } else if (f.geometry.type === 'LineString') {
      const r = ringOf(f);
      if (r) { ring = r; center = centroidOf(r); }
      else {
        const pts = f.geometry.coordinates as number[][];
        center = centroidOf(pts);
      }
    } else if (f.geometry.type === 'Point') {
      const c = f.geometry.coordinates as number[];
      center = [c[0], c[1]];
    }
    if (!center) continue;

    // 无名字的要素先尝试按类型推断（运动场/球场），推断不出则不进地标列表
    if (!name) {
      name = inferName(f, p);
      if (!name) continue;
    }
    if (p.amenity === 'atm' || p.amenity === 'toilets') continue;
    if (seen.has(name)) continue;
    seen.add(name);

    out.push({
      id: f.id,
      name,
      x: +center[0].toFixed(2),
      z: +center[1].toFixed(2),
      category: categoryOf(f),
      aliases: ALIASES[name] || [],
      height: f.height || 0,
      area: ring ? +areaOf(ring).toFixed(1) : 0,
    });
  }
  return out;
}

/**
 * 地标标注的显示等级（数字越小越重要，越早出现）。
 * 全校 90+ 个地标若一次性全显，标牌会叠成好几层，所以按缩放分级：
 *   0 = 总览就能看到的主要建筑（教学楼 / 图书馆 / 体育馆 / 食堂 / 主楼 …）
 *   1 = 拉近后才出现的次级建筑（公寓楼 / 院系楼 / 研究院 …）
 *   2 = 贴近才出现的小体量设施（校门 / 门房 / 超市 / 快递 / 配电房 …）
 * 分级之外还有屏幕空间防重叠（见 CampusScene 的 updateLabels），两者叠加才干净。
 */
export function labelRank(l: Landmark): number {
  const n = l.name;
  // 2 级：校门 / 门房 / 生活配套 / 水景广场 / 各类运动场地 —— 总览时没有信息量
  if (/门$/.test(n)) return 2;
  if (l.category === 'water' || l.category === 'plaza') return 2;
  if (/保安亭|快递|配电|看台|超市|银行|吉野家|麦当劳|喷泉|荷花池|广场|操场|球场/.test(n)) return 2;
  // 1 级：宿舍楼群（数量最多，汇才 7 栋 + 润杰 6 栋 + 阳光 5 栋 …）+ 院系楼 / 实验室 / 研究院
  if (l.category === 'dorm' || /公寓|号楼/.test(n)) return 1;
  if (/实验楼|实验室|地质楼|化工楼|工程|理学院|研究院|科技楼|协同创新|校医院|招待所|办公室|勤工|北功厅|健身房/.test(n)) return 1;
  // 0 级：主要教学 / 图书 / 体育 / 餐饮 / 主楼 —— 总览就该看到
  if (/教学楼|主楼|图书馆|体育馆|游泳|食堂|餐厅|国际交流|中油大厦|活动中心|主教|阶教/.test(n)) return 0;
  if (l.category === 'teaching' || l.category === 'library') return 0;
  // 兜底：体量大的进 0 级，零星小房子进 1 级
  return l.area >= 6 ? 0 : 1;
}

/** 自动巡游站点顺序：北校区 → 南校区 → 东校区。 */
export const TOUR_ORDER = [
  '主楼A座', '图书馆', '地质楼', '第三教学楼', '第四教学楼', '学生活动中心',
  '第一食堂', '汇才学生公寓1号楼', '东教学楼', '教学实验中心', '东门',
  '中油大厦A座', '国际交流中心', '润杰学生公寓1号楼', '阳光学生公寓1号楼',
  '体育馆', '游泳馆', '红旗操场', '化工楼A座', '工程东楼',
];

export function matchLandmark(l: Landmark, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return false;
  return l.name.toLowerCase().includes(s) || l.aliases.some(a => a.toLowerCase().includes(s));
}
