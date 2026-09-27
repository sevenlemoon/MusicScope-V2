from datetime import UTC, date, datetime, time
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.core.database import Base
from app.core.redaction import contains_sensitive_fields
from app.domain.enums import ConnectionStatus, ProviderName, StemJobStatus, SyncStatus


def utc_now() -> datetime:
    return datetime.now(UTC)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    display_name: Mapped[str | None] = mapped_column(String(120))
    exploration_level: Mapped[int] = mapped_column(Integer, default=50, nullable=False)
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class MusicConnection(TimestampMixin, Base):
    __tablename__ = "music_connections"
    __table_args__ = (
        UniqueConstraint("user_id", "provider", "provider_user_id", name="uq_connection_provider_user"),
        Index("ix_music_connections_user_provider", "user_id", "provider"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(32), default=ProviderName.NETEASE.value, nullable=False)
    provider_user_id: Mapped[str | None] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(32), default=ConnectionStatus.IDLE.value, index=True)
    connected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)

    @validates("metadata_json")
    def validate_public_metadata(self, _key: str, value: dict[str, Any]) -> dict[str, Any]:
        if contains_sensitive_fields(value):
            raise ValueError("Provider secrets must be stored only in MusicConnectionSecret.")
        return value


class MusicConnectionSecret(TimestampMixin, Base):
    __tablename__ = "music_connection_secrets"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    connection_id: Mapped[UUID] = mapped_column(
        ForeignKey("music_connections.id", ondelete="CASCADE"), unique=True, index=True
    )
    encrypted_session: Mapped[str] = mapped_column(Text, nullable=False)
    key_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @validates("encrypted_session")
    def validate_encrypted_session(self, _key: str, value: str) -> str:
        import json

        try:
            envelope = json.loads(value)
            required = {"algorithm", "ciphertext", "key_version", "nonce", "version"}
            if not isinstance(envelope, dict) or not required <= envelope.keys():
                raise ValueError
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ValueError("Provider session storage requires an encrypted envelope.") from exc
        return value

    def __repr__(self) -> str:
        return f"MusicConnectionSecret(id={self.id!r}, encrypted_session='[REDACTED]')"


class MusicConnectionChallenge(TimestampMixin, Base):
    __tablename__ = "music_connection_challenges"
    __table_args__ = (
        UniqueConstraint("user_id", "provider", "generation", name="uq_connection_challenge_generation"),
        Index("ix_connection_challenge_latest", "user_id", "provider", "generation"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default=ConnectionStatus.CREATING_QR.value, nullable=False, index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    failure_code: Mapped[str | None] = mapped_column(String(80))


class Artist(TimestampMixin, Base):
    __tablename__ = "artists"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    sort_name: Mapped[str | None] = mapped_column(String(300), index=True)
    artwork_url: Mapped[str | None] = mapped_column(String(1000))
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)


class Album(TimestampMixin, Base):
    __tablename__ = "albums"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    release_date: Mapped[date | None] = mapped_column(Date)
    artwork_url: Mapped[str | None] = mapped_column(String(1000))
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)


class Track(TimestampMixin, Base):
    __tablename__ = "tracks"
    __table_args__ = (Index("ix_tracks_title", "title"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    album_id: Mapped[UUID | None] = mapped_column(ForeignKey("albums.id", ondelete="SET NULL"), index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    disc_number: Mapped[int | None] = mapped_column(Integer)
    track_number: Mapped[int | None] = mapped_column(Integer)
    artwork_url: Mapped[str | None] = mapped_column(String(1000))
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)


class TrackArtist(Base):
    __tablename__ = "track_artists"
    __table_args__ = (UniqueConstraint("track_id", "position", name="uq_track_artist_position"),)

    track_id: Mapped[UUID] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    artist_id: Mapped[UUID] = mapped_column(ForeignKey("artists.id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(String(32), primary_key=True, default="primary")
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class AlbumArtist(Base):
    __tablename__ = "album_artists"

    album_id: Mapped[UUID] = mapped_column(ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True)
    artist_id: Mapped[UUID] = mapped_column(ForeignKey("artists.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Playlist(TimestampMixin, Base):
    __tablename__ = "playlists"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    owner_connection_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("music_connections.id", ondelete="SET NULL"), index=True
    )
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    artwork_url: Mapped[str | None] = mapped_column(String(1000))
    track_count: Mapped[int | None] = mapped_column(Integer)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)


class PlaylistTrack(Base):
    __tablename__ = "playlist_tracks"
    __table_args__ = (UniqueConstraint("playlist_id", "position", name="uq_playlist_position"),)

    playlist_id: Mapped[UUID] = mapped_column(
        ForeignKey("playlists.id", ondelete="CASCADE"), primary_key=True
    )
    track_id: Mapped[UUID] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    added_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class ExternalIdentity(TimestampMixin, Base):
    __tablename__ = "external_identities"
    __table_args__ = (
        UniqueConstraint(
            "provider", "entity_type", "provider_id", name="uq_external_identity_provider_entity"
        ),
        UniqueConstraint(
            "entity_type", "entity_id", "provider", name="uq_external_identity_canonical_provider"
        ),
        CheckConstraint(
            "entity_type IN ('track', 'artist', 'album', 'playlist')",
            name="external_identity_entity_type",
        ),
        Index("ix_external_identity_canonical", "entity_type", "entity_id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[UUID] = mapped_column(nullable=False)
    provider_id: Mapped[str] = mapped_column(String(200), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(1000))
    source_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class LibraryItem(TimestampMixin, Base):
    __tablename__ = "library_items"
    __table_args__ = (
        UniqueConstraint("user_id", "track_id", "connection_id", name="uq_library_item_source"),
        Index("ix_library_items_user_active", "user_id", "active"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    track_id: Mapped[UUID] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), index=True)
    connection_id: Mapped[UUID] = mapped_column(
        ForeignKey("music_connections.id", ondelete="CASCADE"), index=True
    )
    saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class SyncState(TimestampMixin, Base):
    __tablename__ = "sync_states"
    __table_args__ = (UniqueConstraint("connection_id", "scope", name="uq_sync_connection_scope"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    connection_id: Mapped[UUID] = mapped_column(
        ForeignKey("music_connections.id", ondelete="CASCADE"), index=True
    )
    scope: Mapped[str] = mapped_column(String(64), default="library", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default=SyncStatus.PENDING.value, index=True)
    cursor: Mapped[str | None] = mapped_column(String(500))
    checkpoint: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    processed_items: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_items: Mapped[int | None] = mapped_column(Integer)
    last_error_code: Mapped[str | None] = mapped_column(String(80))
    last_error_message: Mapped[str | None] = mapped_column(String(300))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RecommendationProfile(TimestampMixin, Base):
    __tablename__ = "recommendation_profiles"
    __table_args__ = (UniqueConstraint("user_id", "profile_type", name="uq_user_profile_type"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    profile_type: Mapped[str] = mapped_column(String(32), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    signals: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    window_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    window_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RecommendationProfileArtist(Base):
    __tablename__ = "recommendation_profile_artists"
    __table_args__ = (
        UniqueConstraint("profile_id", "artist_id", name="uq_profile_artist"),
        Index("ix_profile_artist_affinity", "profile_id", "affinity"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    profile_id: Mapped[UUID] = mapped_column(
        ForeignKey("recommendation_profiles.id", ondelete="CASCADE"), index=True
    )
    artist_id: Mapped[UUID] = mapped_column(ForeignKey("artists.id", ondelete="CASCADE"), index=True)
    affinity: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    distinct_tracks: Mapped[int] = mapped_column(Integer, nullable=False)
    distinct_playlists: Mapped[int] = mapped_column(Integer, nullable=False)
    weighted_memberships: Mapped[float] = mapped_column(Float, nullable=False)
    repeated_memberships: Mapped[int] = mapped_column(Integer, nullable=False)
    represented_albums: Mapped[int] = mapped_column(Integer, nullable=False)
    collaboration_tracks: Mapped[int] = mapped_column(Integer, nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class RecommendationProfileAlbum(Base):
    __tablename__ = "recommendation_profile_albums"
    __table_args__ = (
        UniqueConstraint("profile_id", "album_id", name="uq_profile_album"),
        Index("ix_profile_album_affinity", "profile_id", "affinity"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    profile_id: Mapped[UUID] = mapped_column(
        ForeignKey("recommendation_profiles.id", ondelete="CASCADE"), index=True
    )
    album_id: Mapped[UUID] = mapped_column(ForeignKey("albums.id", ondelete="CASCADE"), index=True)
    affinity: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    distinct_tracks: Mapped[int] = mapped_column(Integer, nullable=False)
    distinct_playlists: Mapped[int] = mapped_column(Integer, nullable=False)
    weighted_memberships: Mapped[float] = mapped_column(Float, nullable=False)
    artist_affinity: Mapped[float] = mapped_column(Float, nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class RecommendationRelationship(Base):
    __tablename__ = "recommendation_relationships"
    __table_args__ = (
        UniqueConstraint("profile_id", "source_artist_id", "target_artist_id", name="uq_profile_artist_edge"),
        Index("ix_recommendation_relationship_weight", "profile_id", "weight"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    profile_id: Mapped[UUID] = mapped_column(
        ForeignKey("recommendation_profiles.id", ondelete="CASCADE"), index=True
    )
    source_artist_id: Mapped[UUID] = mapped_column(ForeignKey("artists.id", ondelete="CASCADE"), index=True)
    target_artist_id: Mapped[UUID] = mapped_column(ForeignKey("artists.id", ondelete="CASCADE"), index=True)
    weight: Mapped[float] = mapped_column(Float, nullable=False)
    playlist_count: Mapped[int] = mapped_column(Integer, nullable=False)
    collaboration_count: Mapped[int] = mapped_column(Integer, nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class RecommendationFeedback(TimestampMixin, Base):
    __tablename__ = "recommendation_feedback"
    __table_args__ = (
        Index(
            "uq_user_recommendation_feedback",
            "user_id",
            "entity_type",
            "identity_key",
            unique=True,
        ),
        CheckConstraint(
            "entity_type IN ('track', 'artist', 'album')",
            name="recommendation_feedback_entity_type",
        ),
        CheckConstraint(
            "feedback_type IN ('LIKE', 'DISLIKE', 'NOT_INTERESTED')",
            name="recommendation_feedback_type",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    track_id: Mapped[UUID | None] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), index=True)
    entity_type: Mapped[str] = mapped_column(String(32), default="track", nullable=False)
    entity_id: Mapped[UUID | None] = mapped_column(index=True)
    provider: Mapped[str | None] = mapped_column(String(32))
    provider_id: Mapped[str | None] = mapped_column(String(200))
    identity_key: Mapped[str] = mapped_column(String(280), nullable=False)
    strategy: Mapped[str] = mapped_column(String(40), nullable=False)
    feedback_type: Mapped[str] = mapped_column(String(32), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(80))
    context: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class RecommendationCandidate(TimestampMixin, Base):
    __tablename__ = "recommendation_candidates"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "category", "identity_key", name="uq_user_candidate_category_identity"
        ),
        Index("ix_recommendation_candidate_pool", "user_id", "category", "score"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    profile_id: Mapped[UUID] = mapped_column(
        ForeignKey("recommendation_profiles.id", ondelete="CASCADE"), index=True
    )
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    canonical_entity_id: Mapped[UUID | None] = mapped_column(index=True)
    provider: Mapped[str | None] = mapped_column(String(32))
    provider_id: Mapped[str | None] = mapped_column(String(200))
    identity_key: Mapped[str] = mapped_column(String(280), nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    strategy: Mapped[str] = mapped_column(String(48), nullable=False)
    seed_key: Mapped[str | None] = mapped_column(String(280))
    distance: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @validates("payload")
    def validate_candidate_payload(self, _key: str, value: dict[str, Any]) -> dict[str, Any]:
        if contains_sensitive_fields(value):
            raise ValueError("Recommendation candidates cannot contain provider secrets.")
        return value


class RecommendationCandidateRefresh(TimestampMixin, Base):
    __tablename__ = "recommendation_candidate_refreshes"
    __table_args__ = (
        UniqueConstraint("user_id", "provider", name="uq_user_candidate_refresh_provider"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    candidate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    request_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failure_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    safe_error_code: Mapped[str | None] = mapped_column(String(80))


class ConcertEvent(TimestampMixin, Base):
    __tablename__ = "concert_events"
    __table_args__ = (
        Index("ix_concert_events_artist_date", "artist_id", "start_date"),
        Index("ix_concert_events_location_date", "country", "city", "start_date"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    artist_id: Mapped[UUID | None] = mapped_column(ForeignKey("artists.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    primary_artist_name: Mapped[str | None] = mapped_column(String(300))
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time)
    timezone: Mapped[str | None] = mapped_column(String(100))
    venue_name: Mapped[str | None] = mapped_column(String(300))
    venue_address: Mapped[str | None] = mapped_column(String(500))
    city: Mapped[str | None] = mapped_column(String(160))
    region: Mapped[str | None] = mapped_column(String(160))
    country: Mapped[str | None] = mapped_column(String(120))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    artwork_url: Mapped[str | None] = mapped_column(String(1000))
    event_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    ticket_url: Mapped[str | None] = mapped_column(String(1000))
    status: Mapped[str | None] = mapped_column(String(40))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_refreshed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class ConcertEventSource(TimestampMixin, Base):
    __tablename__ = "concert_event_sources"
    __table_args__ = (
        UniqueConstraint("provider", "provider_event_id", name="uq_concert_source_provider_event"),
        Index("ix_concert_event_sources_event", "event_id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    event_id: Mapped[UUID] = mapped_column(
        ForeignKey("concert_events.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    provider_event_id: Mapped[str] = mapped_column(String(200), nullable=False)
    event_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    ticket_url: Mapped[str | None] = mapped_column(String(1000))
    status: Mapped[str | None] = mapped_column(String(40))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_refreshed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class ConcertPerformer(Base):
    __tablename__ = "concert_performers"
    __table_args__ = (
        UniqueConstraint("event_id", "position", name="uq_concert_performer_position"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    event_id: Mapped[UUID] = mapped_column(
        ForeignKey("concert_events.id", ondelete="CASCADE"), index=True
    )
    artist_id: Mapped[UUID | None] = mapped_column(ForeignKey("artists.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    provider_identities: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class LiveRecommendation(TimestampMixin, Base):
    __tablename__ = "live_recommendations"
    __table_args__ = (
        UniqueConstraint("user_id", "event_id", name="uq_user_live_event"),
        Index("ix_live_recommendation_rank", "user_id", "rank"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    event_id: Mapped[UUID] = mapped_column(
        ForeignKey("concert_events.id", ondelete="CASCADE"), index=True
    )
    artist_id: Mapped[UUID | None] = mapped_column(ForeignKey("artists.id", ondelete="SET NULL"))
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class UserLivePreference(TimestampMixin, Base):
    __tablename__ = "user_live_preferences"
    __table_args__ = (
        UniqueConstraint("user_id", name="user_live_preferences_user_id_key"),
        Index("ix_user_live_preferences_user_id", "user_id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    country: Mapped[str | None] = mapped_column(String(2))
    city: Mapped[str | None] = mapped_column(String(160))


class LiveSearchCache(TimestampMixin, Base):
    __tablename__ = "live_search_cache"
    __table_args__ = (
        UniqueConstraint("cache_key", name="live_search_cache_cache_key_key"),
        Index("ix_live_search_cache_cache_key", "cache_key"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False)
    query: Mapped[str] = mapped_column(String(300), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False)
    match_payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    provider_states: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    event_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ArtistSearchAlias(TimestampMixin, Base):
    __tablename__ = "artist_search_aliases"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "normalized_alias", "canonical_name", name="uq_artist_search_alias"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    artist_id: Mapped[UUID | None] = mapped_column(ForeignKey("artists.id", ondelete="CASCADE"), index=True)
    alias: Mapped[str] = mapped_column(String(300), nullable=False)
    normalized_alias: Mapped[str] = mapped_column(String(300), nullable=False, index=True)
    canonical_name: Mapped[str] = mapped_column(String(300), nullable=False)
    source: Mapped[str] = mapped_column(String(40), nullable=False)
    verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class AudioAsset(TimestampMixin, Base):
    __tablename__ = "audio_assets"
    __table_args__ = (
        UniqueConstraint("user_id", "sha256", name="uq_audio_asset_user_sha256"),
        Index("ix_audio_assets_user_sha256", "user_id", "sha256"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    media_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sample_rate: Mapped[int] = mapped_column(Integer, nullable=False)
    channels: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)


class StemJob(TimestampMixin, Base):
    __tablename__ = "stem_jobs"
    __table_args__ = (
        UniqueConstraint("user_id", "fingerprint", name="uq_stem_job_fingerprint"),
        CheckConstraint(
            "status IN ('QUEUED','PREPARING','RUNNING','SUCCEEDED','FAILED','CANCELLED')",
            name="stem_job_status",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    audio_asset_id: Mapped[UUID] = mapped_column(
        ForeignKey("audio_assets.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(32), default=StemJobStatus.QUEUED.value, index=True)
    stage: Mapped[str] = mapped_column(String(40), default="QUEUED", nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    model_name: Mapped[str] = mapped_column(String(120), nullable=False)
    model_version: Mapped[str | None] = mapped_column(String(80))
    demucs_version: Mapped[str | None] = mapped_column(String(80))
    device: Mapped[str | None] = mapped_column(String(16))
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    progress: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    safe_error_code: Mapped[str | None] = mapped_column(String(80))
    safe_error_message: Mapped[str | None] = mapped_column(String(300))
    diagnostic_error: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    worker_run_id: Mapped[UUID | None] = mapped_column(index=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    cancellation_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StudioTrackJob(Base):
    """User-scoped association; one audio job may represent multiple library tracks."""

    __tablename__ = "studio_track_jobs"

    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    track_id: Mapped[UUID] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    stem_job_id: Mapped[UUID] = mapped_column(
        ForeignKey("stem_jobs.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class StemArtifact(TimestampMixin, Base):
    __tablename__ = "stem_artifacts"
    __table_args__ = (
        UniqueConstraint("stem_job_id", "stem_type", name="uq_stem_job_type"),
        CheckConstraint(
            "stem_type IN ('VOCALS','DRUMS','BASS','GUITAR','PIANO','OTHER')",
            name="stem_artifact_type",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    stem_job_id: Mapped[UUID] = mapped_column(ForeignKey("stem_jobs.id", ondelete="CASCADE"), index=True)
    stem_type: Mapped[str] = mapped_column(String(32), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    waveform_storage_key: Mapped[str | None] = mapped_column(String(500))
    media_type: Mapped[str] = mapped_column(String(100), default="audio/flac", nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    sample_rate: Mapped[int] = mapped_column(Integer, nullable=False)
    channels: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    artifact_version: Mapped[str] = mapped_column(String(40), default="flac-v1", nullable=False)


class MusicMemory(TimestampMixin, Base):
    __tablename__ = "music_memories"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_id: Mapped[UUID] = mapped_column(nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
