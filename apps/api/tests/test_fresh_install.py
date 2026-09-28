from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.database import get_db
from app.domain.models import User
from app.main import app


def test_first_read_creates_one_empty_local_user_without_personal_data() -> None:
    with TestClient(app) as client:
        unknown = client.get(
            "/api/v1/studio/jobs", headers={"X-MusicScope-User-ID": str(uuid4())}
        )
        studio = client.get("/api/v1/studio/jobs")
        connections = client.get("/api/v1/music-connections")

    assert unknown.status_code == 404
    assert studio.status_code == 200
    assert studio.json()["items"] == []
    assert connections.status_code == 200
    assert connections.json()["items"] == []

    session_generator = app.dependency_overrides[get_db]()
    db = next(session_generator)
    try:
        assert len(list(db.scalars(select(User)))) == 1
    finally:
        session_generator.close()
