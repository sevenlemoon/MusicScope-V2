"""Materialize the R2 recommendation profile and feedback model."""

from alembic import op

revision = "0004_recommendation_intelligence"
down_revision = "0003_connection_challenges"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS recommendation_profile_artists (
            id UUID PRIMARY KEY,
            profile_id UUID NOT NULL REFERENCES recommendation_profiles(id) ON DELETE CASCADE,
            artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            affinity DOUBLE PRECISION NOT NULL,
            confidence DOUBLE PRECISION NOT NULL,
            distinct_tracks INTEGER NOT NULL,
            distinct_playlists INTEGER NOT NULL,
            weighted_memberships DOUBLE PRECISION NOT NULL,
            repeated_memberships INTEGER NOT NULL,
            represented_albums INTEGER NOT NULL,
            collaboration_tracks INTEGER NOT NULL,
            evidence JSON NOT NULL,
            CONSTRAINT uq_profile_artist UNIQUE (profile_id, artist_id)
        )
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_profile_artist_affinity "
        "ON recommendation_profile_artists (profile_id, affinity)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_profile_artists_artist_id "
        "ON recommendation_profile_artists (artist_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_profile_artists_profile_id "
        "ON recommendation_profile_artists (profile_id)"
    )
    op.execute("""
        CREATE TABLE IF NOT EXISTS recommendation_profile_albums (
            id UUID PRIMARY KEY,
            profile_id UUID NOT NULL REFERENCES recommendation_profiles(id) ON DELETE CASCADE,
            album_id UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
            affinity DOUBLE PRECISION NOT NULL,
            confidence DOUBLE PRECISION NOT NULL,
            distinct_tracks INTEGER NOT NULL,
            distinct_playlists INTEGER NOT NULL,
            weighted_memberships DOUBLE PRECISION NOT NULL,
            artist_affinity DOUBLE PRECISION NOT NULL,
            evidence JSON NOT NULL,
            CONSTRAINT uq_profile_album UNIQUE (profile_id, album_id)
        )
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_profile_album_affinity "
        "ON recommendation_profile_albums (profile_id, affinity)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_profile_albums_album_id "
        "ON recommendation_profile_albums (album_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_profile_albums_profile_id "
        "ON recommendation_profile_albums (profile_id)"
    )
    op.execute("""
        CREATE TABLE IF NOT EXISTS recommendation_relationships (
            id UUID PRIMARY KEY,
            profile_id UUID NOT NULL REFERENCES recommendation_profiles(id) ON DELETE CASCADE,
            source_artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            target_artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
            weight DOUBLE PRECISION NOT NULL,
            playlist_count INTEGER NOT NULL,
            collaboration_count INTEGER NOT NULL,
            evidence JSON NOT NULL,
            CONSTRAINT uq_profile_artist_edge UNIQUE (profile_id, source_artist_id, target_artist_id)
        )
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_relationship_weight "
        "ON recommendation_relationships (profile_id, weight)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_relationships_profile_id "
        "ON recommendation_relationships (profile_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_relationships_source_artist_id "
        "ON recommendation_relationships (source_artist_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_relationships_target_artist_id "
        "ON recommendation_relationships (target_artist_id)"
    )

    op.execute("ALTER TABLE recommendation_feedback ALTER COLUMN track_id DROP NOT NULL")
    op.execute("ALTER TABLE recommendation_feedback ADD COLUMN IF NOT EXISTS entity_type VARCHAR(32)")
    op.execute("ALTER TABLE recommendation_feedback ADD COLUMN IF NOT EXISTS entity_id UUID")
    op.execute("ALTER TABLE recommendation_feedback ADD COLUMN IF NOT EXISTS strategy VARCHAR(40)")
    op.execute(
        "UPDATE recommendation_feedback SET entity_type = 'track', entity_id = track_id, "
        "strategy = 'REDISCOVER' WHERE entity_type IS NULL"
    )
    op.execute("ALTER TABLE recommendation_feedback ALTER COLUMN entity_type SET NOT NULL")
    op.execute("ALTER TABLE recommendation_feedback ALTER COLUMN entity_id SET NOT NULL")
    op.execute("ALTER TABLE recommendation_feedback ALTER COLUMN strategy SET NOT NULL")
    op.execute(
        "ALTER TABLE recommendation_feedback DROP CONSTRAINT IF EXISTS uq_user_recommendation_feedback"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_recommendation_feedback_entity_id "
        "ON recommendation_feedback (entity_id)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_user_recommendation_feedback "
        "ON recommendation_feedback (user_id, entity_type, entity_id)"
    )
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'ck_recommendation_feedback_recommendation_feedback_entity_type'
            ) THEN
                ALTER TABLE recommendation_feedback
                ADD CONSTRAINT ck_recommendation_feedback_recommendation_feedback_entity_type
                CHECK (entity_type IN ('track', 'artist', 'album'));
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'ck_recommendation_feedback_recommendation_feedback_type'
            ) THEN
                ALTER TABLE recommendation_feedback
                ADD CONSTRAINT ck_recommendation_feedback_recommendation_feedback_type
                CHECK (feedback_type IN ('LIKE', 'DISLIKE', 'NOT_INTERESTED'));
            END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute(
        "ALTER TABLE recommendation_feedback DROP CONSTRAINT IF EXISTS "
        "ck_recommendation_feedback_recommendation_feedback_type"
    )
    op.execute(
        "ALTER TABLE recommendation_feedback DROP CONSTRAINT IF EXISTS "
        "ck_recommendation_feedback_recommendation_feedback_entity_type"
    )
    op.execute("DROP INDEX IF EXISTS uq_user_recommendation_feedback")
    op.execute("DROP INDEX IF EXISTS ix_recommendation_feedback_entity_id")
    op.execute("ALTER TABLE recommendation_feedback DROP COLUMN IF EXISTS strategy")
    op.execute("ALTER TABLE recommendation_feedback DROP COLUMN IF EXISTS entity_id")
    op.execute("ALTER TABLE recommendation_feedback DROP COLUMN IF EXISTS entity_type")
    op.execute("ALTER TABLE recommendation_feedback ALTER COLUMN track_id SET NOT NULL")
    op.execute("DROP TABLE IF EXISTS recommendation_relationships")
    op.execute("DROP TABLE IF EXISTS recommendation_profile_albums")
    op.execute("DROP TABLE IF EXISTS recommendation_profile_artists")
