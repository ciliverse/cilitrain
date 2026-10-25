from datetime import datetime, timezone
from typing import Annotated, Any, Optional

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
    simulated: bool = False
    created_at: UtcDateTime


class ClusterProbeOut(BaseModel):
    cluster_id: str
    name: str
    reachable: bool
    message: Optional[str] = None
    gpu_allocatable: Optional[int] = None


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
    kind: str = "custom"
    script: Optional[str] = None
    params: list[dict[str, Any]] = Field(default_factory=list)
    resumable: bool = False


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
    script: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    resume_from: Optional[str] = None
    priority: int = Field(default=0, ge=-1, le=1)
    start_at: Optional[datetime] = None


class SweepCreate(BaseModel):
    run: RunCreate
    grid: dict[str, list[Any]]


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
    script: Optional[str] = None
    simulated: bool = False
    showcase_seed: bool = False
    kind: str = "train"
    model_id: Optional[str] = None
    model_label: Optional[str] = None
    infer_input: Optional[dict[str, Any]] = None
    batch_rows: Optional[int] = None
    prediction: Optional[dict[str, Any]] = None
    registrable: bool = False
    registered_models: list[dict[str, str]] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    pvc_mount_path: str = "/data"
    resume_from: Optional[str] = None
    resume_from_name: Optional[str] = None
    resumable: bool = False
    sweep_id: Optional[str] = None
    queue_position: Optional[int] = None
    queue_reason: Optional[str] = None
    priority: int = 0
    not_before: Optional[UtcDateTime] = None
    started_at: Optional[UtcDateTime] = None
    created_at: UtcDateTime
    updated_at: UtcDateTime
    finished_at: Optional[UtcDateTime] = None
    cilikube_url: Optional[str] = None
    cilikube_links: CiliKubeLinks = Field(default_factory=CiliKubeLinks)
    events: list[str] = Field(default_factory=list)


class SweepOut(BaseModel):
    sweep_id: str
    runs: list[RunOut]


class SettingsOut(BaseModel):
    cilikube_base_url: Optional[str] = None
    cilikube_configured: bool = False
    max_gpu: int = 2
    max_cpu: float = 8.0
    max_memory_gi: float = 16.0
    default_concurrency: int = 3
    max_queued: int = 20
    user_max_active: int = 0
    user_max_cpu: float = 0
    user_max_memory_gi: float = 0
    user_max_gpu: int = 0
    queue_timeout_seconds: int = 86400
    prometheus_url: Optional[str] = None


class SchedulerNamespace(BaseModel):
    cluster_id: str
    cluster_name: str
    namespace: str
    active: int
    queued: int


class SchedulerItem(BaseModel):
    """One queued or active run (or running inference service) as the scheduler sees it."""

    id: str
    kind: str  # train | infer | service
    name: str
    owner: Optional[str] = None
    mine: bool = False
    cluster_name: str
    namespace: str
    status: str
    priority: int = 0
    queue_reason: Optional[str] = None
    queue_position: Optional[int] = None
    not_before: Optional[UtcDateTime] = None
    cpu: str
    memory: str
    gpu_count: int = 0
    created_at: UtcDateTime
    started_at: Optional[UtcDateTime] = None


class SchedulerOut(BaseModel):
    """Limits plus current load, for the scheduling page."""

    concurrency: int
    max_queued: int
    queue_timeout_seconds: int
    quota: dict[str, float]
    usage: dict[str, float]
    my_queued: int
    namespaces: list[SchedulerNamespace]
    queue: list[SchedulerItem] = Field(default_factory=list)
    active: list[SchedulerItem] = Field(default_factory=list)


class PriorityUpdate(BaseModel):
    priority: int = Field(ge=-1, le=1)


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


class ModelFile(BaseModel):
    path: str
    size: int


class ModelOut(BaseModel):
    id: str
    name: str
    version: int
    label: str
    template: str
    source_run_id: Optional[str] = None
    source_run_name: Optional[str] = None
    source_params: dict[str, Any] = Field(default_factory=dict)
    owner_user_id: Optional[str] = None
    files: list[ModelFile] = Field(default_factory=list)
    size_bytes: int = 0
    metrics: dict[str, Any] = Field(default_factory=dict)
    infer: Optional[dict[str, Any]] = None
    infer_count: int = 0
    showcase_seed: bool = False
    created_at: UtcDateTime


class ModelRegister(BaseModel):
    name: str


class InferCreate(BaseModel):
    input: dict[str, Any] = Field(default_factory=dict)


class InferBatchCreate(BaseModel):
    csv: str


class ServiceCreate(BaseModel):
    model_id: str
    name: Optional[str] = None
    replicas: int = Field(default=1, ge=1, le=3)
    cluster_id: Optional[str] = None
    namespace: Optional[str] = None


class ServiceScale(BaseModel):
    replicas: int = Field(ge=1, le=3)


class ServiceOut(BaseModel):
    id: str
    name: str
    model_id: str
    model_label: Optional[str] = None
    template: str
    cluster_id: str
    cluster_name: Optional[str] = None
    namespace: str
    owner_user_id: Optional[str] = None
    image: str
    cpu: str
    memory: str
    replicas: int
    ready_replicas: int = 0
    status: str
    status_message: Optional[str] = None
    simulated: bool = False
    error_message: Optional[str] = None
    api_key_prefix: Optional[str] = None
    endpoint_path: str
    requests: int = 0
    errors: int = 0
    avg_latency_ms: Optional[float] = None
    last_request_at: Optional[UtcDateTime] = None
    infer: Optional[dict[str, Any]] = None
    recent: list[dict[str, Any]] = Field(default_factory=list)
    created_at: UtcDateTime
    started_at: Optional[UtcDateTime] = None
    stopped_at: Optional[UtcDateTime] = None


class ServiceKeyOut(BaseModel):
    """Returned once, when a service is created or its key is rotated."""

    service: ServiceOut
    api_key: str


class ServicePredict(BaseModel):
    input: Optional[dict[str, Any]] = None
    inputs: Optional[list[dict[str, Any]]] = None


class ServicePredictOut(BaseModel):
    output: Optional[dict[str, Any]] = None
    outputs: Optional[list[dict[str, Any]]] = None
    latency_ms: float
