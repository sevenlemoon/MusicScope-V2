import asyncio
from datetime import UTC, datetime

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.api.routes.recommendations import save_recommendation_feedback
from app.api.schemas import ProviderEntityIdentity, RecommendationFeedbackRequest
from app.core.database import Base
from app.domain.models import (
    Album,
    Artist,
    ExternalIdentity,
    LibraryItem,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    RecommendationCandidate,
    Track,
    TrackArtist,
    User,
)
from app.providers.types import ProviderAlbum, ProviderArtist, ProviderTrack
from app.services.external_discovery import MAX_CONCURRENCY, MAX_SEEDS, ExternalDiscoveryService
from app.services.recommendation_engine import RecommendationEngine
from app.services.recommendation_profile import RecommendationProfileService


def _library(db: Session, prefix: str, artist_count: int = 10) -> tuple[User, list[Artist], list[Track]]:
    user = User(display_name=prefix, exploration_level=50)
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
    playlist = Playlist(owner_connection_id=connection.id, name=f"{prefix} playlist")
    db.add(playlist)
    db.flush()
    artists: list[Artist] = []
    tracks: list[Track] = []
    for index in range(artist_count):
        artist = Artist(name=f"{prefix} artist {index}")
        album = Album(title=f"{prefix} album {index}")
        db.add_all([artist, album])
        db.flush()
        track = Track(title=f"Shared title {index}", album_id=album.id)
        db.add(track)
        db.flush()
        db.add_all(
            [
                TrackArtist(track_id=track.id, artist_id=artist.id, position=0),
                PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=index),
                ExternalIdentity(
                    provider="netease",
                    entity_type="artist",
                    entity_id=artist.id,
                    provider_id=f"{prefix}-artist-{index}",
                ),
                ExternalIdentity(
                    provider="netease",
                    entity_type="track",
                    entity_id=track.id,
                    provider_id=f"{prefix}-track-{index}",
                ),
            ]
        )
        artists.append(artist)
        tracks.append(track)
    db.flush()
    return user, artists, tracks


class FakeDiscoveryProvider:
    def __init__(self, tracks: list[ProviderTrack], *, fail_last: bool = False) -> None:
        self.tracks = tracks
        self.fail_last = fail_last
        self.calls = 0
        self.active = 0
        self.max_active = 0

    async def get_artist_tracks(self, provider_id: str, *, limit: int = 30) -> list[ProviderTrack]:
        self.calls += 1
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0)
        self.active -= 1
        if self.fail_last and provider_id.endswith("9"):
            raise TimeoutError("bounded provider failure")
        return self.tracks[:limit]


class FailingDiscoveryProvider:
    async def get_artist_tracks(self, provider_id: str, *, limit: int = 30) -> list[ProviderTrack]:
        raise TimeoutError("provider unavailable")


def test_external_discovery_is_user_scoped_bounded_and_does_not_pollute_library() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user, _, own_tracks = _library(db, "primary")
        other, _, other_tracks = _library(db, "other", artist_count=1)
        RecommendationProfileService(db).rebuild(user)
        profile = RecommendationProfileService(db).get_current(user)
        assert profile is not None
        RecommendationEngine(db, user=user, profile=profile).materialize_internal()

        primary_artist = ProviderArtist("external-artist-a", "External A", "https://example/a.jpg")
        collaborator = ProviderArtist("external-artist-b", "External B", "https://example/b.jpg")
        album = ProviderAlbum(
            "external-album",
            "External album",
            (primary_artist.provider_id, collaborator.provider_id),
            "https://example/album.jpg",
        )
        provider_tracks = [
            ProviderTrack(
                provider_id="primary-track-0",
                title="Already owned",
                duration_ms=180_000,
                album_provider_id=album.provider_id,
                artist_provider_ids=(primary_artist.provider_id,),
                artwork_url=album.artwork_url,
                artists=(primary_artist,),
                album=album,
            ),
            ProviderTrack(
                provider_id="other-track-0",
                title=other_tracks[0].title,
                duration_ms=190_000,
                album_provider_id=album.provider_id,
                artist_provider_ids=(primary_artist.provider_id,),
                artwork_url=album.artwork_url,
                artists=(primary_artist,),
                album=album,
            ),
            ProviderTrack(
                provider_id="same-title-different-provider-id",
                title=own_tracks[0].title,
                duration_ms=200_000,
                album_provider_id=album.provider_id,
                artist_provider_ids=(primary_artist.provider_id, collaborator.provider_id),
                artwork_url=album.artwork_url,
                artists=(primary_artist, collaborator),
                album=album,
            ),
        ]
        provider = FakeDiscoveryProvider(provider_tracks)
        before = tuple(
            db.scalar(select(func.count()).select_from(model))
            for model in (Playlist, PlaylistTrack, LibraryItem)
        )
        result = asyncio.run(
            ExternalDiscoveryService(db).refresh(user, profile, provider=provider)  # type: ignore[arg-type]
        )
        db.commit()
        after = tuple(
            db.scalar(select(func.count()).select_from(model))
            for model in (Playlist, PlaylistTrack, LibraryItem)
        )
        candidates = list(
            db.scalars(
                select(RecommendationCandidate).where(
                    RecommendationCandidate.user_id == user.id,
                    RecommendationCandidate.source == "netease_external",
                )
            )
        )

        assert before == after
        assert result.status == "fresh"
        assert provider.calls <= MAX_SEEDS
        assert provider.max_active <= MAX_CONCURRENCY
        assert {candidate.provider_id for candidate in candidates} == {
            "other-track-0",
            "same-title-different-provider-id",
        }
        globally_known = next(row for row in candidates if row.provider_id == "other-track-0")
        assert globally_known.canonical_entity_id == other_tracks[0].id
        assert globally_known.payload["item"]["is_in_library"] is False
        collaboration = next(
            row for row in candidates if row.provider_id == "same-title-different-provider-id"
        )
        assert len(collaboration.payload["item"]["external_track"]["artists"]) == 2
        assert collaboration.payload["item"]["strategy"] == "EXTERNAL_COLLABORATION"

        item = collaboration.payload["item"]
        feedback = RecommendationFeedbackRequest(
            entity_type="track",
            provider_identity=ProviderEntityIdentity(
                provider="netease",
                entity_type="track",
                provider_id=collaboration.provider_id or "",
            ),
            strategy=item["strategy"],
            feedback_type="NOT_INTERESTED",
        )
        save_recommendation_feedback(feedback, db, user)
        visible = RecommendationEngine(db, user=user, profile=profile).generate(category="external", limit=20)
        assert collaboration.provider_id not in {
            recommendation.provider_identity.provider_id
            for recommendation in visible.items
            if recommendation.provider_identity
        }
        assert other.id != user.id


def test_external_refresh_failure_keeps_stale_verified_candidates() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user, _, _ = _library(db, "stale", artist_count=2)
        RecommendationProfileService(db).rebuild(user)
        profile = RecommendationProfileService(db).get_current(user)
        assert profile is not None
        artist = ProviderArtist("fresh-artist", "Fresh artist", None)
        track = ProviderTrack(
            provider_id="fresh-track",
            title="Fresh track",
            duration_ms=None,
            album_provider_id=None,
            artist_provider_ids=(artist.provider_id,),
            artwork_url=None,
            artists=(artist,),
        )
        service = ExternalDiscoveryService(db)
        first = asyncio.run(
            service.refresh(user, profile, provider=FakeDiscoveryProvider([track]))  # type: ignore[arg-type]
        )
        second = asyncio.run(
            service.refresh(user, profile, provider=FailingDiscoveryProvider())  # type: ignore[arg-type]
        )
        remaining = db.scalar(
            select(func.count())
            .select_from(RecommendationCandidate)
            .where(
                RecommendationCandidate.user_id == user.id,
                RecommendationCandidate.source == "netease_external",
            )
        )

        assert first.candidate_count == 1
        assert second.status == "stale"
        assert remaining == 1
