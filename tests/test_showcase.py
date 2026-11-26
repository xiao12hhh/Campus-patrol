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
                    assert len(state['obstacles']) == 36
                    assert simulator.people_moving
                    if crowd is not None:
                        assert state['obstacles'] == crowd
                    crowd = state['obstacles']
                    stations = [(p['name'], p['x'], p['z']) for r in ROBOTS for p in r['queue']]
                    assert len(stations) == len(set(stations))
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
