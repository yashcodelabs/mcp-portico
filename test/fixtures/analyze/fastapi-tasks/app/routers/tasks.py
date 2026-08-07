"""Task routes. Every task route requires a bearer token."""

from fastapi import APIRouter, Depends, HTTPException, status

from app.models import Task, TaskCreate
from app.security import require_bearer

router = APIRouter(tags=["tasks"], dependencies=[Depends(require_bearer)])

TASKS: dict[int, Task] = {}


@router.get("/tasks", response_model=list[Task])
def list_tasks() -> list[Task]:
    return list(TASKS.values())


@router.post("/tasks", response_model=Task, status_code=status.HTTP_201_CREATED)
def create_task(payload: TaskCreate) -> Task:
    task = Task(id=len(TASKS) + 1, **payload.model_dump())
    TASKS[task.id] = task
    return task


@router.get("/tasks/{task_id}", response_model=Task)
def get_task(task_id: int) -> Task:
    task = TASKS.get(task_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="task not found"
        )
    return task


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: int) -> None:
    task = TASKS.pop(task_id, None)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="task not found"
        )
