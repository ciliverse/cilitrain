from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ClusterCreate(BaseModel):
    name: str
    kubeconfig_path: Optional[str] = None
    kubeconfig_content: Optional[str] = None
    context: Optional[str] = None
    cilikube_base_url: Optional[str] = None


class ClusterOut(BaseModel):
    id: str
    name: str
    context: Optional[str] = None
    kubeconfig_path: Optional[str] = None
    has_kubeconfig_content: bool = False
    cilikube_base_url: Optional[str] = None
    created_at: datetime


class TemplateOut(BaseModel):
    id: str
    name: str
    description: str
    image: str
    command: list[str]
    args: list[str]
    cpu: str
    memory: str
    timeout_seconds: int


class RunCreate(BaseModel):
    cluster_id: str
    name: str
    namespace: str = "default"
    template: str = "custom"
    image: str
    command: list[str] = Field(default_factory=list)
    args: list[str] = Field(default_factory=list)
    cpu: str = "500m"
    memory: str = "1Gi"
    timeout_seconds: int = 7200
    pvc_name: Optional[str] = None
    pvc_mount_path: str = "/data"
    output_path: str = "/output"


class RunOut(BaseModel):
    id: str
    cluster_id: str
    name: str
    namespace: str
    template: str
    image: str
    command: list[str]
    args: list[str]
    cpu: str
    memory: str
    timeout_seconds: int
    pvc_name: Optional[str] = None
    status: str
    job_name: Optional[str] = None
    error_message: Optional[str] = None
    job_yaml: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    finished_at: Optional[datetime] = None
    cilikube_url: Optional[str] = None
    events: list[str] = Field(default_factory=list)


class SettingsOut(BaseModel):
    cilikube_base_url: Optional[str] = None


class SettingsUpdate(BaseModel):
    cilikube_base_url: Optional[str] = None


class LogsOut(BaseModel):
    pod_name: Optional[str] = None
    logs: str
