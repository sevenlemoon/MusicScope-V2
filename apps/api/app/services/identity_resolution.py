from collections.abc import Callable
from typing import TypeVar

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import EntityType
from app.domain.models import Album, Artist, ExternalIdentity, Playlist, Track

CanonicalEntity = Album | Artist | Playlist | Track
CanonicalModel = type[Album] | type[Artist] | type[Playlist] | type[Track]
TEntity = TypeVar("TEntity", Album, Artist, Playlist, Track)

ENTITY_MODELS: dict[EntityType, CanonicalModel] = {
    EntityType.ALBUM: Album,
    EntityType.ARTIST: Artist,
    EntityType.PLAYLIST: Playlist,
    EntityType.TRACK: Track,
}


class IdentityResolutionError(ValueError):
    pass


def _validated_type(entity_type: EntityType | str) -> EntityType:
    try:
        return EntityType(entity_type)
    except ValueError as exc:
        raise IdentityResolutionError(f"Unsupported canonical entity type: {entity_type!r}") from exc


def resolve_external_identity(
    session: Session,
    *,
    provider: str,
    entity_type: EntityType | str,
    provider_id: str,
) -> CanonicalEntity | None:
    """The sole provider-ID to canonical-entity resolution path."""
    resolved_type = _validated_type(entity_type)
    identity = session.scalar(
        select(ExternalIdentity).where(
            ExternalIdentity.provider == provider,
            ExternalIdentity.entity_type == resolved_type.value,
            ExternalIdentity.provider_id == provider_id,
        )
    )
    if identity is None:
        return None
    entity = session.get(ENTITY_MODELS[resolved_type], identity.entity_id)
    if entity is None:
        raise IdentityResolutionError("External identity points to a missing canonical entity.")
    return entity


def bind_external_identity(
    session: Session,
    *,
    provider: str,
    entity_type: EntityType | str,
    provider_id: str,
    entity: CanonicalEntity,
    source_url: str | None = None,
    source_payload: dict[str, object] | None = None,
) -> ExternalIdentity:
    resolved_type = _validated_type(entity_type)
    if not isinstance(entity, ENTITY_MODELS[resolved_type]):
        raise IdentityResolutionError(
            f"A {type(entity).__name__} cannot be bound as {resolved_type.value}."
        )
    if entity.id is None:
        session.add(entity)
        session.flush()

    existing = session.scalar(
        select(ExternalIdentity).where(
            ExternalIdentity.provider == provider,
            ExternalIdentity.entity_type == resolved_type.value,
            ExternalIdentity.provider_id == provider_id,
        )
    )
    if existing is not None:
        if existing.entity_id != entity.id:
            raise IdentityResolutionError("Provider identity is already bound to another entity.")
        return existing

    identity = ExternalIdentity(
        provider=provider,
        entity_type=resolved_type.value,
        provider_id=provider_id,
        entity_id=entity.id,
        source_url=source_url,
        source_payload=source_payload or {},
    )
    session.add(identity)
    session.flush()
    return identity


def resolve_or_create_track(
    session: Session,
    *,
    provider: str,
    provider_id: str,
    factory: Callable[[], Track],
) -> Track:
    existing = resolve_external_identity(
        session,
        provider=provider,
        entity_type=EntityType.TRACK,
        provider_id=provider_id,
    )
    if existing is not None:
        if not isinstance(existing, Track):
            raise IdentityResolutionError("Track identity resolved to the wrong canonical type.")
        return existing

    track = factory()
    session.add(track)
    session.flush()
    bind_external_identity(
        session,
        provider=provider,
        entity_type=EntityType.TRACK,
        provider_id=provider_id,
        entity=track,
    )
    return track
