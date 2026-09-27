from dataclasses import dataclass, field
from datetime import datetime
from typing import Generic, TypeVar

from app.domain.enums import ConnectionStatus

T = TypeVar("T")


@dataclass(frozen=True)
class Page(Generic[T]):
    items: list[T]
    next_cursor: str | None = None
    total: int | None = None


@dataclass(frozen=True)
class AuthChallenge:
    public_id: str
    state: ConnectionStatus
    qr_content: str
    qr_image_data_url: str | None
    expires_at: datetime


@dataclass(frozen=True)
class AuthPollResult:
    state: ConnectionStatus
    provider_user_id: str | None = None
    profile: dict[str, object] = field(default_factory=dict)
    session_material: dict[str, str] | None = field(default=None, repr=False)


@dataclass(frozen=True)
class ProviderPlaylist:
    provider_id: str
    name: str
    artwork_url: str | None
    track_count: int | None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderTrack:
    provider_id: str
    title: str
    duration_ms: int | None
    album_provider_id: str | None
    artist_provider_ids: tuple[str, ...]
    artwork_url: str | None
    artists: tuple["ProviderArtist", ...] = field(default_factory=tuple)
    album: "ProviderAlbum | None" = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderArtist:
    provider_id: str
    name: str
    artwork_url: str | None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderAlbum:
    provider_id: str
    title: str
    artist_provider_ids: tuple[str, ...]
    artwork_url: str | None
    artists: tuple["ProviderArtist", ...] = field(default_factory=tuple)
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderPlaybackSource:
    provider: str
    url: str = field(repr=False)
    mime_type: str
    duration_ms: int | None
    expires_at: datetime | None
    quality: str | None
