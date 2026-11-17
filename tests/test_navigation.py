import asyncio
import json
from copy import deepcopy
import pytest
from app.services.avl import AVL, height
from app.services.campus_grid import CampusGrid
from app.services import robot_simulator as rs
from app.api import navigation


def test_avl_sorted_insert_update_and_balance():
    tree = AVL()
    for i in range(1000):
        tree.put(i, i * 2)
    tree.put(42, 'updated')
    assert tree.size == 1000 and tree.get(42) == 'updated'
    assert [k for k, _ in tree.items()] == list(range(1000))
    def check(n):
        if n:
            assert abs(height(n.left)-height(n.right)) <= 1
            assert n.height == 1 + max(height(n.left), height(n.right))
            check(n.left)
            check(n.right)
    check(tree.root)


@pytest.fixture
def grid(tmp_path):
    path = tmp_path / 'map.json'
    path.write_text(json.dumps({'features':[{'properties':{'building':'yes'},
        'geometry':{'type':'Polygon','coordinates':[[[8,8],[9,8],[9,9],[8,9],[8,8]]]}}]}))
    return CampusGrid(path=str(path), extra_points=[(-5,-5),(5,5)])


def test_dynamic_obstacle_detour_and_restore(grid):
    start, goal = (-3,0), (3,0)
    assert grid.plan(start, goal) == [goal]
    grid.set_obstacle(dict(id='work', x=0,z=0,radius=1))
    path = grid.plan(start, goal)
    assert len(path) > 1
    assert all(grid.segment_clear(*a,*b) for a,b in zip([start]+path,path))
    assert grid.nodes.size > 0
    assert grid.plan(start, (0,0)) == []
    grid.remove_obstacle('work')
    assert grid.plan(start, goal) == [goal]


def test_live_robot_replans_on_revision(grid, monkeypatch):
    monkeypatch.setattr(rs, '_grid', grid)
    monkeypatch.setattr(rs, 'ROBOTS', [])
    sim = rs.RobotSimulator()
    r = dict(id='test',x=-3,z=0)
    goal = dict(x=3,z=0)
    sim._navigate(r, goal)
    grid.set_obstacle(dict(id='work',x=0,z=0,radius=1))
    sim._navigate(r, goal)
    assert r['plan_stats']['revision'] == 1
    assert len(r['path']) > 1
    for _ in range(100):
        before = (r['x'],r['z'])
        arrived = sim._navigate(r, goal)
        assert grid.segment_clear(*before,r['x'],r['z'])
        if arrived:
            break
    assert arrived


def test_robot_yields_without_skipping_goal(grid, monkeypatch):
    monkeypatch.setattr(rs, '_grid', grid)
    r = dict(id='a',x=-2,z=0)
    other = dict(id='b',x=-1.1,z=0)
    monkeypatch.setattr(rs, 'ROBOTS', [r,other])
    # Avoid spawn helper: this test exercises the motion guard directly.
    for _ in range(8):
        rs.RobotSimulator._move_toward(r, dict(x=2,z=0))
        assert r['x'] == -2 and r['speed'] == 0
        assert r['yielding_to'] == 'b'
    other['z'] = 3
    rs.RobotSimulator._move_toward(r, dict(x=2,z=0))
    assert r['x'] > -2 and r['yielding_to'] is None


def test_partition_is_disjoint_complete_and_repeats(monkeypatch):
    robots = deepcopy(rs.ROBOTS)
    monkeypatch.setattr(rs, 'ROBOTS', robots)
    monkeypatch.setattr(navigation, 'ROBOTS', robots)
    asyncio.run(navigation.allocate())
    assigned = [p['name'] for r in robots for p in r['queue']]
    expected = {p['name'] for route in rs.ROUTES.values() for p in route}
    assert set(assigned) == expected and len(assigned) == len(set(assigned))
    for r in robots:
        assert r['cooperative'] and r['queue']
        r['queue_index'] = len(r['queue'])-1
        rs.simulator._advance(r)
        assert r['queue_index'] == 0 and r['queue']


def test_random_people_are_in_campus_and_block_planner():
    from app.services.pedestrians import populate
    from app.services.campus_data import load_campus
    from app.services.campus_grid import _inside
    g = rs.campus_grid()
    saved, revision = dict(g.obstacles), g.revision
    try:
        people = populate(g, rs.ROBOTS, 36, seed=12)
        assert len(people) == 36
        rings = [ring for zone in load_campus()['campus']['zones'] for ring in zone['rings']]
        for p in people:
            assert any(_inside(p['x'],p['z'],ring) for ring in rings)
            assert not g.dynamic_clear(p['x'],p['z'],p['x'],p['z'])
            assert g.plan((p['x'],p['z']), (p['x']+2,p['z'])) == []
        populate(g, rs.ROBOTS, 0)
        assert not any(k.startswith('ped-') for k in g.obstacles)
    finally:
        g.obstacles = saved
        g.revision = revision


def test_unreachable_search_has_time_budget(grid):
    import math
    from time import perf_counter
    # Seal a free goal with a circle of people: endpoints remain unobstructed.
    for i in range(16):
        angle = i * math.pi / 8
        grid.set_obstacle(dict(id=str(i),x=3+math.cos(angle),z=math.sin(angle),radius=.2))
    grid.PLAN_SECONDS = .001
    started = perf_counter()
    assert grid.plan((-3,0),(3,0)) == []
    assert perf_counter()-started < .2
    assert grid.last_plan['reason'] == 'budget_exceeded'


def test_budgeted_search_resumes_and_invalidates_on_obstacle_change(grid):
    import math
    for i in range(16):
        angle = i * math.pi / 8
        grid.set_obstacle(dict(id=str(i),x=3+math.cos(angle),z=math.sin(angle),radius=.2))
    grid.PLAN_SECONDS = .005
    previous = 0
    for _ in range(100):
        assert grid.plan((-3,0),(3,0)) == []
        if grid.last_plan['reason'] != 'budget_exceeded':
            break
        seen = sum(len(state[3]) for state in grid._searches.values())
        assert seen >= previous
        previous = seen
    assert grid.last_plan['reason'] == 'unreachable'
    for key in list(grid.obstacles):
        grid.remove_obstacle(key)
    assert grid.plan((-3,0),(3,0)) == [(3,0)]
