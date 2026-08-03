from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.routes import router
from app.config import settings
from app.db import init_db

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
app.include_router(router)


@app.on_event("startup")
def on_startup() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    init_db()


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "cilitrain", "version": __version__, "docs": "/docs"}
