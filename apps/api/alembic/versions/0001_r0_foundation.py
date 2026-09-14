"""Create the MusicScope V2 R0 domain foundation."""

from alembic import op
from app.core.database import Base
from app.domain import models  # noqa: F401

revision = "0001_r0_foundation"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # This frozen greenfield baseline is generated from the R0 metadata. Future
    # revisions must use explicit Alembic operations rather than create_all.
    Base.metadata.create_all(bind=op.get_bind(), checkfirst=False)


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind(), checkfirst=False)

