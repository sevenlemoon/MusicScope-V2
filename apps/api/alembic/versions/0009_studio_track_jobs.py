"""Persist user-scoped links between library tracks and local stem jobs."""

import sqlalchemy as sa

from alembic import op

revision = "0009_studio_track_jobs"
down_revision = "0008_six_stem_artifacts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "studio_track_jobs",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("track_id", sa.Uuid(), sa.ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column(
            "stem_job_id",
            sa.Uuid(),
            sa.ForeignKey("stem_jobs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_studio_track_jobs_stem_job_id", "studio_track_jobs", ["stem_job_id"])


def downgrade() -> None:
    op.drop_index("ix_studio_track_jobs_stem_job_id", table_name="studio_track_jobs")
    op.drop_table("studio_track_jobs")
