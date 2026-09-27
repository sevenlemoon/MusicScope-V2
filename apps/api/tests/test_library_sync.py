import asyncio
import base64

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.database import Base
from app.core.secrets import ProviderSecretCipher
from app.domain.enums import ConnectionStatus
from app.domain.models import (
    Album,
    Artist,
    ExternalIdentity,
    MusicConnection,
    MusicConnectionSecret,
    Playlist,
    PlaylistTrack,
    SavedAlbum,
    Track,
    TrackArtist,
    User,
)
from app.providers.errors import ProviderTemporarilyUnavailable
from app.providers.types import Page, ProviderAlbum, ProviderArtist, ProviderPlaylist, ProviderTrack
from app.services.library_sync import LibrarySyncService


def make_cipher() -> ProviderSecretCipher:
    key = base64.urlsafe_b64encode(b"s" * 32).decode()
    return ProviderSecretCipher(
        Settings(_env_file=None, secret_encryption_key=key, secret_encryption_key_version=1)
    )


class FakeLibraryProvider:
    def __init__(
        self,
        *,
        fail_track_id: str | None = None,
        reported_track_count_adjustment: int = 0,
    ) -> None:
        self.fail_track_id = fail_track_id
        self.reported_track_count_adjustment = reported_track_count_adjustment
        self.playlist_offsets: list[str | None] = []
        self.album_offsets: list[str | None] = []
        self.track_batches: list[list[str]] = []
        self.tracks = {
            "t1": self._track("t1", "One", ("a1", "a2", "a2"), "al1"),
            "t2": self._track("t2", "Two", ("a2",), "al1"),
            "t3": self._track("t3", "Three", ("a3",), "al2"),
        }

    @staticmethod
    def _track(track_id: str, title: str, artist_ids: tuple[str, ...], album_id: str) -> ProviderTrack:
        artists = tuple(
            ProviderArtist(value, f"Artist {value}", f"https://p1.music.126.net/{value}.jpg")
            for value in artist_ids
        )
        album = ProviderAlbum(
            album_id,
            f"Album {album_id}",
            artist_ids,
            f"https://p1.music.126.net/{album_id}.jpg",
        )
        return ProviderTrack(
            provider_id=track_id,
            title=title,
            duration_ms=180000,
            album_provider_id=album_id,
            artist_provider_ids=artist_ids,
            artwork_url=album.artwork_url,
            artists=artists,
            album=album,
        )

    async def get_profile(self) -> dict[str, object]:
        return {"provider_user_id": "u1", "nickname": "Listener", "avatar_url": None}

    async def list_playlists(self, cursor: str | None = None) -> Page[ProviderPlaylist]:
        self.playlist_offsets.append(cursor)
        if cursor is None:
            return Page([ProviderPlaylist("p1", "First", "https://p1.music.126.net/p1.jpg", 2)], "1")
        return Page([ProviderPlaylist("p2", "Second", None, 2)])

    async def list_playlist_track_ids(self, playlist_id: str, cursor: str | None = None) -> Page[str]:
        del cursor
        ids = ["t1", "t2"] if playlist_id == "p1" else ["t1", "t3"]
        return Page(ids, total=len(ids) + self.reported_track_count_adjustment)

    async def list_collected_albums(self, cursor: str | None = None) -> Page[ProviderAlbum]:
        self.album_offsets.append(cursor)
        return Page([ProviderAlbum("al1", "Album al1", (), "https://p1.music.126.net/al1.jpg")])

    async def get_tracks(self, provider_ids: list[str]) -> list[ProviderTrack]:
        self.track_batches.append(list(provider_ids))
        if self.fail_track_id and self.fail_track_id in provider_ids:
            raise ProviderTemporarilyUnavailable("batch failed")
        return [self.tracks[value] for value in provider_ids]


@pytest.fixture
def db_connection() -> tuple[Session, MusicConnection, ProviderSecretCipher]:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    cipher = make_cipher()
    with Session(engine) as session:
        user = User()
        session.add(user)
        session.flush()
        connection = MusicConnection(
            user_id=user.id,
            provider="netease",
            provider_user_id="u1",
            status=ConnectionStatus.CONNECTED.value,
        )
        session.add(connection)
        session.flush()
        session.add(
            MusicConnectionSecret(
                connection_id=connection.id,
                encrypted_session=cipher.encrypt(
                    {"cookie": "provider-session-sentinel"}, context=f"music-connection:{connection.id}"
                ),
                key_version=1,
            )
        )
        session.flush()
        yield session, connection, cipher


def counts(db: Session) -> tuple[int, int, int, int, int, int]:
    return tuple(
        db.scalar(select(func.count()).select_from(model)) or 0
        for model in (Playlist, Track, Artist, Album, ExternalIdentity, PlaylistTrack)
    )


def test_paginated_sync_is_batched_multi_artist_deduplicated_and_idempotent(
    db_connection: tuple[Session, MusicConnection, ProviderSecretCipher],
) -> None:
    db, connection, cipher = db_connection
    provider = FakeLibraryProvider()
    service = LibrarySyncService(
        db,
        provider_factory=lambda cookie: provider,
        cipher=cipher,
        batch_size=2,
        concurrency=2,
    )
    first = asyncio.run(service.sync(connection))
    first_counts = counts(db)
    second = asyncio.run(service.sync(connection))
    second_counts = counts(db)

    assert provider.playlist_offsets[:2] == [None, "1"]
    assert all(len(batch) <= 2 for batch in provider.track_batches)
    assert first.status == "COMPLETED"
    assert first.track_memberships == 4
    assert first.tracks == 3
    assert first.artists == 3
    assert first.albums == 2
    assert first_counts == second_counts
    assert second.tracks == 3
    assert db.scalar(select(func.count()).select_from(SavedAlbum)) == 1
    assert LibrarySyncService.active_progress(str(connection.id))["status"] == "SYNCED"
    assert (
        db.scalar(
            select(func.count())
            .select_from(TrackArtist)
            .where(
                TrackArtist.track_id
                == select(ExternalIdentity.entity_id)
                .where(ExternalIdentity.provider_id == "t1")
                .scalar_subquery()
            )
        )
        == 2
    )


def test_complete_track_ids_win_when_provider_reported_count_is_stale_lower(
    db_connection: tuple[Session, MusicConnection, ProviderSecretCipher],
) -> None:
    db, connection, cipher = db_connection
    provider = FakeLibraryProvider(reported_track_count_adjustment=-1)
    result = asyncio.run(
        LibrarySyncService(
            db,
            provider_factory=lambda cookie: provider,
            cipher=cipher,
            batch_size=2,
            concurrency=2,
        ).sync(connection)
    )

    assert result.status == "COMPLETED"
    assert result.partial_failures == 0
    assert result.track_memberships == 4


def test_partial_batch_failure_preserves_successful_data(
    db_connection: tuple[Session, MusicConnection, ProviderSecretCipher],
) -> None:
    db, connection, cipher = db_connection
    provider = FakeLibraryProvider(fail_track_id="t3")
    result = asyncio.run(
        LibrarySyncService(
            db, provider_factory=lambda cookie: provider, cipher=cipher, batch_size=1, concurrency=2
        ).sync(connection)
    )
    assert result.status == "PARTIAL"
    assert result.partial_failures > 0
    assert db.scalar(select(func.count()).select_from(Track)) == 2
    assert db.scalar(select(func.count()).select_from(PlaylistTrack)) >= 2


def test_collected_album_outage_preserves_last_good_snapshot(
    db_connection: tuple[Session, MusicConnection, ProviderSecretCipher],
) -> None:
    db, connection, cipher = db_connection
    provider = FakeLibraryProvider()
    service = LibrarySyncService(db, provider_factory=lambda _cookie: provider, cipher=cipher)
    assert asyncio.run(service.sync(connection)).status == "COMPLETED"
    saved_before = set(db.scalars(select(SavedAlbum.album_id)))

    async def unavailable(_cursor: str | None = None) -> Page[ProviderAlbum]:
        raise ProviderTemporarilyUnavailable("temporary provider outage")

    provider.list_collected_albums = unavailable  # type: ignore[method-assign]
    result = asyncio.run(service.sync(connection))
    assert result.status == "PARTIAL"
    assert set(db.scalars(select(SavedAlbum.album_id))) == saved_before


def test_collected_album_only_refresh_is_lightweight_and_reconciles_membership(
    db_connection: tuple[Session, MusicConnection, ProviderSecretCipher],
) -> None:
    db, connection, cipher = db_connection
    provider = FakeLibraryProvider()
    service = LibrarySyncService(db, provider_factory=lambda _cookie: provider, cipher=cipher)
    assert asyncio.run(service.sync_collected_albums_only(connection)) == 1
    assert provider.playlist_offsets == [] and provider.track_batches == []
    assert db.scalar(select(func.count()).select_from(SavedAlbum)) == 1
    assert db.scalar(select(func.count()).select_from(Track)) == 0

    async def empty(_cursor: str | None = None) -> Page[ProviderAlbum]:
        return Page([])

    provider.list_collected_albums = empty  # type: ignore[method-assign]
    assert asyncio.run(service.sync_collected_albums_only(connection)) == 0
    assert db.scalar(select(func.count()).select_from(SavedAlbum)) == 0
    assert db.scalar(select(func.count()).select_from(Album)) == 1
