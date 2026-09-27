"""Choose which synchronized playlist memberships back the library browser.

The provider's `specialType=5` identifies the account's liked-songs playlist.
Older syncs did not retain that field, so their exact account-named playlist is
used as a compatibility fallback. This never guesses from arbitrary playlists.
"""

from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.models import MusicConnection, Playlist, PlaylistTrack, Track, TrackArtist, User

LibraryScope = Literal["liked", "all"]


def playlist_ids_for_scope(db: Session, scope: LibraryScope) -> tuple[UUID, ...]:
    user = db.scalar(select(User).order_by(User.created_at, User.id).limit(1))
    if user is None:
        return ()
    rows = db.execute(
        select(Playlist, MusicConnection)
        .join(MusicConnection, Playlist.owner_connection_id == MusicConnection.id)
        .where(MusicConnection.user_id == user.id)
    ).all()
    if scope == "all":
        return tuple(playlist.id for playlist, _ in rows)
    typed = [playlist.id for playlist, _ in rows if playlist.metadata_json.get("special_type") == 5]
    if typed:
        return tuple(typed)
    return tuple(
        playlist.id
        for playlist, connection in rows
        if not playlist.metadata_json.get("subscribed")
        and playlist.name == f"{connection.metadata_json.get('nickname', '')}喜欢的音乐"
    )


def track_ids_for_scope(db: Session, scope: LibraryScope):
    return select(PlaylistTrack.track_id).where(
        PlaylistTrack.playlist_id.in_(playlist_ids_for_scope(db, scope))
    )


def album_ids_for_scope(db: Session, scope: LibraryScope):
    return select(Track.album_id).where(
        Track.id.in_(track_ids_for_scope(db, scope)), Track.album_id.is_not(None)
    )


def lead_artist_ids_for_scope(db: Session, scope: LibraryScope):
    return select(TrackArtist.artist_id).where(
        TrackArtist.track_id.in_(track_ids_for_scope(db, scope)), TrackArtist.position == 0
    )
