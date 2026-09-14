"""Constrain polymorphic external identity types.

The R0 baseline imports live metadata, so a new database may already have this
constraint. The conditional keeps both fresh and previously migrated V2 databases valid.
"""

from alembic import op

revision = "0002_identity_type_check"
down_revision = "0001_r0_foundation"
branch_labels = None
depends_on = None

CONSTRAINT_NAME = "ck_external_identities_external_identity_entity_type"


def upgrade() -> None:
    op.execute(f"""
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '{CONSTRAINT_NAME}'
        ) THEN
            ALTER TABLE external_identities
            ADD CONSTRAINT {CONSTRAINT_NAME}
            CHECK (entity_type IN ('track', 'artist', 'album', 'playlist'));
        END IF;
    END $$;
    """)


def downgrade() -> None:
    op.execute(
        f"ALTER TABLE external_identities DROP CONSTRAINT IF EXISTS {CONSTRAINT_NAME};"
    )
