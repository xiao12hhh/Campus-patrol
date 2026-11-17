"""校园栅格 + A* 避障寻路。

机器狗原来只会在两点间走直线，目标点又都是建筑质心，看起来就是"直接穿墙"。
这里把 `public/data/campus-local.json` 里的建筑轮廓栅格化成阻挡图，
寻路时绕开楼体，并留出安全间距，最后做拉绳平滑，避免走出一条锯齿路。

坐标沿用数据口径：1 单位 = 10 m，x 东 / z 南。栅格 1 格 = CELL 单位（4 m）。
"""

from __future__ import annotations

import heapq
import json
import math
import os
from time import perf_counter
from .avl import AVL, height
from typing import Iterable, Sequence

CELL = 0.4          # 1 格 = 0.4 单位 = 4 m
INFLATE = 0.35      # 阻挡膨胀（不到 1 格，实测 1 格会把楼间步道焊死）
MARGIN = 4.0        # 包围盒外扩（单位）

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "public", "data", "campus-local.json")


def _rings(feature: dict) -> list[list[tuple[float, float]]]:
    """取出要素的所有外环（Polygon / MultiPolygon 都吃）。"""
    g = feature.get("geometry") or {}
    t = g.get("type")
    out: list[list[tuple[float, float]]] = []
    if t == "Polygon":
        polys = [g.get("coordinates") or []]
    elif t == "MultiPolygon":
        polys = g.get("coordinates") or []
    else:
        return out
    for poly in polys:
        if not poly:
            continue
        ring = poly[0]
        pts = [(float(p[0]), float(p[1])) for p in ring]
        if len(pts) >= 3:
            out.append(pts)
    return out


def _is_building(props: dict) -> bool:
    if props.get("category") == "building":
        return True
    # 东校区那批来自 OSM 的楼没有 category，但有 building 标签
    return bool(props.get("building"))


def _inside(x: float, z: float, ring: Sequence[tuple[float, float]]) -> bool:
    """奇偶规则点在多边形内判定。"""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, zi = ring[i]
        xj, zj = ring[j]
        if (zi > z) != (zj > z):
            xr = (xj - xi) * (z - zi) / (zj - zi) + xi
            if x < xr:
                inside = not inside
        j = i
    return inside


def _seg_dist(px, pz, ax, az, bx, bz) -> float:
    dx, dz = bx - ax, bz - az
    L = dx * dx + dz * dz
    if L <= 1e-12:
        return math.hypot(px - ax, pz - az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def _segments_distance(ax, az, bx, bz, cx, cz, dx, dz):
    def cross(px, pz, qx, qz, rx, rz):
        return (qx-px)*(rz-pz)-(qz-pz)*(rx-px)
    a, b = cross(ax,az,bx,bz,cx,cz), cross(ax,az,bx,bz,dx,dz)
    c, d = cross(cx,cz,dx,dz,ax,az), cross(cx,cz,dx,dz,bx,bz)
    if a*b < 0 and c*d < 0:
        return 0.0
    return min(_seg_dist(ax,az,cx,cz,dx,dz), _seg_dist(bx,bz,cx,cz,dx,dz),
               _seg_dist(cx,cz,ax,az,bx,bz), _seg_dist(dx,dz,ax,az,bx,bz))


class PlanningBudgetExceeded(Exception):
    pass


class CampusGrid:
    PLAN_SECONDS = 0.5

    def _check_budget(self):
        if perf_counter() >= self._deadline:
            raise PlanningBudgetExceeded

    def __init__(self, extra_points: Iterable[tuple[float, float]] = (), path: str = DATA):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)

        rings: list[list[tuple[float, float]]] = []
        for feat in data.get("features") or []:
            props = feat.get("properties") or {}
            if not _is_building(props):
                continue
            rings.extend(_rings(feat))

        xs = [p[0] for r in rings for p in r]
        zs = [p[1] for r in rings for p in r]
        for x, z in extra_points:
            xs.append(x)
            zs.append(z)
        if not xs:
            raise RuntimeError("campus-local.json 里没有建筑轮廓")

        self.x0 = min(xs) - MARGIN
        self.z0 = min(zs) - MARGIN
        self.w = max(1, int(math.ceil((max(xs) + MARGIN - self.x0) / CELL)))
        self.h = max(1, int(math.ceil((max(zs) + MARGIN - self.z0) / CELL)))

        blocked = bytearray(self.w * self.h)
        # 1) 楼体：格心在楼内即填。不看四角/边中点 —— 实测那样会把楼间 8~12 m 的
        #    步道焊死（三教→体育馆 96 m 变 348 m，狗要绕一大圈）。
        #    贴墙那 1~3 m 的误差交给 step_free() 的沿墙滑行 + push_out 兜底。
        for ring in rings:
            rx = [p[0] for p in ring]
            rz = [p[1] for p in ring]
            i0 = max(0, int((min(rx) - INFLATE - self.x0) / CELL))
            i1 = min(self.w - 1, int((max(rx) + INFLATE - self.x0) / CELL) + 1)
            j0 = max(0, int((min(rz) - INFLATE - self.z0) / CELL))
            j1 = min(self.h - 1, int((max(rz) + INFLATE - self.z0) / CELL) + 1)
            for j in range(j0, j1 + 1):
                cz = self.z0 + (j + 0.5) * CELL
                for i in range(i0, i1 + 1):
                    if blocked[j * self.w + i]:
                        continue
                    cx = self.x0 + (i + 0.5) * CELL
                    if _inside(cx, cz, ring) or any(_seg_dist(cx,cz,*ring[k-1],*ring[k]) <= INFLATE for k in range(len(ring))):
                        blocked[j * self.w + i] = 1

        # 2) 膨胀：到楼边距离小于 INFLATE 的格子也算阻挡
        rad = max(1, int(math.ceil(INFLATE / CELL)))
        grown = bytearray(blocked)
        for j in range(self.h):
            cz = self.z0 + (j + 0.5) * CELL
            for i in range(self.w):
                if blocked[j * self.w + i]:
                    continue
                cx = self.x0 + (i + 0.5) * CELL
                hit = False
                for jj in range(max(0, j - rad), min(self.h, j + rad + 1)):
                    if hit:
                        break
                    for ii in range(max(0, i - rad), min(self.w, i + rad + 1)):
                        if not blocked[jj * self.w + ii]:
                            continue
                        if math.hypot((ii - i) * CELL, (jj - j) * CELL) <= INFLATE:
                            hit = True
                            break
                if hit:
                    grown[j * self.w + i] = 1

        self.blocked = grown
        self.revision = 0
        self.obstacles = {}
        self.nodes = AVL()
        self.last_plan = {}
        self._searches = {}
        self._search_revision = 0
        self._rings = rings
        self._bboxes = [
            (min(p[0] for p in r), min(p[1] for p in r), max(p[0] for p in r), max(p[1] for p in r))
            for r in rings
        ]

    def node(self, index):
        """Lazy AVL records store traversable cell adjacency and distance costs."""
        record = self.nodes.get(index)
        if record is not None:
            return record
        j, i = divmod(index, self.w)
        edges = []
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                ni, nj = i + di, j + dj
                if not (di or dj) or not (0 <= ni < self.w and 0 <= nj < self.h):
                    continue
                nxt = nj * self.w + ni
                if self.blocked[nxt] or (di and dj and (self.blocked[j*self.w+ni] or self.blocked[nj*self.w+i])):
                    continue
                edges.append((nxt, math.hypot(di, dj)))
        record = {"x": self.to_world(i,j)[0], "z": self.to_world(i,j)[1], "edges": edges}
        self.nodes.put(index, record)
        return record

    def dynamic_clear(self, ax, az, bx, bz):
        for o in self.obstacles.values():
            radius = o['radius'] + INFLATE
            if o['x'] < min(ax,bx)-radius or o['x'] > max(ax,bx)+radius or o['z'] < min(az,bz)-radius or o['z'] > max(az,bz)+radius:
                continue
            if _seg_dist(o['x'],o['z'],ax,az,bx,bz) <= radius:
                return False
        return True

    def set_obstacle(self, obstacle):
        self.obstacles[obstacle['id']] = obstacle
        self.revision += 1

    def remove_obstacle(self, oid):
        del self.obstacles[oid]
        self.revision += 1

    def plan(self, start, goal):
        began = perf_counter()
        self._deadline = began + self.PLAN_SECONDS
        reason = 'unreachable'
        try:
            if not self.dynamic_clear(*start, *start) or not self.dynamic_clear(*goal, *goal):
                result = []
                reason = 'endpoint_blocked'
            else:
                result = self._plan(start, goal)
                if result:
                    reason = 'ok'
        except PlanningBudgetExceeded:
            result = []
            reason = 'budget_exceeded'
        self.last_plan = {"milliseconds": round((perf_counter()-began)*1000, 3),
                          "reachable": bool(result), "reason": reason,
                          "waypoints": len(result), "revision": self.revision}
        return result

    # ---------------------------------------------------------------- 基础查询
    def to_cell(self, x: float, z: float) -> tuple[int, int]:
        return (int((x - self.x0) / CELL), int((z - self.z0) / CELL))

    def to_world(self, i: int, j: int) -> tuple[float, float]:
        return (self.x0 + (i + 0.5) * CELL, self.z0 + (j + 0.5) * CELL)

    def is_blocked(self, x: float, z: float) -> bool:
        i, j = self.to_cell(x, z)
        if i < 0 or j < 0 or i >= self.w or j >= self.h:
            return False
        return bool(self.blocked[j * self.w + i])

    def near_building(self, x: float, z: float) -> bool:
        """点是否落在（或贴住）任意楼里——用来断言"没穿墙"。"""
        return not self.segment_clear(x, z, x, z)

    def segment_clear(self, ax, az, bx, bz):
        """Swept disk against exact building edges, including narrow walls missed by the grid."""
        if not self.dynamic_clear(ax, az, bx, bz):
            return False
        for ring, bb in zip(self._rings, self._bboxes):
            if max(ax,bx)+INFLATE < bb[0] or min(ax,bx)-INFLATE > bb[2] or max(az,bz)+INFLATE < bb[1] or min(az,bz)-INFLATE > bb[3]:
                continue
            if _inside(ax,az,ring) or _inside(bx,bz,ring): return False
            for k in range(len(ring)):
                if _segments_distance(ax,az,bx,bz,*ring[k-1],*ring[k]) <= INFLATE:
                    return False
        return True

    def nearest_free(self, x: float, z: float, radius: float = 6.0) -> tuple[float, float]:
        """吸附到最近的可行格。楼体较大时（质心离墙 30 m 以上）用放射状兜底。"""
        if not self.is_blocked(x, z):
            return (x, z)
        i0, j0 = self.to_cell(x, z)
        span = int(math.ceil(radius / CELL))
        best = None
        bestd = 1e9
        for j in range(max(0, j0 - span), min(self.h, j0 + span + 1)):
            for i in range(max(0, i0 - span), min(self.w, i0 + span + 1)):
                if self.blocked[j * self.w + i]:
                    continue
                wx, wz = self.to_world(i, j)
                d = (wx - x) ** 2 + (wz - z) ** 2
                if d < bestd:
                    bestd, best = d, (wx, wz)
        if best is not None:
            return best
        # 兜底：从楼中心往外放射找第一个空格（1 单位 = 10 m 的粗粒度扫描，够用）
        for r in range(1, 41):
            ring_r = r * 0.5
            for k in range(24):
                a = k * math.pi / 12
                wx, wz = x + math.cos(a) * ring_r, z + math.sin(a) * ring_r
                if not self.is_blocked(wx, wz):
                    return (wx, wz)
        return (x, z)

    def free_spot(self, x: float, z: float) -> tuple[float, float]:
        """严格可行点：既不在膨胀格内，也不在原始楼体轮廓内。

        细粒度栅格对几米宽的小构筑物（门房/挑檐）会漏格，这里用轮廓判定兜底。
        """
        if not self.is_blocked(x, z) and not self.near_building(x, z):
            return (x, z)
        for r in range(1, 81):
            rr = r * 0.25
            for k in range(24):
                a = k * math.pi / 12
                wx, wz = x + math.cos(a) * rr, z + math.sin(a) * rr
                if not self.is_blocked(wx, wz) and not self.near_building(wx, wz):
                    return (wx, wz)
        return (x, z)

    def push_out(self, x: float, z: float, margin: float = 0.3) -> tuple[float, float]:
        """若点落在楼里，把它推到最近的墙面外侧（沿最近边法线挪 margin）。

        栅格是 4 m 一格，格心有时会落在墙里 1~4 m；这一步保证渲染上不穿墙。
        楼群互相贴边时需要多推几次，最多 4 轮，推不出来就原样返回。
        """
        for _ in range(4):
            hit = None
            for ring in self._rings:
                if not _inside(x, z, ring):
                    continue
                best = None
                bestd = 1e18
                n = len(ring)
                for k in range(n):
                    ax, az = ring[k]
                    bx, bz = ring[(k + 1) % n]
                    ex, ez = bx - ax, bz - az
                    ln = ex * ex + ez * ez
                    if ln < 1e-12:
                        continue
                    t = ((x - ax) * ex + (z - az) * ez) / ln
                    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                    px, pz = ax + ex * t, az + ez * t
                    d = (px - x) ** 2 + (pz - z) ** 2
                    if d < bestd:
                        bestd, best = d, (px, pz, ex, ez, math.sqrt(ln))
                if best is not None:
                    hit = best
                    break
            if hit is None:
                return (x, z)
            px, pz, ex, ez, ln = hit
            nx, nz = -ez / ln, ex / ln
            if (x - px) * nx + (z - pz) * nz < 0:
                nx, nz = -nx, -nz
            x, z = px + nx * margin, pz + nz * margin
        return (x, z)

    def depth_inside(self, x: float, z: float) -> float:
        """点陷在楼里有多深（米）。在楼外返回 0。只用于自检。"""
        best = 0.0
        for ring in self._rings:
            if not _inside(x, z, ring):
                continue
            n = len(ring)
            d = 1e18
            for k in range(n):
                ax, az = ring[k]
                bx, bz = ring[(k + 1) % n]
                d = min(d, _seg_dist(x, z, ax, az, bx, bz))
            best = max(best, d * 10.0)
        return best

    def step_free(self, x: float, z: float, gx: float, gz: float, step: float) -> tuple[float, float]:
        """朝目标 (gx,gz) 走 step，撞楼就沿墙滑行（而不是停住不动）。

        在所有"不落进楼里"的候选方向里，选**离目标最近**的那个 —— 判定是一致
        的，所以不会像"取第一个可走方向"那样在墙角左右横跳。步长先用满，
        全撞墙再减半/四分之一，窄缝里慢慢蹭过去。
        """
        base = math.atan2(gz - z, gx - x)
        for scale in (1.0, 0.6, 0.3):
            st = step * scale
            best = None
            bestd = 1e18
            for k in (0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100, 120, -120):
                a = base + math.radians(k)
                nx, nz = x + math.cos(a) * st, z + math.sin(a) * st
                if not self.segment_clear(x, z, nx, nz):
                    continue
                d = (gx - nx) ** 2 + (gz - nz) ** 2
                if d < bestd:
                    bestd, best = d, (nx, nz)
            if best is not None:
                return best
        return (x, z)

    def line_clear(self, ax: float, az: float, bx: float, bz: float, step: float = 0.1) -> bool:
        return self.segment_clear(ax, az, bx, bz)

    # ---------------------------------------------------------------- A*
    def _plan(self, start: tuple[float, float], goal: tuple[float, float]) -> list[tuple[float, float]]:
        """返回从 start 到 goal 的世界坐标折线（不含 start，含 goal）。"""
        sx, sz = self.free_spot(*start)
        gx, gz = self.free_spot(*goal)
        self._check_budget()
        if self.line_clear(sx, sz, gx, gz):
            return [(gx, gz)]

        si, sj = self.to_cell(sx, sz)
        gi, gj = self.to_cell(gx, gz)
        if not (0 <= si < self.w and 0 <= gi < self.w and 0 <= sj < self.h and 0 <= gj < self.h):
            return []
        if not self.dynamic_clear(*self.to_world(gi,gj), *self.to_world(gi,gj)):
            return []
        if self.blocked[sj * self.w + si] or self.blocked[gj * self.w + gi]:
            return []

        W, H, blocked = self.w, self.h, self.blocked
        start_idx = sj * W + si
        goal_idx = gj * W + gi
        if start_idx == goal_idx:
            return [(gx, gz)] if self.line_clear(sx,sz,gx,gz) else []

        # Resume bounded A* for the same stationary start, goal and obstacle version.
        if self._search_revision != self.revision:
            self._searches.clear()
            self._search_revision = self.revision
        search_key = (sx, sz, gx, gz)
        if search_key not in self._searches:
            if len(self._searches) >= 8:
                self._searches.pop(next(iter(self._searches)))
            self._searches[search_key] = ([(0.0, start_idx)], {start_idx: 0.0}, {}, set())
        openq, gscore, came, seen = self._searches[search_key]
        found = False
        while openq:
            self._check_budget()
            _, cur = heapq.heappop(openq)
            if cur in seen:
                continue
            seen.add(cur)
            if cur == goal_idx:
                found = True
                break
            cj, ci = divmod(cur, W)
            for nxt, cost in self.node(cur)['edges']:
                if nxt in seen:
                    continue
                nj, ni = divmod(nxt, W)
                if not self.segment_clear(*self.to_world(ci,cj), *self.to_world(ni,nj)):
                    continue
                ng = gscore[cur] + cost
                if ng < gscore.get(nxt, 1e18):
                    gscore[nxt] = ng
                    came[nxt] = cur
                    heapq.heappush(openq, (ng + math.hypot(ni-gi,nj-gj), nxt))
        self._searches.pop(search_key, None)
        if not found:
            return []

        cells = [goal_idx]
        while cells[-1] != start_idx:
            cells.append(came[cells[-1]])
        cells.reverse()
        pts = [(sx,sz)] + [self.to_world(idx % W, idx // W) for idx in cells] + [(gx,gz)]
        if any(not self.line_clear(*a,*b) for a,b in zip(pts,pts[1:])):
            return []

        # 拉绳：能直视就跳过中间点，避免锯齿
        out: list[tuple[float, float]] = []
        i = 0
        while i < len(pts) - 1:
            self._check_budget()
            j = len(pts) - 1
            while j > i + 1 and not self.line_clear(*pts[i], *pts[j]):
                self._check_budget()
                j -= 1
            out.append(pts[j])
            i = j
        # Endpoints were included before smoothing; never replace a checked segment.
        return out

    def path_length(self, pts: Sequence[tuple[float, float]], start: tuple[float, float]) -> float:
        total = 0.0
        prev = start
        for p in pts:
            total += math.hypot(p[0] - prev[0], p[1] - prev[1])
            prev = p
        return total
