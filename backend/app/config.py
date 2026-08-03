from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CILITRAIN_", env_file=".env", extra="ignore")

    data_dir: Path = Path.home() / ".cilitrain"
    database_url: str = ""
    cors_origins: str = "http://localhost:8890,http://127.0.0.1:8890,http://0.0.0.0:8890"
    max_cpu: float = 2.0
    max_memory_gi: float = 4.0
    default_timeout_seconds: int = 7200
    default_concurrency: int = 3

    def resolved_db_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data_dir / 'cilitrain.db'}"


settings = Settings()
