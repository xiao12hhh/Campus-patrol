from typing import Optional
from pydantic import BaseModel, Field

class Point(BaseModel):
    id: str
    lat: float
    lng: float

class Vehicle(BaseModel):
    id: str
    capacity: int = Field(gt=0)
    start_time: str = "08:00"
    end_time: str = "18:00"

class Job(Point):
    name: str = "任务点"
    demand: int = Field(ge=0)
    service_minutes: int = Field(default=10, ge=0)
    time_window: tuple[str, str]

class VRPTWRequest(BaseModel):
    depot: Point
    vehicles: list[Vehicle]
    jobs: list[Job]

