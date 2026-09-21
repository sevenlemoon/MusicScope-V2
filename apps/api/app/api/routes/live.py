from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser
from app.api.schemas import (
    ArtistProviderMatchResponse,
    ConcertEventResponse,
    ConcertPerformerResponse,
    ConcertProviderResponse,
    ConcertSourceResponse,
    LiveFeedResponse,
    LivePreferenceRequest,
    LivePreferenceResponse,
    LiveRefreshResponse,
    LiveSearchResponse,
    ProviderSearchOutcomeResponse,
    RecommendationEvidence,
)
from app.core.config import get_settings
from app.core.database import get_db
from app.domain.models import (
    ConcertEvent,
    ConcertEventSource,
    ConcertPerformer,
    LiveRecommendation,
    UserLivePreference,
)
from app.providers.concert import ConcertProvider
from app.providers.concert_experimental import KktixProvider, MaoyanProvider, ShowStartProvider
from app.providers.ticketmaster import TicketmasterProvider
from app.providers.verified_live import VerifiedOfficialSourceProvider
from app.services.concert_aggregator import ConcertAggregator, ProviderCircuitBreaker
from app.services.live_concerts import LiveConcertService

router = APIRouter(tags=["live"])
DbSession = Annotated[Session, Depends(get_db)]
DateFilter = Literal["all", "month", "three_months"]
_circuit_breaker = ProviderCircuitBreaker()


def _is_expired(value: datetime) -> bool:
    comparable = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return comparable <= datetime.now(UTC)


def _providers() -> list[ConcertProvider]:
    settings = get_settings()
    return [
        TicketmasterProvider(
            settings.ticketmaster_api_key,
            timeout_seconds=settings.ticketmaster_timeout_seconds,
        ),
        VerifiedOfficialSourceProvider(
            "asiaworld_expo",
            enabled=settings.enable_verified_official_concerts,
            timeout_seconds=settings.verified_official_timeout_seconds,
        ),
        MaoyanProvider(enabled=settings.enable_maoyan_concerts),
        KktixProvider(enabled=settings.enable_kktix_concerts),
        ShowStartProvider(
            enabled=settings.enable_showstart_concerts,
            timeout_seconds=settings.showstart_timeout_seconds,
        ),
    ]


def _service(db: Session) -> LiveConcertService:
    settings = get_settings()
    return LiveConcertService(
        db,
        ConcertAggregator(
            _providers(),
            circuit_breaker=_circuit_breaker,
            page_budget=settings.ticketmaster_search_page_budget,
            max_concurrency=settings.live_search_max_concurrency,
            provider_timeout_seconds=settings.live_provider_timeout_seconds,
            search_deadline_seconds=settings.live_search_deadline_seconds,
        ),
        cache_ttl_hours=settings.live_cache_ttl_hours,
        search_cache_minutes=settings.live_search_cache_minutes,
        seed_budget=settings.live_seed_budget,
    )


def _coverage_message(status: str) -> str:
    return {
        "OK": "Upcoming events returned by the currently available concert sources.",
        "PARTIAL_RESULTS": (
            "Some concert sources were unavailable; verified results from available sources are shown."
        ),
        "ARTIST_NOT_FOUND": "The currently available concert sources did not identify an exact artist match.",
        "NO_UPCOMING_EVENTS": "No upcoming events were returned by the currently available concert sources.",
        "AMBIGUOUS_ARTIST": (
            "More than one exact provider artist match was found. Choose a result to continue."
        ),
        "PROVIDER_NOT_CONFIGURED": "Concert search is not configured on this MusicScope installation.",
        "PROVIDER_UNAVAILABLE": (
            "Concert sources are temporarily unavailable. Verified cached events remain visible."
        ),
        "PROVIDER_RATE_LIMITED": "Concert search is temporarily rate limited. Please try again later.",
        "PROFILE_NOT_READY": "Build your MusicScope taste profile before refreshing Live For You.",
        "EMPTY": "No verified personalized events are cached yet.",
    }.get(status, "Concert coverage is currently unavailable.")


def _event_response(
    db: Session,
    event: ConcertEvent,
    recommendation: LiveRecommendation | None = None,
) -> ConcertEventResponse:
    performers = list(
        db.scalars(
            select(ConcertPerformer)
            .where(ConcertPerformer.event_id == event.id)
            .order_by(ConcertPerformer.position, ConcertPerformer.id)
        )
    )
    sources = list(
        db.scalars(
            select(ConcertEventSource)
            .where(ConcertEventSource.event_id == event.id)
            .order_by(ConcertEventSource.provider, ConcertEventSource.provider_event_id)
        )
    )
    evidence: list[RecommendationEvidence] = []
    explanation = None
    if recommendation is not None:
        payload = recommendation.evidence
        tracks = int(payload.get("track_count", 0))
        playlists = int(payload.get("playlist_count", 0))
        evidence = [
            RecommendationEvidence(
                code="ARTIST_AFFINITY",
                label="Artist affinity",
                value=float(payload.get("artist_affinity", 0)),
            ),
            RecommendationEvidence(code="LIBRARY_TRACKS", label="Library tracks", value=tracks),
            RecommendationEvidence(code="PLAYLISTS", label="Playlists", value=playlists),
        ]
        if tracks:
            artist_name = payload.get("artist_name", event.primary_artist_name or "this artist")
            explanation = (
                f"{tracks} tracks by {artist_name} are represented in your library."
            )
        elif playlists:
            explanation = f"This artist appears across {playlists} of your playlists."
        else:
            explanation = "Strongly represented in your MusicScope profile."
    return ConcertEventResponse(
        id=str(event.id),
        title=event.title,
        primary_artist_name=event.primary_artist_name,
        canonical_artist_id=str(event.artist_id) if event.artist_id else None,
        performers=[
            ConcertPerformerResponse(
                name=value.name,
                canonical_artist_id=str(value.artist_id) if value.artist_id else None,
                provider_identities={str(key): str(item) for key, item in value.provider_identities.items()},
            )
            for value in performers
        ],
        start_date=event.start_date,
        start_time=event.start_time,
        timezone=event.timezone,
        venue_name=event.venue_name,
        venue_address=event.venue_address,
        city=event.city,
        region=event.region,
        country=event.country,
        latitude=event.latitude,
        longitude=event.longitude,
        artwork_url=event.artwork_url,
        event_url=event.event_url,
        ticket_url=event.ticket_url,
        status=event.status,
        observed_at=event.observed_at,
        last_refreshed_at=event.last_refreshed_at,
        sources=[
            ConcertSourceResponse(
                provider=value.provider,
                provider_event_id=value.provider_event_id,
                event_url=value.event_url,
                ticket_url=value.ticket_url,
                status=value.status,
                observed_at=value.observed_at,
                last_refreshed_at=value.last_refreshed_at,
            )
            for value in sources
        ],
        personalization_evidence=evidence,
        explanation=explanation,
    )


@router.get("/live", response_model=LiveFeedResponse)
def live_feed(
    db: DbSession,
    user: CurrentUser,
    date_filter: Annotated[DateFilter, Query()] = "all",
    country: Annotated[str | None, Query(min_length=2, max_length=2)] = None,
    city: Annotated[str | None, Query(max_length=160)] = None,
    limit: Annotated[int, Query(ge=1, le=60)] = 30,
) -> LiveFeedResponse:
    rows = _service(db).cached_feed(
        user,
        date_filter=date_filter,
        country=country.upper() if country else None,
        city=city,
        limit=limit,
    )
    status = "OK" if rows else "EMPTY"
    generated_at = max((recommendation.generated_at for recommendation, _ in rows), default=None)
    stale = any(_is_expired(recommendation.expires_at) for recommendation, _ in rows)
    return LiveFeedResponse(
        status=status,
        coverage_message=_coverage_message(status),
        events=[_event_response(db, event, recommendation) for recommendation, event in rows],
        provider_states={provider.provider_name: provider.health().state.value for provider in _providers()},
        generated_at=generated_at,
        stale=stale,
    )


@router.get("/live/search", response_model=LiveSearchResponse)
async def search_live(
    query: Annotated[str, Query(min_length=1, max_length=300)],
    db: DbSession,
    user: CurrentUser,
    date_filter: Annotated[DateFilter, Query()] = "all",
    country: Annotated[str | None, Query(min_length=2, max_length=2)] = None,
    city: Annotated[str | None, Query(max_length=160)] = None,
) -> LiveSearchResponse:
    result = await _service(db).search(
        query,
        user=user,
        country=country.upper() if country else None,
        city=city,
        date_filter=date_filter,
    )
    db.commit()
    return LiveSearchResponse(
        query=result.query,
        status=result.status,
        coverage_message=_coverage_message(result.status),
        events=[_event_response(db, event) for event in result.events],
        artist_matches=[ArtistProviderMatchResponse(**value) for value in result.matches],
        provider_states=result.provider_states,
        provider_results=[
            ProviderSearchOutcomeResponse(
                provider=value.provider,
                status=value.status,
                result_count=value.result_count,
                latency_ms=value.latency_ms,
                match_state=value.match_state,
            )
            for value in result.provider_results
        ],
        cache_state=result.cache_state,
        generated_at=result.generated_at,
    )


@router.get("/live/events/{event_id}", response_model=ConcertEventResponse)
def live_event_detail(event_id: UUID, db: DbSession, user: CurrentUser) -> ConcertEventResponse:
    event = db.get(ConcertEvent, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Concert event not found.")
    recommendation = db.scalar(
        select(LiveRecommendation).where(
            LiveRecommendation.user_id == user.id,
            LiveRecommendation.event_id == event.id,
        )
    )
    return _event_response(db, event, recommendation)


@router.post("/live/refresh", response_model=LiveRefreshResponse)
async def refresh_live(db: DbSession, user: CurrentUser) -> LiveRefreshResponse:
    result = await _service(db).refresh_for_user(user)
    db.commit()
    return LiveRefreshResponse(
        status=result.status,
        seed_count=result.seed_count,
        matched_artists=result.matched_artists,
        event_count=result.event_count,
        generated_at=result.generated_at,
    )


@router.get("/live/preferences", response_model=LivePreferenceResponse)
def live_preferences(db: DbSession, user: CurrentUser) -> LivePreferenceResponse:
    preference = db.scalar(
        select(UserLivePreference).where(UserLivePreference.user_id == user.id)
    )
    return LivePreferenceResponse(
        country=preference.country if preference else None,
        city=preference.city if preference else None,
    )


@router.patch("/live/preferences", response_model=LivePreferenceResponse)
def update_live_preferences(
    payload: LivePreferenceRequest, db: DbSession, user: CurrentUser
) -> LivePreferenceResponse:
    preference = db.scalar(
        select(UserLivePreference).where(UserLivePreference.user_id == user.id)
    )
    if preference is None:
        preference = UserLivePreference(user_id=user.id)
        db.add(preference)
    preference.country = payload.country.upper() if payload.country else None
    preference.city = payload.city.strip() if payload.city and payload.city.strip() else None
    db.commit()
    return LivePreferenceResponse(country=preference.country, city=preference.city)


@router.get("/live/providers", response_model=list[ConcertProviderResponse])
def live_providers() -> list[ConcertProviderResponse]:
    return [
        ConcertProviderResponse(
            provider=provider.provider_name,
            tier=(
                "core"
                if provider.provider_name in {"ticketmaster", "asiaworld_expo"}
                else "experimental"
            ),
            enabled=provider.health().state.value != "NOT_CONFIGURED",
            health=provider.health().state.value,
            capabilities=sorted(capability.value for capability in provider.capabilities),
        )
        for provider in _providers()
    ]


@router.get("/artists/{artist_id}/live", response_model=LiveFeedResponse)
def artist_live(artist_id: UUID, db: DbSession, user: CurrentUser) -> LiveFeedResponse:
    rows = list(
        db.execute(
            select(LiveRecommendation, ConcertEvent)
            .join(ConcertEvent, ConcertEvent.id == LiveRecommendation.event_id)
            .where(
                LiveRecommendation.user_id == user.id,
                LiveRecommendation.artist_id == artist_id,
                ConcertEvent.start_date >= datetime.now(UTC).date(),
            )
            .order_by(ConcertEvent.start_date, ConcertEvent.id)
            .limit(8)
        )
    )
    status = "OK" if rows else "EMPTY"
    return LiveFeedResponse(
        status=status,
        coverage_message=_coverage_message(status),
        events=[_event_response(db, event, recommendation) for recommendation, event in rows],
        provider_states={},
        generated_at=max((recommendation.generated_at for recommendation, _ in rows), default=None),
        stale=any(_is_expired(recommendation.expires_at) for recommendation, _ in rows),
    )
