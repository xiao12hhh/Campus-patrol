import { useEffect, useMemo, useRef, useState } from 'react';
import CampusScene, { SceneHandle, TimeOfDay, LayerKey, DEFAULT_LAYERS, ViewPreset, FocusBox, Quality, QUALITY_LABEL, ViewMode } from './components/CampusScene';
import { DetailLevel, DETAIL_LABEL } from './components/scene/detailcfg';
import {
  getRobots, getEvents, controlMission, solveVRPTW, robotSocket,
  setRobotQueue, clearRobotQueue,
  Robot, RobotEvent, VRPTWSolution, Waypoint, LinkState,
} from './lib/api';
import { CampusData, toLandmarks, matchLandmark, CATEGORY_LABEL, Landmark, LandmarkCategory, campusRingsOf } from './lib/campus';

// v3 起原点移到三校区（北 / 南 / 东）整体中心；与 campus-local.json 的 origin 保持一致
const ORIGIN = { lat: 40.2159, lng: 116.2449 };
/** campus-local.json 的数据版本号，数据重建后手动 +1（配合 fetch 的 ?v= 穿透缓存） */
const DATA_VERSION = 7;
const LAT_M = 111320;
const toLatLng = (x: number, z: number) => ({
  lat: ORIGIN.lat - (z * 10) / LAT_M,
  lng: ORIGIN.lng + (x * 10) / (LAT_M * Math.cos((ORIGIN.lat * Math.PI) / 180)),
});
const mm = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmt = (v: number) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(Math.round(v % 60)).padStart(2, '0')}`;

// VRPTW 示例任务点：直接使用真实地标坐标，保证路线贴合校园。
const JOB_DEFS: Array<[string, number, [string, string], number]> = [
  ['主楼A座', 20, ['08:20', '09:40'], 10],
  ['图书馆', 15, ['08:30', '09:50'], 8],
  ['第三教学楼', 20, ['09:00', '10:30'], 8],
  ['中油大厦A座', 30, ['08:30', '10:30'], 12],
  ['第四教学楼', 15, ['09:20', '10:40'], 8],
  ['东教学楼', 15, ['08:10', '09:30'], 8],
  ['教学实验中心', 12, ['09:00', '10:30'], 6],
  ['国际交流中心', 10, ['08:00', '09:00'], 6],
  ['汇才学生公寓1号楼', 25, ['08:10', '09:30'], 10],
  ['实验楼', 12, ['09:10', '10:40'], 6],
];

// 初始机器人位置取 v3 真实地标坐标（主楼A座 / 体育馆 / 东校区主教）
const SEED_ROBOTS: Robot[] = [
  { id: 'SPOT-01', model: 'Unitree B2', status: '巡检中', x: -24.5, z: -5.5, battery: 82, signal: -58, mission: '北校区教学区巡检', progress: 0.1, heading: 0.3, route_name: '北校区教学区环线' },
  { id: 'SPOT-02', model: 'Boston Dynamics Spot', status: '巡检中', x: -33.4, z: -13.6, battery: 64, signal: -61, mission: '体育区巡检', progress: 0.1, heading: 1.2, route_name: '体育设施线' },
  { id: 'ANYmal', model: 'ANYmal C', status: '待命', x: 18.4, z: 24.8, battery: 91, signal: -50, mission: null, progress: 0, heading: -1 },
];

const TODS: Array<[TimeOfDay, string]> = [['dawn', '晨光'], ['day', '日间'], ['dusk', '黄昏'], ['night', '夜景']];
const LAYER_LABELS: Array<[LayerKey, string]> = [
  ['buildings', '建筑'], ['roads', '道路'], ['trees', '植被'], ['green', '绿地'],
  ['parking', '停车场'], ['water', '水体'], ['pitches', '运动场'],
  ['labels', '地名标注'], ['boundary', '校园边界'],
  ['robots', '机器人'], ['routes', '配送路线'], ['lamps', '路灯'],
];

type Module = 'campus' | 'robot' | 'route' | 'grid';

export default function App() {
  const sceneRef = useRef<SceneHandle>(null);
  const [module, setModule] = useState<Module>(() => {
    // 支持 ?m=robot / ?m=route 直达对应模块（也便于分享与自动化验证）
    const q = new URLSearchParams(location.search).get('m');
    return q === 'robot' || q === 'route' || q === 'grid' ? (q as Module) : 'campus';
  });
  const [campus, setCampus] = useState<CampusData | null>(null);
  const [robots, setRobots] = useState<Robot[]>(SEED_ROBOTS);
  const [events, setEvents] = useState<RobotEvent[]>([]);
  const [solution, setSolution] = useState<VRPTWSolution | null>(null);
  const [tod, setTod] = useState<TimeOfDay>(() => {
    // 分享链接里带 ?tod=，读回时生效（分享视角的另一半天)
    const t = new URLSearchParams(location.search).get('tod');
    return t === 'dawn' || t === 'dusk' || t === 'night' ? t : 'day';
  });
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ ...DEFAULT_LAYERS });
  // 视图模式：官方手绘地图（默认） / 程序化三维孪生
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = new URLSearchParams(location.search).get('v');
    return v === 'twin' ? 'twin' : 'map';
  });
  // 分享/自动化验证：?follow=SPOT-01 直接跟随机器狗，配合 ?fp=1 进第一人称
  const [followId, setFollowId] = useState<string | null>(() => new URLSearchParams(location.search).get('follow'));
  const [firstPerson, setFirstPerson] = useState(() => new URLSearchParams(location.search).get('fp') === '1');
  const [selectedRobot, setSelectedRobot] = useState('SPOT-01');
  // 任务队列草稿：先在界面上排好顺序，再一次性下发给选中的机器狗
  const [queueDraft, setQueueDraft] = useState<Waypoint[]>([]);
  const [queuePick, setQueuePick] = useState('');
  const [manualX, setManualX] = useState('');
  const [manualZ, setManualZ] = useState('');
  /** 点图加点：开着的时候点场景地面就往队列里塞一个站（比手填坐标好用得多） */
  const [addPoint, setAddPoint] = useState(() => new URLSearchParams(location.search).get('add') === '1');
  const [selectedLandmark, setSelectedLandmark] = useState<Landmark | null>(null);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<LandmarkCategory | null>(null);
  const [quality, setQuality] = useState<Quality>('high');
  const [autoQuality, setAutoQuality] = useState(true);
  /** 与后端的连接状态：断线时头部变黄并自动重连，界面数据退回轮询 */
  const [link, setLink] = useState<LinkState>('connecting');
  const linkRef = useRef<LinkState>('connecting');
  const [detail, setDetail] = useState<DetailLevel>('standard');
  const [tour, setTour] = useState({ active: false, paused: false, index: 0, total: 0, name: '' });
  const [vrptw, setVrptw] = useState({ clock: 480, playing: false, speed: 8, min: 470, max: 620 });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const notify = (s: string) => { setToast(s); setTimeout(() => setToast(''), 2600); };
  const landmarks = useMemo(() => (campus ? toLandmarks(campus.features) : []), [campus]);
  // v3 边界按校区拆分（北 / 南 / 东），展开成环列表交给场景渲染
  const campusRings = useMemo(() => campusRingsOf(campus?.campus), [campus]);
  // 取景框 = 北校区 + 南校区 + 生活区的合并范围（略放大）。
  // 东校区在横向上离主体很远（x>40），并进取景框会把默认视野拉宽一倍，
  // 主校区内容缩成中间一小块 —— 所以默认取景排除东校区环（按质心 x 判定），
  // 缩小视角或地图模式仍能看到它。
  const focusBox = useMemo<FocusBox | undefined>(() => {
    const pts = campusRings
      .filter(ring => {
        // 东校区环质心 x≈+34，南/北校区 x≈-33/-37，阈值取中间
        const cx = ring.reduce((a, q) => a + q[0], 0) / ring.length;
        return cx < 15;
      })
      .flat();
    if (!pts.length) return undefined;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]);
    }
    const mx = (x1 - x0) * 0.06, mz = (z1 - z0) * 0.06;
    return { x0: x0 - mx, x1: x1 + mx, z0: z0 - mz, z1: z1 + mz };
  }, [campusRings]);
  // 分类筛选与关键词搜索叠加生效（先按类别收窄，再匹配名字/别名）
  const filtered = useMemo(() => {
    let list = landmarks;
    if (catFilter) list = list.filter(l => l.category === catFilter);
    if (search) list = list.filter(l => matchLandmark(l, search));
    return list;
  }, [landmarks, search, catFilter]);
  // 只列出实际有地标的类别，并按数量从多到少排
  const catCounts = useMemo(() => {
    const m = new Map<LandmarkCategory, number>();
    for (const l of landmarks) m.set(l.category, (m.get(l.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [landmarks]);

  // 分享当前视角：把模块、相机位姿、昼夜写进 URL
  const shareView = async () => {
    const st = sceneRef.current?.getCameraState();
    const u = new URL(location.href);
    u.searchParams.set('m', module);
    u.searchParams.set('tod', tod);
    u.searchParams.set('v', viewMode);
    if (st) u.searchParams.set('cam', [...st.pos, ...st.target].join(','));
    const url = u.toString();
    try {
      await navigator.clipboard.writeText(url);
      notify('已复制当前视角链接');
    } catch {
      notify('复制失败，链接已在地址栏');
      history.replaceState(null, '', url);
    }
  };

  // 打开带 cam 参数的链接时还原视角。交给场景持有（见 CampusScene 的 initialCam）——
  // 场景里静态几何、树贴图、瓦片三处异步就绪都会重算机位，只在 App 里落位一次会被覆盖。
  const initialCam = useMemo(() => {
    const raw = new URLSearchParams(location.search).get('cam');
    if (!raw) return null;
    const n = raw.split(',').map(Number);
    if (n.length !== 6 || !n.every(v => Number.isFinite(v))) return null;
    return { pos: n.slice(0, 3), target: n.slice(3) };
  }, []);

  // ---- 数据加载 + WebSocket
  useEffect(() => {
    // 带上版本参数穿透缓存，保证数据更新后浏览器不会拿旧 JSON
    fetch(`/data/campus-local.json?v=${import.meta.env.DEV ? Date.now() : DATA_VERSION}`)
      .then(r => r.json()).then(setCampus).catch(() => setCampus(null));
    let alive = true;
    // 全量拉一次（首屏、重连后、轮询兜底都走这里）
    const pullAll = () => {
      getRobots().then(d => { if (alive) setRobots(d); }).catch(() => {});
      getEvents().then(d => { if (alive) setEvents(d); }).catch(() => {});
    };
    pullAll();
    const ws = robotSocket(msg => {
      if (msg.type === 'robot_state') {
        setRobots(old => old.map(r => (r.id === (msg as any).id ? { ...r, ...(msg as any) } : r)));
      } else if (msg.type === 'robot_event') {
        const ev = msg as any as RobotEvent;
        setEvents(old => [ev, ...old].slice(0, 24));
        notify(`${ev.type} · ${ev.location}`);
      }
    }, s => {
      setLink(s);
      linkRef.current = s;
      if (s === 'open') pullAll();  // 重连后补一次全量，避免中间那段状态缺口
    });
    // 断线期间退回 REST 轮询，界面数据不冻结
    const poll = window.setInterval(() => {
      if (linkRef.current !== 'open') pullAll();
    }, 5000);
    return () => { ws.close(); clearInterval(poll); };
  }, []);

  // ---- VRPTW 时间轴推进（1 real s = speed 模拟分钟）
  useEffect(() => {
    if (!vrptw.playing || !solution) return;
    const id = setInterval(() => {
      setVrptw(v => {
        const c = v.clock + 0.25 * v.speed;
        if (c >= v.max) return { ...v, clock: v.max, playing: false };
        return { ...v, clock: c };
      });
    }, 250);
    return () => clearInterval(id);
  }, [vrptw.playing, vrptw.speed, solution]);

  // ---- 模块切换：图层与视角联动
  useEffect(() => {
    setLayers(l => ({ ...l, routes: module === 'route' && !!solution }));
    if (module === 'robot') sceneRef.current?.flyToXY(6, 22, 'overview');
    else if (module === 'route') sceneRef.current?.flyToXY(0, 2, 'overview');
    else sceneRef.current?.resetView();
  }, [module]);

  // ---- 通过 ?m=route 直达时自动求解一次，便于直接看到调度回放
  const autoSolved = useRef(false);
  useEffect(() => {
    if (module === 'route' && !solution && !autoSolved.current && landmarks.length) {
      autoSolved.current = true;
      solve();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module, landmarks.length]);

  // ---- 交互
  const pickRobot = (id: string) => {
    setSelectedRobot(id);
    setFollowId(f => {
      const next = f === id ? null : id;
      if (!next) setFirstPerson(false); // 取消跟随时必须退出第一人称，否则相机没人接管
      return next;
    });
  };
  const pickLandmark = (l: Landmark) => {
    setSelectedLandmark(l);
    sceneRef.current?.flyToLandmark(l, 'overview');
    notify(`${l.name} · ${CATEGORY_LABEL[l.category]}`);
  };
  const applyPreset = (p: ViewPreset) => {
    if (selectedLandmark) sceneRef.current?.flyToLandmark(selectedLandmark, p);
  };
  const runMission = async (action: 'start' | 'pause') => {
    try {
      await controlMission(null, action);
      notify(action === 'start' ? '已下发全员巡检任务' : '已暂停巡检任务');
    } catch { setRobots(old => old.map(r => (action === 'start' ? { ...r, status: '巡检中' } : { ...r, status: '待命' }))); notify('后端离线，已切换本地仿真'); }
  };

  // ---- 任务队列：按用户排的顺序走
  const addLandmarkToQueue = () => {
    const l = landmarks.find(x => x.name === queuePick);
    if (!l) { notify('先选一个地标'); return; }
    setQueueDraft(q => [...q, { x: l.x, z: l.z, name: l.name }]);
    setQueuePick('');
  };
  const addManualToQueue = () => {
    const x = Number(manualX), z = Number(manualZ);
    if (!Number.isFinite(x) || !Number.isFinite(z)) { notify('坐标要是数字（单位 10 m）'); return; }
    setQueueDraft(q => [...q, { x, z, name: `自定义(${x.toFixed(1)}, ${z.toFixed(1)})` }]);
    setManualX(''); setManualZ('');
  };
  /** 点图加点：直接点场景地面，站名取最近的已知地点（没有就编号） */
  const onPickPoint = (x: number, z: number) => {
    let near: Landmark | null = null;
    let bestD = 3.2; // 32 m 内算"在这个地点"
    for (const l of landmarks) {
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < bestD) { bestD = d; near = l; }
    }
    const name = near ? near.name : `加点 ${queueDraft.length + 1}`;
    setQueueDraft(q => [...q, { x, z, name }]);
  };
  const moveQueue = (i: number, delta: number) => {
    setQueueDraft(q => {
      const j = i + delta;
      if (j < 0 || j >= q.length) return q;
      const next = [...q];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const removeQueue = (i: number) => setQueueDraft(q => q.filter((_, k) => k !== i));
  const dispatchQueue = async (mode: 'replace' | 'append') => {
    if (!queueDraft.length) { notify('队列是空的'); return; }
    try {
      await setRobotQueue(selectedRobot, queueDraft, mode);
      setFollowId(selectedRobot);
      notify(`${selectedRobot} 已接收 ${queueDraft.length} 站任务队列`);
      if (mode === 'replace') setQueueDraft([]);
    } catch {
      // 后端离线时至少让本地状态跟着走，界面不至于"点了没反应"
      setRobots(old => old.map(r => (r.id === selectedRobot
        ? { ...r, status: '巡检中', queue: mode === 'append' ? [...(r.queue || []), ...queueDraft] : queueDraft, queue_index: 0, mission: `自定义任务队列（${queueDraft.length} 站）` }
        : r)));
      notify('后端离线，队列只在本地生效');
    }
  };
  const clearQueue = async () => {
    try { await clearRobotQueue(selectedRobot); } catch { /* 离线时忽略 */ }
    setRobots(old => old.map(r => (r.id === selectedRobot ? { ...r, queue: [], queue_index: 0 } : r)));
    setQueueDraft([]);
    notify('已清空任务队列');
  };
  const toggleFirstPerson = () => {
    const next = !firstPerson;
    setFirstPerson(next);
    if (next) setFollowId(selectedRobot); // 第一人称必须绑定一台机器狗
  };
  const solve = async () => {
    setBusy(true);
    try {
      const byName = new Map(landmarks.map(l => [l.name, l]));
      const jobs = JOB_DEFS
        .map(([name, demand, tw, service], i) => {
          const l = byName.get(name);
          if (!l) return null;
          const { lat, lng } = toLatLng(l.x, l.z);
          return { id: `J-${String(i + 1).padStart(2, '0')}`, name, lat, lng, demand, service_minutes: service, time_window: tw };
        })
        .filter(Boolean);
      const r = await solveVRPTW({
        depot: { id: 'depot', ...toLatLng(0, 0) },
        vehicles: [
          { id: 'V-01', capacity: 80, start_time: '08:00', end_time: '12:00' },
          { id: 'V-02', capacity: 80, start_time: '08:00', end_time: '12:00' },
          { id: 'V-03', capacity: 60, start_time: '08:00', end_time: '12:00' },
        ],
        jobs,
      });
      setSolution(r);
      const ends = r.routes.flatMap(v => v.stops.map(s => mm(s.service_end)));
      const starts = r.routes.flatMap(v => v.stops.map(s => mm(s.arrival)));
      const lo = starts.length ? Math.min(...starts) : 480;
      const hi = ends.length ? Math.max(...ends) : 560;
      setVrptw({ clock: lo - 8, min: lo - 12, max: hi + 18, playing: true, speed: 8 });
      setLayers(l => ({ ...l, routes: true }));
      sceneRef.current?.flyToArea([{ x: 0, z: 0 }, ...r.routes.flatMap(v => v.stops.map(s => ({ x: s.x, z: s.z })))]);
      notify(`求解完成 · ${r.total_distance_km} km · ${r.vehicle_count} 辆车 · ${r.solver === 'ortools' ? 'OR-Tools' : '贪心插入'}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : '求解失败');
    } finally {
      setBusy(false);
    }
  };

  const robot = robots.find(r => r.id === selectedRobot);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <h1>石大·智巡</h1>
            <small>中国石油大学（北京） · DIGITAL TWIN</small>
          </div>
        </div>
        <div className={`live live-${link}`}>
          {link === 'open'
            ? '● 系统在线 · 底图 © 中国石油大学（北京）可视化位置服务平台'
            : link === 'connecting'
              ? '◐ 正在连接后端 · 底图 © 中国石油大学（北京）可视化位置服务平台'
              : '○ 后端断开，正在重连 · 数据已切到轮询'}
        </div>
        <div className="header-campus-state"><span className="state-dot"/> 昌平 · 校园数字孪生 <button onClick={() => notify('官方地图瓦片 + OSM 数据已同步')}>ⓘ</button></div>
      </header>

      <main className={module === 'grid' ? 'grid-mode' : ''}>
        <aside className="sidebar">
          <div className="eyebrow">CAMPUS EXPLORER</div>
          <h2>校园探索</h2>
          <p className="muted">以真实校园位置为底座，连接建筑、巡检与调度。</p>
          <div className="map-campus-switch"><button className="active">昌平校区</button><button onClick={() => notify('克拉玛依校区数据待接入')}>克拉玛依校区</button></div>
          {([
            ['campus', '⌂', '3D 校园浏览', '空间建模 · 沉浸漫游'],
            ['robot', '◈', '四足机器人巡检', '多机协同 · 实时任务'],
            ['route', '⌁', 'VRPTW 路径规划', '时间窗 · 车辆调度'],
            ['grid', '▦', '方格地图导航', '栅格 A* · 最优巡检路线'],
          ] as const).map(x => (
            <button key={x[0]} className={`nav-btn ${module === x[0] ? 'active' : ''}`} onClick={() => setModule(x[0])}>
              <i>{x[1]}</i>
              <span><b>{x[2]}</b><small>{x[3]}</small></span>
            </button>
          ))}
          <div className="overview">
            <div><b>{robots.filter(r => r.status !== '待命').length}/{robots.length}</b><small>执行任务</small></div>
            <div><b>{landmarks.length}</b><small>校园地标</small></div>
            <div><b>{events.length}</b><small>巡检事件</small></div>
          </div>
        </aside>

        <section className="stage">
          <CampusScene
            ref={sceneRef}
            features={campus?.features ?? []}
            landmarks={landmarks}
            campusRings={campusRings}
            focusBox={focusBox}
            initialCam={initialCam}
            robots={robots}
            events={events}
            routes={solution?.routes ?? []}
            vrptwClock={vrptw.clock}
            followRobotId={followId}
            firstPerson={firstPerson}
          addPointMode={addPoint}
          onPickPoint={onPickPoint}
            tod={tod}
            layers={layers}
            detail={detail}
            viewMode={viewMode}
            selectedLandmark={selectedLandmark}
            onPickRobot={pickRobot}
            onPickLandmark={pickLandmark}
            onToggleLayer={(key, visible) => setLayers(l => ({ ...l, [key]: visible }))}
            onTourStation={(i, total, name) => setTour({ active: true, paused: false, index: i, total, name })}
            onTourEnd={() => setTour(t => ({ ...t, active: false, paused: false }))}
            onQualityChange={setQuality}
          />

          {module === 'grid' && (
            <div className="grid-frame">
              <iframe src="/grid/grid-map.html" title="校园方格地图 · 机器狗巡检导航" />
            </div>
          )}

          <div className="stage-top">
            <div>
              <b>{module === 'campus' ? '校园总览 · 沉浸浏览' : module === 'robot' ? '四足机器人 · 多机巡检' : module === 'grid' ? '方格地图 · 栅格 A* 巡检导航' : 'VRPTW · 车辆路径规划'}</b>
              <small>{module === 'campus' ? '搜索地标 · 自动巡游 · 昼夜切换' : module === 'robot' ? '点击机器人可跟随视角' : module === 'grid' ? '32 个站点 · 36 格安全间距 · 最短路检索' : '时间窗约束 · 车辆调度回放'}</small>
            </div>
            <div className="stage-tools">
              <div className="view-switch" role="group" aria-label="视图模式">
                <button className={viewMode === 'map' ? 'on' : ''} onClick={() => setViewMode('map')} title="map.cup.edu.cn 同款手绘底图">官方地图</button>
                <button className={viewMode === 'twin' ? 'on' : ''} onClick={() => setViewMode('twin')} title="程序化三维建筑数字孪生">三维孪生</button>
              </div>
              {TODS.map(([k, label]) => (
                <button key={k} className={`ghost ${tod === k ? 'on' : ''}`} onClick={() => setTod(k)}>{label}</button>
              ))}
              <details className="layers-pop">
                <summary className="ghost">图层</summary>
                <div className="layers-menu">
                  {LAYER_LABELS.map(([k, label]) => (
                    <label key={k}>
                      <input type="checkbox" checked={layers[k]} onChange={e => setLayers(l => ({ ...l, [k]: e.target.checked }))} />
                      {label}
                    </label>
                  ))}
                </div>
              </details>
              <button className="ghost" onClick={() => sceneRef.current?.resetView()}>复位</button>
              <button className="ghost" onClick={() => sceneRef.current?.fullscreen()} title="全屏查看（Esc 退出）">全屏</button>
              <details className="layers-pop">
                <summary className="ghost">更多</summary>
                <div className="layers-menu">
                  <label onClick={shareView}>分享视角（复制链接）</label>
                  <label onClick={() => sceneRef.current?.screenshot()}>保存当前画面</label>
                </div>
              </details>
              <details className="layers-pop">
                <summary className={`ghost ${autoQuality ? 'on' : ''}`}>画质 {QUALITY_LABEL[quality]}</summary>
                <div className="layers-menu">
                  <label>
                    <input type="checkbox" checked={autoQuality} onChange={e => {
                      setAutoQuality(e.target.checked);
                      sceneRef.current?.setAutoQuality(e.target.checked);
                    }} />
                    自动（按帧率调节）
                  </label>
                  {(['high', 'medium', 'low'] as Quality[]).map(q => (
                    <label key={q}>
                      <input type="radio" name="quality" checked={quality === q} onChange={() => {
                        setQuality(q); setAutoQuality(false);
                        sceneRef.current?.setAutoQuality(false);
                        sceneRef.current?.setQuality(q);
                      }} />
                      {QUALITY_LABEL[q]}
                      {q === 'high' ? '（阴影 + 全植被）' : q === 'medium' ? '（小阴影）' : '（无阴影 + 半植被）'}
                    </label>
                  ))}
                </div>
              </details>
              <details className="layers-pop">
                <summary className="ghost">细节 {DETAIL_LABEL[detail]}</summary>
                <div className="layers-menu">
                  {(['lean', 'standard', 'rich'] as DetailLevel[]).map(d => (
                    <label key={d}>
                      <input type="radio" name="detail" checked={detail === d} onChange={() => setDetail(d)} />
                      {DETAIL_LABEL[d]}
                      {d === 'lean' ? '（体块 + 少量设备）' : d === 'standard' ? '（+ 宿舍挂机 / 雨水管 / 井盖）' : '（设备加密 + 小屋面也放）'}
                    </label>
                  ))}
                  <small className="hint">改动会重建静态场景</small>
                </div>
              </details>
            </div>
          </div>

          {module === 'campus' && (
            <div className="dock tour-dock">
              {!tour.active ? (
                <button className="primary" onClick={() => { setTour({ active: true, paused: false, index: 0, total: 0, name: '' }); sceneRef.current?.tour('start'); }}>
                  ▶ 开始自动巡游
                </button>
              ) : (
                <>
                  <div className="tour-info">
                    <b>{tour.name || '…'}</b>
                    <small>{tour.index + 1} / {tour.total || '…'} 站{tour.paused ? ' · 已暂停' : ''}</small>
                    <div className="progress"><i style={{ width: `${tour.total ? ((tour.index + 1) / tour.total) * 100 : 0}%` }} /></div>
                  </div>
                  <button className="ghost" onClick={() => { const p = !tour.paused; setTour(t => ({ ...t, paused: p })); sceneRef.current?.tour(p ? 'pause' : 'resume'); }}>
                    {tour.paused ? '继续' : '暂停'}
                  </button>
                  <button className="ghost" onClick={() => sceneRef.current?.tour('skip')}>下一站</button>
                  <button className="ghost danger" onClick={() => { sceneRef.current?.tour('stop'); setTour(t => ({ ...t, active: false })); }}>结束</button>
                </>
              )}
            </div>
          )}

          {module === 'route' && solution && (
            <div className="dock vrptw-dock">
              <button className="primary" onClick={() => setVrptw(v => ({ ...v, playing: !v.playing }))}>
                {vrptw.playing ? '⏸ 暂停' : '▶ 播放'}
              </button>
              {[4, 8, 16].map(s => (
                <button key={s} className={`ghost ${vrptw.speed === s ? 'on' : ''}`} onClick={() => setVrptw(v => ({ ...v, speed: s }))}>{s}×</button>
              ))}
              <span className="clock">{fmt(vrptw.clock)}</span>
              <input
                type="range" min={vrptw.min} max={vrptw.max} step={0.5} value={vrptw.clock}
                onChange={e => setVrptw(v => ({ ...v, clock: +e.target.value, playing: false }))} />
            </div>
          )}

          {module === 'robot' && events[0] && (
            <div className="dock event-dock">
              <span className={`pill ${events[0].level === 'critical' ? 'red' : events[0].level === 'warning' ? 'amber' : 'cyan'}`}>
                {events[0].type}
              </span>
              <span>{events[0].message}</span>
              <small>{events[0].robot_id} · {events[0].location}</small>
            </div>
          )}
        </section>

        <aside className="inspector" hidden={module === 'grid'}>
          {module === 'campus' && (
            <>
              <div className="panel-head">
                <div>
                  <div className="eyebrow">MODULE 01 / CAMPUS TWIN</div>
                  <h2>3D 校园浏览</h2>
                  <p>OSM 真实轮廓 · 程序化立面</p>
                </div>
                <span className="pill cyan">{landmarks.length} 地标</span>
              </div>
              <div className="card">
                <input className="search" placeholder="搜索地标 / 别名，如“三教”“学活”" value={search} onChange={e => setSearch(e.target.value)} />
                <div className="cat-row">
                  <button className={`chip ${!catFilter ? 'on' : ''}`} onClick={() => setCatFilter(null)}>全部 {landmarks.length}</button>
                  {catCounts.map(([c, n]) => (
                    <button key={c} className={`chip ${catFilter === c ? 'on' : ''}`}
                      onClick={() => setCatFilter(catFilter === c ? null : c)}>
                      {CATEGORY_LABEL[c]} {n}
                    </button>
                  ))}
                </div>
                <div className="preset-row">
                  {(['overview', 'front', 'top', 'close'] as ViewPreset[]).map(p => (
                    <button key={p} className="ghost" disabled={!selectedLandmark}
                      onClick={() => applyPreset(p)}>
                      {p === 'overview' ? '全貌' : p === 'front' ? '正面' : p === 'top' ? '俯视' : '近景'}
                    </button>
                  ))}
                </div>
                <div className="landmark-list">
                  {filtered.map(l => (
                    <button key={l.id} className={`landmark-row ${selectedLandmark?.id === l.id ? 'selected' : ''}`} onClick={() => pickLandmark(l)}>
                      <span className={`cat cat-${l.category}`}>{CATEGORY_LABEL[l.category]}</span>
                      <b>{l.name}</b>
                      {l.aliases[0] && <small>{l.aliases.join(' / ')}</small>}
                    </button>
                  ))}
                  {!filtered.length && <div className="muted pad">没有匹配的地标</div>}
                </div>
              </div>
              <div className="card note">建筑轮廓来自 OpenStreetMap 公开数据（ODbL），高度按 OSM 层数估算，立面为程序化纹理，非实测模型。</div>
            </>
          )}

          {module === 'robot' && (
            <>
              <div className="panel-head">
                <div>
                  <div className="eyebrow">MODULE 02 / ROBOT OPS</div>
                  <h2>四足机器人巡检</h2>
                  <p>仿真状态 · WebSocket 实时流</p>
                </div>
                <span className="pill green">{robots.filter(r => r.status !== '待命').length} 在线</span>
              </div>
              <div className="card">
                <div className="card-title">巡检编队</div>
                {robots.map(r => (
                  <button key={r.id} className={`robot-row ${selectedRobot === r.id ? 'selected' : ''}`} onClick={() => pickRobot(r.id)}>
                    <i className={`dot ${r.status === '待命' ? 'idle' : ''}`} />
                    <b>{r.id}</b>
                    <small>{r.status} · {Math.round((r.progress || 0) * 100)}%</small>
                  </button>
                ))}
                <div className="btn-row">
                  <button className="primary" onClick={() => runMission('start')}>下发巡检</button>
                  <button className="ghost" onClick={() => runMission('pause')}>全员暂停</button>
                </div>
              </div>
              {robot && (
                <div className="card">
                  <div className="card-title">设备详情 <span>{robot.id}</span></div>
                  <div className="stat-row"><span>型号</span><b>{robot.model}</b></div>
                  <div className="stat-row"><span>状态 / 任务</span><b>{robot.status} · {robot.mission || '待命'}</b></div>
                  <div className="stat-row"><span>电量 / 信号</span><b>{Math.round(robot.battery)}% / {robot.signal} dBm</b></div>
                  <div className="stat-row"><span>跟随视角</span><b>{followId === robot.id ? '已开启（点击机器人关闭）' : '未开启'}</b></div>
                  <div className="stat-row"><span>执行中队列</span><b>{(robot.queue?.length ?? 0) ? `${robot.queue_index || 0} / ${robot.queue?.length} 站` : '无（走默认环线）'}</b></div>
                  <div className="progress"><i style={{ width: `${(robot.progress || 0) * 100}%` }} /></div>
                  <div className="btn-row">
                    <button className={firstPerson ? 'primary' : 'ghost'} onClick={toggleFirstPerson}>
                      {firstPerson ? '退出第一人称' : '机器狗第一人称'}
                    </button>
                    <button className="ghost" onClick={() => sceneRef.current?.flyToXY(0, 0, 'overview')}>回到全景</button>
                  </div>
                </div>
              )}

              <div className="card">
                <div className="card-title">任务队列 <span>{queueDraft.length} 站 · 下发给 {selectedRobot}</span></div>
                <button
                  className={addPoint ? 'primary wide' : 'ghost wide'}
                  onClick={() => { setAddPoint(v => !v); if (!addPoint) setFirstPerson(false); }}>
                  {addPoint ? '🖱 点图加点：已开启（再点关闭）' : '🖱 点图加点：在地面上点一下就能加站'}
                </button>
                {addPoint && <div className="queue-hint">在地面空白处点一下 → 加一个站点；点在楼/场地上会取最近的地点名。</div>}
                <div className="queue-add">
                  <select value={queuePick} onChange={e => setQueuePick(e.target.value)}>
                    <option value="">选择地标…</option>
                    {landmarks.map(l => <option key={`q-${l.name}`} value={l.name}>{l.name}</option>)}
                  </select>
                  <button className="ghost" onClick={addLandmarkToQueue}>＋加入</button>
                </div>
                <details className="queue-adv">
                  <summary>按坐标加（高级）</summary>
                  <div className="queue-add">
                    <input value={manualX} onChange={e => setManualX(e.target.value)} placeholder="x（东，单位 10 m）" />
                    <input value={manualZ} onChange={e => setManualZ(e.target.value)} placeholder="z（南，单位 10 m）" />
                    <button className="ghost" onClick={addManualToQueue}>＋坐标</button>
                  </div>
                </details>
                <div className="queue-list">
                  {queueDraft.map((w, i) => (
                    <div key={`d-${i}-${w.name}`} className="queue-item">
                      <b>{i + 1}</b>
                      <small>{w.name}</small>
                      <span className="queue-ops">
                        <button onClick={() => moveQueue(i, -1)} title="上移">↑</button>
                        <button onClick={() => moveQueue(i, 1)} title="下移">↓</button>
                        <button onClick={() => removeQueue(i)} title="移除">×</button>
                      </span>
                    </div>
                  ))}
                  {!queueDraft.length && <div className="muted pad">空队列：加几个站点，机器狗会按这个顺序走过去。</div>}
                </div>
                <div className="btn-row">
                  <button className="primary" onClick={() => dispatchQueue('replace')} disabled={!queueDraft.length}>下发队列</button>
                  <button className="ghost" onClick={() => dispatchQueue('append')} disabled={!queueDraft.length}>追加到队尾</button>
                  <button className="ghost" onClick={clearQueue}>清空</button>
                </div>
              </div>
              <div className="card grow">
                <div className="card-title">巡检事件流</div>
                <div className="event-list">
                  {events.map(e => (
                    <div key={e.id} className="event-item">
                      <span className={`pill ${e.level === 'critical' ? 'red' : e.level === 'warning' ? 'amber' : 'cyan'}`}>{e.type}</span>
                      <div>
                        <b>{e.location}</b>
                        <small>{e.message}</small>
                      </div>
                    </div>
                  ))}
                  {!events.length && <div className="muted pad">暂无事件，等待巡检机器人上报…</div>}
                </div>
              </div>
              <div className="card note">机器人模块负责编队、任务、状态和轨迹；配送车辆调度由 VRPTW 模块负责。</div>
            </>
          )}

          {module === 'route' && (
            <>
              <div className="panel-head">
                <div>
                  <div className="eyebrow">MODULE 03 / OPTIMIZATION</div>
                  <h2>VRPTW 路径规划</h2>
                  <p>带时间窗约束 · 容量与时刻表</p>
                </div>
                <span className="pill amber">{solution ? 'SOLVED' : 'READY'}</span>
              </div>
              <div className="card">
                <div className="card-title">优化摘要</div>
                <div className="stat-row"><span>车辆 / 任务点</span><b>{solution ? `${solution.vehicle_count} / ${solution.routes.reduce((a, r) => a + r.stops.length, 0)}` : '3 / 10'}</b></div>
                <div className="stat-row"><span>总里程</span><b>{solution ? `${solution.total_distance_km} km` : '—'}</b></div>
                <div className="stat-row"><span>准时率</span><b>{solution ? `${solution.on_time_rate}%` : '—'}</b></div>
                <div className="stat-row"><span>求解器</span><b>{solution ? (solution.solver === 'ortools' ? 'OR-Tools' : '贪心插入（降级）') : 'OR-Tools 优先'}</b></div>
                <button className="primary amber-btn" onClick={solve} disabled={busy}>{busy ? '求解中…' : '求解最优路径'}</button>
              </div>
              {solution && (
                <div className="card grow">
                  <div className="card-title">车辆时刻表 <span>当前 {fmt(vrptw.clock)}</span></div>
                  {solution.routes.map(r => {
                    const times = r.stops.flatMap(s => [mm(s.arrival), mm(s.service_end)]);
                    const t0 = Math.min(...times) - 10, t1 = Math.max(...times) + 10;
                    const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - t0) / (t1 - t0)) * 100))}%`;
                    return (
                      <div key={r.vehicle_id} className="gantt">
                        <div className="gantt-head">
                          <b>{r.vehicle_id}</b>
                          <small>{r.stops.length} 站 · {r.distance_km} km</small>
                        </div>
                        <div className="gantt-track">
                          {r.stops.map(s => (
                            <div key={s.job_id} className="gantt-win" style={{ left: pos(mm(s.time_window[0])), width: `${((mm(s.time_window[1]) - mm(s.time_window[0])) / (t1 - t0)) * 100}%` }} />
                          ))}
                          {r.stops.map(s => (
                            <div key={s.job_id + 's'} className="gantt-stop" style={{ left: pos(mm(s.arrival)) }} title={`${s.name} ${s.arrival}–${s.service_end}（窗 ${s.time_window[0]}–${s.time_window[1]}）`}>
                              <span>{s.name}</span>
                            </div>
                          ))}
                          <div className="gantt-now" style={{ left: pos(vrptw.clock) }} />
                        </div>
                      </div>
                    );
                  })}
                  <div className="legend">
                    <span><i className="win" />时间窗</span>
                    <span><i className="stop" />到达时刻</span>
                    <span><i className="now" />当前时间</span>
                  </div>
                </div>
              )}
              <div className="card note">支持车辆容量、到达时间窗、服务时长约束；结果回写 3D 场景回放，不控制四足机器人。</div>
            </>
          )}
        </aside>
      </main>

      <footer>
        <span>石大·智巡 · 校园数字孪生演示系统</span>
        <span>地理数据 © OpenStreetMap contributors (ODbL) · 建筑高度按公开资料估算</span>
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
