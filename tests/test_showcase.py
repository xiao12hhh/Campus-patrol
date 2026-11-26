import asyncio
from app.api import navigation as n
from app.services.robot_simulator import simulator, ROBOTS


def test_showcase_replay_and_exit():
    async def run():
        try:
            crowd = None
            for step in [0, 1, 2, 2, 3, 4, 4, 5, 0]:
                state = await n.showcase_step(n.ShowcaseStep(step=step))
                assert state['demo_mode']
                if step in (2, 3):
                    assert len(state['obstacles']) == 1
                    r = ROBOTS[0]
                    assert r['comparison']['before'] != r['comparison']['after']
                if step == 4:
                    assert len(state['obstacles']) == 3
                    assert not simulator.people_moving
                    if crowd is not None:
                        assert state['obstacles'] == crowd
                    crowd = state['obstacles']
                    stations = [(p['name'], p['x'], p['z']) for r in ROBOTS for p in r['queue']]
                    assert len(stations) == len(set(stations))
                    r = ROBOTS[0]
                    goal = r['queue'][0]
                    grid = n.grid_or_fail()
                    assert len(r['comparison']['after']) > 2
                    arrived = False
                    for _ in range(100):
                        before = r['x'], r['z']
                        arrived = simulator._navigate(r, goal)
                        assert grid.segment_clear(*before, r['x'], r['z'])
                        if arrived:
                            break
                    assert arrived, 'Focused pedestrian demo must visibly reach the goal'
                if step in (0, 5):
                    assert not state['obstacles']
                    assert all(r['status'] == '待命' for r in ROBOTS)
            await n.showcase_exit()
            assert not simulator.demo_mode and not simulator.people_moving
            assert all(r['status'] != '巡检中' for r in ROBOTS)
        finally:
            await n.demo_reset()
            await n.showcase_exit()
    asyncio.run(run())
