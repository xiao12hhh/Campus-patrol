"""Teaching demo: AVL navigation index, dynamic obstacles and disjoint patrol sectors."""
from copy import deepcopy
import math
import uuid
from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from app.services.avl import AVL, height
from app.services.robot_simulator import campus_grid, simulator, ROBOTS, ROUTES

INITIAL_ROBOTS = deepcopy(ROBOTS)
DEMO_OBSTACLE = None

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
    return {'people_moving': simulator.people_moving, 'demo_mode': simulator.demo_mode, 'demo_obstacle': DEMO_OBSTACLE, 'revision': g.revision, 'index': {'nodes': g.nodes.size, 'height': height(g.nodes.root)},
            'obstacles': list(g.obstacles.values()), 'last_plan': g.last_plan,
            'robots': [{k: r.get(k) for k in ('id', 'x', 'z', 'path', 'queue', 'cooperative',
                        'yielding_to', 'navigation_blocked', 'plan_stats', 'comparison')} for r in ROBOTS]}


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


@router.post('/demo/reset')
async def demo_reset():
    global DEMO_OBSTACLE
    from app.services.campus_data import load_campus
    from app.services.campus_grid import _inside
    g = grid_or_fail()
    g.obstacles.clear()
    g.revision += 1
    g._searches.clear()
    for cache in (simulator._path, simulator._path_key, simulator._dwell,
                  simulator._dock_target, simulator._stuck, simulator._recover):
        cache.clear()
    simulator.reset_epoch += 1
    ROBOTS[:] = deepcopy(INITIAL_ROBOTS)
    for robot in ROBOTS:
        robot.update(motion_epoch=simulator.reset_epoch, status='待命', battery=100, speed=0, queue=[], path=[], cooperative=False)
    simulator.people_moving = False
    simulator.demo_mode = True
    rings = [r for zone in load_campus()['campus']['zones'] for r in zone['rings']]
    # Deterministic open corridor inside campus, with room to detour around its midpoint.
    for z in range(-30, 1, 2):
        for x in range(-50, -10, 2):
            start, goal = (x,z), (x+3,z)
            if not all(any(_inside(*p,r) for r in rings) for p in (start,goal)):
                continue
            if not g.segment_clear(*start,*goal):
                continue
            item = dict(id='demo-construction',x=x+1.5,z=z,radius=.35,kind='施工')
            g.obstacles[item['id']] = item
            detour = g.plan(start, goal)
            del g.obstacles[item['id']]
            if not detour:
                continue
            DEMO_OBSTACLE = item
            robot = ROBOTS[0]
            robot.update(x=x,z=z,heading=math.pi/2,mission='课堂演示路线')
            simulator.set_queue(robot['id'], [dict(x=goal[0],z=goal[1],name='演示终点')])
            robot['status']='待命'
            robot['path']=[list(goal)]
            simulator._path[robot['id']]=[list(goal)]
            simulator._path_key[robot['id']]=(float(goal[0]),float(goal[1]),g.revision)
            return await state()
    raise HTTPException(409,'未找到可复现的演示通道')


@router.post('/demo/obstacle')
async def demo_obstacle():
    if not simulator.demo_mode or not DEMO_OBSTACLE:
        raise HTTPException(400,'请先一键复位演示')
    item = DEMO_OBSTACLE
    await add_obstacle(Obstacle(x=item['x'],z=item['z'],radius=item['radius']))
    # Plan while paused so the before/after comparison is visible before starting.
    robot = ROBOTS[0]
    position = robot['x'], robot['z']
    simulator._navigate(robot, robot['queue'][0])
    robot['x'], robot['z'] = position
    robot['speed']=0
    return await state()


@router.post('/demo/start')
async def demo_start():
    if not simulator.demo_mode:
        raise HTTPException(400,'请先一键复位演示')
    simulator.control([ROBOTS[0]['id']], 'start')
    return await state()


@router.post('/demo/exit')
async def demo_exit():
    simulator.demo_mode = False
    return await state()


class PeopleMotion(BaseModel):
    enabled: bool


@router.post('/pedestrians/motion')
async def people_motion(body: PeopleMotion):
    simulator.people_moving = body.enabled
    return await state()


class ShowcaseStep(BaseModel):
    step: int = Field(ge=0, le=5)


@router.post('/showcase/step')
async def showcase_step(body: ShowcaseStep):
    # Each stage rebuilds its own fixture, so retry/back/replay cannot duplicate obstacles.
    await demo_reset()
    if body.step in (2, 3):
        await demo_obstacle()
    if body.step in (1, 3):
        ROBOTS[0]['cooperative'] = True
        await demo_start()
    if body.step == 4:
        goal = dict(ROBOTS[0]['queue'][0])
        await allocate()
        simulator.set_queue(ROBOTS[0]['id'], [goal])
        ROBOTS[0]['cooperative'] = True
        g = grid_or_fail()
        # A visible, reproducible gathering in the selected robot's corridor.
        for i, offset in enumerate((-.65, 0, .65)):
            item = dict(id=f'ped-demo-{i}', x=DEMO_OBSTACLE['x'], z=DEMO_OBSTACLE['z']+offset,
                        radius=.2, kind='行人', heading=-math.pi/2, color=i%2)
            if not g.segment_clear(item['x'], item['z'], item['x'], item['z']):
                raise HTTPException(409, '演示通道无法放置行人，请重播')
            g.set_obstacle(item)
        position = ROBOTS[0]['x'], ROBOTS[0]['z']
        simulator._navigate(ROBOTS[0], goal)
        ROBOTS[0]['x'], ROBOTS[0]['z'] = position
        ROBOTS[0]['comparison'] = dict(before=[list(position), [goal['x'],goal['z']]], after=[list(position), *ROBOTS[0]['path']], revision=g.revision)
        simulator.people_moving = False
        simulator.control(None, 'start')
    return await state()


@router.post('/showcase/exit')
async def showcase_exit():
    simulator.control(None, 'pause')
    simulator.people_moving = False
    simulator.demo_mode = False
    return await state()
