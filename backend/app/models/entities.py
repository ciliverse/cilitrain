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
    owner_user_id: Optional[str] = Field(default=None, index=True)  # null = platform cluster
    simulated: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class Run(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    cluster_id: str = Field(index=True)
    owner_user_id: Optional[str] = Field(default=None, index=True)
    name: str
    namespace: str = "default"
    template: str
    image: str
    command: str  # JSON list
    args: str = "[]"  # JSON list
    cpu: str = "500m"
    memory: str = "1Gi"
    gpu_count: int = 0
    timeout_seconds: int = 7200
    pvc_name: Optional[str] = None
    pvc_mount_path: str = "/data"
    output_path: str = "/output"
    status: str = "pending"
    job_name: Optional[str] = None
    error_message: Optional[str] = None
    job_yaml: Optional[str] = None
    script: Optional[str] = None
    simulated: bool = False
    showcase_seed: bool = False
    kind: str = "train"  # train | infer
    model_id: Optional[str] = Field(default=None, index=True)
    infer_input: Optional[str] = None  # JSON object
    batch_rows: Optional[int] = None  # CSV batch inference; rows live in the inference store
    queue_reason: Optional[str] = None  # why a queued run is waiting: namespace / user_active / user_quota / scheduled
    priority: int = 0  # -1 low, 0 normal, 1 high; higher leaves the queue first
    not_before: Optional[datetime] = None  # scheduled start; the run stays queued until then
    params: Optional[str] = None  # JSON object, template hyperparameters
    env_json: Optional[str] = None  # JSON object, user env vars
    resume_from: Optional[str] = Field(default=None, index=True)
    sweep_id: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    started_at: Optional[datetime] = None  # left the queue / Job submitted
    finished_at: Optional[datetime] = None


class ModelVersion(SQLModel, table=True):
    """A trained model registered from a succeeded run's artifacts."""

    id: str = Field(default_factory=new_id, primary_key=True)
    name: str = Field(index=True)
    version: int = 1
    source_run_id: Optional[str] = Field(default=None, index=True)
    template: str
    owner_user_id: Optional[str] = Field(default=None, index=True)
    files_json: str = "[]"  # [{"path", "size"}]
    size_bytes: int = 0
    metrics_json: str = "{}"
    showcase_seed: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class InferenceService(SQLModel, table=True):
    """A long-running model server (Deployment + Service) behind an HTTP endpoint."""

    id: str = Field(default_factory=new_id, primary_key=True)
    name: str
    model_id: str = Field(index=True)
    cluster_id: str = Field(index=True)
    owner_user_id: Optional[str] = Field(default=None, index=True)
    namespace: str = "default"
    template: str
    image: str
    cpu: str = "500m"
    memory: str = "512Mi"
    replicas: int = 1
    status: str = "starting"  # starting | running | stopped | failed
    simulated: bool = False
    showcase_seed: bool = False
    error_message: Optional[str] = None
    api_key_hash: Optional[str] = None
    api_key_prefix: Optional[str] = None
    requests: int = 0
    errors: int = 0
    total_ms: int = 0
    last_request_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    started_at: Optional[datetime] = None
    stopped_at: Optional[datetime] = None


class AppSettings(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    cilikube_base_url: Optional[str] = None


class Pipeline(SQLModel, table=True):
    """Simple multi-step training pipeline (preprocess → train)."""

    id: str = Field(default_factory=new_id, primary_key=True)
    name: str
    cluster_id: str = Field(index=True)
    owner_user_id: Optional[str] = Field(default=None, index=True)
    namespace: str = "default"
    status: str = "pending"  # pending|running|succeeded|failed|cancelled
    current_step: int = 0
    steps_json: str = "[]"  # list of step specs
    run_ids_json: str = "[]"  # created run ids in order
    pvc_name: Optional[str] = None  # shared PVC for all steps (B1)
    error_message: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    finished_at: Optional[datetime] = None


class User(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    role: str = "operator"  # admin | operator | viewer
    is_active: bool = True
    must_change_password: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class AuthSession(SQLModel, table=True):
    """Server-side session; JWT carries session_id for revocation."""

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(index=True)
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime
    revoked_at: Optional[datetime] = None


class ClusterGrant(SQLModel, table=True):
    """Which (cluster, namespace) a non-admin user may use."""

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(index=True)
    cluster_id: str = Field(index=True)
    namespace: str = "default"
    created_at: datetime = Field(default_factory=utcnow)
