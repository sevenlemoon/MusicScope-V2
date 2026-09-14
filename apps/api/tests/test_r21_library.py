import asyncio
import base64
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.api.routes import catalog, library
from app.core.config import Settings
from app.core.database import Base
from app.core.secrets import ProviderSecretCipher
from app.domain.enums import ConnectionStatus, EntityType
from app.domain.models import (
    Album,
    AlbumArtist,
    Artist,
    AudioAsset,
    MusicConnection,
    MusicConnectionSecret,
    Playlist,
    PlaylistTrack,
    StemJob,
    Track,
    TrackArtist,
    User,
)
from app.providers.errors import ProviderAuthenticationExpired, ProviderPlaybackUnavailable
from app.providers.types import ProviderArtist, ProviderPlaybackSource
from app.services.artist_enrichment import ArtistEnrichmentService
from app.services.identity_resolution import bind_external_identity
from app.services.playback import PlaybackService


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def cipher() -> ProviderSecretCipher:
    key = base64.urlsafe_b64encode(b"p" * 32).decode()
    return ProviderSecretCipher(Settings(_env_file=None, secret_encryption_key=key))


def connected_user(db: Session) -> MusicConnection:
    user = User()
    db.add(user)
    db.flush()
    connection = MusicConnection(
        user_id=user.id,
        provider="netease",
        provider_user_id="listener",
        status=ConnectionStatus.CONNECTED.value,
    )
    db.add(connection)
    db.flush()
    db.add(
        MusicConnectionSecret(
            connection_id=connection.id,
            encrypted_session=cipher().encrypt(
                {"cookie": "test-session"}, context=f"music-connection:{connection.id}"
            ),
            key_version=1,
        )
    )
    db.flush()
    return connection


def test_global_sort_group_and_pagination_put_non_latin_last(db: Session) -> None:
    for name in ("Beta", " alpha ", "Ado", "#KTCHAN", "中文艺人"):
        db.add(Artist(name=name))
    db.flush()

    first = library.artists(db, cursor=None, limit=2, sort="asc", group=None)
    second = library.artists(db, cursor=first.next_cursor, limit=2, sort="asc", group=None)
    final = library.artists(db, cursor=second.next_cursor, limit=2, sort="asc", group=None)
    descending = library.artists(db, cursor=None, limit=10, sort="desc", group=None)
    other = library.artists(db, cursor=None, limit=10, sort="asc", group="#")

    assert [item.name.strip() for item in first.items] == ["Ado", "alpha"]
    assert [item.name.strip() for item in second.items] == ["Beta", "#KTCHAN"]
    assert [item.name.strip() for item in final.items] == ["中文艺人"]
    assert [item.name.strip() for item in descending.items][:3] == ["Beta", "alpha", "Ado"]
    assert [item.name for item in descending.items][-2:] == ["中文艺人", "#KTCHAN"]
    assert {item.sort_group for item in other.items} == {"#"}
    assert [group.key for group in first.groups] == ["A", "B", "#"]
    assert first.range_start == 1 and first.range_end == 2
    assert second.previous_cursor == "0"


def test_detail_queries_use_canonical_multi_artist_relationships_and_playlist_order(
    db: Session,
) -> None:
    artist_a = Artist(name="Artist A")
    artist_b = Artist(name="Artist B")
    album = Album(title="Album A")
    playlist = Playlist(name="Large list", track_count=120)
    db.add_all([artist_a, artist_b, album, playlist])
    db.flush()
    db.add_all(
        [
            AlbumArtist(album_id=album.id, artist_id=artist_a.id, position=0),
            AlbumArtist(album_id=album.id, artist_id=artist_b.id, position=1),
        ]
    )
    tracks = []
    for index in range(120):
        track = Track(title=f"Track {119 - index:03}", album_id=album.id)
        db.add(track)
        db.flush()
        tracks.append(track)
        db.add(TrackArtist(track_id=track.id, artist_id=artist_a.id, position=0))
        if index == 0:
            db.add(TrackArtist(track_id=track.id, artist_id=artist_b.id, position=1))
        db.add(PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=index))
    db.flush()

    detail_a = catalog.artist_detail(artist_a.id, db)
    detail_b = catalog.artist_detail(artist_b.id, db)
    tracks_b = catalog.artist_tracks(artist_b.id, db, None, 50, "asc")
    album_detail = catalog.album_detail(album.id, db)
    playlist_detail = catalog.playlist_detail(playlist.id, db)
    original = catalog.playlist_tracks(playlist.id, db, None, 50, "original")
    second = catalog.playlist_tracks(playlist.id, db, original.next_cursor, 50, "original")
    alphabetical = catalog.playlist_tracks(playlist.id, db, None, 50, "asc")
    track_detail = catalog.track_detail(tracks[0].id, db)

    assert detail_a.library_track_count == 120
    assert detail_a.represented_album_count == 1
    assert detail_b.library_track_count == 1
    assert tracks_b.items[0].id == str(tracks[0].id)
    assert len(album_detail.artists) == 2 and album_detail.library_track_count == 120
    assert playlist_detail.synchronized_track_count == 120
    assert original.items[0].playlist_position == 0
    assert second.items[0].playlist_position == 50
    assert alphabetical.items[0].title == "Track 000"
    assert {artist.name for artist in track_detail.artists} == {"Artist A", "Artist B"}
    assert track_detail.album and track_detail.album.name == "Album A"
    assert track_detail.playlists[0].name == "Large list"


class PlaybackProvider:
    def __init__(self, outcome: str = "available") -> None:
        self.outcome = outcome

    async def resolve_playback_source(self, provider_id: str) -> ProviderPlaybackSource:
        if self.outcome == "expired":
            raise ProviderAuthenticationExpired("expired")
        if self.outcome == "unavailable":
            raise ProviderPlaybackUnavailable("unavailable")
        return ProviderPlaybackSource(
            provider="netease",
            url=f"https://example.invalid/audio/{provider_id}",
            mime_type="audio/mpeg",
            duration_ms=180_000,
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
            quality="standard",
        )


def test_playback_uses_authenticated_provider_result_and_stem_entry_is_honest(db: Session) -> None:
    connected_user(db)
    track = Track(title="VIP metadata but provider-authorized", metadata_json={"fee": 1})
    db.add(track)
    db.flush()
    bind_external_identity(
        db,
        provider="netease",
        entity_type=EntityType.TRACK,
        provider_id="123",
        entity=track,
    )
    service = PlaybackService(
        db,
        provider_factory=lambda cookie: PlaybackProvider(),
        cipher=cipher(),
    )

    result = asyncio.run(service.resolve(track.id))
    assert result.source.duration_ms == 180_000
    assert result.source.quality == "standard"
    entry = catalog.stem_entry(track.id, db)
    assert entry.status == "LOCAL_UPLOAD_REQUIRED"
    assert db.scalar(select(func.count()).select_from(AudioAsset)) == 0
    assert db.scalar(select(func.count()).select_from(StemJob)) == 0

    for outcome, error in (
        ("unavailable", ProviderPlaybackUnavailable),
        ("expired", ProviderAuthenticationExpired),
    ):
        failing = PlaybackService(
            db,
            provider_factory=lambda cookie, value=outcome: PlaybackProvider(value),
            cipher=cipher(),
        )
        with pytest.raises(error):
            asyncio.run(failing.resolve(track.id))


class ArtistProvider:
    def __init__(self, *, fail: set[str] | None = None) -> None:
        self.fail = fail or set()
        self.requests: list[str] = []

    async def get_artists(self, provider_ids: list[str]) -> list[ProviderArtist]:
        provider_id = provider_ids[0]
        self.requests.append(provider_id)
        if provider_id in self.fail:
            raise ProviderPlaybackUnavailable("temporary failure")
        artwork = f"https://p1.music.126.net/{provider_id}.jpg" if provider_id != "missing" else None
        return [ProviderArtist(provider_id, f"Artist {provider_id}", artwork)]


def test_artist_enrichment_is_idempotent_and_partial_failure_tolerant(db: Session) -> None:
    connected_user(db)
    artists = [
        Artist(name="Existing", artwork_url="https://p1.music.126.net/existing.jpg"),
        Artist(name="Needs artwork"),
        Artist(name="No provider artwork"),
    ]
    db.add_all(artists)
    db.flush()
    for artist, provider_id in zip(artists, ("existing", "enriched", "missing"), strict=True):
        bind_external_identity(
            db,
            provider="netease",
            entity_type=EntityType.ARTIST,
            provider_id=provider_id,
            entity=artist,
        )
    provider = ArtistProvider()
    service = ArtistEnrichmentService(
        db,
        provider_factory=lambda cookie: provider,
        cipher=cipher(),
        concurrency=2,
    )
    first = asyncio.run(service.enrich())
    second = asyncio.run(service.enrich())

    assert first.attempted == 2 and first.enriched == 1 and first.unavailable_artwork == 1
    assert first.artists_with_artwork == 2
    assert second.attempted == 1 and second.enriched == 0
    assert provider.requests.count("existing") == 0
    assert provider.requests.count("enriched") == 1

    failing = ArtistEnrichmentService(
        db,
        provider_factory=lambda cookie: ArtistProvider(fail={"missing"}),
        cipher=cipher(),
        concurrency=2,
    )
    partial = asyncio.run(failing.enrich())
    assert partial.failures == 1
