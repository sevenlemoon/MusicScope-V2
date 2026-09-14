"""Add durable QR challenge generation state."""

from alembic import op

revision = "0003_connection_challenges"
down_revision = "0002_identity_type_check"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The greenfield R0 baseline creates current metadata. IF NOT EXISTS keeps
    # fresh databases and databases already at 0002 on the same upgrade path.
    op.execute("""
        CREATE TABLE IF NOT EXISTS music_connection_challenges (
            id UUID NOT NULL,
            user_id UUID NOT NULL,
            provider VARCHAR(32) NOT NULL,
            generation INTEGER NOT NULL,
            status VARCHAR(32) NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            failure_code VARCHAR(80),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            CONSTRAINT pk_music_connection_challenges PRIMARY KEY (id),
            CONSTRAINT fk_music_connection_challenges_user_id_users
                FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE,
            CONSTRAINT uq_connection_challenge_generation
                UNIQUE (user_id, provider, generation)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_connection_challenge_latest
        ON music_connection_challenges (user_id, provider, generation)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_music_connection_challenges_status
        ON music_connection_challenges (status)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_music_connection_challenges_user_id
        ON music_connection_challenges (user_id)
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS music_connection_challenges")
