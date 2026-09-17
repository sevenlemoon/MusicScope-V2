from datetime import UTC, datetime
from time import perf_counter
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser
from app.api.schemas import (
    AffinityItem,
    CandidateRefreshResponse,
    DiscoverRecommendationsResponse,
    EntityReference,
    HomeRecommendationsResponse,
    PlaybackSourceResponse,
    ProfileRebuildResponse,
    ProviderEntityIdentity,
    RecommendationEvidence,
    RecommendationFeedbackRequest,
    RecommendationFeedbackResponse,
    RecommendationItem,
    RecommendationProfileResponse,
    RecommendationSettingsRequest,
    RelationshipItem,
)
from app.core.database import get_db
from app.domain.models import (
    Album,
    Artist,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    RecommendationCandidate,
    RecommendationFeedback,
    RecommendationProfile,
    RecommendationProfileAlbum,
    RecommendationProfileArtist,
    RecommendationRelationship,
    Track,
    TrackArtist,
    User,
)
from app.providers.errors import (
    ProviderAuthenticationExpired,
    ProviderError,
    ProviderPlaybackUnavailable,
)
from app.services.external_discovery import ExternalDiscoveryService
from app.services.playback import PlaybackService
from app.services.recommendation_engine import RecommendationEngine
from app.services.recommendation_profile import RecommendationProfileService

router = APIRouter(prefix="/recommendations", tags=["recommendations"])
DbSession = Annotated[Session, Depends(get_db)]
SUPPORTED_CATEGORIES = {
    "for-you",
    "artists",
    "albums",
    "tracks",
    "adjacent",
    "rediscover",
    "hidden-gems",
    "explore",
    "external",
}


def _profile_or_conflict(db: Session, user: User) -> RecommendationProfile:
    profile = RecommendationProfileService(db).get_current(user)
    if profile is None:
        raise HTTPException(
            status_code=409,
            detail="Recommendation profile is missing or stale. Rebuild it explicitly.",
        )
    return profile


def _profile_response(
    db: Session,
    user: User,
    profile: RecommendationProfile,
    *,
    stale: bool,
) -> RecommendationProfileResponse:
    artist_rows = list(
        db.execute(
            select(RecommendationProfileArtist, Artist)
            .join(Artist, Artist.id == RecommendationProfileArtist.artist_id)
            .where(RecommendationProfileArtist.profile_id == profile.id)
            .order_by(
                RecommendationProfileArtist.affinity.desc(),
                RecommendationProfileArtist.artist_id,
            )
            .limit(12)
        )
    )
    album_rows = list(
        db.execute(
            select(RecommendationProfileAlbum, Album)
            .join(Album, Album.id == RecommendationProfileAlbum.album_id)
            .where(RecommendationProfileAlbum.profile_id == profile.id)
            .order_by(
                RecommendationProfileAlbum.affinity.desc(),
                RecommendationProfileAlbum.album_id,
            )
            .limit(12)
        )
    )
    relationships = _relationship_items(db, profile.id)
    signals = profile.signals
    return RecommendationProfileResponse(
        profile_id=str(profile.id),
        version=profile.version,
        stale=stale,
        exploration_level=user.exploration_level,
        artist_count=int(signals.get("artist_count", 0)),
        album_count=int(signals.get("album_count", 0)),
        relationship_count=int(signals.get("relationship_count", 0)),
        playlist_count=int(signals.get("playlist_count", 0)),
        track_count=int(signals.get("track_count", 0)),
        largest_playlist=int(signals.get("largest_playlist", 0)),
        largest_playlist_weight=float(signals.get("largest_playlist_weight", 0)),
        generated_at=profile.updated_at,
        timings_ms=signals.get("timings_ms", {}),
        top_artists=[
            AffinityItem(
                id=str(artist.id),
                name=artist.name,
                artwork_url=artist.artwork_url,
                affinity=row.affinity,
                confidence=row.confidence,
                evidence=[
                    RecommendationEvidence(
                        code="ARTIST_LIBRARY_TRACK_COUNT",
                        label="Library tracks",
                        value=row.distinct_tracks,
                    ),
                    RecommendationEvidence(
                        code="ARTIST_PLAYLIST_COUNT",
                        label="Playlists",
                        value=row.distinct_playlists,
                    ),
                ],
            )
            for row, artist in artist_rows
        ],
        top_albums=[
            AffinityItem(
                id=str(album.id),
                name=album.title,
                artwork_url=album.artwork_url,
                affinity=row.affinity,
                confidence=row.confidence,
                evidence=[
                    RecommendationEvidence(
                        code="ALBUM_LIBRARY_TRACK_COUNT",
                        label="Library tracks",
                        value=row.distinct_tracks,
                    ),
                    RecommendationEvidence(
                        code="ALBUM_PLAYLIST_COUNT",
                        label="Playlists",
                        value=row.distinct_playlists,
                    ),
                ],
            )
            for row, album in album_rows
        ],
        relationships=relationships,
    )


def _relationship_items(db: Session, profile_id: UUID) -> list[RelationshipItem]:
    rows = list(
        db.scalars(
            select(RecommendationRelationship)
            .where(RecommendationRelationship.profile_id == profile_id)
            .order_by(
                RecommendationRelationship.weight.desc(),
                RecommendationRelationship.id,
            )
            .limit(12)
        )
    )
    artist_ids = {artist_id for row in rows for artist_id in (row.source_artist_id, row.target_artist_id)}
    artists = {artist.id: artist for artist in db.scalars(select(Artist).where(Artist.id.in_(artist_ids)))}
    return [
        RelationshipItem(
            source=EntityReference(id=str(row.source_artist_id), name=artists[row.source_artist_id].name),
            target=EntityReference(id=str(row.target_artist_id), name=artists[row.target_artist_id].name),
            weight=row.weight,
            playlist_count=row.playlist_count,
            collaboration_count=row.collaboration_count,
        )
        for row in rows
        if row.source_artist_id in artists and row.target_artist_id in artists
    ]


@router.get("/profile", response_model=RecommendationProfileResponse)
def recommendation_profile(db: DbSession, user: CurrentUser) -> RecommendationProfileResponse:
    service = RecommendationProfileService(db)
    profile = service.get(user)
    if profile is None:
        raise HTTPException(status_code=404, detail="Recommendation profile has not been built.")
    return _profile_response(db, user, profile, stale=service.is_stale(user, profile))


@router.post("/profile/rebuild", response_model=ProfileRebuildResponse)
def rebuild_recommendation_profile(db: DbSession, user: CurrentUser) -> ProfileRebuildResponse:
    result = RecommendationProfileService(db).rebuild(user)
    profile = RecommendationProfileService(db).get_current(user)
    if profile is None:
        raise HTTPException(status_code=500, detail="Recommendation profile rebuild failed.")
    RecommendationEngine(db, user=user, profile=profile).materialize_internal()
    db.commit()
    return ProfileRebuildResponse(
        profile_id=result.profile_id,
        artist_count=result.artist_count,
        album_count=result.album_count,
        relationship_count=result.relationship_count,
        timings_ms=result.timings_ms,
    )


@router.get("/home", response_model=HomeRecommendationsResponse)
def home_recommendations(db: DbSession, user: CurrentUser) -> HomeRecommendationsResponse:
    started = perf_counter()
    engine = RecommendationEngine(db, user=user, profile=_profile_or_conflict(db, user))
    made_for_you = engine.generate(category="for-you", limit=10)
    rediscover = engine.generate(category="rediscover", limit=10)
    artists = engine.generate(category="artists", limit=8)
    explore = engine.generate(category="external", limit=6)
    external_state, cache_generated_at = ExternalDiscoveryService(db).state(user)
    timings = dict(made_for_you.timings_ms)
    timings["home_api"] = round((perf_counter() - started) * 1000)
    return HomeRecommendationsResponse(
        generated_at=made_for_you.generated_at,
        exploration_level=user.exploration_level,
        made_for_you=made_for_you.items,
        rediscover=rediscover.items,
        strong_artists=artists.items,
        explore_next=explore.items,
        candidate_counts=made_for_you.candidate_counts,
        timings_ms=timings,
        external_state=external_state,
        cache_generated_at=cache_generated_at,
    )


@router.get("/discover", response_model=DiscoverRecommendationsResponse)
def discover_recommendations(
    db: DbSession,
    user: CurrentUser,
    category: str = Query("for-you"),
    limit: int = Query(24, ge=1, le=60),
) -> DiscoverRecommendationsResponse:
    if category not in SUPPORTED_CATEGORIES:
        raise HTTPException(status_code=422, detail="Unsupported recommendation category.")
    started = perf_counter()
    result = RecommendationEngine(db, user=user, profile=_profile_or_conflict(db, user)).generate(
        category=category, limit=limit
    )
    timings = dict(result.timings_ms)
    timings["discover_api"] = round((perf_counter() - started) * 1000)
    external_state, cache_generated_at = ExternalDiscoveryService(db).state(user)
    return DiscoverRecommendationsResponse(
        generated_at=result.generated_at,
        category=category,
        exploration_level=user.exploration_level,
        items=result.items,
        candidate_counts=result.candidate_counts,
        timings_ms=timings,
        external_state=external_state,
        cache_generated_at=cache_generated_at,
    )


@router.post("/candidates/refresh", response_model=CandidateRefreshResponse)
async def refresh_candidates(db: DbSession, user: CurrentUser) -> CandidateRefreshResponse:
    profile = _profile_or_conflict(db, user)
    try:
        result = await ExternalDiscoveryService(db).refresh(user, profile)
        db.commit()
        return CandidateRefreshResponse(
            status=result.status,
            candidate_count=result.candidate_count,
            provider_request_count=result.provider_request_count,
            provider_failure_count=result.provider_failure_count,
            duration_ms=result.duration_ms,
            generated_at=result.generated_at,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail="Connect NetEase before discovery refresh.") from exc
    except ProviderAuthenticationExpired as exc:
        raise HTTPException(status_code=401, detail="NetEase session expired.") from exc
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail="NetEase discovery is temporarily unavailable.") from exc


@router.get(
    "/external/{provider}/tracks/{provider_id}",
    response_model=RecommendationItem,
)
def external_track_detail(
    provider: str, provider_id: str, db: DbSession, user: CurrentUser
) -> RecommendationItem:
    candidate = db.scalar(
        select(RecommendationCandidate).where(
            RecommendationCandidate.user_id == user.id,
            RecommendationCandidate.provider == provider,
            RecommendationCandidate.provider_id == provider_id,
            RecommendationCandidate.entity_type == "track",
            RecommendationCandidate.source == "netease_external",
        )
    )
    if candidate is None:
        raise HTTPException(status_code=404, detail="External recommendation not found.")
    return RecommendationItem.model_validate(candidate.payload["item"])


@router.post(
    "/external/{provider}/tracks/{provider_id}/playback-source",
    response_model=PlaybackSourceResponse,
)
async def external_track_playback(
    provider: str,
    provider_id: str,
    response: Response,
    db: DbSession,
    user: CurrentUser,
) -> PlaybackSourceResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        result = await PlaybackService(db).resolve_provider_track(
            user, provider=provider, provider_id=provider_id
        )
        return PlaybackSourceResponse(
            provider_identity=ProviderEntityIdentity(
                provider="netease", entity_type="track", provider_id=provider_id
            ),
            url=result.source.url,
            mime_type=result.source.mime_type,
            duration_ms=result.source.duration_ms,
            expires_at=result.source.expires_at,
            quality=result.source.quality,
            provider="netease",
            resolution_ms=result.resolution_ms,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="External recommendation not found.") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail="Connect NetEase before playback.") from exc
    except ProviderPlaybackUnavailable as exc:
        raise HTTPException(
            status_code=422,
            detail="This track cannot be played with the current account.",
        ) from exc
    except ProviderAuthenticationExpired as exc:
        raise HTTPException(status_code=401, detail="NetEase session expired.") from exc
    except ProviderError as exc:
        raise HTTPException(status_code=503, detail="Playback is temporarily unavailable.") from exc


@router.get("/{category}", response_model=DiscoverRecommendationsResponse)
def recommendation_category(
    category: str,
    db: DbSession,
    user: CurrentUser,
    limit: int = Query(24, ge=1, le=60),
) -> DiscoverRecommendationsResponse:
    return discover_recommendations(db=db, user=user, category=category, limit=limit)


def _entity_is_owned(db: Session, user: User, entity_type: str, entity_id: UUID) -> bool:
    base = (
        select(func.count())
        .select_from(PlaylistTrack)
        .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
        .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
        .join(Track, Track.id == PlaylistTrack.track_id)
        .where(MusicConnection.user_id == user.id)
    )
    if entity_type == "track":
        statement = base.where(Track.id == entity_id)
    elif entity_type == "album":
        statement = base.where(Track.album_id == entity_id)
    else:
        statement = base.join(TrackArtist, TrackArtist.track_id == Track.id).where(
            TrackArtist.artist_id == entity_id
        )
    return bool(db.scalar(statement))


@router.post("/feedback", response_model=RecommendationFeedbackResponse)
def save_recommendation_feedback(
    payload: RecommendationFeedbackRequest,
    db: DbSession,
    user: CurrentUser,
) -> RecommendationFeedbackResponse:
    if bool(payload.canonical_entity_id) == bool(payload.provider_identity):
        raise HTTPException(status_code=422, detail="Provide exactly one recommendation identity.")
    entity_id: UUID | None = None
    provider = None
    provider_id = None
    if payload.canonical_entity_id:
        try:
            entity_id = UUID(payload.canonical_entity_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid canonical entity identifier.") from exc
        if not _entity_is_owned(db, user, payload.entity_type, entity_id):
            raise HTTPException(status_code=404, detail="Recommendation entity is not in this library.")
        identity_key = f"canonical:{entity_id}"
    else:
        identity = payload.provider_identity
        if identity is None or identity.entity_type != payload.entity_type:
            raise HTTPException(status_code=422, detail="Provider identity type does not match.")
        provider = identity.provider
        provider_id = identity.provider_id
        identity_key = f"provider:{provider}:{payload.entity_type}:{provider_id}"
        candidate = db.scalar(
            select(RecommendationCandidate).where(
                RecommendationCandidate.user_id == user.id,
                RecommendationCandidate.identity_key == identity_key,
                RecommendationCandidate.source == "netease_external",
            )
        )
        if candidate is None:
            raise HTTPException(status_code=404, detail="External recommendation not found.")
    feedback = db.scalar(
        select(RecommendationFeedback).where(
            RecommendationFeedback.user_id == user.id,
            RecommendationFeedback.entity_type == payload.entity_type,
            RecommendationFeedback.identity_key == identity_key,
        )
    )
    if feedback is None:
        feedback = RecommendationFeedback(
            user_id=user.id,
            entity_type=payload.entity_type,
            entity_id=entity_id,
            provider=provider,
            provider_id=provider_id,
            identity_key=identity_key,
            track_id=entity_id if payload.entity_type == "track" else None,
            strategy=payload.strategy,
            feedback_type=payload.feedback_type,
            reason=payload.reason,
            context={"source": "recommendation_ui"},
        )
        db.add(feedback)
    else:
        feedback.strategy = payload.strategy
        feedback.feedback_type = payload.feedback_type
        feedback.reason = payload.reason
        feedback.updated_at = datetime.now(UTC)
    db.commit()
    return RecommendationFeedbackResponse(
        feedback_type=payload.feedback_type,
        canonical_entity_id=payload.canonical_entity_id,
        provider_identity=payload.provider_identity,
    )


@router.patch("/settings", response_model=RecommendationProfileResponse)
def update_recommendation_settings(
    payload: RecommendationSettingsRequest,
    db: DbSession,
    user: CurrentUser,
) -> RecommendationProfileResponse:
    user.exploration_level = payload.exploration_level
    db.commit()
    profile = RecommendationProfileService(db).get(user)
    if profile is None:
        raise HTTPException(status_code=404, detail="Recommendation profile has not been built.")
    return _profile_response(
        db,
        user,
        profile,
        stale=RecommendationProfileService(db).is_stale(user, profile),
    )
