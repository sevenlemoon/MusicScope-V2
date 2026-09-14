from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.domain.enums import ConnectionStatus

CapabilityStage = Literal["implemented", "verification_pending", "designed"]
SortOrder = Literal["asc", "desc"]


class EntityReference(BaseModel):
    id: str
    name: str


class AlphabetGroup(BaseModel):
    key: str
    count: int


class ProductStatus(BaseModel):
    release: Literal["R0", "R1", "R2.1"]
    stage: Literal[
        "architecture_and_greenfield_bootstrap",
        "netease_integration_verification",
        "library_experience_and_playback",
    ]
    capabilities: dict[str, CapabilityStage]


class NeteaseCapabilities(BaseModel):
    provider: Literal["netease"]
    implementation_stage: Literal["implemented"]
    real_world_verified: bool = False
    current_state: ConnectionStatus
    auth_states: list[str]
    message: str


class ConnectionSummary(BaseModel):
    id: str
    provider: str
    status: str
    provider_user_id: str | None = None
    nickname: str | None = None
    avatar_url: str | None = None


class ConnectionList(BaseModel):
    items: list[ConnectionSummary] = Field(default_factory=list)
    next_cursor: str | None = None


class QrChallengeResponse(BaseModel):
    challenge_id: str
    status: str
    qr_url: str
    qr_image_data_url: str
    expires_at: datetime


class QrStatusResponse(BaseModel):
    challenge_id: str
    status: str
    connection: ConnectionSummary | None = None


class OperationResponse(BaseModel):
    status: str


class SyncResponse(BaseModel):
    status: str
    playlists: int
    track_memberships: int
    tracks: int
    artists: int
    albums: int
    artwork_count: int
    timings_ms: dict[str, int]
    partial_failures: int


class SyncStateResponse(BaseModel):
    status: str
    processed_items: int
    total_items: int | None = None
    checkpoint: dict[str, object] = Field(default_factory=dict)
    safe_error: str | None = None


class PlaylistItem(BaseModel):
    id: str
    name: str
    description: str | None = None
    artwork_url: str | None = None
    track_count: int | None = None
    sort_group: str = "#"


class AlbumItem(BaseModel):
    id: str
    title: str
    artwork_url: str | None = None
    artists: list[EntityReference] = Field(default_factory=list)
    sort_group: str = "#"


class ArtistItem(BaseModel):
    id: str
    name: str
    artwork_url: str | None = None
    sort_group: str = "#"


class TrackItem(BaseModel):
    id: str
    title: str
    artwork_url: str | None = None
    duration_ms: int | None = None
    album_id: str | None = None
    album: str | None = None
    artists: list[str] = Field(default_factory=list)
    artist_items: list[EntityReference] = Field(default_factory=list)
    sort_group: str = "#"
    playlist_position: int | None = None


class PlaylistPage(BaseModel):
    items: list[PlaylistItem]
    total: int
    next_cursor: str | None = None
    previous_cursor: str | None = None
    range_start: int = 0
    range_end: int = 0
    groups: list[AlphabetGroup] = Field(default_factory=list)
    sort: SortOrder = "asc"
    group: str | None = None


class AlbumPage(BaseModel):
    items: list[AlbumItem]
    total: int
    next_cursor: str | None = None
    previous_cursor: str | None = None
    range_start: int = 0
    range_end: int = 0
    groups: list[AlphabetGroup] = Field(default_factory=list)
    sort: SortOrder = "asc"
    group: str | None = None


class ArtistPage(BaseModel):
    items: list[ArtistItem]
    total: int
    next_cursor: str | None = None
    previous_cursor: str | None = None
    range_start: int = 0
    range_end: int = 0
    groups: list[AlphabetGroup] = Field(default_factory=list)
    sort: SortOrder = "asc"
    group: str | None = None


class TrackPage(BaseModel):
    items: list[TrackItem]
    total: int
    next_cursor: str | None = None
    previous_cursor: str | None = None
    range_start: int = 0
    range_end: int = 0
    groups: list[AlphabetGroup] = Field(default_factory=list)
    sort: Literal["asc", "desc", "original"] = "asc"
    group: str | None = None


SearchMatch = Literal["exact", "prefix", "substring"]


class SearchTrackResult(BaseModel):
    entity_type: Literal["track"] = "track"
    match: SearchMatch
    track: TrackItem


class SearchArtistResult(BaseModel):
    entity_type: Literal["artist"] = "artist"
    match: SearchMatch
    artist: ArtistItem
    library_track_count: int


class SearchAlbumResult(BaseModel):
    entity_type: Literal["album"] = "album"
    match: SearchMatch
    album: AlbumItem


class SearchPlaylistResult(BaseModel):
    entity_type: Literal["playlist"] = "playlist"
    match: SearchMatch
    playlist: PlaylistItem


class LibrarySearchResponse(BaseModel):
    query: str
    tracks: list[SearchTrackResult] = Field(default_factory=list)
    artists: list[SearchArtistResult] = Field(default_factory=list)
    albums: list[SearchAlbumResult] = Field(default_factory=list)
    playlists: list[SearchPlaylistResult] = Field(default_factory=list)
    total: int
    next_cursor: str | None = None
    previous_cursor: str | None = None
    range_start: int = 0
    range_end: int = 0


class ArtistDetail(BaseModel):
    id: str
    name: str
    artwork_url: str | None = None
    library_track_count: int
    represented_album_count: int


class AlbumDetail(BaseModel):
    id: str
    title: str
    artwork_url: str | None = None
    artists: list[EntityReference] = Field(default_factory=list)
    library_track_count: int


class PlaylistDetail(BaseModel):
    id: str
    name: str
    description: str | None = None
    artwork_url: str | None = None
    provider_track_count: int | None = None
    synchronized_track_count: int


class TrackDetail(BaseModel):
    id: str
    title: str
    artwork_url: str | None = None
    duration_ms: int | None = None
    artists: list[EntityReference] = Field(default_factory=list)
    album: EntityReference | None = None
    playlists: list[EntityReference] = Field(default_factory=list)


class PlaybackSourceResponse(BaseModel):
    track_id: str
    source_type: Literal["provider_stream"] = "provider_stream"
    url: str
    mime_type: str
    duration_ms: int | None = None
    expires_at: datetime | None = None
    quality: str | None = None
    provider: Literal["netease"] = "netease"
    resolution_ms: int


class StemEntryResponse(BaseModel):
    status: Literal["LOCAL_UPLOAD_REQUIRED"]
    message: str
    studio_url: str


class ArtistEnrichmentResponse(BaseModel):
    total_artists: int
    artists_with_artwork: int
    unavailable_artwork: int
    attempted: int
    enriched: int
    failures: int
    duration_ms: int


class LibraryCounts(BaseModel):
    playlists: int = 0
    albums: int = 0
    artists: int = 0
    tracks: int = 0


class LibrarySummary(BaseModel):
    connection_state: Literal["not_connected", "connected"]
    sync_state: str
    counts: LibraryCounts
    items: list[dict[str, object]] = Field(default_factory=list)
    next_cursor: str | None = None


class HealthResponse(BaseModel):
    status: str
    service: str
    release: str | None = None
    database: str | None = None
