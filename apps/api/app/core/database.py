from collections.abc import Generator
from functools import lru_cache
from urllib.parse import urlsplit

from sqlalchemy import MetaData, create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def assert_safe_database_url(database_url: str) -> None:
    """Refuse ambiguous PostgreSQL targets before any connection or migration."""
    if database_url.startswith("sqlite"):
        return
    database_name = urlsplit(database_url.replace("postgresql+psycopg", "postgresql", 1)).path.lstrip("/")
    if not database_name or "v2" not in database_name.casefold():
        raise RuntimeError(
            "Unsafe database target: MusicScope V2 requires a PostgreSQL database name containing 'v2'."
        )


@lru_cache
def get_engine() -> Engine:
    database_url = get_settings().database_url
    assert_safe_database_url(database_url)
    return create_engine(database_url, pool_pre_ping=True)


def get_db() -> Generator[Session, None, None]:
    session_factory = sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)
    with session_factory() as session:
        yield session


def check_database() -> None:
    with get_engine().connect() as connection:
        connection.execute(text("SELECT 1"))

