from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.routes.recommendations import save_recommendation_feedback
from app.api.schemas import RecommendationFeedbackRequest
from app.core.database import Base, get_db
from app.domain.models import (
    Album,
    AlbumArtist,
    Artist,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    RecommendationFeedback,
    RecommendationProfile,
    RecommendationProfileArtist,
    RecommendationRelationship,
    Track,
    TrackArtist,
    User,
)
from app.main import app
from app.services.recommendation_engine import RankedCandidate, RecommendationEngine
from app.services.recommendation_profile import (
    MAX_PLAYLIST_ARTISTS_FOR_GRAPH,
    RecommendationProfileService,
    playlist_membership_weight,
)


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def add_library(db: Session, *, prefix: str, artist_count: int = 30) -> User:
    user = User(display_name=f"{prefix} Listener", exploration_level=50)
    db.add(user)
    db.flush()
    connection = MusicConnection(
        user_id=user.id,
        provider="netease",
        provider_user_id=f"{prefix}-provider-user",
        status="CONNECTED",
        last_sync_at=datetime.now(UTC),
    )
    db.add(connection)
    db.flush()
    playlist = Playlist(owner_connection_id=connection.id, name=f"{prefix} Focus")
    db.add(playlist)
    db.flush()
    artists: list[Artist] = []
    for index in range(artist_count):
        artist = Artist(name=f"{prefix} Artist {index:02}")
        album = Album(title=f"{prefix} Album {index:02}")
        track = Track(title=f"{prefix} Track {index:02}", album_id=album.id)
        db.add_all([artist, album])
        db.flush()
        track.album_id = album.id
        db.add(track)
        db.flush()
        db.add_all(
            [
                AlbumArtist(album_id=album.id, artist_id=artist.id, position=0),
                TrackArtist(track_id=track.id, artist_id=artist.id, position=0),
                PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=index),
            ]
        )
        artists.append(artist)
        if index == 0:
            second_playlist = Playlist(
                owner_connection_id=connection.id,
                name=f"{prefix} Repeat",
            )
            db.add(second_playlist)
            db.flush()
            db.add(PlaylistTrack(playlist_id=second_playlist.id, track_id=track.id, position=0))
        if index == 1:
            db.add(TrackArtist(track_id=track.id, artist_id=artists[0].id, position=1))
    db.flush()
    return user


def test_profile_normalizes_large_playlists_and_preserves_all_affinity_evidence(
    db: Session,
) -> None:
    user = add_library(db, prefix="Profile", artist_count=81)
    result = RecommendationProfileService(db).rebuild(user)

    assert playlist_membership_weight(20) == 1.0
    assert playlist_membership_weight(2_513) == pytest.approx(0.141055, rel=1e-5)
    assert result.artist_count == 81
    assert result.album_count == 81
    profile = db.get(RecommendationProfile, UUID(result.profile_id))
    assert profile is not None
    profile_artists = list(
        db.scalars(
            select(RecommendationProfileArtist).where(RecommendationProfileArtist.profile_id == profile.id)
        )
    )
    assert len(profile_artists) == 81
    graph_artist_ids = {
        artist_id
        for row in db.scalars(
            select(RecommendationRelationship).where(RecommendationRelationship.profile_id == profile.id)
        )
        for artist_id in (row.source_artist_id, row.target_artist_id)
    }
    assert len(graph_artist_ids) <= MAX_PLAYLIST_ARTISTS_FOR_GRAPH
    split_artist = max(profile_artists, key=lambda row: row.collaboration_tracks)
    assert split_artist.evidence["weighted_track_breadth"] < split_artist.distinct_tracks


def test_profile_rebuild_is_idempotent_and_user_scoped(db: Session) -> None:
    first_user = add_library(db, prefix="First", artist_count=6)
    second_user = add_library(db, prefix="Second", artist_count=4)
    service = RecommendationProfileService(db)
    first = service.rebuild(first_user)
    before = (
        first.artist_count,
        first.album_count,
        first.relationship_count,
    )
    second = service.rebuild(first_user)
    after = (
        second.artist_count,
        second.album_count,
        second.relationship_count,
    )
    service.rebuild(second_user)

    assert before == after
    assert db.scalar(select(func.count()).select_from(RecommendationProfile)) == 2
    first_names = set(
        db.scalars(
            select(Artist.name)
            .join(RecommendationProfileArtist, RecommendationProfileArtist.artist_id == Artist.id)
            .where(RecommendationProfileArtist.profile_id == UUID(first.profile_id))
        )
    )
    assert first_names and all(name.startswith("First") for name in first_names)


def test_candidates_are_truthful_evidence_bearing_diverse_and_exploration_changes_mix(
    db: Session,
) -> None:
    user = add_library(db, prefix="Engine", artist_count=32)
    RecommendationProfileService(db).rebuild(user)
    profile = RecommendationProfileService(db).get_current(user)
    assert profile is not None
    RecommendationEngine(db, user=user, profile=profile).materialize_internal()

    user.exploration_level = 0
    familiar = RecommendationEngine(db, user=user, profile=profile).generate(limit=20)
    user.exploration_level = 100
    exploratory = RecommendationEngine(db, user=user, profile=profile).generate(limit=20)
    rediscover = RecommendationEngine(db, user=user, profile=profile).generate(
        category="rediscover", limit=12
    )

    familiar_adjacent = sum(item.strategy == "ADJACENT_ARTIST" for item in familiar.items)
    exploratory_adjacent = sum(item.strategy == "ADJACENT_ARTIST" for item in exploratory.items)
    assert exploratory_adjacent > familiar_adjacent
    assert all(item.evidence and item.explanation for item in rediscover.items)
    assert all(item.is_in_library and item.source == "musicscope_library" for item in rediscover.items)
    assert rediscover.candidate_counts["external_discovery"] == 0
    identities = {(item.entity_type, item.canonical_entity_id) for item in familiar.items}
    assert len(identities) == len(familiar.items)

    raw_tracks = RecommendationEngine(db, user=user, profile=profile).generate(category="tracks", limit=20)
    candidates = [
        RankedCandidate(
            item=item,
            artist_ids=tuple(UUID(artist.id) for artist in (item.track.artist_items if item.track else [])),
            album_id=UUID(item.track.album_id) if item.track and item.track.album_id else None,
        )
        for item in raw_tracks.items
    ]
    diversified = RecommendationEngine._diversify(candidates, 20)
    artist_counts: dict[object, int] = {}
    for candidate in diversified:
        for artist_id in candidate.artist_ids:
            artist_counts[artist_id] = artist_counts.get(artist_id, 0) + 1
    assert max(artist_counts.values(), default=0) <= 2


def test_feedback_is_idempotent_user_owned_and_excludes_candidate(db: Session) -> None:
    user = add_library(db, prefix="Feedback", artist_count=28)
    RecommendationProfileService(db).rebuild(user)
    profile = RecommendationProfileService(db).get_current(user)
    assert profile is not None
    RecommendationEngine(db, user=user, profile=profile).materialize_internal()
    before = RecommendationEngine(db, user=user, profile=profile).generate(category="rediscover", limit=8)
    candidate = before.items[0]
    payload = RecommendationFeedbackRequest(
        entity_type=candidate.entity_type,
        canonical_entity_id=candidate.canonical_entity_id,
        strategy=candidate.strategy,
        feedback_type="NOT_INTERESTED",
    )
    save_recommendation_feedback(payload, db, user)
    save_recommendation_feedback(payload, db, user)

    assert db.scalar(select(func.count()).select_from(RecommendationFeedback)) == 1
    after = RecommendationEngine(db, user=user, profile=profile).generate(category="rediscover", limit=8)
    assert candidate.canonical_entity_id not in {item.canonical_entity_id for item in after.items}


def test_recommendation_api_rebuild_profile_home_discover_and_settings() -> None:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = add_library(session, prefix="API", artist_count=30)
        user_id = str(user.id)
        session.commit()

    def override_database():  # type: ignore[no-untyped-def]
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = override_database
    client = TestClient(app)
    headers = {"X-MusicScope-User-ID": user_id}
    try:
        assert client.get("/api/v1/recommendations/home", headers=headers).status_code == 409
        rebuilt = client.post("/api/v1/recommendations/profile/rebuild", headers=headers)
        assert rebuilt.status_code == 200
        profile = client.get("/api/v1/recommendations/profile", headers=headers)
        home = client.get("/api/v1/recommendations/home", headers=headers)
        discover = client.get("/api/v1/recommendations/discover?category=rediscover", headers=headers)
        settings = client.patch(
            "/api/v1/recommendations/settings",
            headers=headers,
            json={"exploration_level": 88},
        )
        assert profile.status_code == home.status_code == discover.status_code == 200
        assert profile.json()["artist_count"] == 30
        assert home.json()["made_for_you"]
        assert discover.json()["category"] == "rediscover"
        assert settings.json()["exploration_level"] == 88
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_materialized_reads_do_not_rebuild_profile_or_candidate_pools(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = add_library(db, prefix="Cached", artist_count=30)
    RecommendationProfileService(db).rebuild(user)
    profile = RecommendationProfileService(db).get_current(user)
    assert profile is not None
    RecommendationEngine(db, user=user, profile=profile).materialize_internal()

    def unexpected(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("normal recommendation reads must reuse materialization")

    monkeypatch.setattr(RecommendationProfileService, "rebuild", unexpected)
    monkeypatch.setattr(RecommendationEngine, "_track_candidates", unexpected)
    monkeypatch.setattr(RecommendationEngine, "_adjacent_candidates", unexpected)

    engine = RecommendationEngine(db, user=user, profile=profile)
    first = engine.generate(category="for-you", limit=20)
    second = engine.generate(category="rediscover", limit=10)

    assert first.items
    assert second.items
    assert first.timings_ms["candidate_generation"] >= 0
