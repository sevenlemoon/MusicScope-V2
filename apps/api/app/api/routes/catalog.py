from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    AlbumDetail,
    AlbumItem,
    AlbumPage,
    ArtistDetail,
    EntityReference,
    PlaybackSourceResponse,
    PlaylistDetail,
    StemEntryResponse,
    TrackDetail,
    TrackPage,
)
from app.core.database import get_db
from app.domain.models import (
    Album,
    AlbumArtist,
    Artist,
    Playlist,
    PlaylistTrack,
    Track,
    TrackArtist,
)
from app.providers.errors import (
    ProviderAuthenticationExpired,
    ProviderError,
    ProviderPlaybackUnavailable,
)
from app.services.library_queries import (
    apply_group,
    display_group,
    offset_from_cursor,
    page_metadata,
    sort_clauses,
    track_items,
)
from app.services.playback import PlaybackService

router = APIRouter(tags=["catalog"])
DbSession = Annotated[Session, Depends(get_db)]
SortOrder = Literal["asc", "desc"]


def _track_page(
    db: Session,
    statement: object,
    *,
    cursor: str | None,
    limit: int,
    sort: SortOrder,
    group: str | None = None,
) -> TrackPage:
    offset = offset_from_cursor(cursor)
    filtered = apply_group(statement, Track.title, group)
    total = db.scalar(select(func.count()).select_from(filtered.order_by(None).subquery())) or 0
    rows = list(
        db.scalars(
            filtered.order_by(*sort_clauses(Track.title, Track.id, sort))
            .offset(offset)
            .limit(limit)
        )
    )
    items = track_items(db, rows)
    return TrackPage(
        items=items,
        total=total,
        sort=sort,
        group=group,
        **page_metadata(offset, len(items), total, limit),
    )


def _artist_references(db: Session, album_id: UUID) -> list[EntityReference]:
    artists = db.scalars(
        select(Artist)
        .join(AlbumArtist, AlbumArtist.artist_id == Artist.id)
        .where(AlbumArtist.album_id == album_id)
        .order_by(AlbumArtist.position, Artist.id)
    )
    return [EntityReference(id=str(artist.id), name=artist.name) for artist in artists]


@router.get("/artists/{artist_id}", response_model=ArtistDetail)
def artist_detail(artist_id: UUID, db: DbSession) -> ArtistDetail:
    artist = db.get(Artist, artist_id)
    if artist is None:
        raise HTTPException(status_code=404, detail="Artist not found.")
    track_ids = select(TrackArtist.track_id).where(TrackArtist.artist_id == artist.id)
    track_count = db.scalar(select(func.count()).select_from(track_ids.subquery())) or 0
    album_count = (
        db.scalar(
            select(func.count(func.distinct(Track.album_id))).where(
                Track.id.in_(track_ids), Track.album_id.is_not(None)
            )
        )
        or 0
    )
    return ArtistDetail(
        id=str(artist.id),
        name=artist.name,
        artwork_url=artist.artwork_url,
        library_track_count=track_count,
        represented_album_count=album_count,
    )


@router.get("/artists/{artist_id}/tracks", response_model=TrackPage)
def artist_tracks(
    artist_id: UUID,
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    sort: SortOrder = "asc",
) -> TrackPage:
    if db.get(Artist, artist_id) is None:
        raise HTTPException(status_code=404, detail="Artist not found.")
    statement = (
        select(Track)
        .join(TrackArtist, TrackArtist.track_id == Track.id)
        .where(TrackArtist.artist_id == artist_id)
    )
    return _track_page(db, statement, cursor=cursor, limit=limit, sort=sort)


@router.get("/artists/{artist_id}/albums", response_model=AlbumPage)
def artist_albums(
    artist_id: UUID,
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(24, ge=1, le=100),
    sort: SortOrder = "asc",
) -> AlbumPage:
    if db.get(Artist, artist_id) is None:
        raise HTTPException(status_code=404, detail="Artist not found.")
    offset = offset_from_cursor(cursor)
    album_ids = (
        select(Track.album_id)
        .join(TrackArtist, TrackArtist.track_id == Track.id)
        .where(TrackArtist.artist_id == artist_id, Track.album_id.is_not(None))
        .distinct()
    )
    statement = select(Album).where(Album.id.in_(album_ids))
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    albums = list(
        db.scalars(
            statement.order_by(*sort_clauses(Album.title, Album.id, sort))
            .offset(offset)
            .limit(limit)
        )
    )
    return AlbumPage(
        items=[
            AlbumItem(
                id=str(album.id),
                title=album.title,
                artwork_url=album.artwork_url,
                artists=_artist_references(db, album.id),
                sort_group=display_group(album.title),
            )
            for album in albums
        ],
        total=total,
        sort=sort,
        **page_metadata(offset, len(albums), total, limit),
    )


@router.get("/albums/{album_id}", response_model=AlbumDetail)
def album_detail(album_id: UUID, db: DbSession) -> AlbumDetail:
    album = db.get(Album, album_id)
    if album is None:
        raise HTTPException(status_code=404, detail="Album not found.")
    track_count = (
        db.scalar(select(func.count()).select_from(Track).where(Track.album_id == album.id)) or 0
    )
    return AlbumDetail(
        id=str(album.id),
        title=album.title,
        artwork_url=album.artwork_url,
        artists=_artist_references(db, album.id),
        library_track_count=track_count,
    )


@router.get("/albums/{album_id}/tracks", response_model=TrackPage)
def album_tracks(
    album_id: UUID,
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    sort: SortOrder = "asc",
) -> TrackPage:
    if db.get(Album, album_id) is None:
        raise HTTPException(status_code=404, detail="Album not found.")
    return _track_page(
        db,
        select(Track).where(Track.album_id == album_id),
        cursor=cursor,
        limit=limit,
        sort=sort,
    )


@router.get("/playlists/{playlist_id}", response_model=PlaylistDetail)
def playlist_detail(playlist_id: UUID, db: DbSession) -> PlaylistDetail:
    playlist = db.get(Playlist, playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found.")
    synchronized_count = (
        db.scalar(
            select(func.count())
            .select_from(PlaylistTrack)
            .where(PlaylistTrack.playlist_id == playlist.id)
        )
        or 0
    )
    return PlaylistDetail(
        id=str(playlist.id),
        name=playlist.name,
        description=playlist.description,
        artwork_url=playlist.artwork_url,
        provider_track_count=playlist.track_count,
        synchronized_track_count=synchronized_count,
    )


@router.get("/playlists/{playlist_id}/tracks", response_model=TrackPage)
def playlist_tracks(
    playlist_id: UUID,
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    sort: Literal["original", "asc", "desc"] = "original",
) -> TrackPage:
    if db.get(Playlist, playlist_id) is None:
        raise HTTPException(status_code=404, detail="Playlist not found.")
    offset = offset_from_cursor(cursor)
    total = (
        db.scalar(
            select(func.count())
            .select_from(PlaylistTrack)
            .where(PlaylistTrack.playlist_id == playlist_id)
        )
        or 0
    )
    statement = (
        select(Track, PlaylistTrack.position)
        .join(PlaylistTrack, PlaylistTrack.track_id == Track.id)
        .where(PlaylistTrack.playlist_id == playlist_id)
    )
    if sort == "original":
        statement = statement.order_by(PlaylistTrack.position, Track.id)
    else:
        statement = statement.order_by(*sort_clauses(Track.title, Track.id, sort))
    rows = list(db.execute(statement.offset(offset).limit(limit)))
    tracks = [track for track, _ in rows]
    positions = {track.id: position for track, position in rows}
    items = track_items(db, tracks, positions=positions)
    return TrackPage(
        items=items,
        total=total,
        sort=sort,
        **page_metadata(offset, len(items), total, limit),
    )


@router.get("/tracks/{track_id}", response_model=TrackDetail)
def track_detail(track_id: UUID, db: DbSession) -> TrackDetail:
    track = db.get(Track, track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found.")
    artists = db.scalars(
        select(Artist)
        .join(TrackArtist, TrackArtist.artist_id == Artist.id)
        .where(TrackArtist.track_id == track.id)
        .order_by(TrackArtist.position, Artist.id)
    )
    playlists = db.scalars(
        select(Playlist)
        .join(PlaylistTrack, PlaylistTrack.playlist_id == Playlist.id)
        .where(PlaylistTrack.track_id == track.id)
        .order_by(Playlist.name, Playlist.id)
    )
    album = db.get(Album, track.album_id) if track.album_id else None
    return TrackDetail(
        id=str(track.id),
        title=track.title,
        artwork_url=track.artwork_url,
        duration_ms=track.duration_ms,
        artists=[EntityReference(id=str(artist.id), name=artist.name) for artist in artists],
        album=EntityReference(id=str(album.id), name=album.title) if album else None,
        playlists=[
            EntityReference(id=str(playlist.id), name=playlist.name) for playlist in playlists
        ],
    )


@router.post("/tracks/{track_id}/playback-source", response_model=PlaybackSourceResponse)
async def playback_source(track_id: UUID, response: Response, db: DbSession) -> PlaybackSourceResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        result = await PlaybackService(db).resolve(track_id)
        return PlaybackSourceResponse(
            track_id=str(track_id),
            url=result.source.url,
            mime_type=result.source.mime_type,
            duration_ms=result.source.duration_ms,
            expires_at=result.source.expires_at,
            quality=result.source.quality,
            provider="netease",
            resolution_ms=result.resolution_ms,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="Track not found.") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail="Connect NetEase before playback.") from exc
    except ProviderPlaybackUnavailable as exc:
        raise HTTPException(
            status_code=422,
            detail="This track cannot be played with the current account.",
        ) from exc
    except ProviderAuthenticationExpired as exc:
        raise HTTPException(status_code=401, detail="NetEase session expired.") from exc
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail="Playback is temporarily unavailable.") from exc


@router.post("/tracks/{track_id}/stem-jobs", response_model=StemEntryResponse)
def stem_entry(track_id: UUID, db: DbSession) -> StemEntryResponse:
    if db.get(Track, track_id) is None:
        raise HTTPException(status_code=404, detail="Track not found.")
    return StemEntryResponse(
        status="LOCAL_UPLOAD_REQUIRED",
        message="Source audio is unavailable for separation. Upload a local audio file instead.",
        studio_url=f"/studio?source=local-upload&track={track_id}",
    )
