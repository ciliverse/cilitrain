from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid4())


class Cluster(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    name: str
    kubeconfig_path: Optional[str] = None
    kubeconfig_content: Optional[str] = None
    context: Optional[str] = None
    cilikube_base_url: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)


class Run(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    cluster_id: str = Field(index=True)
    name: str
    namespace: str = "default"
    template: str
    image: str
    command: str  # JSON list
    args: str = "[]"  # JSON list
    cpu: str = "500m"
    memory: str = "1Gi"
    timeout_seconds: int = 7200
    pvc_name: Optional[str] = None
    pvc_mount_path: str = "/data"
    output_path: str = "/output"
    status: str = "pending"
    job_name: Optional[str] = None
    error_message: Optional[str] = None
    job_yaml: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    finished_at: Optional[datetime] = None


class AppSettings(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    cilikube_base_url: Optional[str] = None
