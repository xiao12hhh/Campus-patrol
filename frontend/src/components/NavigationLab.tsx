import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/api';
import { CampusData } from '../lib/campus';

type Obstacle = { id: string; x: number; z: number; radius: number; kind: string };
type Bot = { comparison?: {before:number[][];after:number[][];revision:number}; id: string; x: number; z: number; path: number[][]; queue: {x:number;z:number;name:string}[]; cooperative: boolean; yielding_to: string; navigation_blocked: boolean; plan_stats?: {milliseconds:number;revision:number;reason?:string} };
type State = { demo_mode:boolean; revision: number; index: { nodes: number; height: number }; obstacles: Obstacle[]; robots: Bot[] };
const colors = ['#18b8a6', '#f7ad42', '#8285ff'];

export default function NavigationLab({campus}: {campus: CampusData | null}) {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('施工');
  const [radius, setRadius] = useState(1);
  const [point, setPoint] = useState<{x:number;z:number}|null>(null);
  async function request(path = '', method = 'GET', body?: unknown) {
    const res = await fetch(`${API_BASE}/api/navigation${path}`, { method, headers: {'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    const result = await res.json();
    if (!res.ok) {
      if (res.status === 405 || res.status === 404) throw new Error('当前后端尚未加载此接口，请重启校园巡视服务后重试（仅刷新网页无效）。');
      throw new Error(typeof result.detail === 'string' ? result.detail : '参数无效，请检查障碍大小和位置');
    }
    return result;
  }
  useEffect(() => {
    let live = true;
    let pending = false;
    const poll = async () => { if(pending) return; pending=true; try { const next = await request(); if(live) {setData(next); setError('');} } catch(e) { if(live) setError(e instanceof Error && e.name === 'TimeoutError' ? '服务响应超时，正在重新连接；请勿连续重复提交。' : String(e)); } finally {pending=false;} };
    void poll(); const timer = setInterval(poll, 2000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  async function act(path: string, method: string, body?: unknown) {
    setBusy(true);
    try { await request(path, method, body); setData(await request()); setError(''); }
    catch(e) { setError(e instanceof Error && e.name === 'TimeoutError' ? '请求超时，操作可能已生效，请等待地图状态刷新后再操作。' : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="card">
    <div className="card-title">AVL 协同巡检实验</div>
    <div className="btn-row" style={{flexWrap:'wrap'}}>
      <button disabled={busy} onClick={()=>void act('/demo/reset','POST')}>一键复位演示</button>
      <button disabled={busy || !data?.demo_mode} onClick={()=>void act('/demo/obstacle','POST')}>放置固定施工障碍</button>
      <button disabled={busy || !data?.demo_mode} onClick={()=>void act('/demo/start','POST')}>开始演示</button>
      <button disabled={busy || !data?.demo_mode} onClick={()=>void act('/demo/exit','POST')}>退出演示模式</button>
    </div>
    <p>{data?.demo_mode ? '课堂演示：电量冻结 · 复位 → 放障碍看对比 → 开始演示' : '常规模式：正常耗电与返航'} · 复位会清空障碍和任务</p>
    <p>节点存储可通行区域、邻接关系与距离代价；A* 通过 AVL 检索邻接节点。点击下图选择临时障碍位置。</p>
    <small>已索引 {data?.index.nodes ?? 0} 个节点 · 树高 {data?.index.height ?? 0} · 地图版本 {data?.revision ?? 0}</small>
    <svg aria-label="协同巡检路线与动态障碍地图" viewBox="-70 -55 125 110" style={{width:'100%',background:'#10222e',borderRadius:10, cursor:'crosshair'}} onClick={e => {
      const p = e.currentTarget.createSVGPoint(); p.x=e.clientX; p.y=e.clientY;
      const m=e.currentTarget.getScreenCTM(); if(m) {const q=p.matrixTransform(m.inverse()); setPoint({x:+q.x.toFixed(2),z:+q.y.toFixed(2)});}
    }}>
      <text x="-66" y="-49" fill="#c2d1df" fontSize="3">北 ↑ · 路线示意（1 单位 = 10 米）</text>
      {campus?.features.filter(f=>f.kind==='building' || f.properties.building).flatMap(f=>{
        const rings: number[][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map((p:number[][][])=>p[0]) : [];
        return rings.map((ring,i)=><polygon key={`${f.id}-${i}`} points={ring.map(p=>p.join(',')).join(' ')} fill="#354753" stroke="#6c7d89" strokeWidth=".15"><title>{f.name}</title></polygon>);
      })}
      {data?.robots.map((r,i) => <g key={r.id}>
        {r.comparison && <>
          <polyline points={r.comparison.before.map(p=>p.join(',')).join(' ')} fill="none" stroke="#ffbd70" strokeWidth=".5" strokeDasharray="1 .7" />
          <polyline points={r.comparison.after.map(p=>p.join(',')).join(' ')} fill="none" stroke={colors[i]} strokeWidth=".65" />
        </>}
        <polyline points={[[r.x,r.z],...(r.path||[])].map(p=>p.join(',')).join(' ')} fill="none" stroke={colors[i]} strokeWidth=".5" />
        {r.cooperative && r.queue.map((p,j)=><circle key={j} cx={p.x} cy={p.z} r=".7" fill={colors[i]}><title>{p.name}</title></circle>)}
        <circle cx={r.x} cy={r.z} r="1" fill={colors[i]} />
        <text x={r.x+1.4} y={r.z} fill={colors[i]} fontSize="2.8">{r.id}</text>
      </g>)}
      {data?.obstacles.map(o=><circle key={o.id} cx={o.x} cy={o.z} r={o.radius} fill="#f0525277" stroke="#ff7878" strokeWidth=".4"><title>{o.kind}</title></circle>)}
      {point && <circle cx={point.x} cy={point.z} r={radius} fill="none" stroke="white" strokeWidth=".4" strokeDasharray="1 1" />}
    </svg>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:10}}>
      <select aria-label="障碍类型" value={kind} onChange={e=>setKind(e.target.value)}><option>施工</option><option>人群</option></select>
      <label>半径（米） <input aria-label="障碍半径米" type="number" min="2" max="100" value={radius*10} style={{width:60}} onChange={e=>setRadius(Number(e.target.value)/10)} /></label>
      <button disabled={busy || !point} onClick={()=>void act('/obstacles','POST',{...point,radius,kind})}>添加障碍并重规划</button>
      <button disabled={busy} onClick={()=>void act('/pedestrians','POST',{count:36})}>重新随机生成行人</button>
      <button disabled={busy} onClick={()=>void act('/pedestrians','POST',{count:0})}>清空行人</button>
      <button disabled={busy || !data} onClick={()=>void act('/allocate','POST')}>分配三机巡检子区</button>
    </div>
    <p>橙色虚线：绕行前 · 彩色实线：绕行后（保留最近一次同目标重规划）</p>
    {point && <small>已选位置：x {point.x}，z {point.z}</small>}
    {error && <p role="alert" style={{color:'#e75b5b'}}>{error}</p>}
    <p>校园行人：{data?.obstacles.filter(o=>o.kind==='行人').length ?? 0} 人 · 随机站立，参与避障</p>
    {data?.obstacles.filter(o=>o.kind!=='行人').map(o=><div key={o.id} style={{marginTop:8}}>{o.kind} · 半径 {o.radius*10} 米 <button disabled={busy} onClick={()=>void act(`/obstacles/${o.id}`,'DELETE')}>移除 / 恢复通行</button></div>)}
    {data?.robots.map((r,i)=><p key={r.id} style={{borderLeft:`3px solid ${colors[i]}`,paddingLeft:8}}>
      <b>{r.id}</b> · {r.cooperative ? `${r.queue.length} 站分区循环` : '常规巡检'}<br/>
      {r.plan_stats?.reason === 'budget_exceeded' ? '本轮搜索达到时间上限，停车并稍后重试' : r.navigation_blocked ? '路线受阻，等待调整障碍' : r.yielding_to ? `等待 ${r.yielding_to} 通行` : '路线可通行'}
      {r.plan_stats && <> · 规划 {r.plan_stats.milliseconds} ms（版本 {r.plan_stats.revision}）</>}
    </p>)}
    <small>分区站点互不重复；转场可能共用道路，通过安全间距停车避让。狭窄对向通道可能需要移除障碍或调整任务。索引按搜索按需建立，耗时为实际测量。</small>
  </div>;
}
