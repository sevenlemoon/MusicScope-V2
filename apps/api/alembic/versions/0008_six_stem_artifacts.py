"""Allow guitar and piano artifacts from the optional six-stem model."""

from alembic import op

revision = "0008_six_stem_artifacts"
down_revision = "0007_audio_studio"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE stem_artifacts DROP CONSTRAINT ck_stem_artifacts_stem_artifact_type")
    op.execute("""
        ALTER TABLE stem_artifacts ADD CONSTRAINT ck_stem_artifacts_stem_artifact_type
        CHECK (stem_type IN ('VOCALS','DRUMS','BASS','GUITAR','PIANO','OTHER'))
    """)


def downgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM stem_artifacts WHERE stem_type IN ('GUITAR','PIANO')) THEN
                RAISE EXCEPTION 'Cannot downgrade while six-stem artifacts exist';
            END IF;
        END $$
    """)
    op.execute("ALTER TABLE stem_artifacts DROP CONSTRAINT ck_stem_artifacts_stem_artifact_type")
    op.execute("""
        ALTER TABLE stem_artifacts ADD CONSTRAINT ck_stem_artifacts_stem_artifact_type
        CHECK (stem_type IN ('VOCALS','DRUMS','BASS','OTHER'))
    """)
