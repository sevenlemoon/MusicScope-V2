from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from time import perf_counter
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    ExternalAlbumItem,
    ExternalArtistItem,
    ExternalTrackItem,
    ProviderEntityIdentity,
    RecommendationEvidence,
    RecommendationItem,
)
from app.domain.enums import ConnectionStatus, EntityType
from app.domain.models import (
    Artist,
    ExternalIdentity,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    RecommendationCandidate,
    RecommendationCandidateRefresh,
    RecommendationProfile,
    RecommendationProfileArtist,
    Track,
    User,
)
from app.providers.music import MusicProvider
from app.providers.netease import NetEaseProvider
from app.providers.types import ProviderTrack
from app.services.music_connections import MusicConnectionService
from app.services.recommendation_engine import RecommendationEngine, confidence_label

MAX_SEEDS = 8
TRACKS_PER_SEED = 30
MAX_EXTERNAL_CANDIDATES = 80
MAX_PER_SEED = 6
MAX_PER_ARTIST = 4
MAX_CONCURRENCY = 3
FRESHNESS = timedelta(hours=24)


@dataclass(frozen=True)
class ExternalRefreshResult:
    status: str
    candidate_count: int
    provider_request_count: int
    provider_failure_count: int
    duration_ms: int
    generated_at: datetime | None


@dataclass(frozen=True)
class DiscoverySeed:
    canonical_artist_id: UUID
    provider_artist_id: str
    name: str
    affinity: float
    confidence: float
    distinct_tracks: int


ProviderFactory = Callable[[str], MusicProvider]


class ExternalDiscoveryService:
    """Materialize bounded, read-only, user-scoped provider discovery candidates."""

    def __init__(
        self,
        session: Session,
        *,
        provider_factory: ProviderFactory | None = None,
    ) -> None:
        self.session = session
        self.provider_factory = provider_factory or (lambda cookie: NetEaseProvider(session_cookie=cookie))

    def _connection(self, user: User) -> MusicConnection:
        connection = self.session.scalar(
            select(MusicConnection)
            .where(
                MusicConnection.user_id == user.id,
                MusicConnection.provider == "netease",
                MusicConnection.status == ConnectionStatus.CONNECTED.value,
            )
            .order_by(MusicConnection.updated_at.desc())
            .limit(1)
        )
        if connection is None:
            raise PermissionError("A connected NetEase account is required.")
        return connection

    def _seeds(self, profile: RecommendationProfile) -> list[DiscoverySeed]:
        rows = self.session.execute(
            select(RecommendationProfileArtist, Artist, ExternalIdentity.provider_id)
            .join(Artist, Artist.id == RecommendationProfileArtist.artist_id)
            .join(
                ExternalIdentity,
                (ExternalIdentity.entity_id == Artist.id)
                & (ExternalIdentity.entity_type == EntityType.ARTIST.value)
                & (ExternalIdentity.provider == "netease"),
            )
            .where(RecommendationProfileArtist.profile_id == profile.id)
            .order_by(
                RecommendationProfileArtist.affinity.desc(),
                RecommendationProfileArtist.artist_id,
            )
            .limit(MAX_SEEDS)
        )
        return [
            DiscoverySeed(
                canonical_artist_id=artist.id,
                provider_artist_id=provider_id,
                name=artist.name,
                affinity=profile_artist.affinity,
                confidence=profile_artist.confidence,
                distinct_tracks=profile_artist.distinct_tracks,
            )
            for profile_artist, artist, provider_id in rows
        ]

    def _owned_track_provider_ids(self, user: User) -> set[str]:
        return set(
            self.session.scalars(
                select(ExternalIdentity.provider_id)
                .join(Track, Track.id == ExternalIdentity.entity_id)
                .join(PlaylistTrack, PlaylistTrack.track_id == Track.id)
                .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
                .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
                .where(
                    MusicConnection.user_id == user.id,
                    ExternalIdentity.provider == "netease",
                    ExternalIdentity.entity_type == EntityType.TRACK.value,
                )
                .distinct()
            )
        )

    def _known_track_identities(self) -> dict[str, UUID]:
        return dict(
            self.session.execute(
                select(ExternalIdentity.provider_id, ExternalIdentity.entity_id).where(
                    ExternalIdentity.provider == "netease",
                    ExternalIdentity.entity_type == EntityType.TRACK.value,
                )
            ).all()
        )

    async def refresh(
        self,
        user: User,
        profile: RecommendationProfile,
        *,
        provider: MusicProvider | None = None,
    ) -> ExternalRefreshResult:
        started = perf_counter()
        seeds = self._seeds(profile)
        if provider is None:
            connection = self._connection(user)
            cookie = MusicConnectionService(self.session).decrypt_session(connection)
            provider = self.provider_factory(cookie)

        semaphore = asyncio.Semaphore(MAX_CONCURRENCY)

        async def catalog(seed: DiscoverySeed) -> tuple[DiscoverySeed, list[ProviderTrack] | Exception]:
            async with semaphore:
                try:
                    return seed, await provider.get_artist_tracks(
                        seed.provider_artist_id, limit=TRACKS_PER_SEED
                    )
                except Exception as exc:  # provider errors become a safe partial refresh state
                    return seed, exc

        results = await asyncio.gather(*(catalog(seed) for seed in seeds))
        failures = sum(isinstance(value, Exception) for _, value in results)
        owned = self._owned_track_provider_ids(user)
        known = self._known_track_identities()
        generated_at = datetime.now(UTC)
        candidates: dict[str, tuple[RecommendationItem, str, tuple[str, ...], str | None]] = {}

        for seed, value in results:
            if isinstance(value, Exception):
                continue
            for rank, track in enumerate(value):
                if track.provider_id in owned:
                    continue
                provider_rank = 1.0 - min(rank, TRACKS_PER_SEED - 1) / TRACKS_PER_SEED
                collaboration = len(track.artists) > 1
                score = min(1.0, seed.affinity * 0.72 + provider_rank * 0.18 + (0.04 if collaboration else 0))
                confidence = min(1.0, seed.confidence * 0.75 + 0.15 + (0.05 if collaboration else 0))
                strategy = "EXTERNAL_COLLABORATION" if collaboration else "EXTERNAL_ARTIST_CATALOG"
                artists = [
                    ExternalArtistItem(
                        provider_id=artist.provider_id,
                        name=artist.name,
                        artwork_url=artist.artwork_url,
                    )
                    for artist in track.artists
                ]
                album = (
                    ExternalAlbumItem(
                        provider_id=track.album.provider_id,
                        title=track.album.title,
                        artwork_url=track.album.artwork_url,
                    )
                    if track.album
                    else None
                )
                explanation = (
                    f"An unsaved collaboration from {seed.name}, an artist with strong "
                    "representation in your collection."
                    if collaboration
                    else f"An unsaved track from {seed.name}, an artist strongly represented "
                    "in your collection."
                )
                item = RecommendationItem(
                    entity_type="track",
                    canonical_entity_id=str(known[track.provider_id])
                    if track.provider_id in known
                    else None,
                    provider_identity=ProviderEntityIdentity(
                        provider="netease", entity_type="track", provider_id=track.provider_id
                    ),
                    title=track.title,
                    subtitle=" · ".join(artist.name for artist in track.artists),
                    artwork_url=track.artwork_url,
                    score=round(score, 6),
                    confidence=round(confidence, 6),
                    confidence_label=confidence_label(confidence),
                    strategy=strategy,
                    evidence=[
                        RecommendationEvidence(code="AFFINITY_SEED", label="Profile seed", value=seed.name),
                        RecommendationEvidence(
                            code="SEED_ARTIST_AFFINITY",
                            label="Seed affinity",
                            value=round(seed.affinity, 3),
                        ),
                        RecommendationEvidence(
                            code="PROVIDER_CATALOG_RANK",
                            label="Artist catalog position",
                            value=rank + 1,
                        ),
                    ],
                    explanation=explanation,
                    is_in_library=False,
                    source="netease_external",
                    generated_at=generated_at,
                    external_track=ExternalTrackItem(
                        provider_id=track.provider_id,
                        title=track.title,
                        artwork_url=track.artwork_url,
                        duration_ms=track.duration_ms,
                        artists=artists,
                        album=album,
                    ),
                    discovery_distance=1,
                )
                identity_key = RecommendationEngine.identity_key(item)
                previous = candidates.get(identity_key)
                if previous is None or item.score > previous[0].score:
                    candidates[identity_key] = (
                        item,
                        f"netease:artist:{seed.provider_artist_id}",
                        tuple(artist.provider_id for artist in track.artists),
                        track.album_provider_id,
                    )

        ranked = sorted(candidates.values(), key=lambda value: (-value[0].score, value[0].title.casefold()))
        selected: list[tuple[RecommendationItem, str, tuple[str, ...], str | None]] = []
        seed_counts: dict[str, int] = defaultdict(int)
        artist_counts: dict[str, int] = defaultdict(int)
        for candidate in ranked:
            item, seed_key, artist_ids, _ = candidate
            if seed_counts[seed_key] >= MAX_PER_SEED:
                continue
            if any(artist_counts[artist_id] >= MAX_PER_ARTIST for artist_id in artist_ids):
                continue
            selected.append(candidate)
            seed_counts[seed_key] += 1
            for artist_id in artist_ids:
                artist_counts[artist_id] += 1
            if len(selected) >= MAX_EXTERNAL_CANDIDATES:
                break

        state = self._refresh_state(user)
        if not selected and failures:
            existing_count = len(self._existing_external(user, profile))
            state.status = "stale" if existing_count else "unavailable"
            state.failure_count = failures
            state.request_count = len(seeds)
            state.duration_ms = round((perf_counter() - started) * 1000)
            state.safe_error_code = "provider_refresh_failed"
            self.session.flush()
            return ExternalRefreshResult(
                status="stale" if existing_count else "no_candidates",
                candidate_count=existing_count,
                provider_request_count=len(seeds),
                provider_failure_count=failures,
                duration_ms=state.duration_ms,
                generated_at=state.generated_at,
            )

        self.session.execute(
            delete(RecommendationCandidate).where(
                RecommendationCandidate.user_id == user.id,
                RecommendationCandidate.source == "netease_external",
            )
        )
        for item, seed_key, artist_ids, album_id in selected:
            identity = item.provider_identity
            if identity is None:
                continue
            self.session.add(
                RecommendationCandidate(
                    user_id=user.id,
                    profile_id=profile.id,
                    category="external",
                    source=item.source,
                    entity_type=item.entity_type,
                    canonical_entity_id=UUID(item.canonical_entity_id)
                    if item.canonical_entity_id
                    else None,
                    provider=identity.provider,
                    provider_id=identity.provider_id,
                    identity_key=RecommendationEngine.identity_key(item),
                    score=item.score,
                    confidence=item.confidence,
                    strategy=item.strategy,
                    seed_key=seed_key,
                    distance=item.discovery_distance,
                    payload={
                        "item": item.model_dump(mode="json"),
                        "artist_ids": list(artist_ids),
                        "album_id": album_id,
                    },
                    generated_at=generated_at,
                    expires_at=generated_at + FRESHNESS,
                )
            )
        state.status = "partial" if failures else ("fresh" if selected else "no_candidates")
        state.generated_at = generated_at
        state.expires_at = generated_at + FRESHNESS
        state.candidate_count = len(selected)
        state.request_count = len(seeds)
        state.failure_count = failures
        state.duration_ms = round((perf_counter() - started) * 1000)
        state.safe_error_code = "provider_refresh_partial" if failures else None
        self.session.flush()
        return ExternalRefreshResult(
            status=state.status,
            candidate_count=len(selected),
            provider_request_count=len(seeds),
            provider_failure_count=failures,
            duration_ms=state.duration_ms,
            generated_at=generated_at,
        )

    def _existing_external(self, user: User, profile: RecommendationProfile) -> list[RecommendationCandidate]:
        return list(
            self.session.scalars(
                select(RecommendationCandidate).where(
                    RecommendationCandidate.user_id == user.id,
                    RecommendationCandidate.profile_id == profile.id,
                    RecommendationCandidate.source == "netease_external",
                )
            )
        )

    def _refresh_state(self, user: User) -> RecommendationCandidateRefresh:
        state = self.session.scalar(
            select(RecommendationCandidateRefresh).where(
                RecommendationCandidateRefresh.user_id == user.id,
                RecommendationCandidateRefresh.provider == "netease",
            )
        )
        if state is None:
            state = RecommendationCandidateRefresh(
                user_id=user.id,
                provider="netease",
                status="unavailable",
            )
            self.session.add(state)
            self.session.flush()
        return state

    def state(self, user: User) -> tuple[str, datetime | None]:
        state = self.session.scalar(
            select(RecommendationCandidateRefresh).where(
                RecommendationCandidateRefresh.user_id == user.id,
                RecommendationCandidateRefresh.provider == "netease",
            )
        )
        if state is None:
            return "unavailable", None
        if state.status in {"fresh", "partial"} and state.expires_at and state.expires_at < datetime.now(UTC):
            return "stale", state.generated_at
        return state.status, state.generated_at
