import { useRef, useState } from 'react';
import { API_BASE } from '../lib/api';
import './Showcase.css';

const steps = [
  ['校园全景', '以校园地理布局为底座，将楼宇、道路、行人与机器人统一放入三维场景。建筑为近似重建，本系统用于教学仿真。', '看点：地图与三维视图使用同一组坐标。'],
  ['机器狗巡检', '观察 SPOT-01 沿固定路线行走。跟随镜头可以查看四足步态，机器人按可通行路径前进。', '看点：机器人运动、视角跟随与实时状态。'],
  ['施工障碍', '机器人暂时停下，前方新增固定施工区。右侧小地图保留原路线，并显示绕行后的路线。', '看点：橙色虚线是原路线，彩色实线是重规划结果。'],
  ['动态绕行', '恢复巡检，观察机器狗避开施工区。AVL 索引用于检索节点；A* 根据邻接关系和通行代价搜索路径。', '看点：避障效果、可通行路径与实际规划耗时。'],
  ['行人避让', '镜头锁定 SPOT-01 前方的三名行人。黄色圈表示规划安全间距，观察机器狗沿绿色路线绕开聚集的人群；其他机器狗继续分区巡检。', '看点：固定行人聚集示例，便于重播比较；随机行人走动仍可在右侧开启。'],
  ['AI 问路', '打开校园助手，查询“从图书馆到体育馆多远”。路线与距离来自地图规划器，普通问题由本地 AI 回答。', '看点：地图计算不依赖 AI 推理；距离为模型估算，非实地导航。'],
];

export default function Showcase({ onStage, onActive, live }: { live?: any; onStage: (step: number, state: any) => void; onActive: (active: boolean) => void }) {
  const [step, setStep] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [comparison, setComparison] = useState<{ before: number[][]; after: number[][]; obstacle: {x:number;z:number;radius:number} } | null>(null);
  const lock = useRef(false);
  async function change(next: number) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const r = await fetch(`${API_BASE}/api/navigation/showcase/${next < 0 ? 'exit' : 'step'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: next < 0 ? undefined : JSON.stringify({ step: next }), signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw Error('场景准备失败，请确认新版后端已启动后重试。');
      const state = await r.json();
      const plan = state.robots?.[0]?.comparison;
      setComparison(next === 2 && plan && state.obstacles?.[0] ? { ...plan, obstacle: state.obstacles[0] } : null);
      setStep(next); onActive(next >= 0); onStage(next,state);
    } catch (e) { setError(e instanceof Error && e.name === 'TimeoutError' ? '准备超时，场景可能已变化。可重试本步；每次都会重新准备，不会重复添加障碍。' : String(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  if (step < 0) return <div className="showcase-entry">
    <button disabled={busy} onClick={() => void change(0)}>{busy ? '准备演示…' : '▶ 一键讲解演示'}</button>
    <small>约 3–5 分钟 · 将重置巡检任务和障碍</small>{error && <span role="alert">{error}</span>}
  </div>;
  return <section className={`showcase-panel ${[2,3,4].includes(step) ? 'showcase-scene' : ''}`} aria-label="讲解演示" aria-busy={busy}>
    <div className="showcase-heading"><span>校园巡检 · 展示导览</span><b>{step + 1} / {steps.length}</b></div>
    <div className="showcase-progress">{steps.map((s, i) => <span key={s[0]} className={i <= step ? 'done' : ''} />)}</div>
    <h3>{steps[step][0]}</h3><p>{steps[step][1]}</p><small>{steps[step][2]}</small>
    {[2,3,4].includes(step) && live?.robots?.[0] && (() => {
      const r=live.robots[0], end=r.queue?.[0];
      const distance=end?Math.hypot(r.x-end.x,r.z-end.z)*10:null;
      return <p className="showcase-live" role="status">{step===2?'已暂停 · 点击下一步观看绕行':r.navigation_blocked?'路线受阻 · 正在安全等待':distance!==null && distance<1.5?'已到达终点 · 可重播本步':`正在绕行${distance!==null ? ` · 距终点直线约 ${Math.round(distance)} 米` : ''}`}</p>;
    })()}
    {comparison && (() => {
      const points = [...comparison.before, ...comparison.after];
      const xs = points.map(p => p[0]), zs = points.map(p => p[1]);
      const x = Math.min(...xs)-1.5, z = Math.min(...zs)-1.5;
      return <svg className="showcase-comparison" aria-label="施工前后路线对比" viewBox={`${x} ${z} ${Math.max(...xs)-x+1.5} ${Math.max(...zs)-z+1.5}`}>
        <circle cx={comparison.obstacle.x} cy={comparison.obstacle.z} r={comparison.obstacle.radius} fill="#f2838355" stroke="#fb8a8a" strokeWidth=".06" />
        <polyline points={comparison.before.map(p => p.join(',')).join(' ')} fill="none" stroke="#ffc174" strokeWidth=".09" strokeDasharray=".22 .14" />
        <polyline points={comparison.after.map(p => p.join(',')).join(' ')} fill="none" stroke="#49ddbe" strokeWidth=".09" />
      </svg>;
    })()}
    {error && <p role="alert" className="showcase-error">{error}</p>}
    <div className="showcase-actions">
      <button disabled={busy || step === 0} onClick={() => void change(step - 1)}>上一步</button>
      <button disabled={busy} onClick={() => void change(step)}>重播本步</button>
      <button disabled={busy} onClick={() => void change(-1)}>退出并暂停</button>
      <button className="primary" disabled={busy} onClick={() => void change(step === 5 ? -1 : step + 1)}>{busy ? '准备中…' : step === 5 ? '完成演示' : '下一步'}</button>
    </div>
  </section>;
}
