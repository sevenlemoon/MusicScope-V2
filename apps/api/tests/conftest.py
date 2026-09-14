import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.domain import models  # noqa: F401
from app.main import app


@pytest.fixture(autouse=True)
def isolated_api_database() -> None:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)

    def override_database():  # type: ignore[no-untyped-def]
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = override_database
    yield
    app.dependency_overrides.clear()
    engine.dispose()
