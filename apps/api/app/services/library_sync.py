import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from time import perf_counter
from typing import ClassVar
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.secrets import ProviderSecretCipher
from app.domain.enums import EntityType, SyncStatus
from app.domain.models import (
    Album,
    AlbumArtist,
    Artist,
    ExternalIdentity,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    SyncState,
    Track,
    TrackArtist,
    utc_now,
)
from app.providers.errors import ProviderAuthenticationExpired, ProviderError
from app.providers.netease import NetEaseProvider
from app.providers.types import ProviderAlbum, ProviderArtist, ProviderPlaylist, ProviderTrack
from app.services.identity_resolution import bind_external_identity
from app.services.music_connections import MusicConnectionService
from app.services.sync_planning import batched, unique_in_order


@dataclass(frozen=True)
class SyncResult:
    status: str
    playlists: int
    track_memberships: int
    tracks: int
    artists: int
    albums: int
    artwork_count: int
    timings_ms: dict[str, int]
    partial_failures: int


class LibrarySyncService:
    _progress: ClassVar[dict[str, dict[str, object]]] = {}

    def __init__(
        self,
        session: Session,
        *,
        provider_factory: Callable[[str], NetEaseProvider] | None = None,
        cipher: ProviderSecretCipher | None = None,
        batch_size: int | None = None,
        concurrency: int | None = None,
    ) -> None:
        self.session = session
        self.settings = get_settings()
        self.provider_factory = provider_factory or (lambda cookie: NetEaseProvider(session_cookie=cookie))
        self.cipher = cipher
        self.batch_size = batch_size or self.settings.netease_song_batch_size
        self.concurrency = concurrency or self.settings.netease_song_concurrency
        self._identity_cache: dict[
            tuple[EntityType, str], Album | Artist | Playlist | Track
        ] = {}
        self._album_artist_cache: dict[UUID, set[UUID]] = {}
        self._track_artist_cache: dict[UUID, list[UUID]] = {}

    @classmethod
    def active_progress(cls, connection_id: str) -> dict[str, object] | None:
        return cls._progress.get(connection_id)

    def _publish_progress(
        self,
        connection: MusicConnection,
        state: SyncState,
        *,
        safe_error: str | None = None,
    ) -> None:
        public_status = {
            SyncStatus.PENDING.value: "READY",
            SyncStatus.RUNNING.value: "SYNCING",
            SyncStatus.COMPLETED.value: "SYNCED",
        }.get(state.status, state.status)
        self._progress[str(connection.id)] = {
            "status": public_status,
            "processed_items": state.processed_items,
            "total_items": state.total_items,
            "checkpoint": dict(state.checkpoint),
            "safe_error": safe_error,
        }

    def _prepare_caches(self) -> None:
        for entity_type, model in (
            (EntityType.ALBUM, Album),
            (EntityType.ARTIST, Artist),
            (EntityType.PLAYLIST, Playlist),
            (EntityType.TRACK, Track),
        ):
            rows = self.session.execute(
                select(ExternalIdentity.provider_id, model)
                .join(model, model.id == ExternalIdentity.entity_id)
                .where(
                    ExternalIdentity.provider == "netease",
                    ExternalIdentity.entity_type == entity_type.value,
                )
            )
            for provider_id, entity in rows:
                self._identity_cache[(entity_type, provider_id)] = entity
        for album_id, artist_id in self.session.execute(
            select(AlbumArtist.album_id, AlbumArtist.artist_id)
        ):
            self._album_artist_cache.setdefault(album_id, set()).add(artist_id)
        for track_id, artist_id in self.session.execute(
            select(TrackArtist.track_id, TrackArtist.artist_id).order_by(
                TrackArtist.track_id, TrackArtist.position
            )
        ):
            self._track_artist_cache.setdefault(track_id, []).append(artist_id)

    def _sync_state(self, connection: MusicConnection) -> SyncState:
        state = self.session.scalar(
            select(SyncState).where(SyncState.connection_id == connection.id, SyncState.scope == "library")
        )
        if state is None:
            state = SyncState(connection_id=connection.id, scope="library")
            self.session.add(state)
            self.session.flush()
        return state

    async def sync(self, connection: MusicConnection) -> SyncResult:
        state = self._sync_state(connection)
        state.status = SyncStatus.RUNNING.value
        state.processed_items = 0
        state.total_items = None
        state.last_error_code = None
        state.last_error_message = None
        state.started_at = utc_now()
        state.completed_at = None
        state.checkpoint = {"stage": "playlists", "playlists_processed": 0}
        self.session.flush()
        self._publish_progress(connection, state)

        total_started = perf_counter()
        timings: dict[str, int] = {}
        partial_failures = 0
        try:
            cookie = MusicConnectionService(self.session, cipher=self.cipher).decrypt_session(connection)
            provider = self.provider_factory(cookie)
            self._prepare_caches()

            started = perf_counter()
            playlists: list[ProviderPlaylist] = []
            cursor: str | None = None
            while True:
                page = await provider.list_playlists(cursor)
                playlists.extend(page.items)
                cursor = page.next_cursor
                if cursor is None:
                    break
            timings["playlist_retrieval"] = round((perf_counter() - started) * 1000)

            canonical_playlists: dict[str, Playlist] = {}
            for item in playlists:
                canonical_playlists[item.provider_id] = self._upsert_playlist(connection, item)
            self.session.flush()

            started = perf_counter()
            track_ids_by_playlist: dict[str, list[str]] = {}
            complete_playlists: set[str] = set()
            all_track_ids: list[str] = []
            for index, playlist in enumerate(playlists, start=1):
                try:
                    page = await provider.list_playlist_track_ids(playlist.provider_id)
                    track_ids_by_playlist[playlist.provider_id] = page.items
                    all_track_ids.extend(page.items)
                    if page.total is None or len(page.items) >= page.total:
                        complete_playlists.add(playlist.provider_id)
                    else:
                        partial_failures += 1
                    state.checkpoint = {
                        "stage": "track_ids",
                        "playlists_processed": index,
                        "playlists_total": len(playlists),
                        "track_memberships_found": len(all_track_ids),
                    }
                    self.session.flush()
                    self._publish_progress(connection, state)
                except ProviderAuthenticationExpired:
                    raise
                except ProviderError:
                    partial_failures += 1
            timings["track_id_retrieval"] = round((perf_counter() - started) * 1000)

            unique_track_ids = unique_in_order(all_track_ids)
            state.total_items = len(unique_track_ids)
            state.checkpoint = {
                "stage": "song_details",
                "tracks_processed": 0,
                "tracks_total": len(unique_track_ids),
            }
            self.session.flush()
            self._publish_progress(connection, state)

            started = perf_counter()
            semaphore = asyncio.Semaphore(self.concurrency)

            async def fetch_batch(batch_number: int, ids: list[str]) -> tuple[int, list[ProviderTrack]]:
                async with semaphore:
                    return batch_number, await provider.get_tracks(ids)

            tasks = [
                fetch_batch(number, list(ids))
                for number, ids in enumerate(batched(unique_track_ids, self.batch_size), start=1)
            ]
            provider_tracks: list[ProviderTrack] = []
            for completed in asyncio.as_completed(tasks):
                try:
                    _, tracks = await completed
                except ProviderAuthenticationExpired:
                    raise
                except ProviderError:
                    partial_failures += 1
                    continue
                provider_tracks.extend(tracks)
                state.processed_items += len(tracks)
                state.checkpoint = {
                    "stage": "song_details",
                    "tracks_processed": state.processed_items,
                    "tracks_total": len(unique_track_ids),
                }
                self.session.flush()
                self._publish_progress(connection, state)
            timings["song_detail_retrieval"] = round((perf_counter() - started) * 1000)

            started = perf_counter()
            canonical_tracks: dict[str, Track] = {}
            for index, provider_track in enumerate(provider_tracks, start=1):
                canonical_tracks[provider_track.provider_id] = self._upsert_track(provider_track)
                if index % 100 == 0 or index == len(provider_tracks):
                    state.checkpoint = {
                        "stage": "database_reconciliation",
                        "tracks_processed": index,
                        "tracks_total": len(provider_tracks),
                    }
                    self._publish_progress(connection, state)
            self.session.flush()

            for provider_playlist_id, provider_track_ids in track_ids_by_playlist.items():
                playlist = canonical_playlists[provider_playlist_id]
                resolved_ids = [
                    canonical_tracks[provider_id].id
                    for provider_id in provider_track_ids
                    if provider_id in canonical_tracks
                ]
                is_complete = provider_playlist_id in complete_playlists and len(resolved_ids) == len(
                    provider_track_ids
                )
                self._reconcile_playlist(playlist, resolved_ids, complete=is_complete)
                if not is_complete:
                    partial_failures += 1

            connection.last_sync_at = utc_now()
            timings["database_reconciliation"] = round((perf_counter() - started) * 1000)
            timings["total"] = round((perf_counter() - total_started) * 1000)
            state.status = SyncStatus.PARTIAL.value if partial_failures else SyncStatus.COMPLETED.value
            state.completed_at = utc_now()
            state.checkpoint = {
                "stage": "complete",
                "playlists_processed": len(playlists),
                "playlists_total": len(playlists),
                "tracks_processed": len(provider_tracks),
                "tracks_total": len(unique_track_ids),
                "track_memberships": len(all_track_ids),
                "timings_ms": timings,
                "partial_failures": partial_failures,
            }
            self.session.flush()
            self._publish_progress(connection, state)
            return self._result(connection, state, timings, partial_failures)
        except ProviderAuthenticationExpired:
            connection.status = "EXPIRED"
            state.status = SyncStatus.SESSION_EXPIRED.value
            state.completed_at = utc_now()
            state.last_error_code = "provider_session_expired"
            state.last_error_message = "Reconnect NetEase Cloud Music to continue synchronization."
            self.session.flush()
            self._publish_progress(connection, state, safe_error=state.last_error_message)
            raise
        except Exception:
            connection_id = connection.id
            self.session.rollback()
            connection = self.session.get(MusicConnection, connection_id)
            if connection is None:
                raise
            state = self._sync_state(connection)
            state.status = SyncStatus.FAILED.value
            state.completed_at = utc_now()
            state.last_error_code = "sync_failed"
            state.last_error_message = "Library synchronization failed safely. Existing data was preserved."
            self.session.flush()
            self._publish_progress(connection, state, safe_error=state.last_error_message)
            raise

    def _upsert_playlist(self, connection: MusicConnection, item: ProviderPlaylist) -> Playlist:
        cache_key = (EntityType.PLAYLIST, item.provider_id)
        entity = self._identity_cache.get(cache_key)
        if entity is None:
            entity = Playlist(name=item.name, owner_connection_id=connection.id)
            self.session.add(entity)
            self.session.flush()
            bind_external_identity(
                self.session,
                provider="netease",
                entity_type=EntityType.PLAYLIST,
                provider_id=item.provider_id,
                entity=entity,
                source_payload={"provider_update_time": item.metadata.get("provider_update_time")},
            )
            self._identity_cache[cache_key] = entity
        if not isinstance(entity, Playlist):
            raise RuntimeError("Playlist identity resolved to the wrong canonical type.")
        entity.owner_connection_id = connection.id
        entity.name = item.name
        entity.description = item.metadata.get("description") or None
        entity.artwork_url = item.artwork_url
        entity.track_count = item.track_count
        entity.metadata_json = dict(item.metadata)
        return entity

    def _upsert_artist(self, item: ProviderArtist) -> Artist:
        cache_key = (EntityType.ARTIST, item.provider_id)
        entity = self._identity_cache.get(cache_key)
        if entity is None:
            entity = Artist(name=item.name)
            self.session.add(entity)
            self.session.flush()
            bind_external_identity(
                self.session,
                provider="netease",
                entity_type=EntityType.ARTIST,
                provider_id=item.provider_id,
                entity=entity,
            )
            self._identity_cache[cache_key] = entity
        if not isinstance(entity, Artist):
            raise RuntimeError("Artist identity resolved to the wrong canonical type.")
        entity.name = item.name
        entity.artwork_url = item.artwork_url
        return entity

    def _upsert_album(self, item: ProviderAlbum) -> Album:
        cache_key = (EntityType.ALBUM, item.provider_id)
        entity = self._identity_cache.get(cache_key)
        if entity is None:
            entity = Album(title=item.title)
            self.session.add(entity)
            self.session.flush()
            bind_external_identity(
                self.session,
                provider="netease",
                entity_type=EntityType.ALBUM,
                provider_id=item.provider_id,
                entity=entity,
            )
            self._identity_cache[cache_key] = entity
        if not isinstance(entity, Album):
            raise RuntimeError("Album identity resolved to the wrong canonical type.")
        entity.title = item.title
        entity.artwork_url = item.artwork_url
        return entity

    def _upsert_track(self, item: ProviderTrack) -> Track:
        provider_artists = {artist.provider_id: artist for artist in item.artists}
        artists = [self._upsert_artist(artist) for artist in provider_artists.values()]
        album = self._upsert_album(item.album) if item.album else None
        cache_key = (EntityType.TRACK, item.provider_id)
        entity = self._identity_cache.get(cache_key)
        if entity is None:
            entity = Track(title=item.title)
            self.session.add(entity)
            self.session.flush()
            bind_external_identity(
                self.session,
                provider="netease",
                entity_type=EntityType.TRACK,
                provider_id=item.provider_id,
                entity=entity,
            )
            self._identity_cache[cache_key] = entity
        if not isinstance(entity, Track):
            raise RuntimeError("Track identity resolved to the wrong canonical type.")
        entity.title = item.title
        entity.duration_ms = item.duration_ms
        entity.album_id = album.id if album else None
        entity.artwork_url = item.artwork_url or (album.artwork_url if album else None)
        artist_ids = [artist.id for artist in artists]
        if self._track_artist_cache.get(entity.id, []) != artist_ids:
            self.session.execute(delete(TrackArtist).where(TrackArtist.track_id == entity.id))
            for position, artist in enumerate(artists):
                self.session.add(TrackArtist(track_id=entity.id, artist_id=artist.id, position=position))
            self._track_artist_cache[entity.id] = artist_ids
        if album:
            existing_album_artists = self._album_artist_cache.setdefault(album.id, set())
            next_position = len(existing_album_artists)
            for artist in artists:
                if artist.id not in existing_album_artists:
                    self.session.add(
                        AlbumArtist(
                            album_id=album.id,
                            artist_id=artist.id,
                            position=next_position,
                        )
                    )
                    existing_album_artists.add(artist.id)
                    next_position += 1
        return entity

    def _reconcile_playlist(self, playlist: Playlist, track_ids: list[object], *, complete: bool) -> None:
        existing = list(
            self.session.scalars(
                select(PlaylistTrack)
                .where(PlaylistTrack.playlist_id == playlist.id)
                .order_by(PlaylistTrack.position)
            )
        )
        if complete:
            if [item.track_id for item in existing] == track_ids:
                return
            self.session.execute(delete(PlaylistTrack).where(PlaylistTrack.playlist_id == playlist.id))
            self.session.flush()
            for position, track_id in enumerate(track_ids):
                self.session.add(PlaylistTrack(playlist_id=playlist.id, track_id=track_id, position=position))
            return
        existing_ids = {item.track_id for item in existing}
        next_position = max((item.position for item in existing), default=-1) + 1
        for track_id in track_ids:
            if track_id not in existing_ids:
                self.session.add(
                    PlaylistTrack(
                        playlist_id=playlist.id,
                        track_id=track_id,
                        position=next_position,
                    )
                )
                next_position += 1

    def _result(
        self,
        connection: MusicConnection,
        state: SyncState,
        timings: dict[str, int],
        partial_failures: int,
    ) -> SyncResult:
        playlist_ids = select(Playlist.id).where(Playlist.owner_connection_id == connection.id)
        track_ids = select(PlaylistTrack.track_id).where(PlaylistTrack.playlist_id.in_(playlist_ids))
        artist_ids = select(TrackArtist.artist_id).where(TrackArtist.track_id.in_(track_ids))
        album_ids = select(Track.album_id).where(Track.id.in_(track_ids), Track.album_id.is_not(None))
        playlists = (
            self.session.scalar(
                select(func.count())
                .select_from(Playlist)
                .where(Playlist.owner_connection_id == connection.id)
            )
            or 0
        )
        tracks = (
            self.session.scalar(select(func.count(func.distinct(Track.id))).where(Track.id.in_(track_ids)))
            or 0
        )
        artists = (
            self.session.scalar(select(func.count(func.distinct(Artist.id))).where(Artist.id.in_(artist_ids)))
            or 0
        )
        albums = (
            self.session.scalar(select(func.count(func.distinct(Album.id))).where(Album.id.in_(album_ids)))
            or 0
        )
        artwork = (
            self.session.scalar(
                select(func.count(func.distinct(Track.id))).where(
                    Track.id.in_(track_ids), Track.artwork_url.is_not(None)
                )
            )
            or 0
        )
        memberships = (
            self.session.scalar(
                select(func.count())
                .select_from(PlaylistTrack)
                .where(PlaylistTrack.playlist_id.in_(playlist_ids))
            )
            or 0
        )
        return SyncResult(
            state.status, playlists, memberships, tracks, artists, albums, artwork, timings, partial_failures
        )
