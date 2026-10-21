from app.models.schemas import VRPTWRequest
from app.services.vrptw_solver import solve
def test_vrptw_solves_example():
    request=VRPTWRequest.model_validate({"depot":{"id":"d","lat":39.98,"lng":116.35},"vehicles":[{"id":"V-1","capacity":100}],"jobs":[{"id":"J-1","name":"A","lat":39.981,"lng":116.351,"demand":10,"service_minutes":5,"time_window":["08:00","10:00"]}]})
    result=solve(request)
    assert result['vehicle_count']==1
    assert result['routes'][0]['stops'][0]['job_id']=='J-1'
