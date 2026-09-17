"""Add user-scoped recommendation candidate materialization."""

from alembic import op

revision = "0005_external_candidates"
down_revision = "0004_recommendation_intelligence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE recommendation_feedback ALTER COLUMN entity_id DROP NOT NULL")
    op.execute("ALTER TABLE recommendation_feedback ADD COLUMN IF NOT EXISTS provider VARCHAR(32)")
    op.execute("ALTER TABLE recommendation_feedback ADD COLUMN IF NOT EXISTS provider_id VARCHAR(200)")
    op.execute(
        "ALTER TABLE recommendation_feedback ADD COLUMN IF NOT EXISTS identity_key VARCHAR(280)"
    )
    op.execute(
        "UPDATE recommendation_feedback SET identity_key = 'canonical:' || entity_id::text "
        "WHERE identity_key IS NULL"
    )
    op.execute("ALTER TABLE recommendation_feedback ALTER COLUMN identity_key SET NOT NULL")
    op.execute(
        "ALTER TABLE recommendation_feedback DROP CONSTRAINT IF EXISTS uq_user_recommendation_feedback"
    )
    op.execute("DROP INDEX IF EXISTS uq_user_recommendation_feedback")
    op.execute(
        "CREATE UNIQUE INDEX uq_user_recommendation_feedback "
        "ON recommendation_feedback (user_id, entity_type, identity_key)"
    )

    op.execute("""
        CREATE TABLE recommendation_candidates (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            profile_id UUID NOT NULL REFERENCES recommendation_profiles(id) ON DELETE CASCADE,
            category VARCHAR(40) NOT NULL,
            source VARCHAR(32) NOT NULL,
            entity_type VARCHAR(32) NOT NULL,
            canonical_entity_id UUID,
            provider VARCHAR(32),
            provider_id VARCHAR(200),
            identity_key VARCHAR(280) NOT NULL,
            score DOUBLE PRECISION NOT NULL,
            confidence DOUBLE PRECISION NOT NULL,
            strategy VARCHAR(48) NOT NULL,
            seed_key VARCHAR(280),
            distance INTEGER NOT NULL,
            payload JSON NOT NULL,
            generated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_user_candidate_category_identity
                UNIQUE (user_id, category, identity_key)
        )
    """)
    op.execute(
        "CREATE INDEX ix_recommendation_candidate_pool "
        "ON recommendation_candidates (user_id, category, score)"
    )
    op.execute(
        "CREATE INDEX ix_recommendation_candidates_user_id "
        "ON recommendation_candidates (user_id)"
    )
    op.execute(
        "CREATE INDEX ix_recommendation_candidates_profile_id "
        "ON recommendation_candidates (profile_id)"
    )
    op.execute(
        "CREATE INDEX ix_recommendation_candidates_canonical_entity_id "
        "ON recommendation_candidates (canonical_entity_id)"
    )

    op.execute("""
        CREATE TABLE recommendation_candidate_refreshes (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider VARCHAR(32) NOT NULL,
            status VARCHAR(32) NOT NULL,
            generated_at TIMESTAMP WITH TIME ZONE,
            expires_at TIMESTAMP WITH TIME ZONE,
            candidate_count INTEGER NOT NULL,
            request_count INTEGER NOT NULL,
            failure_count INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            safe_error_code VARCHAR(80),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT uq_user_candidate_refresh_provider UNIQUE (user_id, provider)
        )
    """)
    op.execute(
        "CREATE INDEX ix_recommendation_candidate_refreshes_user_id "
        "ON recommendation_candidate_refreshes (user_id)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS recommendation_candidate_refreshes")
    op.execute("DROP TABLE IF EXISTS recommendation_candidates")
    op.execute("DROP INDEX IF EXISTS uq_user_recommendation_feedback")
    op.execute(
        "CREATE UNIQUE INDEX uq_user_recommendation_feedback "
        "ON recommendation_feedback (user_id, entity_type, entity_id)"
    )
    op.execute("ALTER TABLE recommendation_feedback DROP COLUMN IF EXISTS identity_key")
    op.execute("ALTER TABLE recommendation_feedback DROP COLUMN IF EXISTS provider_id")
    op.execute("ALTER TABLE recommendation_feedback DROP COLUMN IF EXISTS provider")
    op.execute("ALTER TABLE recommendation_feedback ALTER COLUMN entity_id SET NOT NULL")
