from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.domain.models import User

DbSession = Annotated[Session, Depends(get_db)]


def get_current_user(
    db: DbSession,
    x_musicscope_user_id: Annotated[str | None, Header()] = None,
) -> User:
    """Resolve the local user while retaining an explicit isolation seam for clients/tests."""
    if x_musicscope_user_id:
        try:
            user_id = UUID(x_musicscope_user_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid MusicScope user identifier.") from exc
        user = db.get(User, user_id)
    else:
        user = db.scalar(select(User).order_by(User.created_at, User.id).limit(1))
        if user is None:
            # A fresh installation needs a local identity before its first QR login.
            # Serialize the first request so parallel Home/Studio/Live reads cannot
            # create separate users in the same PostgreSQL database.
            if db.get_bind().dialect.name == "postgresql":
                db.execute(text("SELECT pg_advisory_xact_lock(6200611)"))
            user = db.scalar(select(User).order_by(User.created_at, User.id).limit(1))
            if user is None:
                user = User(display_name="MusicScope listener")
                db.add(user)
                db.commit()
                db.refresh(user)
    if user is None:
        raise HTTPException(status_code=404, detail="No MusicScope user is available.")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
