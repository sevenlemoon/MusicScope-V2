"""Track albums explicitly collected by each connected account."""

import sqlalchemy as sa

from alembic import op

revision = "0010_saved_albums"
down_revision = "0009_studio_track_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_albums",
        sa.Column(
            "connection_id",
            sa.Uuid(),
            sa.ForeignKey("music_connections.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("album_id", sa.Uuid(), sa.ForeignKey("albums.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_saved_albums_album_id", "saved_albums", ["album_id"])


def downgrade() -> None:
    op.drop_index("ix_saved_albums_album_id", table_name="saved_albums")
    op.drop_table("saved_albums")
