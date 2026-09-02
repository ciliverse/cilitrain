from datetime import datetime, timezone
from typing import Annotated, Optional

from pydantic import BaseModel, Field, PlainSerializer


def _dt_to_utc_z(dt: datetime) -> str:
    """Serialize as UTC ISO-8601 with Z so browsers parse as UTC, not local."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


# Stored as UTC (naive or aware); JSON always emits ...Z for local-timezone UI.
UtcDateTime = Annotated[
    datetime,
    PlainSerializer(_dt_to_utc_z, return_type=str, when_used="json"),
]


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
    # Path/content never exposed to non-admin (platform-held credentials)
    kubeconfig_path: Optional[str] = None
    has_kubeconfig_content: bool = False
    cilikube_base_url: Optional[str] = None
    created_at: UtcDateTime


class ClusterProbeOut(BaseModel):
    cluster_id: str
    name: str
    reachable: bool
    message: Optional[str] = None


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
    gpu_count: int = 0


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
    gpu_count: int = 0
    timeout_seconds: int = 7200
    pvc_name: Optional[str] = None
    pvc_mount_path: str = "/data"
    output_path: str = "/output"


class CiliKubeLinks(BaseModel):
    configured: bool = False
    console: Optional[str] = None
    job: Optional[str] = None
    pod: Optional[str] = None
    events: Optional[str] = None
    pvc: Optional[str] = None


class RunOut(BaseModel):
    id: str
    cluster_id: str
    owner_user_id: Optional[str] = None
    name: str
    namespace: str
    template: str
    image: str
    command: list[str]
    args: list[str]
    cpu: str
    memory: str
    gpu_count: int = 0
    timeout_seconds: int
    pvc_name: Optional[str] = None
    status: str
    job_name: Optional[str] = None
    pod_name: Optional[str] = None
    pod_phase: Optional[str] = None
    status_reason: Optional[str] = None
    status_message: Optional[str] = None
    duration_seconds: Optional[int] = None
    error_message: Optional[str] = None
    job_yaml: Optional[str] = None
    created_at: UtcDateTime
    updated_at: UtcDateTime
    finished_at: Optional[UtcDateTime] = None
    cilikube_url: Optional[str] = None
    cilikube_links: CiliKubeLinks = Field(default_factory=CiliKubeLinks)
    events: list[str] = Field(default_factory=list)


class SettingsOut(BaseModel):
    cilikube_base_url: Optional[str] = None
    cilikube_configured: bool = False
    max_gpu: int = 2


class SettingsUpdate(BaseModel):
    cilikube_base_url: Optional[str] = None


class LogsOut(BaseModel):
    pod_name: Optional[str] = None
    logs: str


class CleanupOut(BaseModel):
    status: str = "ok"
    cleaned: bool = False


class PipelineStepIn(BaseModel):
    name: str
    template: str = "custom"
    image: str
    command: list[str] = Field(default_factory=list)
    args: list[str] = Field(default_factory=list)
    cpu: str = "500m"
    memory: str = "512Mi"
    gpu_count: int = 0
    timeout_seconds: int = 1800


class PipelineCreate(BaseModel):
    name: str
    cluster_id: str
    namespace: str = "default"
    steps: list[PipelineStepIn] = Field(min_length=1, max_length=8)


class PipelineOut(BaseModel):
    id: str
    name: str
    cluster_id: str
    owner_user_id: Optional[str] = None
    namespace: str
    status: str
    current_step: int
    steps: list[dict] = Field(default_factory=list)
    run_ids: list[str] = Field(default_factory=list)
    pvc_name: Optional[str] = None
    error_message: Optional[str] = None
    created_at: UtcDateTime
    updated_at: UtcDateTime
    finished_at: Optional[UtcDateTime] = None
