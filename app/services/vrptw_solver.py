from math import hypot, cos, radians
from datetime import datetime
try:
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
except ImportError:
    pywrapcp = None

# ------------------------------------------------------------------ 距离口径
# 请求里的坐标是 WGS-84 经纬度（前端由 campus-local 的米制平面坐标反算而来）。
# 求距离时有两个必须处理的点：
#   1) 经度方向要按纬度做 cos 收缩。直接 dlng*111000 会让东西向距离虚高
#      1/cos(40°) ≈ 1.31 倍（三教→图书馆 193 m 会被算成 253 m）。
#   2) VRPTW 量的是**沿路行程距离**，不是两点直线。校园数据里只有主干道
#      （OSM 缺楼间步道，直接跑路网最短路反而偏到 900 m+），
#      所以统一用「直线距离 × 步行绕路系数」近似。
#   标定点：第三教学楼(-44.46,-7.23) ↔ 图书馆(-25.15,-14.28)，
#   实测步行 380 m ÷ 直线 205.6 m = 1.85。
LAT_M = 111320.0
DETOUR_FACTOR = 1.85


def planar_m(a, b) -> float:
    """两点经纬度的米制平面直线距离（经度按两点平均纬度收缩）。"""
    dy = (a[0] - b[0]) * LAT_M
    dx = (a[1] - b[1]) * LAT_M * cos(radians((a[0] + b[0]) / 2))
    return hypot(dx, dy)


def travel_m(a, b) -> float:
    """业务口径的行程距离（米）= 直线距离 × 步行绕路系数。"""
    return planar_m(a, b) * DETOUR_FACTOR

def minutes(value: str) -> int:
    h, m = value.split(":"); return int(h) * 60 + int(m)
def clock(value: int) -> str: return f"{value//60:02d}:{value%60:02d}"
def solve(request):
    if pywrapcp:
        return solve_with_ortools(request)
    jobs=request.jobs; vehicles=request.vehicles
    # 经纬度按米制平面处理（口径见文件头 travel_m），校园尺度下足够精确。
    coords=[(request.depot.lat,request.depot.lng)]+[(j.lat,j.lng) for j in jobs]
    # 行程距离（km），与 OR-Tools 分支同口径：米制直线 × 步行绕路系数
    distance=lambda a,b: travel_m(a,b)/1000
    routes=[]; remaining=list(jobs)
    for vehicle in vehicles:
        if not remaining: break
        now=minutes(vehicle.start_time); load=0; prev=coords[0]; stops=[]; total=0
        for job in list(remaining):
            if load+job.demand>vehicle.capacity: continue
            travel=distance(prev,(job.lat,job.lng))*2
            arrival=max(now+int(travel),minutes(job.time_window[0]))
            if arrival>minutes(job.time_window[1]) or arrival+job.service_minutes>minutes(vehicle.end_time): continue
            total+=travel/2; stops.append({"job_id":job.id,"name":job.name,"x":(job.lng-request.depot.lng)*111000/10,"z":(request.depot.lat-job.lat)*111000/10,"arrival":clock(arrival),"service_end":clock(arrival+job.service_minutes),"time_window":list(job.time_window)})
            now=arrival+job.service_minutes; load+=job.demand; prev=(job.lat,job.lng); remaining.remove(job)
        if stops: routes.append({"vehicle_id":vehicle.id,"distance_km":round(total,2),"stops":stops})
    if remaining: raise ValueError(f"无可行解：{len(remaining)} 个任务点无法满足容量或时间窗")
    total=sum(r["distance_km"] for r in routes)
    return {"routes":routes,"total_distance_km":round(total,2),"on_time_rate":100 if jobs else 0,"vehicle_count":len(routes),"solver":"ortools" if pywrapcp else "greedy-fallback"}

def solve_with_ortools(request):
    jobs, vehicles = request.jobs, request.vehicles
    coords=[(request.depot.lat,request.depot.lng)]+[(j.lat,j.lng) for j in jobs]
    def dist(a,b): return int(travel_m(a,b))
    matrix=[[dist(a,b) for b in coords] for a in coords]
    manager=pywrapcp.RoutingIndexManager(len(coords),len(vehicles),0)
    routing=pywrapcp.RoutingModel(manager)
    transit=routing.RegisterTransitCallback(lambda f,t: matrix[manager.IndexToNode(f)][manager.IndexToNode(t)])
    routing.SetArcCostEvaluatorOfAllVehicles(transit)
    routing.AddDimension(transit, 3600, max(minutes(v.end_time) for v in vehicles)*60, False, 'Distance')
    distance_dim=routing.GetDimensionOrDie('Distance'); distance_dim.SetGlobalSpanCostCoefficient(100)
    demand=routing.RegisterUnaryTransitCallback(lambda i: 0 if manager.IndexToNode(i)==0 else jobs[manager.IndexToNode(i)-1].demand)
    routing.AddDimensionWithVehicleCapacity(demand,0,[v.capacity for v in vehicles],True,'Capacity')
    time_cb=routing.RegisterTransitCallback(lambda f,t: max(1, matrix[manager.IndexToNode(f)][manager.IndexToNode(t)]//1200))
    routing.AddDimension(time_cb, 24*60, 24*60, False, 'Time')
    time_dim=routing.GetDimensionOrDie('Time')
    for n,job in enumerate(jobs,1):
        idx=manager.NodeToIndex(n); time_dim.CumulVar(idx).SetRange(minutes(job.time_window[0]),minutes(job.time_window[1]))
    for vi,v in enumerate(vehicles):
        start=time_dim.CumulVar(routing.Start(vi)); end=time_dim.CumulVar(routing.End(vi)); start.SetRange(minutes(v.start_time),minutes(v.start_time)); end.SetRange(minutes(v.start_time),minutes(v.end_time))
    params=pywrapcp.DefaultRoutingSearchParameters(); params.first_solution_strategy=routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC; params.local_search_metaheuristic=routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH; params.time_limit.FromSeconds(3)
    solution=routing.SolveWithParameters(params)
    if not solution: raise ValueError('无可行解：OR-Tools 无法满足容量或时间窗约束')
    routes=[]
    for vi,v in enumerate(vehicles):
        idx=routing.Start(vi); stops=[]; used=not routing.IsEnd(solution.Value(routing.NextVar(idx))); total=0
        while not routing.IsEnd(idx):
            nxt=solution.Value(routing.NextVar(idx)); node=manager.IndexToNode(nxt)
            if node:
                job=jobs[node-1]; arrival=solution.Min(time_dim.CumulVar(nxt)); stops.append({'job_id':job.id,'name':job.name,'x':(job.lng-request.depot.lng)*111000/10,'z':(request.depot.lat-job.lat)*111000/10,'arrival':clock(arrival),'service_end':clock(arrival+job.service_minutes),'time_window':list(job.time_window)})
            total+=routing.GetArcCostForVehicle(idx,nxt,vi); idx=nxt
        if used: routes.append({'vehicle_id':v.id,'distance_km':round(total/1000,2),'stops':stops})
    return {'routes':routes,'total_distance_km':round(sum(r['distance_km'] for r in routes),2),'on_time_rate':100 if jobs else 0,'vehicle_count':len(routes),'solver':'ortools'}
