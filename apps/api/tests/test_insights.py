from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
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
from app.main import app
from app.services.insights import (
    UNIVERSE_EDGE_CAP,
    UNIVERSE_EDGES_PER_NODE,
    UNIVERSE_NODE_CAP,
    InsightsService,
)
from app.services.recommendation_engine import RecommendationEngine
from app.services.recommendation_profile import RecommendationProfileService


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def add_insights_library(db: Session, prefix: str) -> User:
    user = User(display_name=f"{prefix} user")
    db.add(user)
    db.flush()
    connection = MusicConnection(
        user_id=user.id,
        provider="netease",
        provider_user_id=f"{prefix}-provider",
        status="CONNECTED",
        last_sync_at=datetime.now(UTC),
    )
    db.add(connection)
    db.flush()
    playlists = [
        Playlist(owner_connection_id=connection.id, name=f"{prefix} primary"),
        Playlist(owner_connection_id=connection.id, name=f"{prefix} overlap"),
    ]
    db.add_all(playlists)
    db.flush()
    artists = [Artist(name=f"{prefix} artist {index}") for index in range(3)]
    albums = [Album(title=f"{prefix} album {index}") for index in range(3)]
    db.add_all([*artists, *albums])
    db.flush()
    tracks = [
        Track(title=f"{prefix} track {index}", album_id=albums[index].id, metadata_json={})
        for index in range(3)
    ]
    db.add_all(tracks)
    db.flush()
    db.add_all(
        [
            AlbumArtist(album_id=albums[index].id, artist_id=artists[index].id, position=0)
            for index in range(3)
        ]
    )
    db.add_all(
        [
            TrackArtist(track_id=tracks[0].id, artist_id=artists[0].id, position=0),
            TrackArtist(track_id=tracks[1].id, artist_id=artists[0].id, position=0),
            TrackArtist(track_id=tracks[1].id, artist_id=artists[1].id, position=1),
            TrackArtist(track_id=tracks[2].id, artist_id=artists[2].id, position=0),
            PlaylistTrack(playlist_id=playlists[0].id, track_id=tracks[0].id, position=0),
            PlaylistTrack(playlist_id=playlists[0].id, track_id=tracks[1].id, position=1),
            PlaylistTrack(playlist_id=playlists[0].id, track_id=tracks[2].id, position=2),
            PlaylistTrack(playlist_id=playlists[1].id, track_id=tracks[1].id, position=0),
            PlaylistTrack(playlist_id=playlists[1].id, track_id=tracks[2].id, position=1),
        ]
    )
    db.commit()
    return user


def test_overview_is_truthful_reproducible_and_reports_missing_genre_data(db: Session) -> None:
    user = add_insights_library(db, "truth")
    RecommendationProfileService(db).rebuild(user)
    db.commit()
    profile = RecommendationProfileService(db).get_current(user)
    assert profile is not None

    result = InsightsService(db, user=user, profile=profile).overview()

    assert result.counts.model_dump() == {"tracks": 3, "artists": 3, "albums": 3, "playlists": 2}
    assert result.collaboration.multi_artist_tracks == 1
    assert result.collaboration.multi_artist_track_share == pytest.approx(1 / 3, abs=1e-6)
    assert result.concentration.top_10_track_share == 1
    assert result.concentration.median_tracks_per_artist == 1
    assert [bucket.artist_count for bucket in result.concentration.long_tail] == [2, 1, 0, 0, 0]
    assert result.genre_coverage.reliable_track_count == 0
    assert result.genre_coverage.missing_track_count == 3
    assert result.genre_coverage.sufficient_for_primary_insight is False
    assert all("listen" not in metric.formula.casefold() for metric in result.profile_metrics)


def test_playlist_jaccard_uniqueness_and_canonical_deduplication(db: Session) -> None:
    user = add_insights_library(db, "playlist")
    profile = RecommendationProfileService(db).get(user)
    result = InsightsService(db, user=user, profile=profile).playlists()

    assert len(result.playlists) == 2
    assert result.strongest_overlaps[0].shared_track_count == 2
    assert result.strongest_overlaps[0].jaccard_similarity == pytest.approx(2 / 3, abs=1e-6)
    primary = next(item for item in result.playlists if item.track_count == 3)
    overlap = next(item for item in result.playlists if item.track_count == 2)
    assert primary.unique_library_coverage == pytest.approx(1 / 3, abs=1e-6)
    assert overlap.unique_library_coverage == 0
    assert primary.multi_artist_track_count == 1


def test_universe_is_bounded_deterministic_explainable_and_has_no_dangling_edges(
    db: Session,
) -> None:
    user = add_insights_library(db, "graph")
    RecommendationProfileService(db).rebuild(user)
    db.commit()
    profile = RecommendationProfileService(db).get_current(user)
    assert profile is not None
    service = InsightsService(db, user=user, profile=profile)

    first = service.universe()
    second = service.universe()

    first_payload = first.model_dump(exclude={"timings_ms"})
    second_payload = second.model_dump(exclude={"timings_ms"})
    assert first_payload == second_payload
    assert len(first.nodes) <= UNIVERSE_NODE_CAP
    assert len(first.edges) <= UNIVERSE_EDGE_CAP
    node_ids = {node.id for node in first.nodes}
    pairs: set[frozenset[str]] = set()
    degree: dict[str, int] = {}
    for edge in first.edges:
        assert edge.source in node_ids and edge.target in node_ids
        pair = frozenset((edge.source, edge.target))
        assert pair not in pairs
        pairs.add(pair)
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1
        assert edge.shared_playlist_count or edge.collaboration_track_count
    assert max(degree.values(), default=0) <= UNIVERSE_EDGES_PER_NODE


def test_empty_and_single_user_scoping_do_not_leak(db: Session) -> None:
    first = add_insights_library(db, "first")
    second = User(display_name="empty")
    db.add(second)
    db.commit()

    first_result = InsightsService(db, user=first, profile=None).overview()
    second_result = InsightsService(db, user=second, profile=None).overview()

    assert first_result.counts.tracks == 3
    assert second_result.counts.tracks == 0
    assert second_result.counts.playlists == 0
    assert second_result.profile_state == "missing_or_stale"
    assert InsightsService(db, user=second, profile=None).universe().nodes == []


def test_insights_api_reuses_profile_and_enforces_header_user_scope() -> None:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        first = add_insights_library(session, "api-first")
        second = add_insights_library(session, "api-second")
        RecommendationProfileService(session).rebuild(first)
        RecommendationProfileService(session).rebuild(second)
        first_profile = RecommendationProfileService(session).get_current(first)
        second_profile = RecommendationProfileService(session).get_current(second)
        assert first_profile is not None and second_profile is not None
        RecommendationEngine(session, user=first, profile=first_profile).materialize_internal()
        RecommendationEngine(session, user=second, profile=second_profile).materialize_internal()
        session.commit()
        first_id, second_id = str(first.id), str(second.id)

    def override_database():  # type: ignore[no-untyped-def]
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = override_database
    client = TestClient(app)
    try:
        first = client.get("/api/v1/insights/overview", headers={"X-MusicScope-User-ID": first_id})
        second = client.get("/api/v1/insights/overview", headers={"X-MusicScope-User-ID": second_id})
        universe = client.get("/api/v1/insights/universe", headers={"X-MusicScope-User-ID": first_id})
        playlists = client.get("/api/v1/insights/playlists", headers={"X-MusicScope-User-ID": first_id})
        rediscovery = client.get(
            "/api/v1/insights/rediscovery", headers={"X-MusicScope-User-ID": first_id}
        )
        assert first.status_code == second.status_code == 200
        assert first.json()["counts"] == second.json()["counts"]
        assert universe.status_code == playlists.status_code == rediscovery.status_code == 200
        assert universe.json()["profile_state"] == "current"
        assert playlists.json()["strongest_overlaps"]
        assert rediscovery.json()["items"]
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
