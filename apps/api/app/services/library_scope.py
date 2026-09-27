"""Scope local browsing to liked tracks, account-created playlists, and saved albums.

The provider's `specialType=5` identifies the account's liked-songs playlist.
Older syncs did not retain that field, so their exact account-named playlist is
used as a compatibility fallback. The personal scope keeps that track picker,
but gives playlists and albums their own explicit account ownership evidence.
"""

from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.models import MusicConnection, Playlist, PlaylistTrack, SavedAlbum, Track, TrackArtist, User

LibraryScope = Literal["liked", "personal", "all"]


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
    if scope == "personal":
        return tuple(
            playlist.id
            for playlist, connection in rows
            if (
                playlist.metadata_json.get("creator_user_id") == connection.provider_user_id
                if playlist.metadata_json.get("creator_user_id") is not None
                else playlist.metadata_json.get("subscribed") is False
            )
        )
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
    # Personal browsing keeps the song picker focused on liked tracks.
    playlist_scope: LibraryScope = "liked" if scope == "personal" else scope
    return select(PlaylistTrack.track_id).where(
        PlaylistTrack.playlist_id.in_(playlist_ids_for_scope(db, playlist_scope))
    )


def album_ids_for_scope(db: Session, scope: LibraryScope):
    if scope == "personal":
        user_id = select(User.id).order_by(User.created_at, User.id).limit(1).scalar_subquery()
        return select(SavedAlbum.album_id).join(
            MusicConnection, SavedAlbum.connection_id == MusicConnection.id
        ).where(
            MusicConnection.user_id == user_id
        )
    return select(Track.album_id).where(
        Track.id.in_(track_ids_for_scope(db, scope)), Track.album_id.is_not(None)
    )


def lead_artist_ids_for_scope(db: Session, scope: LibraryScope):
    return select(TrackArtist.artist_id).where(
        TrackArtist.track_id.in_(track_ids_for_scope(db, scope)), TrackArtist.position == 0
    )
