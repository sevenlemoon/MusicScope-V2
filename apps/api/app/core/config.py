from functools import lru_cache
from pathlib import Path

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict

V2_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    app_name: str = "MusicScope V2 API"
    environment: str = "development"
    database_url: str = "postgresql+psycopg://musicscope_v2:musicscope_v2_dev@localhost:55432/musicscope_v2"
    api_host: str = "0.0.0.0"
    api_port: int = 8100
    web_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    log_level: str = "INFO"
    secret_encryption_key: str | None = None
    secret_encryption_key_version: int = 1
    netease_api_base_url: str = "http://127.0.0.1:36531"
    netease_request_timeout_seconds: float = 10
    netease_playlist_page_size: int = 50
    netease_song_batch_size: int = 200
    netease_song_concurrency: int = 2
    netease_artist_concurrency: int = 6
    netease_playback_level: str = "standard"
    audio_storage_dir: str = "storage/audio"
    audio_upload_max_bytes: int = 200 * 1024 * 1024
    audio_duration_max_seconds: int = 15 * 60
    audio_storage_quota_bytes: int = 10 * 1024 * 1024 * 1024
    audio_worker_stale_seconds: int = 90
    audio_worker_poll_seconds: float = 1.0
    separator_executable: str | None = None
    separator_model: str = "htdemucs"
    concert_provider: str = "none"
    ticketmaster_api_key: str | None = None
    ticketmaster_timeout_seconds: float = 6
    ticketmaster_search_page_budget: int = 2
    live_cache_ttl_hours: int = 6
    live_search_cache_minutes: int = 30
    live_seed_budget: int = 12
    live_search_max_concurrency: int = 3
    live_provider_timeout_seconds: float = 8
    live_search_deadline_seconds: float = 10
    showstart_timeout_seconds: float = 5
    verified_official_timeout_seconds: float = 6
    enable_maoyan_concerts: bool = False
    enable_kktix_concerts: bool = False
    enable_showstart_concerts: bool = False
    enable_verified_official_concerts: bool = True

    model_config = SettingsConfigDict(env_file=V2_ROOT / ".env", extra="ignore")

    @computed_field
    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.web_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
