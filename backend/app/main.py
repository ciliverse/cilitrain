import logging
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session

from app import __version__
from app.api.auth_routes import router as auth_router
from app.api.model_routes import router as model_router
from app.api.routes import dispatch_queue, router
from app.api.service_routes import router as service_router
from app.api.service_routes import sync_active_services
from app.config import settings
from app.db import engine, init_db
from app.services.auth import backfill_owners, bootstrap_admin
from app.services.showcase import prepare_showcase

QUEUE_TICK_SECONDS = 15

app = FastAPI(title="CiliTrain", version=__version__)
origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
# Dev convenience: any host on 8890
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_origin_regex=r"https?://.*:8890",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(router)
app.include_router(model_router)
app.include_router(service_router)


@app.on_event("startup")
def on_startup() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    with Session(engine) as session:
        bootstrap_admin(session)
        backfill_owners(session)
        # Pytest imports the app and would otherwise rewrite a developer database.
        if not os.environ.get("PYTEST_CURRENT_TEST"):
            prepare_showcase(session)
    if not os.environ.get("PYTEST_CURRENT_TEST"):
        threading.Thread(target=_dispatch_loop, name="cilitrain-queue", daemon=True).start()


def _dispatch_loop() -> None:
    while True:
        time.sleep(QUEUE_TICK_SECONDS)
        try:
            with Session(engine) as session:
                dispatch_queue(session)
                sync_active_services(session)
        except Exception:  # noqa: BLE001
            logging.getLogger("cilitrain.queue").exception("queue dispatch failed")


def _static_root() -> Path | None:
    raw = (settings.static_dir or "").strip()
    if not raw:
        return None
    path = Path(raw)
    if path.is_dir() and (path / "index.html").is_file():
        return path
    return None


@app.get("/")
def root():
    static = _static_root()
    if static is not None:
        return FileResponse(static / "index.html")
    return {"service": "cilitrain", "version": __version__, "docs": "/docs"}


def _mount_static() -> None:
    static = _static_root()
    if static is None:
        return
    assets = static / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api") or full_path in {"docs", "redoc", "openapi.json"}:
            raise HTTPException(status_code=404, detail="not found")
        candidate = static / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(static / "index.html")


_mount_static()
