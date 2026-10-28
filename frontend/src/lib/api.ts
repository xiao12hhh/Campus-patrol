// 留空时使用当前页面同源地址：开发环境由 Vite proxy 转发，生产环境由 Nginx/反向代理转发。
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

const REQUEST_TIMEOUT = 10000;

/** 带超时的 fetch：后端没响应时不至于一直挂住等它 */
function request(input: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
  return fetch(input, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

export interface Waypoint { x: number; z: number; name: string }

export interface Robot {
  id: string; model: string; status: string;
  x: number; z: number; battery: number; signal: number;
  mission: string | null; progress: number; heading: number;
  speed?: number; route_name?: string; waypoint_index?: number;
  route?: Waypoint[];
  /** 自定义任务队列：非空时机器人优先按队列顺序走 */
  queue?: Waypoint[]; queue_index?: number;
}

export interface RobotEvent {
  id: string; robot_id: string; location: string;
  x: number; z: number; time: string;
  type: string; level: 'info' | 'warning' | 'critical'; message: string;
}

export interface RouteStop {
  job_id: string; name: string; x: number; z: number;
  arrival: string; service_end: string; time_window: [string, string];
}

export interface VehicleRoute { vehicle_id: string; distance_km: number; stops: RouteStop[] }

export interface VRPTWSolution {
  routes: VehicleRoute[]; total_distance_km: number;
  on_time_rate: number; vehicle_count: number; solver: string;
}

export async function getRobots(): Promise<Robot[]> {
  const r = await request(`${API_BASE}/api/robots`);
  if (!r.ok) throw Error('机器人接口不可用');
  return r.json();
}

export async function getEvents(): Promise<RobotEvent[]> {
  const r = await request(`${API_BASE}/api/robots/events`);
  if (!r.ok) throw Error('事件接口不可用');
  return r.json();
}

export async function controlMission(robotIds: string[] | null, action: 'start' | 'pause') {
  const r = await request(`${API_BASE}/api/robots/missions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ robot_ids: robotIds, action }),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}

/** 下发自定义任务队列；mode=replace 覆盖、append 追加到队尾 */
export async function setRobotQueue(
  robotId: string, waypoints: Waypoint[], mode: 'replace' | 'append' = 'replace',
) {
  const r = await request(`${API_BASE}/api/robots/queue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ robot_id: robotId, waypoints, mode }),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}

export async function clearRobotQueue(robotId?: string) {
  const r = await request(`${API_BASE}/api/robots/queue/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(robotId ? { robot_id: robotId } : {}),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}

export async function solveVRPTW(payload: unknown): Promise<VRPTWSolution> {
  const r = await request(`${API_BASE}/api/vrptw/solve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}

export type WsMessage =
  | ({ type: 'robot_state'; timestamp: string } & Robot)
  | ({ type: 'robot_event' } & RobotEvent);

export type LinkState = 'connecting' | 'open' | 'closed';

/**
 * 机器人状态 WebSocket + 自动重连。
 * 后端重启/网络抖动时按 1s→2s→4s→8s 退避重连，期间 App 可以退回 REST 轮询。
 */
export function robotSocket(
  onMessage: (data: WsMessage) => void,
  onState?: (s: LinkState) => void,
): { close: () => void } {
  const base = API_BASE
    ? API_BASE.replace(/^http/, 'ws')
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  let ws: WebSocket | null = null;
  let timer = 0;
  let tries = 0;
  let closed = false;

  const open = () => {
    if (closed) return;
    onState?.('connecting');
    try {
      ws = new WebSocket(`${base}/ws/robots`);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => { tries = 0; onState?.('open'); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } };
    ws.onerror = () => { /* onclose 会跟着来，统一在那边重连 */ };
    ws.onclose = () => { if (!closed) { onState?.('closed'); schedule(); } };
  };
  const schedule = () => {
    if (closed) return;
    const delay = Math.min(8000, 1000 * 2 ** tries) + Math.random() * 300;
    tries += 1;
    clearTimeout(timer);
    timer = window.setTimeout(open, delay);
  };

  open();
  return {
    close: () => {
      closed = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* 已经关掉了 */ }
    },
  };
}
