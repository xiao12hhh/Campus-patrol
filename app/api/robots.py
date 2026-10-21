from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from app.services.robot_simulator import DOCKS, EVENTS, ROUTES, ROBOTS, simulator

router = APIRouter(tags=["robots"])


@router.get('/api/robots')
def robots():
    """机器人清单（含巡检路线，供前端绘制轨迹）。"""
    return [
        {**r, "route": ROUTES.get(r["route_name"], []), "docks": DOCKS}
        for r in ROBOTS
    ]


@router.get('/api/robots/events')
def robot_events():
    """最近 60 条巡检事件。"""
    return EVENTS


@router.get('/api/robots/{robot_id}')
def robot(robot_id: str):
    item = next((r for r in ROBOTS if r['id'] == robot_id), None)
    if not item:
        raise HTTPException(404, '机器人不存在')
    return {**item, "route": ROUTES.get(item["route_name"], [])}


@router.post('/api/robots/queue')
def set_queue(payload: dict):
    """下发自定义任务队列。

    payload: {"robot_id": "SPOT-01", "mode": "replace" | "append",
              "waypoints": [{"x": -46.7, "z": -11.4, "name": "第三教学楼"}, ...]}
    waypoints 单位与场景一致（1 单位 = 10 m，x 向东、z 向南）。
    """
    robot_id = payload.get('robot_id')
    if not robot_id:
        raise HTTPException(400, '缺少 robot_id')
    waypoints = payload.get('waypoints') or []
    if not isinstance(waypoints, list) or not waypoints:
        raise HTTPException(400, 'waypoints 不能为空')
    mode = payload.get('mode', 'replace')
    if mode not in ('replace', 'append'):
        raise HTTPException(400, 'mode 仅支持 replace / append')
    result = simulator.set_queue(robot_id, waypoints, mode)
    if result is None:
        raise HTTPException(404, '机器人不存在或路点全部非法')
    return result


@router.delete('/api/robots/queue')
def clear_all_queues():
    return {"cleared": simulator.clear_queue(None), "status": "ok"}


@router.post('/api/robots/queue/clear')
def clear_queue(payload: dict | None = None):
    robot_id = (payload or {}).get('robot_id')
    return {"cleared": simulator.clear_queue(robot_id), "status": "ok"}


@router.post('/api/robots/missions')
def create_mission(payload: dict):
    """payload: {"robot_ids": ["SPOT-01"], "action": "start" | "pause"}"""
    action = payload.get('action', 'start')
    if action not in ('start', 'pause'):
        raise HTTPException(400, 'action 仅支持 start / pause')
    ids = payload.get('robot_ids') or None
    result = simulator.control(ids, action)
    if not result:
        raise HTTPException(404, '未找到指定机器人')
    return {"mission_id": "mission-live", "status": action, "robots": result}


@router.post('/api/robots/missions/{mission_id}/{action}')
def mission_action(mission_id: str, action: str):
    if action not in ('start', 'pause', 'cancel'):
        raise HTTPException(400, 'action 仅支持 start / pause / cancel')
    result = simulator.control(None, 'pause' if action == 'cancel' else action)
    return {"mission_id": mission_id, "status": action, "robots": result}


@router.get('/api/robots/missions/{mission_id}')
def mission(mission_id: str):
    return {
        "mission_id": mission_id,
        "status": "running",
        "robots": [{"id": r["id"], "status": r["status"], "progress": r["progress"]} for r in ROBOTS],
    }


def websocket_routes(sim):
    async def ws(websocket: WebSocket):
        await websocket.accept()
        sim.clients.add(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            sim.clients.discard(websocket)
    return ws
