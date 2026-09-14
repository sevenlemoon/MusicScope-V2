from uuid import uuid4

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import Base
from app.domain.enums import EntityType
from app.domain.models import Artist, ExternalIdentity, Track
from app.services.identity_resolution import (
    IdentityResolutionError,
    bind_external_identity,
    resolve_external_identity,
    resolve_or_create_track,
)


@pytest.fixture
def session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as value:
        yield value


def test_provider_id_resolves_to_one_canonical_track(session: Session) -> None:
    factory_calls = 0

    def factory() -> Track:
        nonlocal factory_calls
        factory_calls += 1
        return Track(title="Canonical track")

    first = resolve_or_create_track(
        session, provider="provider-a", provider_id="track-42", factory=factory
    )
    second = resolve_or_create_track(
        session, provider="provider-a", provider_id="track-42", factory=factory
    )

    assert first.id == second.id
    assert factory_calls == 1
    assert session.scalar(select(func.count()).select_from(Track)) == 1
    assert (
        resolve_external_identity(
            session,
            provider="provider-a",
            entity_type=EntityType.TRACK,
            provider_id="track-42",
        )
        is first
    )


def test_wrong_canonical_type_is_rejected(session: Session) -> None:
    artist = Artist(name="Not a track")
    with pytest.raises(IdentityResolutionError, match="cannot be bound"):
        bind_external_identity(
            session,
            provider="provider-a",
            entity_type=EntityType.TRACK,
            provider_id="track-42",
            entity=artist,
        )


def test_database_rejects_invalid_entity_type(session: Session) -> None:
    session.add(
        ExternalIdentity(
            provider="provider-a",
            entity_type="song",
            entity_id=uuid4(),
            provider_id="42",
        )
    )
    with pytest.raises(IntegrityError):
        session.flush()
