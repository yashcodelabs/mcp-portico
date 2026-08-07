"""FastAPI application for the task service fixture."""

from fastapi import FastAPI

from app.routers import health, tasks

app = FastAPI(title="Tasks API", version="1.0.0")

app.include_router(health.router)
app.include_router(tasks.router)
