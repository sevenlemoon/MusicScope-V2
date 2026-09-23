"""Create the MusicScope V2 R0 domain foundation."""

from alembic import op
from app.core.database import Base
from app.domain import models  # noqa: F401

revision = "0001_r0_foundation"
down_revision = None
branch_labels = None
depends_on = None

R0_TABLES = (
    "users",
    "music_connections",
    "music_connection_secrets",
    "music_connection_challenges",
    "artists",
    "albums",
    "tracks",
    "track_artists",
    "album_artists",
    "playlists",
    "playlist_tracks",
    "external_identities",
    "library_items",
    "sync_states",
    "recommendation_profiles",
    "recommendation_feedback",
    "audio_assets",
    "stem_jobs",
    "stem_artifacts",
    "music_memories",
)


def _r0_tables():  # type: ignore[no-untyped-def]
    return [Base.metadata.tables[name] for name in R0_TABLES]


def upgrade() -> None:
    # This frozen greenfield baseline is generated from the R0 metadata. Future
    # revisions must use explicit Alembic operations rather than create_all.
    Base.metadata.create_all(bind=op.get_bind(), tables=_r0_tables(), checkfirst=False)
    op.execute("""
        CREATE TABLE concert_events (
            id UUID PRIMARY KEY,
            artist_id UUID REFERENCES artists(id) ON DELETE SET NULL,
            provider VARCHAR(64) NOT NULL,
            provider_event_id VARCHAR(200) NOT NULL,
            artist_name VARCHAR(300) NOT NULL,
            title VARCHAR(300) NOT NULL,
            starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
            venue_name VARCHAR(300),
            city VARCHAR(160),
            country VARCHAR(120),
            source_url VARCHAR(1000) NOT NULL,
            ticket_url VARCHAR(1000),
            confidence DOUBLE PRECISION,
            source_metadata JSON NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_concert_provider_event UNIQUE (provider, provider_event_id)
        )
    """)
    op.execute("CREATE INDEX ix_concert_events_artist_date ON concert_events (artist_id, starts_at)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS concert_events")
    Base.metadata.drop_all(bind=op.get_bind(), tables=_r0_tables(), checkfirst=False)
