"""Add capability-based live concert materialization."""

from alembic import op

revision = "0006_live_concerts"
down_revision = "0005_external_candidates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE concert_events DROP CONSTRAINT IF EXISTS uq_concert_provider_event")
    op.execute("DROP INDEX IF EXISTS ix_concert_events_artist_date")
    op.execute("ALTER TABLE concert_events RENAME COLUMN source_url TO event_url")
    op.execute("ALTER TABLE concert_events ADD COLUMN primary_artist_name VARCHAR(300)")
    op.execute("UPDATE concert_events SET primary_artist_name = artist_name")
    op.execute("ALTER TABLE concert_events ADD COLUMN start_date DATE")
    op.execute("UPDATE concert_events SET start_date = starts_at::date")
    op.execute("ALTER TABLE concert_events ALTER COLUMN start_date SET NOT NULL")
    op.execute("ALTER TABLE concert_events ADD COLUMN start_time TIME")
    op.execute("UPDATE concert_events SET start_time = starts_at::time")
    op.execute("ALTER TABLE concert_events ADD COLUMN timezone VARCHAR(100)")
    op.execute("ALTER TABLE concert_events ADD COLUMN venue_address VARCHAR(500)")
    op.execute("ALTER TABLE concert_events ADD COLUMN region VARCHAR(160)")
    op.execute("ALTER TABLE concert_events ADD COLUMN latitude DOUBLE PRECISION")
    op.execute("ALTER TABLE concert_events ADD COLUMN longitude DOUBLE PRECISION")
    op.execute("ALTER TABLE concert_events ADD COLUMN artwork_url VARCHAR(1000)")
    op.execute("ALTER TABLE concert_events ADD COLUMN status VARCHAR(40)")
    op.execute("ALTER TABLE concert_events ADD COLUMN observed_at TIMESTAMP WITH TIME ZONE")
    op.execute("UPDATE concert_events SET observed_at = updated_at")
    op.execute("ALTER TABLE concert_events ALTER COLUMN observed_at SET NOT NULL")
    op.execute("ALTER TABLE concert_events ADD COLUMN last_refreshed_at TIMESTAMP WITH TIME ZONE")
    op.execute("UPDATE concert_events SET last_refreshed_at = updated_at")
    op.execute("ALTER TABLE concert_events ALTER COLUMN last_refreshed_at SET NOT NULL")

    op.execute("""
        CREATE TABLE concert_event_sources (
            id UUID PRIMARY KEY,
            event_id UUID NOT NULL REFERENCES concert_events(id) ON DELETE CASCADE,
            provider VARCHAR(64) NOT NULL,
            provider_event_id VARCHAR(200) NOT NULL,
            event_url VARCHAR(1000) NOT NULL,
            ticket_url VARCHAR(1000),
            status VARCHAR(40),
            observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
            last_refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL,
            source_payload JSON NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_concert_source_provider_event UNIQUE (provider, provider_event_id)
        )
    """)
    op.execute("""
        INSERT INTO concert_event_sources (
            id, event_id, provider, provider_event_id, event_url, ticket_url, status,
            observed_at, last_refreshed_at, source_payload, created_at, updated_at
        )
        SELECT id, id, provider, provider_event_id, event_url, ticket_url, NULL,
               updated_at, updated_at, source_metadata, created_at, updated_at
        FROM concert_events
    """)
    op.execute("CREATE INDEX ix_concert_event_sources_event ON concert_event_sources (event_id)")
    op.execute("CREATE INDEX ix_concert_event_sources_event_id ON concert_event_sources (event_id)")

    op.execute("ALTER TABLE concert_events DROP COLUMN provider")
    op.execute("ALTER TABLE concert_events DROP COLUMN provider_event_id")
    op.execute("ALTER TABLE concert_events DROP COLUMN artist_name")
    op.execute("ALTER TABLE concert_events DROP COLUMN starts_at")
    op.execute("ALTER TABLE concert_events DROP COLUMN confidence")
    op.execute("CREATE INDEX ix_concert_events_artist_date ON concert_events (artist_id, start_date)")
    op.execute(
        "CREATE INDEX ix_concert_events_location_date ON concert_events (country, city, start_date)"
    )

    op.execute("""
        CREATE TABLE concert_performers (
            id UUID PRIMARY KEY,
            event_id UUID NOT NULL REFERENCES concert_events(id) ON DELETE CASCADE,
            artist_id UUID REFERENCES artists(id) ON DELETE SET NULL,
            name VARCHAR(300) NOT NULL,
            position INTEGER NOT NULL,
            provider_identities JSON NOT NULL,
            CONSTRAINT uq_concert_performer_position UNIQUE (event_id, position)
        )
    """)
    op.execute("CREATE INDEX ix_concert_performers_event_id ON concert_performers (event_id)")

    op.execute("""
        CREATE TABLE live_recommendations (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            event_id UUID NOT NULL REFERENCES concert_events(id) ON DELETE CASCADE,
            artist_id UUID REFERENCES artists(id) ON DELETE SET NULL,
            rank INTEGER NOT NULL,
            score DOUBLE PRECISION NOT NULL,
            evidence JSON NOT NULL,
            generated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_user_live_event UNIQUE (user_id, event_id)
        )
    """)
    op.execute("CREATE INDEX ix_live_recommendations_user_id ON live_recommendations (user_id)")
    op.execute("CREATE INDEX ix_live_recommendations_event_id ON live_recommendations (event_id)")
    op.execute("CREATE INDEX ix_live_recommendation_rank ON live_recommendations (user_id, rank)")

    op.execute("""
        CREATE TABLE user_live_preferences (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            country VARCHAR(2),
            city VARCHAR(160),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        )
    """)
    op.execute("CREATE INDEX ix_user_live_preferences_user_id ON user_live_preferences (user_id)")

    op.execute("""
        CREATE TABLE live_search_cache (
            id UUID PRIMARY KEY,
            cache_key VARCHAR(64) NOT NULL UNIQUE,
            query VARCHAR(300) NOT NULL,
            status VARCHAR(40) NOT NULL,
            match_payload JSON NOT NULL,
            provider_states JSON NOT NULL,
            event_ids JSON NOT NULL,
            generated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        )
    """)
    op.execute("CREATE INDEX ix_live_search_cache_cache_key ON live_search_cache (cache_key)")
    op.execute("""
        CREATE TABLE artist_search_aliases (
            id UUID PRIMARY KEY,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
            alias VARCHAR(300) NOT NULL,
            normalized_alias VARCHAR(300) NOT NULL,
            canonical_name VARCHAR(300) NOT NULL,
            source VARCHAR(40) NOT NULL,
            verified BOOLEAN NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_artist_search_alias UNIQUE (user_id, normalized_alias, canonical_name)
        )
    """)
    op.execute("CREATE INDEX ix_artist_search_aliases_user_id ON artist_search_aliases (user_id)")
    op.execute("CREATE INDEX ix_artist_search_aliases_artist_id ON artist_search_aliases (artist_id)")
    op.execute(
        "CREATE INDEX ix_artist_search_aliases_normalized_alias "
        "ON artist_search_aliases (normalized_alias)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS artist_search_aliases")
    op.execute("DROP TABLE IF EXISTS live_search_cache")
    op.execute("DROP TABLE IF EXISTS user_live_preferences")
    op.execute("DROP TABLE IF EXISTS live_recommendations")
    op.execute("DROP TABLE IF EXISTS concert_performers")
    op.execute("DROP INDEX IF EXISTS ix_concert_events_location_date")
    op.execute("DROP INDEX IF EXISTS ix_concert_events_artist_date")
    op.execute("ALTER TABLE concert_events ADD COLUMN provider VARCHAR(64)")
    op.execute("ALTER TABLE concert_events ADD COLUMN provider_event_id VARCHAR(200)")
    op.execute("ALTER TABLE concert_events ADD COLUMN artist_name VARCHAR(300)")
    op.execute("ALTER TABLE concert_events ADD COLUMN starts_at TIMESTAMP WITH TIME ZONE")
    op.execute("ALTER TABLE concert_events ADD COLUMN confidence DOUBLE PRECISION")
    op.execute("""
        UPDATE concert_events event
        SET provider = source.provider,
            provider_event_id = source.provider_event_id,
            artist_name = event.primary_artist_name,
            starts_at = event.start_date + COALESCE(event.start_time, TIME '00:00')
        FROM concert_event_sources source
        WHERE source.event_id = event.id
    """)
    op.execute("ALTER TABLE concert_events ALTER COLUMN provider SET NOT NULL")
    op.execute("ALTER TABLE concert_events ALTER COLUMN provider_event_id SET NOT NULL")
    op.execute("ALTER TABLE concert_events ALTER COLUMN artist_name SET NOT NULL")
    op.execute("ALTER TABLE concert_events ALTER COLUMN starts_at SET NOT NULL")
    op.execute("DROP TABLE IF EXISTS concert_event_sources")
    op.execute("ALTER TABLE concert_events RENAME COLUMN event_url TO source_url")
    for column in (
        "primary_artist_name",
        "start_date",
        "start_time",
        "timezone",
        "venue_address",
        "region",
        "latitude",
        "longitude",
        "artwork_url",
        "status",
        "observed_at",
        "last_refreshed_at",
    ):
        op.execute(f"ALTER TABLE concert_events DROP COLUMN {column}")
    op.execute(
        "ALTER TABLE concert_events ADD CONSTRAINT uq_concert_provider_event "
        "UNIQUE (provider, provider_event_id)"
    )
    op.execute("CREATE INDEX ix_concert_events_artist_date ON concert_events (artist_id, starts_at)")
