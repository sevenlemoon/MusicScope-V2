"""Add the production local audio Studio lifecycle."""

from alembic import op

revision = "0007_audio_studio"
down_revision = "0006_live_concerts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS media_type VARCHAR(100)")
    op.execute("ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS size_bytes BIGINT")
    op.execute("ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS sample_rate INTEGER")
    op.execute("ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS channels INTEGER")
    op.execute("UPDATE audio_assets SET media_type = 'application/octet-stream' WHERE media_type IS NULL")
    op.execute("UPDATE audio_assets SET size_bytes = 0 WHERE size_bytes IS NULL")
    op.execute("UPDATE audio_assets SET sample_rate = 44100 WHERE sample_rate IS NULL")
    op.execute("UPDATE audio_assets SET channels = 2 WHERE channels IS NULL")
    op.execute("ALTER TABLE audio_assets ALTER COLUMN media_type SET NOT NULL")
    op.execute("ALTER TABLE audio_assets ALTER COLUMN size_bytes SET NOT NULL")
    op.execute("ALTER TABLE audio_assets ALTER COLUMN sample_rate SET NOT NULL")
    op.execute("ALTER TABLE audio_assets ALTER COLUMN channels SET NOT NULL")
    op.execute("CREATE INDEX IF NOT EXISTS ix_audio_assets_user_sha256 ON audio_assets (user_id, sha256)")
    op.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'uq_audio_asset_user_sha256'
            ) THEN
                ALTER TABLE audio_assets ADD CONSTRAINT uq_audio_asset_user_sha256 UNIQUE (user_id, sha256);
            END IF;
        END $$
    """)

    op.execute("ALTER TABLE stem_jobs ADD COLUMN IF NOT EXISTS stage VARCHAR(40)")
    op.execute("ALTER TABLE stem_jobs ADD COLUMN IF NOT EXISTS demucs_version VARCHAR(80)")
    op.execute("ALTER TABLE stem_jobs ADD COLUMN IF NOT EXISTS device VARCHAR(16)")
    op.execute("ALTER TABLE stem_jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0")
    op.execute("ALTER TABLE stem_jobs ADD COLUMN IF NOT EXISTS safe_error_code VARCHAR(80)")
    op.execute("ALTER TABLE stem_jobs ADD COLUMN IF NOT EXISTS worker_run_id UUID")
    op.execute("ALTER TABLE stem_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP WITH TIME ZONE")
    op.execute(
        "ALTER TABLE stem_jobs ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMP WITH TIME ZONE"
    )
    op.execute("UPDATE stem_jobs SET status = 'QUEUED' WHERE status = 'PENDING'")
    op.execute("UPDATE stem_jobs SET status = 'RUNNING' WHERE status = 'PROCESSING'")
    op.execute("UPDATE stem_jobs SET status = 'SUCCEEDED' WHERE status = 'COMPLETED'")
    op.execute("UPDATE stem_jobs SET stage = status WHERE stage IS NULL")
    op.execute("UPDATE stem_jobs SET attempt_count = 0 WHERE attempt_count IS NULL")
    op.execute("ALTER TABLE stem_jobs ALTER COLUMN stage SET NOT NULL")
    op.execute("ALTER TABLE stem_jobs ALTER COLUMN attempt_count SET NOT NULL")
    op.execute("CREATE INDEX IF NOT EXISTS ix_stem_jobs_worker_run_id ON stem_jobs (worker_run_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_stem_jobs_heartbeat_at ON stem_jobs (heartbeat_at)")
    op.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_stem_jobs_stem_job_status') THEN
                ALTER TABLE stem_jobs ADD CONSTRAINT ck_stem_jobs_stem_job_status
                CHECK (status IN ('QUEUED','PREPARING','RUNNING','SUCCEEDED','FAILED','CANCELLED'));
            END IF;
        END $$
    """)

    op.execute("ALTER TABLE stem_artifacts ADD COLUMN IF NOT EXISTS media_type VARCHAR(100)")
    op.execute("ALTER TABLE stem_artifacts ADD COLUMN IF NOT EXISTS size_bytes BIGINT")
    op.execute("ALTER TABLE stem_artifacts ADD COLUMN IF NOT EXISTS sample_rate INTEGER")
    op.execute("ALTER TABLE stem_artifacts ADD COLUMN IF NOT EXISTS channels INTEGER")
    op.execute("ALTER TABLE stem_artifacts ADD COLUMN IF NOT EXISTS artifact_version VARCHAR(40)")
    op.execute("UPDATE stem_artifacts SET media_type = 'audio/flac' WHERE media_type IS NULL")
    op.execute("UPDATE stem_artifacts SET size_bytes = 0 WHERE size_bytes IS NULL")
    op.execute("UPDATE stem_artifacts SET sample_rate = 44100 WHERE sample_rate IS NULL")
    op.execute("UPDATE stem_artifacts SET channels = 2 WHERE channels IS NULL")
    op.execute("UPDATE stem_artifacts SET artifact_version = 'flac-v1' WHERE artifact_version IS NULL")
    op.execute("ALTER TABLE stem_artifacts ALTER COLUMN media_type SET NOT NULL")
    op.execute("ALTER TABLE stem_artifacts ALTER COLUMN size_bytes SET NOT NULL")
    op.execute("ALTER TABLE stem_artifacts ALTER COLUMN sample_rate SET NOT NULL")
    op.execute("ALTER TABLE stem_artifacts ALTER COLUMN channels SET NOT NULL")
    op.execute("ALTER TABLE stem_artifacts ALTER COLUMN artifact_version SET NOT NULL")
    op.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'ck_stem_artifacts_stem_artifact_type'
            ) THEN
                ALTER TABLE stem_artifacts ADD CONSTRAINT ck_stem_artifacts_stem_artifact_type
                CHECK (stem_type IN ('VOCALS','DRUMS','BASS','OTHER'));
            END IF;
        END $$
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE stem_artifacts DROP CONSTRAINT IF EXISTS ck_stem_artifacts_stem_artifact_type")
    for column in ("artifact_version", "channels", "sample_rate", "size_bytes", "media_type"):
        op.execute(f"ALTER TABLE stem_artifacts DROP COLUMN IF EXISTS {column}")
    op.execute("ALTER TABLE stem_jobs DROP CONSTRAINT IF EXISTS ck_stem_jobs_stem_job_status")
    op.execute("UPDATE stem_jobs SET status = 'PENDING' WHERE status = 'QUEUED'")
    op.execute("UPDATE stem_jobs SET status = 'PROCESSING' WHERE status IN ('PREPARING','RUNNING')")
    op.execute("UPDATE stem_jobs SET status = 'COMPLETED' WHERE status = 'SUCCEEDED'")
    op.execute("UPDATE stem_jobs SET status = 'FAILED' WHERE status = 'CANCELLED'")
    for column in (
        "cancellation_requested_at",
        "heartbeat_at",
        "worker_run_id",
        "safe_error_code",
        "attempt_count",
        "device",
        "demucs_version",
        "stage",
    ):
        op.execute(f"ALTER TABLE stem_jobs DROP COLUMN IF EXISTS {column}")
    op.execute("ALTER TABLE audio_assets DROP CONSTRAINT IF EXISTS uq_audio_asset_user_sha256")
    op.execute("DROP INDEX IF EXISTS ix_audio_assets_user_sha256")
    for column in ("channels", "sample_rate", "size_bytes", "media_type"):
        op.execute(f"ALTER TABLE audio_assets DROP COLUMN IF EXISTS {column}")
