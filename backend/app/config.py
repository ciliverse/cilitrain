from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CILITRAIN_", env_file=".env", extra="ignore")

    data_dir: Path = Path.home() / ".cilitrain"
    database_url: str = ""
    cors_origins: str = "http://localhost:8890,http://127.0.0.1:8890,http://0.0.0.0:8890"
    max_cpu: float = 8.0
    max_memory_gi: float = 16.0
    max_gpu: int = 2
    # Skip nvidia.com/gpu allocatable probe (debug only; risky on Kind).
    gpu_probe_skip: bool = False
    default_timeout_seconds: int = 7200
    default_concurrency: int = 3
    # Runs beyond the namespace limit wait as `queued`; this caps how many may wait.
    max_queued: int = 20
    queue_timeout_seconds: int = 86400
    # Per-user caps across all namespaces; 0 leaves only the namespace limit.
    # Active runs, and the summed CPU / memory / GPU requests of those runs.
    user_max_active: int = 0
    user_max_cpu: float = 0
    user_max_memory_gi: float = 0
    user_max_gpu: int = 0
    # Seconds to keep the training container Running after user command exits
    # so the API can exec-collect /output (see artifacts harvest design).
    hold_seconds: int = 45
    # Largest model a run may register; inference copies it into the pod.
    max_model_mb: int = 200
    # e.g. http://127.0.0.1:9090 after port-forward to kube-prometheus prometheus
    prometheus_url: str = "http://127.0.0.1:9090"
    # Auth (JWT + session). Set auth_disabled=true only for local/dev.
    auth_disabled: bool = False
    jwt_secret: str = ""
    jwt_expire_hours: int = 24
    bootstrap_admin_user: str = "admin"
    bootstrap_admin_password: str = "admin123"
    # Public exhibit. Off unless the demo host sets CILITRAIN_SHOWCASE=1.
    showcase: bool = False
    # Demo accounts shown on the showcase login page; set real values in the host's env file.
    showcase_admin_password: str = "showcase-admin"
    showcase_guest_password: str = "showcase-guest"
    # Optional CiliKube exhibit URL used only when showcase mode is on.
    showcase_cilikube_url: str = ""
    # Built web assets. When set, the API serves the UI on the same port.
    static_dir: str = ""

    def resolved_db_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data_dir / 'cilitrain.db'}"


settings = Settings()
