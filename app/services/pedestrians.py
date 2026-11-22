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



def move_people(grid, robots, dt=1.0):
    """Move at 0.8 m/s; swept checks prevent walking into buildings or robots."""
    from .campus_grid import _seg_dist
    rings = [r for zone in load_campus()['campus']['zones'] for r in zone['rings']]
    moved = False
    for key in list(grid.obstacles):
        person = grid.obstacles[key]
        if person.get('kind') != '行人':
            continue
        x,z=person['x'],person['z']
        nx,nz=x+math.sin(person['heading'])*.08*dt,z+math.cos(person['heading'])*.08*dt
        # Exclude only this person's own collision body.
        del grid.obstacles[key]
        safe = all(any(_inside(*p,r) for r in rings) for p in ((nx,nz),((x+nx)/2,(z+nz)/2)))
        safe = safe and grid.segment_clear(x,z,nx,nz)
        safe = safe and all(_seg_dist(r['x'],r['z'],x,z,nx,nz) > .9 for r in robots)
        if safe:
            person.update(x=nx,z=nz,speed=.08)
            moved=True
        else:
            person.update(heading=person['heading']+math.pi*.65,speed=0)
        grid.obstacles[key]=person
    if moved:
        grid.revision+=1
    return moved
