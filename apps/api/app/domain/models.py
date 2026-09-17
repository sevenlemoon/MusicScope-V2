from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
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
    __table_args__ = (
        UniqueConstraint("track_id", "artist_id", "role", name="uq_track_artist_role"),
        UniqueConstraint("track_id", "position", name="uq_track_artist_position"),
    )

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
    __table_args__ = (
        UniqueConstraint("playlist_id", "track_id", name="uq_playlist_track"),
        UniqueConstraint("playlist_id", "position", name="uq_playlist_position"),
    )

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
        UniqueConstraint(
            "user_id", "entity_type", "identity_key", name="uq_user_recommendation_feedback"
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
        UniqueConstraint("provider", "provider_event_id", name="uq_concert_provider_event"),
        Index("ix_concert_events_artist_date", "artist_id", "starts_at"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    artist_id: Mapped[UUID | None] = mapped_column(ForeignKey("artists.id", ondelete="SET NULL"))
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    provider_event_id: Mapped[str] = mapped_column(String(200), nullable=False)
    artist_name: Mapped[str] = mapped_column(String(300), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    venue_name: Mapped[str | None] = mapped_column(String(300))
    city: Mapped[str | None] = mapped_column(String(160))
    country: Mapped[str | None] = mapped_column(String(120))
    source_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    ticket_url: Mapped[str | None] = mapped_column(String(1000))
    confidence: Mapped[float | None] = mapped_column(Float)
    source_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class AudioAsset(TimestampMixin, Base):
    __tablename__ = "audio_assets"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict, nullable=False)


class StemJob(TimestampMixin, Base):
    __tablename__ = "stem_jobs"
    __table_args__ = (UniqueConstraint("user_id", "fingerprint", name="uq_stem_job_fingerprint"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    audio_asset_id: Mapped[UUID] = mapped_column(
        ForeignKey("audio_assets.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(32), default=StemJobStatus.PENDING.value, index=True)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    model_name: Mapped[str] = mapped_column(String(120), nullable=False)
    model_version: Mapped[str | None] = mapped_column(String(80))
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    progress: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    safe_error_message: Mapped[str | None] = mapped_column(String(300))
    diagnostic_error: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StemArtifact(TimestampMixin, Base):
    __tablename__ = "stem_artifacts"
    __table_args__ = (UniqueConstraint("stem_job_id", "stem_type", name="uq_stem_job_type"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    stem_job_id: Mapped[UUID] = mapped_column(ForeignKey("stem_jobs.id", ondelete="CASCADE"), index=True)
    stem_type: Mapped[str] = mapped_column(String(32), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    waveform_storage_key: Mapped[str | None] = mapped_column(String(500))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)


class MusicMemory(TimestampMixin, Base):
    __tablename__ = "music_memories"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_id: Mapped[UUID] = mapped_column(nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
