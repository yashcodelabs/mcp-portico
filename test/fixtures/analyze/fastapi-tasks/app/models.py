"""Pydantic schemas for the task service."""

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    completed: bool = False
    priority: int = Field(default=1, ge=1, le=5)


class Task(TaskCreate):
    id: int
