from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes import library
from app.core.database import Base
from app.domain.models import Album, AlbumArtist, Artist, Playlist, Track, TrackArtist


def make_library(db: Session) -> dict[str, object]:
    milet = Artist(name="milet", artwork_url="https://p1.music.126.net/milet.jpg")
    yoasobi = Artist(name="YOASOBI")
    japanese = Artist(name="宇多田ヒカル")
    album = Album(title="milet Live Album", artwork_url="https://p1.music.126.net/album.jpg")
    playlist = Playlist(name="milet favorites", track_count=1)
    track = Track(title="milet song", album_id=None, artwork_url="https://p1.music.126.net/track.jpg")
    non_latin_track = Track(title="夜に駆ける")
    db.add_all([milet, yoasobi, japanese, album, playlist, track, non_latin_track])
    db.flush()
    track.album_id = album.id
    db.add_all(
        [
            TrackArtist(track_id=track.id, artist_id=milet.id, position=0),
            TrackArtist(track_id=non_latin_track.id, artist_id=yoasobi.id, position=0),
            AlbumArtist(album_id=album.id, artist_id=milet.id, position=0),
        ]
    )
    for index in range(6):
        db.add(Track(title=f"Milestone {index:02}"))
    db.flush()
    return {"milet": milet, "album": album, "playlist": playlist, "track": track}


def flatten_ids(result: object) -> list[str]:
    return [
        *[item.track.id for item in result.tracks],
        *[item.artist.id for item in result.artists],
        *[item.album.id for item in result.albums],
        *[item.playlist.id for item in result.playlists],
    ]


def test_search_matching_ranking_metadata_and_unified_entities() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        entities = make_library(db)
        exact = library.search_library(db, "  MILET  ", None, None, 20)
        prefix = library.search_library(db, "mil", None, None, 20)
        substring = library.search_library(db, "LET", None, None, 20)
        case_insensitive = library.search_library(db, "yoas", None, None, 20)
        non_latin = library.search_library(db, "夜", None, None, 20)
        artists_only = library.search_library(db, "milet", "artist", None, 20)
        empty = library.search_library(db, "   ", None, None, 20)

        assert exact.query == "MILET"
        assert exact.artists[0].match == "exact"
        assert exact.artists[0].library_track_count == 1
        assert exact.tracks[0].track.album == "milet Live Album"
        assert exact.tracks[0].track.artist_items[0].name == "milet"
        assert {
            item.entity_type for item in [*exact.tracks, *exact.artists, *exact.albums, *exact.playlists]
        } == {
            "track",
            "artist",
            "album",
            "playlist",
        }
        assert all(
            item.match == "prefix"
            for item in [*prefix.tracks, *prefix.artists, *prefix.albums, *prefix.playlists]
        )
        assert substring.total >= 4 and all(
            item.match == "substring"
            for item in [*substring.tracks, *substring.artists, *substring.albums, *substring.playlists]
        )
        assert case_insensitive.artists[0].artist.name == "YOASOBI"
        assert non_latin.tracks[0].track.title == "夜に駆ける"
        assert artists_only.total == 1 and artists_only.artists[0].artist.id == str(entities["milet"].id)
        assert not artists_only.tracks and not artists_only.albums and not artists_only.playlists
        assert empty.total == 0 and empty.query == ""
    engine.dispose()


def test_search_paginates_after_stable_global_ranking() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        make_library(db)
        first = library.search_library(db, "mile", None, None, 3)
        second = library.search_library(db, "mile", None, first.next_cursor, 3)
        repeated = library.search_library(db, "mile", None, None, 3)

        assert first.total > 3
        assert first.range_start == 1 and first.range_end == 3
        assert second.range_start == 4 and second.previous_cursor == "0"
        assert set(flatten_ids(first)).isdisjoint(flatten_ids(second))
        assert flatten_ids(first) == flatten_ids(repeated)
    engine.dispose()
