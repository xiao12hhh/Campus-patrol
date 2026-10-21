import asyncio
from pathlib import Path
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.api import campus, robots, vrptw
from app.services.robot_simulator import simulator

app = FastAPI(title='石大·智巡 API', version='0.2.0')
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_credentials=True, allow_methods=['*'], allow_headers=['*'])
app.include_router(campus.router)
app.include_router(robots.router)
app.include_router(vrptw.router)


@app.on_event('startup')
async def startup():
    asyncio.create_task(simulator.loop())


@app.get('/health')
def health():
    return {'status': 'ok', 'service': 'cup-campus-twin'}


@app.get('/')
def root():
    # 已构建前端时由下方 StaticFiles 接管 '/'；此处仅作为纯 API 模式的入口说明。
    return {'service': 'cup-campus-twin', 'docs': '/docs', 'frontend': 'build frontend and serve it through the same reverse proxy'}


@app.websocket('/ws/robots')
async def websocket_endpoint(ws: WebSocket):
    await robots.websocket_routes(simulator)(ws)


# Docker/生产环境中由 FastAPI 同源托管构建后的前端；开发环境没有 dist 时不挂载。
# 注意：挂载必须在 root() 注册之后再判断——如果 dist 存在，移除 root 路由，
# 否则显式路由会优先于挂载，把首页变成 JSON。
dist_dir = Path(__file__).resolve().parent.parent / 'dist'
if dist_dir.exists():
    app.router.routes = [
        r for r in app.router.routes
        if not (getattr(r, 'path', None) == '/' and getattr(r, 'methods', None) == {'GET'})
    ]
    app.mount('/', StaticFiles(directory=dist_dir, html=True), name='frontend')
