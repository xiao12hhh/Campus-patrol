// 留空时使用当前页面同源地址：开发环境由 Vite proxy 转发，生产环境由 Nginx/反向代理转发。
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

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
  const r = await fetch(`${API_BASE}/api/robots`);
  if (!r.ok) throw Error('机器人接口不可用');
  return r.json();
}

export async function getEvents(): Promise<RobotEvent[]> {
  const r = await fetch(`${API_BASE}/api/robots/events`);
  if (!r.ok) throw Error('事件接口不可用');
  return r.json();
}

export async function controlMission(robotIds: string[] | null, action: 'start' | 'pause') {
  const r = await fetch(`${API_BASE}/api/robots/missions`, {
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
  const r = await fetch(`${API_BASE}/api/robots/queue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ robot_id: robotId, waypoints, mode }),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}

export async function clearRobotQueue(robotId?: string) {
  const r = await fetch(`${API_BASE}/api/robots/queue/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(robotId ? { robot_id: robotId } : {}),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}

export async function solveVRPTW(payload: unknown): Promise<VRPTWSolution> {  const r = await fetch(`${API_BASE}/api/vrptw/solve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw Error(await r.text());
  return r.json();
}

export type WsMessage =
  | ({ type: 'robot_state'; timestamp: string } & Robot)
  | ({ type: 'robot_event' } & RobotEvent);

export function robotSocket(onMessage: (data: WsMessage) => void): WebSocket {
  const base = API_BASE
    ? API_BASE.replace(/^http/, 'ws')
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  const ws = new WebSocket(`${base}/ws/robots`);
  ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } };
  return ws;
}
