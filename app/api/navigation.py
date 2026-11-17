"""Teaching demo: AVL navigation index, dynamic obstacles and disjoint patrol sectors."""
import math
import uuid
from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from app.services.avl import AVL, height
from app.services.robot_simulator import campus_grid, simulator, ROBOTS, ROUTES

router = APIRouter(prefix='/api/navigation', tags=['navigation'])


class Obstacle(BaseModel):
    x: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)
    radius: float = Field(default=1, ge=0.2, le=10, allow_inf_nan=False)
    kind: Literal['施工', '人群'] = '施工'


def grid_or_fail():
    grid = campus_grid()
    if grid is None:
        raise HTTPException(503, '地图未加载')
    return grid


@router.get('')
async def state():
    g = grid_or_fail()
    return {'revision': g.revision, 'index': {'nodes': g.nodes.size, 'height': height(g.nodes.root)},
            'obstacles': list(g.obstacles.values()), 'last_plan': g.last_plan,
            'robots': [{k: r.get(k) for k in ('id', 'x', 'z', 'path', 'queue', 'cooperative',
                        'yielding_to', 'navigation_blocked', 'plan_stats')} for r in ROBOTS]}


@router.post('/obstacles')
async def add_obstacle(body: Obstacle):
    g = grid_or_fail()
    i, j = g.to_cell(body.x, body.z)
    if not (0 <= i < g.w and 0 <= j < g.h) or not g.segment_clear(body.x, body.z, body.x, body.z):
        raise HTTPException(400, '请在地图范围内的空地添加障碍')
    if any(math.hypot(r['x']-body.x, r['z']-body.z) <= body.radius + 0.7 for r in ROBOTS):
        raise HTTPException(400, '障碍不能覆盖机器人当前位置，请放在前方路线')
    item = {'id': uuid.uuid4().hex[:8], **body.model_dump()}
    g.set_obstacle(item)
    return item


@router.delete('/obstacles/{oid}')
async def remove_obstacle(oid: str):
    g = grid_or_fail()
    if oid not in g.obstacles:
        raise HTTPException(404, '障碍不存在')
    g.remove_obstacle(oid)
    return {'removed': oid}


@router.post('/allocate')
async def allocate():
    # In-order traversal forms non-overlapping east-west coordinate bands.
    index = AVL()
    for route in ROUTES.values():
        for point in route:
            index.put((point['x'], point['z'], point['name']), dict(point))
    points = [p for _, p in index.items()]
    robots = sorted(ROBOTS, key=lambda r: r['x'])
    for i, r in enumerate(robots):
        sector = points[len(points)*i//len(robots):len(points)*(i+1)//len(robots)]
        simulator.set_queue(r['id'], sector)
        r['cooperative'] = True
        r['mission'] = f'协同分区 {i+1} · {len(sector)} 站循环巡检'
    return await state()


class PedestrianRequest(BaseModel):
    count: int = Field(default=36, ge=0, le=80)


@router.post('/pedestrians')
async def random_pedestrians(body: PedestrianRequest):
    from app.services.pedestrians import populate
    return {'pedestrians': populate(grid_or_fail(), ROBOTS, body.count)}
