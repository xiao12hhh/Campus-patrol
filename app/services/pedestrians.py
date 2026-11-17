"""Stationary pedestrian demo: visible people are the planner's actual obstacles."""
import math
import random
from .campus_data import load_campus
from .campus_grid import _inside


def populate(grid, robots, count=36, seed=None):
    rng = random.Random(seed)
    for key in list(grid.obstacles):
        if key.startswith('ped-'):
            del grid.obstacles[key]
    rings = [r for z in load_campus()['campus']['zones'] for r in z['rings']]
    anchors = [(r['x'], r['z']) for r in robots]
    anchors += [tuple(p) for r in robots for p in r.get('path', [])]
    people = []
    for attempt in range(count * 150):
        if len(people) >= count:
            break
        if anchors and attempt % 3 != 0:
            ax, az = rng.choice(anchors)
            x, z = ax + rng.uniform(-3, 3), az + rng.uniform(-3, 3)
        else:
            x = rng.uniform(grid.x0, grid.x0 + grid.w * .4)
            z = rng.uniform(grid.z0, grid.z0 + grid.h * .4)
        if not any(_inside(x, z, ring) for ring in rings):
            continue
        if not grid.segment_clear(x, z, x, z):
            continue
        if any(math.hypot(x-r['x'], z-r['z']) < 1.2 for r in robots):
            continue
        person = dict(id=f'ped-{len(people)}', x=round(x,3), z=round(z,3), radius=.2,
                      kind='行人', heading=rng.uniform(-math.pi, math.pi), color=rng.randrange(5))
        grid.obstacles[person['id']] = person
        people.append(person)
    grid.revision += 1
    return people
