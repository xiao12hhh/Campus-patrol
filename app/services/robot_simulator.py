"""四足机器人巡检仿真服务。

坐标单位与 public/data/campus-local.json（v4）一致：1 单位 = 10 米，
**x 向东、z 向南**（原点 40.2159,116.2449）。

路点按名称从当前地理布局读取，地图重建后不保留旧示意图坐标。

状态机：待命 -> 巡检中 -> (到点) 检测中 -> 巡检中 -> ... 电量低 -> 返航 -> 充电中 -> 巡检中
事件流：检测中按概率生成巡检告警，随 WebSocket 推送并保留最近 60 条历史。
"""
import asyncio
import math
import random
import uuid
from time import monotonic
from datetime import datetime, timezone

from .campus_grid import CampusGrid, _seg_dist

# 巡检站点随地图版本解析，禁止继续使用手绘地图里的硬编码坐标。
from .campus_data import places_by_name
_places = places_by_name()
_ROUTE_NAMES = {
    "北校区教学区环线": ["主楼A座", "主楼B座", "图书馆", "第二教学楼", "国际交流中心"],
    "体育设施线": ["网球场", "红旗操场", "体育馆", "游泳馆"],
    "东校区生活区线": ["1号楼", "3号楼", "5号楼", "6号楼", "4号楼", "2号楼", "实验楼", "主教"],
}
ROUTES = {name: [dict(_places[n]) for n in names if n in _places] for name, names in _ROUTE_NAMES.items()}
_south_gate = _places["南门"]
DOCKS = [
    {"x": _south_gate["x"] + 1.5, "z": _south_gate["z"] - 1.5, "name": "南门充电桩"},
    {"x": 28.0, "z": 6.0, "name": "东校区充电桩"},
]

# ------------------------------------------------------------------ 避障栅格
_grid: CampusGrid | None = None


def campus_grid() -> CampusGrid | None:
    """懒加载栅格地图（首次用到时建，约 0.2 s）。失败则返回 None，降级为直线行进。"""
    global _grid
    if _grid is None:
        try:
            extra = [(w["x"], w["z"]) for pts in ROUTES.values() for w in pts]
            extra += [(d["x"], d["z"]) for d in DOCKS]
            _grid = CampusGrid(extra_points=extra)
        except Exception:  # 数据缺失/解析失败时不能让整个仿真挂掉
            _grid = None
    return _grid


EVENT_TEMPLATES = [
    {"type": "消防通道占用", "level": "warning", "message": "检测到消防通道被杂物占用，已拍照上报"},
    {"type": "门窗未关闭", "level": "warning", "message": "红外检测到门窗未关闭，已记录位置"},
    {"type": "设备温度异常", "level": "critical", "message": "配电箱表面温度 68℃，超过阈值 60℃"},
    {"type": "夜间照明故障", "level": "info", "message": "路灯不亮，疑似灯具故障"},
    {"type": "人员徘徊", "level": "warning", "message": "闭园时段检测到人员长时间徘徊"},
    {"type": "垃圾溢满", "level": "info", "message": "垃圾桶满溢，建议通知清运"},
    {"type": "仪表读数正常", "level": "info", "message": "巡检点位读数正常，无异常"},
]

ROBOTS: list[dict] = [
    {
        "id": "SPOT-01", "model": "Unitree B2", "status": "巡检中",
        "x": -46.75, "z": -11.44, "battery": 82.0, "signal": -58,
        "mission": "北校区教学区巡检", "progress": 0.0, "heading": 0.0,
        "route_name": "北校区教学区环线", "waypoint_index": 1, "speed": 0.0,
        # 自定义任务队列（前端「任务队列」下发）：非空时优先走队列，走完自动清空并回到默认环线
        "queue": [], "queue_index": 0, "path": [],
    },
    {
        "id": "SPOT-02", "model": "Boston Dynamics Spot", "status": "巡检中",
        "x": -49.72, "z": -17.66, "battery": 64.0, "signal": -61,
        "mission": "体育设施区巡检", "progress": 0.1, "heading": 1.2,
        "route_name": "体育设施线", "waypoint_index": 1, "speed": 0.0,
        "queue": [], "queue_index": 0, "path": [],
    },
    {
        "id": "ANYmal", "model": "ANYmal C", "status": "待命",
        "x": 24.80, "z": 2.36, "battery": 91.0, "signal": -50,
        "mission": None, "progress": 0.0, "heading": -1.0,
        "route_name": "东校区生活区线", "waypoint_index": 0, "speed": 0.0,
        "queue": [], "queue_index": 0, "path": [],
    },
]

# 初始位置与巡检线路一致；实际行走由 CampusGrid 推离楼体并避障。
for _robot, _route in zip(ROBOTS, ROUTES.values()):
    if _route:
        _robot.update(x=_route[0]["x"], z=_route[0]["z"])

EVENTS: list[dict] = []


def _seed_events() -> None:
    for robot in ROBOTS[:2]:
        _emit_event(robot, random.choice(EVENT_TEMPLATES))


def _emit_event(robot: dict, template: dict) -> None:
    event = {
        "id": uuid.uuid4().hex[:8],
        "robot_id": robot["id"],
        "location": _nearest_name(robot),
        "x": round(robot["x"], 2),
        "z": round(robot["z"], 2),
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **template,
    }
    EVENTS.append(event)
    del EVENTS[:-60]


def _nearest_name(robot: dict) -> str:
    queue = robot.get("queue") or []
    if queue:
        index = min(robot.get("queue_index", 0), len(queue) - 1)
        return queue[index]["name"]
    route = ROUTES.get(robot["route_name"], [])
    if route:
        return route[robot["waypoint_index"] % len(route)]["name"]
    return "校园"


class RobotSimulator:
    """每秒一个 tick：推进状态机、生成事件、向 WebSocket 客户端广播。"""

    MOVE_SPEED = 0.35       # 单位/秒 ≈ 3.5 m/s（演示节奏）
    STUCK_EPS = 0.02        # 一个 tick 位移小于 0.02 单位（0.2 m）就算没动
    STUCK_TICKS = 3         # 连续 3 个 tick 没动 → 判定卡住并解困
    DETECT_SECONDS = 4
    DRAIN_PER_TICK = 0.12
    CHARGE_PER_TICK = 1.6
    LOW_BATTERY = 20.0
    FULL_BATTERY = 90.0
    EVENT_CHANCE = 0.22

    def __init__(self) -> None:
        self.clients: set = set()
        self.running = False
        self._dwell: dict[str, int] = {}
        self._dock_target: dict[str, dict] = {}
        self._path: dict[str, list] = {}          # 当前规划出的剩余路径（世界坐标折线）
        self._path_key: dict[str, tuple] = {}     # 该路径对应的目标点，目标变了才重算
        self._stuck: dict[str, int] = {}          # 连续多少个 tick 几乎没挪动
        self._recover: dict[str, int] = {}        # 当前目标已经尝试过几次解困
        _seed_events()
        self._snap_spawn()

    @staticmethod
    def _snap_spawn() -> None:
        """路点与出生点原本是建筑质心（落在楼里），统一吸附到最近的可行格。"""
        grid = campus_grid()
        if grid is None:
            return
        for robot in ROBOTS:
            x, z = grid.free_spot(robot["x"], robot["z"])
            robot["x"], robot["z"] = round(x, 2), round(z, 2)

    # ---------------------------------------------------------------- 任务队列
    def set_queue(self, robot_id: str, waypoints: list[dict], mode: str = "replace") -> dict | None:
        """下发自定义路点队列。mode=replace 覆盖，append 追加。

        队列非空时机器人优先按队列顺序走，走完自动清空并回到 route_name 的默认环线。
        """
        robot = next((r for r in ROBOTS if r["id"] == robot_id), None)
        if robot is None:
            return None
        robot["cooperative"] = False
        clean: list[dict] = []
        for item in waypoints:
            try:
                x, z = float(item["x"]), float(item["z"])
            except (KeyError, TypeError, ValueError):
                continue
            name = str(item.get("name") or f"路点{len(clean) + 1}")[:24]
            clean.append({"x": round(x, 2), "z": round(z, 2), "name": name})
        if not clean:
            return None

        if mode == "append" and robot.get("queue"):
            robot["queue"] = list(robot["queue"]) + clean
        else:
            robot["queue"] = clean
            robot["queue_index"] = 0
        robot["mission"] = f"自定义任务队列（{len(robot['queue'])} 站）"
        robot["progress"] = round(min(1.0, robot["queue_index"] / len(robot["queue"])), 3)
        robot["status"] = "巡检中"
        robot["speed"] = 0.0
        return {"id": robot["id"], "queue": robot["queue"], "queue_index": robot["queue_index"], "status": robot["status"]}

    def clear_queue(self, robot_id: str | None = None) -> list[dict]:
        out = []
        for robot in ROBOTS:
            if robot_id and robot["id"] != robot_id:
                continue
            robot["queue"] = []
            robot["queue_index"] = 0
            robot["progress"] = 0.0
            if robot["status"] in ("巡检中", "检测中"):
                robot["mission"] = f"{robot['route_name']}巡检"
            out.append({"id": robot["id"], "queue": []})
        return out

    # ---------------------------------------------------------------- 对外控制
    def control(self, robot_ids: list[str] | None, action: str) -> list[dict]:
        targets = [r for r in ROBOTS if not robot_ids or r["id"] in robot_ids]
        for robot in targets:
            if action == "start":
                robot["status"] = "巡检中"
                robot["mission"] = (
                    f"自定义任务队列（{len(robot['queue'])} 站）" if robot.get("queue")
                    else f"{robot['route_name']}巡检"
                )
            elif action == "pause":
                robot["status"] = "待命"
                robot["speed"] = 0.0
            elif action == "clear_queue":
                robot["queue"] = []
                robot["queue_index"] = 0
                robot["progress"] = 0.0
        return [{"id": r["id"], "status": r["status"]} for r in targets]

    # ---------------------------------------------------------------- 主循环
    async def loop(self) -> None:
        self.running = True
        while self.running:
            for robot in ROBOTS:
                self._tick(robot)
                await asyncio.sleep(0)  # Let pending API requests run between bounded plans.
            if self.clients:
                await self._broadcast()
            await asyncio.sleep(1)

    def _target_of(self, robot: dict) -> dict | None:
        """当前要去的路点：自定义队列优先，否则走默认环线。"""
        queue = robot.get("queue") or []
        if queue:
            index = robot.get("queue_index", 0)
            return queue[index] if index < len(queue) else None
        route = ROUTES.get(robot["route_name"], [])
        if not route:
            return None
        return route[robot["waypoint_index"] % len(route)]

    def _advance(self, robot: dict) -> None:
        """到达并检视完一站后推进指针；队列走完就清空并回到默认环线。"""
        queue = robot.get("queue") or []
        if queue and robot.get("cooperative"):
            robot["queue_index"] = (robot.get("queue_index", 0) + 1) % len(queue)
            return
        if queue:
            robot["queue_index"] = robot.get("queue_index", 0) + 1
            robot["progress"] = round(min(1.0, robot["queue_index"] / len(queue)), 3)
            if robot["queue_index"] >= len(queue):
                robot["queue"] = []
                robot["queue_index"] = 0
                robot["progress"] = 0.0
                robot["mission"] = f"{robot['route_name']}巡检"
                _emit_event(robot, {
                    "type": "任务队列完成",
                    "level": "info",
                    "message": f"自定义队列 {len(queue)} 个路点已全部抵达，恢复默认巡检环线",
                })
            return
        route = ROUTES.get(robot["route_name"], [])
        if route:
            robot["waypoint_index"] = (robot["waypoint_index"] + 1) % len(route)
            robot["progress"] = round(robot["waypoint_index"] / len(route), 3)

    def _tick(self, robot: dict) -> None:
        rid = robot["id"]
        target = self._target_of(robot)
        if target is None:
            robot["status"] = "待命"
            robot["speed"] = 0.0
            return

        # 低电量 -> 返航充电（检测/巡检中均可触发）
        if robot["status"] in ("巡检中", "检测中") and robot["battery"] <= self.LOW_BATTERY:
            dock = min(DOCKS, key=lambda d: (d["x"] - robot["x"]) ** 2 + (d["z"] - robot["z"]) ** 2)
            self._dock_target[rid] = dock
            robot["status"] = "返航"

        if robot["status"] == "巡检中":
            arrived = self._navigate(robot, target)
            robot["battery"] = max(0.0, robot["battery"] - self.DRAIN_PER_TICK)
            if arrived:
                robot["status"] = "检测中"
                self._dwell[rid] = self.DETECT_SECONDS
                if random.random() < self.EVENT_CHANCE:
                    _emit_event(robot, random.choice(EVENT_TEMPLATES))
        elif robot["status"] == "检测中":
            robot["speed"] = 0.0
            self._dwell[rid] = self._dwell.get(rid, 0) - 1
            if self._dwell[rid] <= 0:
                self._advance(robot)
                robot["status"] = "巡检中"
        elif robot["status"] == "返航":
            dock = self._dock_target.get(rid) or DOCKS[0]
            arrived = self._navigate(robot, dock)
            robot["battery"] = max(0.0, robot["battery"] - self.DRAIN_PER_TICK)
            if arrived:
                robot["status"] = "充电中"
        elif robot["status"] == "充电中":
            robot["speed"] = 0.0
            robot["battery"] = min(100.0, robot["battery"] + self.CHARGE_PER_TICK)
            if robot["battery"] >= self.FULL_BATTERY:
                robot["status"] = "巡检中"

    def _navigate(self, robot: dict, target: dict) -> bool:
        """沿栅格 A* 路径走向 target；到达（走完路径）返回 True。

        路点大多是建筑质心（在楼里），plan() 会把起终点吸附到最近的可行格，
        所以"走完整条路径"就是到达，不要求和 target 重合。
        """
        rid = robot["id"]
        grid = campus_grid()
        key = (round(target["x"], 2), round(target["z"], 2), grid.revision if grid else -1)
        if robot.get('plan_stats', {}).get('reason') == 'budget_exceeded' and monotonic() >= robot.get('_retry_at', 0):
            self._path_key.pop(rid, None)
        if self._path_key.get(rid) != key:
            pts = grid.plan((robot["x"], robot["z"]), (target["x"], target["z"])) if grid else []
            robot["plan_stats"] = dict(grid.last_plan) if grid else {}
            robot["_retry_at"] = monotonic() + 1
            robot["navigation_blocked"] = not bool(pts)
            self._path[rid] = [list(p) for p in pts]
            self._path_key[rid] = key
            self._stuck[rid] = 0
            self._recover[rid] = 0
        if robot.get("navigation_blocked"):
            robot["speed"] = 0.0
            robot["path"] = []
            return False
        path = self._path.get(rid) or []
        while path:
            # 最后一个点是吸附到楼边上的点，贴墙时进不到 0.18，放宽到 0.45
            tol = 0.01
            if math.hypot(path[0][0] - robot["x"], path[0][1] - robot["z"]) < tol:
                path.pop(0)
            else:
                break
        robot["path"] = [[round(p[0], 2), round(p[1], 2)] for p in path]
        if not path:
            robot["speed"] = 0.0
            self._stuck[rid] = 0
            return True

        bx, bz = robot["x"], robot["z"]
        self._move_toward(robot, {"x": path[0][0], "z": path[0][1]})
        if robot.get("yielding_to"):
            return False
        if math.hypot(robot["x"] - bx, robot["z"] - bz) >= self.STUCK_EPS:
            self._stuck[rid] = 0
            return False

        # 几乎没挪动：连续几个 tick 就认定卡住（墙角 / 楼间窄缝 / 目标贴在墙上）
        self._stuck[rid] = self._stuck.get(rid, 0) + 1
        if self._stuck[rid] < self.STUCK_TICKS:
            return False

        self._stuck[rid] = 0
        self._recover[rid] = self._recover.get(rid, 0) + 1

        # 贴着目标墙边磨蹭：离最后一点不到 2 个单位就当作到了，别在墙角耗着
        last = path[-1]
        if math.hypot(last[0] - robot["x"], last[1] - robot["z"]) < 2.0:
            self._path[rid] = []
            robot["path"] = []
            robot["speed"] = 0.0
            return True

        if grid is not None and self._recover[rid] <= 2:
            # 先把自己挪到最近的可行点，再重算路径（相当于"蹭出墙角"）
            nx, nz = grid.free_spot(robot["x"], robot["z"])
            robot["x"], robot["z"] = round(nx, 3), round(nz, 3)
            self._path[rid] = []
            self._path_key[rid] = None
            robot["path"] = []
            return False

        # 两轮还出不来，就放弃这个点，让调用方推进到下一站
        self._path[rid] = []
        self._path_key[rid] = None
        robot["path"] = []
        robot["speed"] = 0.0
        _emit_event(robot, {"type": "路径受阻", "level": "warning",
                            "message": f"{robot.get('mission') or '巡检'} · 该点绕障失败，已转到下一站"})
        return True

    @staticmethod
    def _move_toward(robot: dict, target: dict) -> None:
        dx, dz = target["x"] - robot["x"], target["z"] - robot["z"]
        dist = math.hypot(dx, dz)
        if dist < 1e-6:
            robot["speed"] = 0.0
            return
        step = min(RobotSimulator.MOVE_SPEED, dist)
        grid = campus_grid()
        if grid is not None:
            # 撞楼就沿墙滑行（不是停住），保证"遇到楼改变方向"永远有解
            nx, nz = grid.step_free(robot["x"], robot["z"], target["x"], target["z"], step)
            robot["yielding_to"] = None
            for other in ROBOTS:
                if other['id'] == robot['id']:
                    continue
                if _seg_dist(other['x'], other['z'], robot['x'], robot['z'], nx, nz) < 0.7:
                    robot['yielding_to'] = other['id']
                    robot['speed'] = 0.0
                    return
            robot["x"], robot["z"] = nx, nz
        else:
            robot["speed"] = 0.0
            return
        robot["x"], robot["z"] = round(robot["x"], 3), round(robot["z"], 3)
        robot["speed"] = round(math.hypot(robot["x"] - (target["x"]-dx), robot["z"] - (target["z"]-dz)), 3)
        robot["heading"] = math.atan2(dx, dz)  # 绕 y 轴，北为 0

    @staticmethod
    def _arrived(robot: dict, target: dict) -> bool:
        return math.hypot(target["x"] - robot["x"], target["z"] - robot["z"]) < 0.3

    async def _broadcast(self) -> None:
        dead = []
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for client in list(self.clients):
            try:
                for robot in ROBOTS:
                    await client.send_json({
                        "type": "robot_state",
                        "timestamp": stamp,
                        **{k: (round(v, 3 if k in ("x", "z") else 2) if isinstance(v, float) else v) for k, v in robot.items()},
                    })
                if EVENTS:
                    await client.send_json({"type": "robot_event", **EVENTS[-1]})
            except Exception:
                dead.append(client)
        for client in dead:
            self.clients.discard(client)


# 全局单例：main.py 与 robots.py 共用，避免循环导入。
simulator = RobotSimulator()
