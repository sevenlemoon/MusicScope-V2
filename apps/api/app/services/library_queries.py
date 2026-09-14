from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.schemas import AlphabetGroup, EntityReference, TrackItem
from app.domain.models import Album, Artist, Track, TrackArtist

ALPHABET = tuple("ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def normalized_name(column: Any) -> Any:
    return func.lower(func.trim(column))


def first_character(column: Any) -> Any:
    return func.substr(normalized_name(column), 1, 1)


def latin_bucket(column: Any) -> Any:
    first = first_character(column)
    return case((first.between("a", "z"), 0), else_=1)


def group_expression(column: Any) -> Any:
    first = first_character(column)
    return case((first.between("a", "z"), func.upper(first)), else_="#")


def sort_clauses(column: Any, canonical_id: Any, order: str) -> tuple[Any, ...]:
    normalized = normalized_name(column)
    direction = normalized.desc() if order == "desc" else normalized.asc()
    return latin_bucket(column).asc(), direction, canonical_id.asc()


def apply_group(statement: Any, column: Any, group: str | None) -> Any:
    if not group:
        return statement
    first = first_character(column)
    if group == "#":
        return statement.where(~first.between("a", "z"))
    return statement.where(first == group.casefold())


def alphabet_groups(
    session: Session,
    *,
    model: Any,
    column: Any,
    conditions: Sequence[Any] = (),
    order: str = "asc",
) -> list[AlphabetGroup]:
    expression = group_expression(column)
    statement = select(expression, func.count()).select_from(model)
    if conditions:
        statement = statement.where(*conditions)
    counts = {str(key): int(count) for key, count in session.execute(statement.group_by(expression))}
    letters = list(reversed(ALPHABET)) if order == "desc" else list(ALPHABET)
    return [AlphabetGroup(key=key, count=counts[key]) for key in (*letters, "#") if counts.get(key)]


def display_group(value: str) -> str:
    stripped = value.strip()
    if stripped and "A" <= stripped[0].upper() <= "Z" and stripped[0].isascii():
        return stripped[0].upper()
    return "#"


def offset_from_cursor(cursor: str | None) -> int:
    try:
        return max(0, int(cursor or 0))
    except ValueError:
        return 0


def page_metadata(offset: int, count: int, total: int, limit: int) -> dict[str, int | str | None]:
    return {
        "next_cursor": str(offset + count) if offset + count < total else None,
        "previous_cursor": str(max(0, offset - limit)) if offset > 0 else None,
        "range_start": offset + 1 if count else 0,
        "range_end": offset + count,
    }


def track_items(
    session: Session,
    tracks: Sequence[Track],
    *,
    positions: dict[UUID, int] | None = None,
) -> list[TrackItem]:
    track_ids = [track.id for track in tracks]
    album_ids = {track.album_id for track in tracks if track.album_id is not None}
    albums = {
        album.id: album
        for album in session.scalars(select(Album).where(Album.id.in_(album_ids)))
    }
    artists_by_track: dict[UUID, list[Artist]] = {track_id: [] for track_id in track_ids}
    if track_ids:
        rows = session.execute(
            select(TrackArtist.track_id, Artist)
            .join(Artist, Artist.id == TrackArtist.artist_id)
            .where(TrackArtist.track_id.in_(track_ids))
            .order_by(TrackArtist.track_id, TrackArtist.position)
        )
        for track_id, artist in rows:
            artists_by_track.setdefault(track_id, []).append(artist)

    return [
        TrackItem(
            id=str(track.id),
            title=track.title,
            artwork_url=track.artwork_url,
            duration_ms=track.duration_ms,
            album_id=str(track.album_id) if track.album_id else None,
            album=albums[track.album_id].title if track.album_id in albums else None,
            artists=[artist.name for artist in artists_by_track.get(track.id, [])],
            artist_items=[
                EntityReference(id=str(artist.id), name=artist.name)
                for artist in artists_by_track.get(track.id, [])
            ],
            sort_group=display_group(track.title),
            playlist_position=positions.get(track.id) if positions else None,
        )
        for track in tracks
    ]
