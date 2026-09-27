from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import String, case, cast, func, literal, select, union_all
from sqlalchemy.orm import Session

from app.api.schemas import (
    AlbumItem,
    AlbumPage,
    ArtistEnrichmentResponse,
    ArtistItem,
    ArtistPage,
    EntityReference,
    LibraryCounts,
    LibrarySearchResponse,
    LibrarySummary,
    PlaylistItem,
    PlaylistPage,
    SearchAlbumResult,
    SearchArtistResult,
    SearchPlaylistResult,
    SearchTrackResult,
    SortOrder,
    TrackItem,
    TrackPage,
)
from app.core.database import get_db
from app.domain.models import (
    Album,
    Artist,
    MusicConnection,
    Playlist,
    SyncState,
    Track,
    TrackArtist,
    User,
)
from app.providers.errors import ProviderAuthenticationExpired, ProviderError
from app.services.artist_enrichment import ArtistEnrichmentService
from app.services.library_queries import (
    alphabet_groups,
    apply_group,
    display_group,
    offset_from_cursor,
    page_metadata,
    sort_clauses,
    track_items,
)
from app.services.library_scope import (
    LibraryScope,
    album_ids_for_scope,
    lead_artist_ids_for_scope,
    playlist_ids_for_scope,
    track_ids_for_scope,
)

router = APIRouter(prefix="/library", tags=["library"])
DbSession = Annotated[Session, Depends(get_db)]


@router.get("/summary", response_model=LibrarySummary)
def library_summary(db: DbSession, scope: LibraryScope = "liked") -> LibrarySummary:
    user = db.scalar(select(User).order_by(User.created_at, User.id).limit(1))
    if user is None:
        return LibrarySummary(connection_state="not_connected", sync_state="idle", counts=LibraryCounts())
    connection_ids = select(MusicConnection.id).where(MusicConnection.user_id == user.id)
    playlist_ids = playlist_ids_for_scope(db, scope)
    track_ids = track_ids_for_scope(db, scope)
    album_ids = album_ids_for_scope(db, scope)
    artist_ids = lead_artist_ids_for_scope(db, scope)
    counts = LibraryCounts(
        playlists=db.scalar(select(func.count()).select_from(Playlist).where(Playlist.id.in_(playlist_ids)))
        or 0,
        tracks=db.scalar(select(func.count(func.distinct(Track.id))).where(Track.id.in_(track_ids))) or 0,
        albums=db.scalar(select(func.count(func.distinct(Album.id))).where(Album.id.in_(album_ids))) or 0,
        artists=db.scalar(select(func.count(func.distinct(Artist.id))).where(Artist.id.in_(artist_ids))) or 0,
    )
    connected = db.scalar(
        select(func.count())
        .select_from(MusicConnection)
        .where(MusicConnection.user_id == user.id, MusicConnection.status == "CONNECTED")
    )
    latest_sync = db.scalar(
        select(SyncState)
        .where(SyncState.connection_id.in_(connection_ids))
        .order_by(SyncState.updated_at.desc())
        .limit(1)
    )
    return LibrarySummary(
        connection_state="connected" if connected else "not_connected",
        sync_state=latest_sync.status.casefold() if latest_sync else "idle",
        counts=counts,
    )


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _search_select(entity_type: str, model: object, column: object, query: str) -> object:
    normalized = func.lower(func.trim(column))
    escaped = _escape_like(query.casefold())
    ranking = case(
        (normalized == query.casefold(), 0),
        (normalized.like(f"{escaped}%", escape="\\"), 1),
        else_=2,
    )
    return (
        select(
            literal(entity_type).label("entity_type"),
            cast(model.id, String).label("entity_id"),
            column.label("display_name"),
            ranking.label("match_rank"),
        )
        .select_from(model)
        .where(normalized.like(f"%{escaped}%", escape="\\"))
    )


@router.get("/search", response_model=LibrarySearchResponse)
def search_library(
    db: DbSession,
    q: str = Query(..., max_length=200),
    types: str | None = Query(None, description="Comma-separated track,artist,album,playlist"),
    cursor: str | None = None,
    limit: int = Query(24, ge=1, le=100),
    scope: LibraryScope = "liked",
) -> LibrarySearchResponse:
    query = q.strip()
    if not query:
        return LibrarySearchResponse(query="", total=0)
    supported = ("track", "artist", "album", "playlist")
    requested = tuple(
        dict.fromkeys(
            part.strip().casefold() for part in (types or ",".join(supported)).split(",") if part.strip()
        )
    )
    if not requested or any(item not in supported for item in requested):
        raise HTTPException(status_code=422, detail="Search types must be track, artist, album, or playlist.")
    models = {
        "track": (Track, Track.title),
        "artist": (Artist, Artist.name),
        "album": (Album, Album.title),
        "playlist": (Playlist, Playlist.name),
    }
    candidates = []
    for kind in requested:
        candidate = _search_select(kind, *models[kind], query)
        if kind == "track":
            candidate = candidate.where(Track.id.in_(track_ids_for_scope(db, scope)))
        elif kind == "album":
            candidate = candidate.where(Album.id.in_(album_ids_for_scope(db, scope)))
        elif kind == "artist":
            candidate = candidate.where(Artist.id.in_(lead_artist_ids_for_scope(db, scope)))
        elif kind == "playlist":
            candidate = candidate.where(Playlist.id.in_(playlist_ids_for_scope(db, scope)))
        candidates.append(candidate)
    hits = union_all(*candidates).subquery()
    offset = offset_from_cursor(cursor)
    total = db.scalar(select(func.count()).select_from(hits)) or 0
    rows = list(
        db.execute(
            select(hits)
            .order_by(
                hits.c.match_rank,
                func.lower(func.trim(hits.c.display_name)),
                hits.c.entity_type,
                hits.c.entity_id,
            )
            .offset(offset)
            .limit(limit)
        )
    )
    ids_by_type: dict[str, list[UUID]] = {kind: [] for kind in supported}
    for row in rows:
        ids_by_type[row.entity_type].append(UUID(row.entity_id))

    track_models = list(db.scalars(select(Track).where(Track.id.in_(ids_by_type["track"]))))
    tracks = {UUID(item.id): item for item in track_items(db, track_models)}
    artist_models = {
        item.id: item for item in db.scalars(select(Artist).where(Artist.id.in_(ids_by_type["artist"])))
    }
    artist_counts = (
        dict(
            db.execute(
                select(TrackArtist.artist_id, func.count())
                .where(
                    TrackArtist.artist_id.in_(ids_by_type["artist"]),
                    TrackArtist.position == 0,
                    TrackArtist.track_id.in_(track_ids_for_scope(db, scope)),
                )
                .group_by(TrackArtist.artist_id)
            ).all()
        )
        if ids_by_type["artist"]
        else {}
    )
    album_models = {
        item.id: item for item in db.scalars(select(Album).where(Album.id.in_(ids_by_type["album"])))
    }
    artists_by_album: dict[UUID, list[EntityReference]] = {album_id: [] for album_id in ids_by_type["album"]}
    if ids_by_type["album"]:
        for album_id, artist_id, artist_name in db.execute(
            select(Track.album_id, Artist.id, Artist.name)
            .join(TrackArtist, TrackArtist.track_id == Track.id)
            .join(Artist, Artist.id == TrackArtist.artist_id)
            .where(
                Track.album_id.in_(ids_by_type["album"]),
                Track.id.in_(track_ids_for_scope(db, scope)),
                TrackArtist.position == 0,
            )
            .distinct()
            .order_by(Track.album_id, Artist.name)
        ):
            artists_by_album[album_id].append(EntityReference(id=str(artist_id), name=artist_name))
    playlist_models = {
        item.id: item for item in db.scalars(select(Playlist).where(Playlist.id.in_(ids_by_type["playlist"])))
    }

    result = LibrarySearchResponse(
        query=query,
        total=total,
        **page_metadata(offset, len(rows), total, limit),
    )
    for row in rows:
        canonical_id = UUID(row.entity_id)
        match = ("exact", "prefix", "substring")[row.match_rank]
        if row.entity_type == "track" and canonical_id in tracks:
            result.tracks.append(SearchTrackResult(match=match, track=tracks[canonical_id]))
        elif row.entity_type == "artist" and canonical_id in artist_models:
            artist = artist_models[canonical_id]
            result.artists.append(
                SearchArtistResult(
                    match=match,
                    artist=ArtistItem(
                        id=str(artist.id),
                        name=artist.name,
                        artwork_url=artist.artwork_url,
                        sort_group=display_group(artist.name),
                    ),
                    library_track_count=int(artist_counts.get(artist.id, 0)),
                )
            )
        elif row.entity_type == "album" and canonical_id in album_models:
            album = album_models[canonical_id]
            result.albums.append(
                SearchAlbumResult(
                    match=match,
                    album=AlbumItem(
                        id=str(album.id),
                        title=album.title,
                        artwork_url=album.artwork_url,
                        artists=artists_by_album[album.id],
                        sort_group=display_group(album.title),
                    ),
                )
            )
        elif row.entity_type == "playlist" and canonical_id in playlist_models:
            playlist = playlist_models[canonical_id]
            result.playlists.append(
                SearchPlaylistResult(
                    match=match,
                    playlist=PlaylistItem(
                        id=str(playlist.id),
                        name=playlist.name,
                        description=playlist.description,
                        artwork_url=playlist.artwork_url,
                        track_count=playlist.track_count,
                        sort_group=display_group(playlist.name),
                    ),
                )
            )
    return result


@router.get("/playlists", response_model=PlaylistPage)
def playlists(
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(24, ge=1, le=100),
    sort: SortOrder = "asc",
    group: str | None = Query(None, pattern=r"^(?:[A-Z]|#)$"),
    scope: LibraryScope = "liked",
) -> PlaylistPage:
    offset = offset_from_cursor(cursor)
    scope_condition = Playlist.id.in_(playlist_ids_for_scope(db, scope))
    statement = apply_group(select(Playlist).where(scope_condition), Playlist.name, group)
    total = db.scalar(select(func.count()).select_from(statement.order_by(None).subquery())) or 0
    rows = list(
        db.scalars(
            statement.order_by(*sort_clauses(Playlist.name, Playlist.id, sort)).offset(offset).limit(limit)
        )
    )
    return PlaylistPage(
        items=[
            PlaylistItem(
                id=str(row.id),
                name=row.name,
                description=row.description,
                artwork_url=row.artwork_url,
                track_count=row.track_count,
                sort_group=display_group(row.name),
            )
            for row in rows
        ],
        total=total,
        groups=alphabet_groups(
            db, model=Playlist, column=Playlist.name, conditions=(scope_condition,), order=sort
        ),
        sort=sort,
        group=group,
        **page_metadata(offset, len(rows), total, limit),
    )


@router.get("/albums", response_model=AlbumPage)
def albums(
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(24, ge=1, le=100),
    sort: SortOrder = "asc",
    group: str | None = Query(None, pattern=r"^(?:[A-Z]|#)$"),
    scope: LibraryScope = "liked",
) -> AlbumPage:
    offset = offset_from_cursor(cursor)
    scope_condition = Album.id.in_(album_ids_for_scope(db, scope))
    statement = apply_group(select(Album).where(scope_condition), Album.title, group)
    total = db.scalar(select(func.count()).select_from(statement.order_by(None).subquery())) or 0
    rows = list(
        db.scalars(statement.order_by(*sort_clauses(Album.title, Album.id, sort)).offset(offset).limit(limit))
    )
    artists_by_album: dict[object, list[EntityReference]] = {row.id: [] for row in rows}
    if rows:
        artist_rows = db.execute(
            select(Track.album_id, Artist.id, Artist.name)
            .join(TrackArtist, TrackArtist.track_id == Track.id)
            .join(Artist, Artist.id == TrackArtist.artist_id)
            .where(
                Track.album_id.in_([row.id for row in rows]),
                Track.id.in_(track_ids_for_scope(db, scope)),
                TrackArtist.position == 0,
            )
            .distinct()
            .order_by(Track.album_id, Artist.name)
        )
        for album_id, artist_id, artist_name in artist_rows:
            artists_by_album[album_id].append(EntityReference(id=str(artist_id), name=artist_name))
    return AlbumPage(
        items=[
            AlbumItem(
                id=str(row.id),
                title=row.title,
                artwork_url=row.artwork_url,
                artists=artists_by_album[row.id],
                sort_group=display_group(row.title),
            )
            for row in rows
        ],
        total=total,
        groups=alphabet_groups(
            db, model=Album, column=Album.title, conditions=(scope_condition,), order=sort
        ),
        sort=sort,
        group=group,
        **page_metadata(offset, len(rows), total, limit),
    )


@router.get("/artists", response_model=ArtistPage)
def artists(
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(24, ge=1, le=100),
    sort: SortOrder = "asc",
    group: str | None = Query(None, pattern=r"^(?:[A-Z]|#)$"),
    scope: LibraryScope = "liked",
) -> ArtistPage:
    offset = offset_from_cursor(cursor)
    scope_condition = Artist.id.in_(lead_artist_ids_for_scope(db, scope))
    statement = apply_group(select(Artist).where(scope_condition), Artist.name, group)
    total = db.scalar(select(func.count()).select_from(statement.order_by(None).subquery())) or 0
    rows = list(
        db.scalars(
            statement.order_by(*sort_clauses(Artist.name, Artist.id, sort)).offset(offset).limit(limit)
        )
    )
    return ArtistPage(
        items=[
            ArtistItem(
                id=str(row.id),
                name=row.name,
                artwork_url=row.artwork_url,
                sort_group=display_group(row.name),
            )
            for row in rows
        ],
        total=total,
        groups=alphabet_groups(
            db, model=Artist, column=Artist.name, conditions=(scope_condition,), order=sort
        ),
        sort=sort,
        group=group,
        **page_metadata(offset, len(rows), total, limit),
    )


@router.get("/tracks", response_model=TrackPage)
def tracks(
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(50, ge=1, le=100),
    sort: SortOrder = "asc",
    group: str | None = Query(None, pattern=r"^(?:[A-Z]|#)$"),
    scope: LibraryScope = "liked",
) -> TrackPage:
    offset = offset_from_cursor(cursor)
    scope_condition = Track.id.in_(track_ids_for_scope(db, scope))
    statement = apply_group(select(Track).where(scope_condition), Track.title, group)
    total = db.scalar(select(func.count()).select_from(statement.order_by(None).subquery())) or 0
    rows = list(
        db.scalars(statement.order_by(*sort_clauses(Track.title, Track.id, sort)).offset(offset).limit(limit))
    )
    items: list[TrackItem] = track_items(db, rows)
    return TrackPage(
        items=items,
        total=total,
        groups=alphabet_groups(
            db, model=Track, column=Track.title, conditions=(scope_condition,), order=sort
        ),
        sort=sort,
        group=group,
        **page_metadata(offset, len(items), total, limit),
    )


@router.post("/artists/enrich", response_model=ArtistEnrichmentResponse)
async def enrich_artist_artwork(db: DbSession) -> ArtistEnrichmentResponse:
    try:
        result = await ArtistEnrichmentService(db).enrich()
        db.commit()
        return ArtistEnrichmentResponse(**result.__dict__)
    except ProviderAuthenticationExpired as exc:
        db.rollback()
        raise HTTPException(status_code=401, detail="NetEase session expired.") from exc
    except PermissionError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Connect NetEase before enrichment.") from exc
    except ProviderError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="Artist enrichment is temporarily unavailable.") from exc
