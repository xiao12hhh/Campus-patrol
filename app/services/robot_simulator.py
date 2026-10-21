"""四足机器人巡检仿真服务。

坐标单位与 public/data/campus-local.json（v3）一致：1 单位 = 10 米，
**x 向东、z 向南**（原点 40.2159,116.2449）。

路点取自 v3 真实地标质心：主校区建筑来自学校官方 3D 源（map.cup.edu.cn），
东校区来自 OSM。旧版路点是 v2/OSM 时代的坐标，其中「第三教学楼」用的正是
后来被删除的那栋错位楼位置，所以在 v3 场景下会飘到错误的地方。

状态机：待命 -> 巡检中 -> (到点) 检测中 -> 巡检中 -> ... 电量低 -> 返航 -> 充电中 -> 巡检中
事件流：检测中按概率生成巡检告警，随 WebSocket 推送并保留最近 60 条历史。
"""
import asyncio
import math
import random
import uuid
from datetime import datetime, timezone

from .campus_grid import CampusGrid

# ------------------------------------------------------------------ 巡检路线
# 路点取自 v3 真实地标质心（主校区为官方 3D 源，东校区为 OSM）。
ROUTES: dict[str, list[dict]] = {
    "北校区教学区环线": [
        {"x": -46.75, "z": -11.44, "name": "中油大厦A座"},
        {"x": -44.46, "z": -7.23, "name": "第三教学楼"},
        {"x": -40.68, "z": -3.68, "name": "地质楼"},
        {"x": -36.83, "z": -3.17, "name": "第四教学楼"},
        {"x": -37.90, "z": -5.43, "name": "南校区北门"},
        {"x": -33.98, "z": -11.18, "name": "游泳馆"},
        {"x": -25.15, "z": -14.28, "name": "图书馆"},
        {"x": -31.45, "z": -15.62, "name": "国际交流中心"},
    ],
    "体育设施线": [
        {"x": -49.72, "z": -17.66, "name": "网球场"},
        {"x": -41.30, "z": -15.06, "name": "看台"},
        {"x": -39.20, "z": -13.28, "name": "红旗操场"},
        {"x": -35.50, "z": -10.54, "name": "健身房"},
        {"x": -33.45, "z": -13.65, "name": "体育馆"},
        {"x": -33.98, "z": -11.18, "name": "游泳馆"},
    ],
    "东校区生活区线": [
        {"x": 24.80, "z": 2.36, "name": "1号楼"},
        {"x": 24.33, "z": 7.35, "name": "3号楼"},
        {"x": 24.40, "z": 12.08, "name": "5号楼"},
        {"x": 34.15, "z": 11.80, "name": "6号楼"},
        {"x": 33.91, "z": 7.11, "name": "4号楼"},
        {"x": 33.21, "z": 1.54, "name": "2号楼"},
        {"x": 34.95, "z": 22.60, "name": "实验楼"},
        {"x": 18.41, "z": 24.77, "name": "主教"},
    ],
}

# 充电桩放在开阔场地上（南广场是 pedestrian 铺装面；东校区取生活区东侧空地）
DOCKS = [
    {"x": -29.50, "z": -1.42, "name": "南广场充电桩"},
    {"x": 28.00, "z": 6.00, "name": "东校区充电桩"},
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
        key = (round(target["x"], 2), round(target["z"], 2))
        if self._path_key.get(rid) != key:
            pts = grid.plan((robot["x"], robot["z"]), (target["x"], target["z"])) if grid else []
            self._path[rid] = [list(p) for p in pts]
            self._path_key[rid] = key
        path = self._path.get(rid) or []
        while path and math.hypot(path[0][0] - robot["x"], path[0][1] - robot["z"]) < 0.18:
            path.pop(0)
        robot["path"] = [[round(p[0], 2), round(p[1], 2)] for p in path]
        if not path:
            robot["speed"] = 0.0
            return True
        self._move_toward(robot, {"x": path[0][0], "z": path[0][1]})
        return False

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
            robot["x"], robot["z"] = grid.step_free(robot["x"], robot["z"], target["x"], target["z"], step)
        else:
            robot["x"] += dx / dist * step
            robot["z"] += dz / dist * step
        robot["x"], robot["z"] = round(robot["x"], 3), round(robot["z"], 3)
        robot["speed"] = round(step, 2)
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
                        **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in robot.items()},
                    })
                if EVENTS:
                    await client.send_json({"type": "robot_event", **EVENTS[-1]})
            except Exception:
                dead.append(client)
        for client in dead:
            self.clients.discard(client)


# 全局单例：main.py 与 robots.py 共用，避免循环导入。
simulator = RobotSimulator()
