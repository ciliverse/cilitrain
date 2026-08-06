from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CILITRAIN_", env_file=".env", extra="ignore")

    data_dir: Path = Path.home() / ".cilitrain"
    database_url: str = ""
    cors_origins: str = "http://localhost:8890,http://127.0.0.1:8890,http://0.0.0.0:8890"
    max_cpu: float = 2.0
    max_memory_gi: float = 4.0
    max_gpu: int = 2
    # Skip nvidia.com/gpu allocatable probe (debug only; risky on Kind).
    gpu_probe_skip: bool = False
    default_timeout_seconds: int = 7200
    default_concurrency: int = 3
    # Seconds to keep the training container Running after user command exits
    # so the API can exec-collect /output (see artifacts harvest design).
    hold_seconds: int = 45
    # e.g. http://127.0.0.1:9090 after port-forward to kube-prometheus prometheus
    prometheus_url: str = "http://127.0.0.1:9090"
    # Auth (JWT + session). Set auth_disabled=true only for local/dev.
    auth_disabled: bool = False
    jwt_secret: str = ""
    jwt_expire_hours: int = 24
    bootstrap_admin_user: str = "admin"
    bootstrap_admin_password: str = "admin123"

    def resolved_db_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data_dir / 'cilitrain.db'}"


settings = Settings()
