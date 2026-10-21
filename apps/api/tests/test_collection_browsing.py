from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes import catalog
from app.core.database import Base
from app.domain.models import (
    Album,
    AlbumArtist,
    Artist,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    Track,
    TrackArtist,
    User,
)
from app.services.library_queries import offset_from_cursor
from app.services.library_scope import default_liked_collection


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def account(db, name="current", **kwargs):
    user = db.query(User).first() or User()
    db.add(user)
    db.flush()
    connection = MusicConnection(
        user_id=user.id,
        provider="netease",
        provider_user_id=name,
        status="CONNECTED",
        metadata_json={"nickname": name},
        **kwargs,
    )
    db.add(connection)
    db.flush()
    return connection


def playlist(db, connection, name="Liked", **metadata):
    row = Playlist(name=name, owner_connection_id=connection.id, metadata_json=metadata)
    db.add(row)
    db.flush()
    return row


def test_default_uses_active_connection_and_creator_not_arbitrary_special_playlist(db):
    old = account(db, "old", updated_at=datetime.now(UTC) - timedelta(days=1))
    current = account(db)
    playlist(db, old, special_type=5, creator_user_id="old")
    playlist(db, current, special_type=5, creator_user_id="someone-else", subscribed=True)
    own = playlist(db, current, special_type=5, creator_user_id="current")
    result = default_liked_collection(db)
    assert result.playlist_id == str(own.id)
    assert result.connection_id == str(current.id)


def test_default_is_honest_for_missing_ambiguous_and_disconnected(db):
    assert default_liked_collection(db).status == "no_connection"
    c = account(db)
    playlist(db, c, name="Anything 喜欢", subscribed=False)
    assert default_liked_collection(db).status == "missing"
    playlist(db, c, special_type=5, creator_user_id="current")
    playlist(db, c, special_type=5, creator_user_id="current")
    assert default_liked_collection(db).status == "ambiguous"
    assert default_liked_collection(db).playlist_id is None


def test_default_exact_legacy_name_only_when_type_missing(db):
    c = account(db)
    own = playlist(db, c, name="current喜欢的音乐", subscribed=False)
    assert default_liked_collection(db).playlist_id == str(own.id)
    own.metadata_json = {"special_type": 0, "subscribed": False}
    assert default_liked_collection(db).status == "missing"


def test_collection_search_before_pagination_and_preserves_positions(db):
    c = account(db)
    p = playlist(db, c, subscribed=False)
    other = playlist(db, c, subscribed=False)
    album = Album(title="Synced album")
    db.add(album)
    db.flush()
    tracks = [Track(title=f"Song {i:03}", album_id=album.id) for i in range(65)]
    db.add_all(tracks)
    db.flush()
    for i, track in enumerate(tracks):
        db.add(PlaylistTrack(playlist_id=p.id, track_id=track.id, position=i + 1))
    outside = Track(title="Only outside")
    same_title = Track(title="Song 060")
    db.add_all([outside, same_title])
    db.flush()
    db.add_all(
        [
            PlaylistTrack(playlist_id=other.id, track_id=outside.id, position=1),
            PlaylistTrack(playlist_id=other.id, track_id=same_title.id, position=2),
        ]
    )
    db.flush()
    result = catalog.playlist_tracks(p.id, db, limit=50, scope="personal", q="Song 060")
    assert result.total == 1
    assert result.items[0].playlist_position == 61
    assert catalog.playlist_tracks(p.id, db, limit=50, scope="personal", q="Only outside").total == 0
    first = catalog.playlist_tracks(p.id, db, limit=50, scope="personal", q="Song")
    last = catalog.playlist_tracks(p.id, db, cursor=first.next_cursor, limit=50, scope="personal", q="Song")
    assert first.total == 65 and len(last.items) == 15
    assert catalog.album_tracks(album.id, db, limit=50, scope="personal", q="060").total == 1
    assert catalog.playlist_tracks(p.id, db, limit=50, scope="personal").items[0].playlist_position == 1


@pytest.mark.parametrize("query", ["%", "_", "\\", "中文"])
def test_search_literals_and_multiple_artists_do_not_duplicate(db, query):
    c = account(db)
    p = playlist(db, c, subscribed=False)
    a, b = Artist(name=f"艺人{query}"), Artist(name=f"合作{query}")
    track, unrelated = Track(title="Song"), Track(title="Other")
    db.add_all([a, b, track, unrelated])
    db.flush()
    db.add_all(
        [
            PlaylistTrack(playlist_id=p.id, track_id=track.id, position=8),
            PlaylistTrack(playlist_id=p.id, track_id=unrelated.id, position=9),
            TrackArtist(track_id=track.id, artist_id=a.id, position=0),
            TrackArtist(track_id=track.id, artist_id=b.id, position=1),
        ]
    )
    db.flush()
    result = catalog.playlist_tracks(p.id, db, limit=50, scope="personal", q=query)
    assert result.total == 1
    assert [item.id for item in result.items] == [str(track.id)]
    assert result.items[0].playlist_position == 8


def test_personal_album_search_rejects_albums_outside_account_scope(db):
    account(db)
    album = Album(title="Other account album")
    db.add(album)
    db.flush()
    db.add(Track(title="Known title", album_id=album.id))
    db.flush()
    with pytest.raises(HTTPException) as exc:
        catalog.album_tracks(album.id, db, limit=50, scope="personal", q="Known")
    assert exc.value.status_code == 404


def test_personal_album_deep_link_keeps_synced_subscribed_playlist_tracks(db):
    c = account(db)
    p = playlist(db, c, subscribed=True, creator_user_id="another-creator")
    album = Album(title="Album linked from an existing track")
    db.add(album)
    db.flush()
    track = Track(title="Existing song", album_id=album.id)
    db.add(track)
    db.flush()
    db.add(PlaylistTrack(playlist_id=p.id, track_id=track.id, position=1))
    db.flush()
    assert catalog.album_tracks(album.id, db, limit=50, scope="personal", q="Existing").total == 1


def test_personal_playlist_accepts_numeric_provider_creator_ids(db):
    c = account(db, "12345")
    p = playlist(db, c, creator_user_id=12345, special_type=5)
    assert default_liked_collection(db).playlist_id == str(p.id)
    assert catalog.playlist_detail(p.id, db, scope="personal").id == str(p.id)


def test_saved_album_details_show_its_artists_without_liked_tracks(db):
    from app.domain.models import SavedAlbum

    c = account(db)
    album, artist = Album(title="Saved"), Artist(name="Album artist")
    db.add_all([album, artist])
    db.flush()
    db.add_all([SavedAlbum(connection_id=c.id, album_id=album.id),
                AlbumArtist(album_id=album.id, artist_id=artist.id, position=0)])
    db.flush()
    detail = catalog.album_detail(album.id, db, scope="personal")
    assert [item.name for item in detail.artists] == [artist.name]


@pytest.mark.parametrize("cursor", [str(2**63), "9" * 400, "-1", "invalid"])
def test_out_of_range_cursors_cannot_overflow_database_offsets(db, cursor):
    c = account(db)
    p = playlist(db, c, subscribed=False)
    assert offset_from_cursor(cursor) == 0
    assert catalog.playlist_tracks(p.id, db, scope="personal", cursor=cursor, limit=50).total == 0
