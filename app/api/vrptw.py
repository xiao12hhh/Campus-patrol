from fastapi import APIRouter,HTTPException
from app.models.schemas import VRPTWRequest
from app.services.vrptw_solver import solve
router=APIRouter(prefix='/api/vrptw',tags=['vrptw'])
@router.post('/solve')
def solve_route(request:VRPTWRequest):
    try:return solve(request)
    except ValueError as exc: raise HTTPException(422,str(exc))
@router.get('/examples')
def examples(): return {"name":"campus-demo","vehicles":2,"jobs":3}
