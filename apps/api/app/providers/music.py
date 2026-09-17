from collections.abc import Sequence
from typing import Protocol

from app.providers.types import (
    AuthChallenge,
    AuthPollResult,
    Page,
    ProviderAlbum,
    ProviderArtist,
    ProviderPlaybackSource,
    ProviderPlaylist,
    ProviderTrack,
)


class MusicProvider(Protocol):
    provider_id: str

    async def create_auth_challenge(self) -> AuthChallenge: ...

    async def poll_auth_challenge(self, challenge_id: str) -> AuthPollResult: ...

    async def get_profile(self) -> dict[str, object]: ...

    async def list_playlists(self, cursor: str | None = None) -> Page[ProviderPlaylist]: ...

    async def list_playlist_track_ids(
        self, playlist_id: str, cursor: str | None = None
    ) -> Page[str]: ...

    async def get_tracks(self, provider_ids: Sequence[str]) -> list[ProviderTrack]: ...

    async def get_artists(self, provider_ids: Sequence[str]) -> list[ProviderArtist]: ...

    async def get_albums(self, provider_ids: Sequence[str]) -> list[ProviderAlbum]: ...

    async def search_tracks(self, query: str, *, limit: int = 20) -> list[ProviderTrack]: ...

    async def search_artists(self, query: str, *, limit: int = 20) -> list[ProviderArtist]: ...

    async def get_artist_tracks(
        self, provider_id: str, *, limit: int = 30
    ) -> list[ProviderTrack]: ...

    async def get_artist_albums(
        self, provider_id: str, *, limit: int = 20
    ) -> list[ProviderAlbum]: ...

    async def get_related_artists(
        self, provider_id: str, *, limit: int = 12
    ) -> list[ProviderArtist]: ...

    async def resolve_playback_source(self, provider_id: str) -> ProviderPlaybackSource: ...

    async def refresh_session(self) -> None: ...

    async def disconnect(self) -> None: ...
