"""Local-model chat; distances always come from the campus planner, never the LLM."""
import asyncio
from copy import deepcopy
import json
import math
import os
import re
import threading
import urllib.request
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from app.services.campus_data import places_by_name
from app.services.campus_grid import CampusGrid
from app.services.robot_simulator import campus_grid

router = APIRouter(prefix='/api/assistant', tags=['assistant'])
MODEL = os.environ.get('CAMPUS_AI_MODEL', 'deepseek-r1:1.5b')
BASE = os.environ.get('CAMPUS_AI_URL', 'http://127.0.0.1:11434').rstrip('/')
_grid = None
_lock = threading.Lock()
_busy = asyncio.Semaphore(1)
ALIASES = {'三教': '第三教学楼', '四教': '第四教学楼', '一食堂': '第一食堂', '二食堂': '第二食堂', '学活': '学生活动中心', '操场': '红旗操场'}


class Message(BaseModel):
    role: Literal['user', 'assistant']
    content: str = Field(max_length=2000)


class Question(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    start: str | None = Field(default=None, max_length=100)
    end: str | None = Field(default=None, max_length=100)
    history: list[Message] = Field(default_factory=list, max_length=10)


def ollama(path, body=None, timeout=3):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout) as response:
        return json.load(response)


@router.get('/status')
async def status():
    try:
        data = await asyncio.to_thread(ollama, '/api/tags')
        ready = any(m['name'] == MODEL for m in data.get('models', []))
    except Exception:
        ready = False
    return {'ready': ready, 'model': MODEL, 'places': sorted(places_by_name())}


def mentioned(text, places):
    matches = []
    for word in sorted(set(places) | set(ALIASES), key=len, reverse=True):
        name = ALIASES.get(word, word)
        if name not in places:
            continue
        for hit in re.finditer(re.escape(word), text):
            if not any(a <= hit.start() < b for a, b, _ in matches):
                matches.append((hit.start(), hit.end(), name))
    return [name for _, _, name in sorted(matches)]


def route(start, end, obstacles, revision):
    global _grid
    places = places_by_name()
    with _lock:
        if _grid is None:
            _grid = CampusGrid()
        g = _grid
        g.obstacles = obstacles
        g.revision = revision
        a = g.free_spot(places[start]['x'], places[start]['z'])
        b = g.free_spot(places[end]['x'], places[end]['z'])
        path = []
        for _ in range(6):
            path = g.plan(a, b)
            if path or g.last_plan['reason'] != 'budget_exceeded':
                break
        if not path:
            return {'answer': '当前未找到可通行路线，可能存在障碍或规划时间不足。请调整起终点或移除障碍后重试。', 'source': '地图计算'}
        points = [a, *path]
        meters = round(sum(math.dist(p, q) for p, q in zip(points, points[1:])) * 10)
        directions = []
        for p, q in zip(points, points[1:]):
            distance = round(math.dist(p, q) * 10)
            if distance < 1:
                continue
            angle = math.atan2(q[1]-p[1], q[0]-p[0])
            direction = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'][round(angle / (math.pi/4)) % 8]
            directions.append(f'向{direction}约 {distance} 米')
        return {'answer': f'{start} → {end}\n模型内可通行路线约 {meters} 米，按步行 1.2 米/秒估算约 {max(1, math.ceil(meters/72))} 分钟。\n' + '；'.join(directions) + '。\n起终点吸附至建筑附近空地，并非已核实的入口；路线可能经过空地，仅供校园模型演示。障碍变化后请重新查询。',
                'source': '地图计算', 'route': {'start': start, 'end': end, 'points': points, 'meters': meters, 'revision': revision}}


def chat(body):
    system = ('你是中国石油大学（北京）校园演示系统的中文助手。简短回答普通问题。'
              '不了解的学校事实请明确说不知道；不得编造楼宇位置、开放时间、路线和距离。'
              '路线问题请引导用户选择起点和终点再点击查询路线。你只能解释，不能操作系统、下发任务或修改地图。系统已有三维校园、机器狗巡检、AVL索引、A*避障、动态行人功能。')
    data = ollama('/api/chat', {'model': MODEL, 'stream': False, 'think': False, 'keep_alive': '10m',
        'messages': [{'role': 'system', 'content': system}, *[m.model_dump() for m in body.history], {'role': 'user', 'content': body.message}],
        'options': {'num_predict': 700, 'num_ctx': 4096, 'temperature': 0.3}}, timeout=75)
    answer = re.sub(r'<think>.*?</think>', '', data.get('message', {}).get('content', ''), flags=re.S).strip()
    if not answer or '<think>' in answer:
        raise ValueError('No completed answer')
    return {'answer': answer, 'source': '本地 AI · ' + MODEL}


@router.post('/chat')
async def ask(body: Question):
    places = places_by_name()
    names = mentioned(body.message, places)
    start, end = body.start, body.end
    route_intent = bool(start or end or (len(names) >= 2 and re.search('到|至', body.message)) or re.search('路线|怎么走|怎么去|多远|距离|到.*米|去.*走', body.message))
    if route_intent:
        if not start and len(names) >= 2:
            start, end = names[0], names[1]
        if start not in places or end not in places:
            return {'answer': '请选择起点和终点，或输入“从图书馆到体育馆怎么走”。我不能确定你当前的位置。', 'source': '地图助手'}
        if start == end:
            return {'answer': '起终点相同，距离为 0 米。', 'source': '地图计算'}
        live = campus_grid()
        if live is None:
            return {'answer': '地图尚未加载，请稍后重试。', 'source': '系统提示'}
        return await asyncio.to_thread(route, start, end, deepcopy(live.obstacles), live.revision)
    if _busy.locked():
        return {'answer': '助手正在处理另一条问题，请稍后重试。', 'source': '系统提示'}
    async with _busy:
        try:
            return await asyncio.to_thread(chat, body)
        except Exception:
            return {'answer': '本地 AI 暂时无法回答（服务未启动、模型未安装或生成超时）。路线和距离查询仍可使用。请启动 Ollama 后重试。', 'source': '系统提示'}
