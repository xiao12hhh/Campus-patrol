import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/api';
import type { CampusData } from '../lib/campus';
import './CampusAssistant.css';

type Reply = { topic_ids?: string[]; references?: {path:string;symbol:string;current:boolean}[]; answer: string; source: string; route?: { start: string; end: string; points: number[][]; meters: number; revision: number } };
type Entry = { role: 'user' | 'assistant'; content: string; reply?: Reply };

export default function CampusAssistant({ campus, demoRequest = 0 }: { campus: CampusData | null; demoRequest?: number }) {
  const [open, setOpen] = useState(false);
  const [knowledgeCount, setKnowledgeCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [places, setPlaces] = useState<string[]>([]);
  const [start, setStart] = useState('图书馆');
  const [end, setEnd] = useState('体育馆');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Entry[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => { if (demoRequest) { setOpen(true); setStart('图书馆'); setEnd('体育馆'); setInput('从图书馆到体育馆怎么走？'); } }, [demoRequest]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch(`${API_BASE}/api/assistant/status`, { signal: controller.signal }).then(r => {
      if (!r.ok) throw Error(); return r.json();
    }).then(d => { setReady(d.ready); setPlaces(d.places); setKnowledgeCount(d.knowledge_topics || 0); }).catch(() => setReady(false));
    return () => controller.abort();
  }, [open]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages, busy, open]);
  async function send(text: string, route = false) {
    if (!text.trim() || sending.current) return;
    sending.current = true; setBusy(true); setInput('');
    setMessages(old => [...old.slice(-19), { role: 'user', content: text }]);
    const controller = new AbortController();
    activeRequest.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(`${API_BASE}/api/assistant/chat`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ message: text, context_topics: [...messages].reverse().find(m=>m.role==='assistant')?.reply?.topic_ids || [], ...(route ? { start, end } : {}), history: messages.slice(-6).map(m => ({ role: m.role, content: m.content.slice(0, 2000) })) }) });
      if (!response.ok) throw Error('问答服务不可用，请重新运行 start.bat 启动新版后端。');
      const reply: Reply = await response.json();
      setMessages(old => [...old, { role: 'assistant', content: reply.answer, reply }]);
    } catch (e) {
      setMessages(old => [...old, { role: 'assistant', content: e instanceof Error && e.name !== 'AbortError' ? e.message : '已停止等待或回答超时；可以重试，也可以继续查询路线。' }]);
    } finally { clearTimeout(timer); activeRequest.current = null; sending.current = false; setBusy(false); }
  }
  function routeMap(route: NonNullable<Reply['route']>) {
    const xs = route.points.map(p => p[0]), zs = route.points.map(p => p[1]);
    const x = Math.min(...xs) - 6, z = Math.min(...zs) - 6;
    const w = Math.max(...xs) - x + 6, h = Math.max(...zs) - z + 6;
    const radius = Math.max(w, h) / 100;
    return <figure className="assistant-map">
      <svg viewBox={`${x} ${z} ${w} ${h}`} role="img" aria-label={`${route.start}到${route.end}的路线`}>
        {campus?.features.filter(f => f.geometry.type === 'Polygon' && f.kind === 'building').map(f => <polygon key={f.id} points={f.geometry.coordinates[0].map((p: number[]) => p.join(',')).join(' ')} fill="#334d57" />)}
        <polyline points={route.points.map(p => p.join(',')).join(' ')} fill="none" stroke="#55e2c2" strokeWidth={radius} strokeLinejoin="round" />
        {[route.points[0], route.points[route.points.length - 1]].map((p, i) => <g key={i}><circle cx={p[0]} cy={p[1]} r={radius * 2} fill={i ? '#ffca73' : '#55e2c2'} /><text x={p[0]} y={p[1] - radius * 3} fontSize={radius * 4} fill="white" textAnchor="middle">{i ? '终' : '起'}</text></g>)}
      </svg>
      <figcaption>北 ↑ · 约 {route.meters} 米 · 障碍快照版本 {route.revision}</figcaption>
    </figure>;
  }
  return <div className="campus-assistant">
    {open && <section className="assistant-panel" aria-label="校园 AI 助手">
      <header><div><strong>校园 AI 助手</strong><small>{ready ? '本地 AI 在线 · 无 API 费用' : '本地 AI 未连接 · 可查询地图路线'}</small></div><button onClick={() => setOpen(false)} aria-label="收起助手">×</button></header>
      <div className="assistant-route"><label>起点<select aria-label="路线起点" value={start} onChange={e => setStart(e.target.value)}>{places.map(p => <option key={p}>{p}</option>)}</select></label><label>终点<select aria-label="路线终点" value={end} onChange={e => setEnd(e.target.value)}>{places.map(p => <option key={p}>{p}</option>)}</select></label><button disabled={busy || !places.length} onClick={() => send(`从${start}到${end}怎么走？`, true)}>查询路线与距离</button></div>
      <div className="assistant-knowledge"><small>项目记忆 · {knowledgeCount} 个主题 · 含实现依据</small><div>
        {['本项目有哪些功能和知识点？','AVL 和 A* 分别做什么？','机器狗步态怎么实现？'].map(q=><button key={q} disabled={busy} onClick={()=>void send(q)}>{q}</button>)}
      </div></div>
      <div className="assistant-messages" aria-live="polite" aria-busy={busy}>
        {!messages.length && <div className="assistant-welcome">你好！可以问我项目知识点、实现过程、代码位置，也可以查询校园路线与距离。<p>试试：“从图书馆到体育馆多远？”</p><button onClick={() => send('什么是 AVL 平衡二叉树？')}>什么是 AVL 平衡二叉树？</button></div>}
        {messages.map((m, i) => <article className={`assistant-message ${m.role}`} key={i}><small>{m.role === 'user' ? '你' : m.reply?.source || '系统提示'}</small><div>{m.content}</div>{m.reply?.route && routeMap(m.reply.route)}{m.reply?.references?.length ? <details className="assistant-sources"><summary>查看实现依据（{m.reply.references.length}）</summary>{m.reply.references.map((r,j)=><div key={j}><code>{r.path}</code><br/>{r.symbol}{!r.current && <b> · 源码已变化，待核验</b>}</div>)}</details> : null}</article>)}
        {busy && <p className="assistant-pending" role="status">正在回答，请稍候… 本地模型首次加载可能需要一些时间。</p>}<div ref={bottom} />
      </div>
      <form onSubmit={e => { e.preventDefault(); void send(input); }}><input aria-label="向校园助手提问" placeholder="输入问题，Enter 发送" maxLength={1000} value={input} onChange={e => setInput(e.target.value)} /><button disabled={busy || !input.trim()}>发送</button></form>
      <div className="assistant-footnote">{busy && <button type="button" onClick={() => activeRequest.current?.abort()}>停止等待</button>} AI 回答供参考；路线按当前模型计算，不代表实地导航。</div>
    </section>}
    <button className="assistant-toggle" onClick={() => setOpen(v => !v)} aria-expanded={open}>{open ? '收起助手' : '✦ 校园 AI · 问路'}</button>
  </div>;
}
