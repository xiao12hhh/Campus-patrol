import json
from copy import deepcopy
from app.services.campus_grid import CampusGrid
from app.services.robot_simulator import ROBOTS, campus_grid
from app.services.robot_simulator import RobotSimulator, ROUTES


def test_robots_spawn_outside_buildings():
    grid = campus_grid()
    assert grid is not None
    assert all(not grid.near_building(r['x'], r['z']) for r in ROBOTS)


def test_thin_wall_cannot_be_crossed_between_free_endpoints(tmp_path):
    path = tmp_path/'map.json'
    path.write_text(json.dumps({'features': [{'properties': {'building': 'yes'},
        'geometry': {'type': 'Polygon', 'coordinates': [[[0,-4],[.05,-4],[.05,4],[0,4],[0,-4]]]}}]}))
    grid = CampusGrid(path=str(path))
    assert not grid.line_clear(-1, 0, 1, 0)
    x, z = grid.step_free(-1, 0, 1, 0, 2)
    assert x < 0, (x, z)


def test_all_patrol_legs_progress_without_crossing_buildings():
    grid = campus_grid()
    sim = RobotSimulator()
    for index, route in enumerate(ROUTES.values()):
        robot = deepcopy(ROBOTS[index])
        robot['x'], robot['z'] = grid.free_spot(route[0]['x'], route[0]['z'])
        for goal in route[1:] + route[:1]:
            arrived = False
            for _ in range(2000):
                before = (robot['x'], robot['z'])
                arrived = sim._navigate(robot, goal)
                after = (robot['x'], robot['z'])
                assert grid.segment_clear(*before, *after), (robot['id'], goal['name'], before, after)
                if arrived: break
            assert arrived, (robot['id'], goal['name'], robot.get('navigation_blocked'))


def test_unreachable_goal_never_falls_back_to_a_straight_line(tmp_path):
    walls = [[[-3,-3],[3,-3],[3,-2.5],[-3,-2.5]],
             [[-3,2.5],[3,2.5],[3,3],[-3,3]],
             [[-3,-3],[-2.5,-3],[-2.5,3],[-3,3]],
             [[2.5,-3],[3,-3],[3,3],[2.5,3]]]
    features = [{'properties': {'building': 'yes'}, 'geometry': {'type': 'Polygon',
        'coordinates': [ring + [ring[0]]]}} for ring in walls]
    path = tmp_path/'closed.json'
    path.write_text(json.dumps({'features': features}))
    grid = CampusGrid(path=str(path), extra_points=[(6, 0)])
    assert grid.plan((0, 0), (6, 0)) == []
