import asyncio
from dataclasses import replace
from datetime import UTC, date, datetime, time
from time import perf_counter

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.domain.models import (
    Artist,
    ConcertEvent,
    ConcertEventSource,
    LiveRecommendation,
    LiveSearchCache,
    RecommendationProfile,
    RecommendationProfileArtist,
    User,
    UserLivePreference,
)
from app.providers.concert import (
    ArtistMatchResult,
    ArtistMatchState,
    ConcertCapability,
    ProviderArtistMatch,
    ProviderConcertEvent,
    ProviderHealth,
    ProviderHealthState,
    ProviderPerformer,
    ProviderVenue,
)
from app.providers.concert_experimental import MaoyanProvider
from app.providers.errors import ProviderCapabilityUnavailable, ProviderTemporarilyUnavailable
from app.services.concert_aggregator import (
    ConcertAggregator,
    LiveResultStatus,
    ProviderCircuitBreaker,
)
from app.services.live_concerts import LiveConcertService


class FakeProvider:
    provider_name = "ticketmaster"
    capabilities = frozenset(ConcertCapability)

    def __init__(self, events: list[ProviderConcertEvent]) -> None:
        self.events = events
        self.artist_calls = 0
        self.event_calls = 0

    async def search_artists(self, query: str) -> ArtistMatchResult:
        self.artist_calls += 1
        return ArtistMatchResult(
            ArtistMatchState.MATCHED,
            query,
            (ProviderArtistMatch("artist-1", query),),
        )

    async def search_events(self, **_kwargs: object) -> list[ProviderConcertEvent]:
        self.event_calls += 1
        return self.events

    async def get_event(self, provider_event_id: str) -> ProviderConcertEvent:
        return self.events[0]

    def health(self) -> ProviderHealth:
        return ProviderHealth("ticketmaster", ProviderHealthState.HEALTHY, datetime.now(UTC))


class FailingProvider(FakeProvider):
    provider_name = "kktix"

    async def search_artists(self, query: str) -> ArtistMatchResult:
        raise ProviderTemporarilyUnavailable("safe failure")


class DirectSearchProvider(FakeProvider):
    capabilities = frozenset({ConcertCapability.EVENT_SEARCH})

    def __init__(
        self, provider_name: str, events: list[ProviderConcertEvent], *, delay: float = 0
    ) -> None:
        super().__init__(events)
        self.provider_name = provider_name
        self.delay = delay

    async def search_events(self, **_kwargs: object) -> list[ProviderConcertEvent]:
        self.event_calls += 1
        await asyncio.sleep(self.delay)
        return self.events


def provider_event(
    provider: str,
    provider_id: str,
    *,
    venue: str = "Tokyo Garden Theater",
    city: str = "Tokyo",
    title: str = "milet Asia Tour",
    start_time: time = time(19, 30),
    status: str = "onsale",
) -> ProviderConcertEvent:
    return ProviderConcertEvent(
        provider=provider,
        provider_event_id=provider_id,
        title=title,
        performers=(ProviderPerformer("milet", "artist-1"),),
        primary_artist_name="milet",
        start_date=date(2027, 3, 14),
        start_time=start_time,
        timezone="Asia/Tokyo",
        venue=ProviderVenue(name=venue, city=city, country="JP"),
        artwork_url="https://img.example/event.jpg",
        event_url=f"https://events.example/{provider_id}",
        ticket_url=f"https://tickets.example/{provider_id}",
        status=status,
        observed_at=datetime.now(UTC),
    )


def database() -> tuple[Session, User]:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine)
    user = User(display_name="Live listener")
    session.add(user)
    session.flush()
    return session, user


def test_same_provider_identity_is_idempotent() -> None:
    db, _user = database()
    service = LiveConcertService(db, ConcertAggregator([]))
    event = provider_event("ticketmaster", "tm-1")
    service.materialize((event,))
    service.materialize((event,))
    assert db.scalar(select(func.count()).select_from(ConcertEvent)) == 1
    assert db.scalar(select(func.count()).select_from(ConcertEventSource)) == 1


def test_same_provider_refresh_updates_status_without_multiplying_rows() -> None:
    db, _user = database()
    service = LiveConcertService(db, ConcertAggregator([]))
    service.materialize((provider_event("ticketmaster", "tm-1"),))
    service.materialize((provider_event("ticketmaster", "tm-1", status="cancelled"),))
    event = db.scalar(select(ConcertEvent))
    source = db.scalar(select(ConcertEventSource))
    assert event is not None and source is not None
    assert event.status == "cancelled"
    assert source.status == "cancelled"
    assert db.scalar(select(func.count()).select_from(ConcertEvent)) == 1
    assert db.scalar(select(func.count()).select_from(ConcertEventSource)) == 1


def test_sparse_same_provider_refresh_does_not_erase_verified_detail() -> None:
    db, _user = database()
    service = LiveConcertService(db, ConcertAggregator([]))
    rich = replace(
        provider_event("ticketmaster", "tm-1"),
        venue=ProviderVenue(
            name="Tokyo Garden Theater",
            address="2-1-6 Ariake",
            city="Tokyo",
            country="JP",
            latitude=35.6396,
            longitude=139.7883,
        ),
    )
    sparse = replace(
        rich,
        start_time=None,
        timezone=None,
        venue=ProviderVenue(name="Tokyo Garden Theater", city="Tokyo"),
        artwork_url=None,
        ticket_url=None,
        status=None,
        metadata={},
    )
    service.materialize((rich,))
    service.materialize((sparse,))
    event = db.scalar(select(ConcertEvent))
    source = db.scalar(select(ConcertEventSource))
    assert event is not None and source is not None
    assert event.start_time == time(19, 30)
    assert event.timezone == "Asia/Tokyo"
    assert event.venue_address == "2-1-6 Ariake"
    assert event.latitude == 35.6396
    assert event.longitude == 139.7883
    assert event.artwork_url == "https://img.example/event.jpg"
    assert event.status == "onsale"
    assert source.source_payload["normalized"]["venue"]["address"] == "2-1-6 Ariake"
    assert source.source_payload["normalized"]["start_time"] == "19:30:00"


def test_strong_cross_provider_evidence_merges_and_retains_sources() -> None:
    db, _user = database()
    service = LiveConcertService(db, ConcertAggregator([]))
    service.materialize((provider_event("ticketmaster", "tm-1"),))
    service.materialize((provider_event("maoyan", "my-1"),))
    assert db.scalar(select(func.count()).select_from(ConcertEvent)) == 1
    assert db.scalar(select(func.count()).select_from(ConcertEventSource)) == 2


def test_same_artist_and_date_at_different_venue_stays_separate() -> None:
    db, _user = database()
    service = LiveConcertService(db, ConcertAggregator([]))
    service.materialize((provider_event("ticketmaster", "tm-1"),))
    service.materialize((provider_event("maoyan", "my-1", venue="Zepp Osaka", city="Osaka"),))
    assert db.scalar(select(func.count()).select_from(ConcertEvent)) == 2


def test_uncertain_title_similarity_stays_separate() -> None:
    db, _user = database()
    service = LiveConcertService(db, ConcertAggregator([]))
    service.materialize((provider_event("ticketmaster", "tm-1"),))
    service.materialize((provider_event("maoyan", "my-1", title="Completely Different Festival"),))
    assert db.scalar(select(func.count()).select_from(ConcertEvent)) == 2


def test_conflicting_source_fields_are_retained_with_deterministic_precedence() -> None:
    db, _user = database()
    service = LiveConcertService(db, ConcertAggregator([]))
    service.materialize(
        (provider_event("maoyan", "my-1", start_time=time(20), status="cancelled"),)
    )
    service.materialize((provider_event("ticketmaster", "tm-1"),))
    event = db.scalar(select(ConcertEvent))
    sources = list(db.scalars(select(ConcertEventSource).order_by(ConcertEventSource.provider)))
    assert event is not None
    assert str(event.start_time) == "19:30:00"
    assert event.status == "onsale"
    assert event.source_metadata["canonical_provider"] == "ticketmaster"
    assert len(sources) == 2
    assert sources[0].source_payload["normalized"]["start_time"] == "20:00:00"
    assert sources[0].source_payload["normalized"]["status"] == "cancelled"


def test_repeated_search_uses_verified_cache_without_provider_call() -> None:
    db, user = database()
    provider = FakeProvider([provider_event("ticketmaster", "tm-1")])
    service = LiveConcertService(db, ConcertAggregator([provider]), search_cache_minutes=30)
    first = asyncio.run(service.search("milet", user=user))
    second = asyncio.run(service.search("milet", user=user))
    assert first.cache_state == "miss"
    assert second.cache_state == "fresh"
    assert provider.artist_calls == 1
    assert provider.event_calls == 1


def test_stale_verified_search_cache_survives_provider_failure() -> None:
    db, user = database()
    provider = FakeProvider([provider_event("ticketmaster", "tm-1")])
    service = LiveConcertService(db, ConcertAggregator([provider]), search_cache_minutes=30)
    asyncio.run(service.search("milet", user=user))
    cache = db.scalar(select(LiveSearchCache))
    assert cache is not None
    cache.expires_at = datetime(2020, 1, 1)
    failing = FailingProvider([])
    failing.provider_name = "ticketmaster"
    service.aggregator = ConcertAggregator([failing])
    stale = asyncio.run(service.search("milet", user=user))
    assert stale.cache_state == "stale"
    assert stale.status == "PARTIAL_RESULTS"
    assert len(stale.events) == 1


def test_experimental_failure_does_not_discard_core_results() -> None:
    core = FakeProvider([provider_event("ticketmaster", "tm-1")])
    result = asyncio.run(
        ConcertAggregator([core, FailingProvider([])]).search_artist("milet")
    )
    assert result.status == LiveResultStatus.PARTIAL_RESULTS
    assert len(result.events) == 1
    assert result.provider_states["kktix"] == "UNAVAILABLE"
    assert {value.provider: value.status for value in result.provider_results} == {
        "ticketmaster": "SUCCESS",
        "kktix": "UNAVAILABLE",
    }


def test_independent_event_search_providers_run_concurrently() -> None:
    first = DirectSearchProvider("first", [provider_event("first", "one")], delay=0.05)
    second = DirectSearchProvider("second", [provider_event("second", "two")], delay=0.05)
    started = perf_counter()
    result = asyncio.run(ConcertAggregator([first, second]).search_artist("milet"))
    elapsed = perf_counter() - started
    assert result.status == LiveResultStatus.OK
    assert len(result.events) == 2
    assert elapsed < 0.09


def test_slow_provider_hits_deadline_without_discarding_fast_results() -> None:
    fast = DirectSearchProvider("fast", [provider_event("fast", "one")])
    slow = DirectSearchProvider("slow", [], delay=0.2)
    result = asyncio.run(
        ConcertAggregator(
            [fast, slow], provider_timeout_seconds=0.05, search_deadline_seconds=0.1
        ).search_artist("milet")
    )
    assert result.status == LiveResultStatus.PARTIAL_RESULTS
    assert len(result.events) == 1
    outcomes = {value.provider: value.status for value in result.provider_results}
    assert outcomes == {"fast": "SUCCESS", "slow": "TIMEOUT"}


def test_unsupported_experimental_capability_fails_explicitly() -> None:
    provider = MaoyanProvider(enabled=True)
    with __import__("pytest").raises(ProviderCapabilityUnavailable):
        asyncio.run(provider.search_artists("milet"))


def test_personalization_is_bounded_user_scoped_and_location_aware() -> None:
    db, user = database()
    other = User(display_name="Other listener")
    artist = Artist(name="milet")
    db.add_all([other, artist])
    db.flush()
    profile = RecommendationProfile(user_id=user.id, profile_type="library_taste", version=2)
    db.add(profile)
    db.flush()
    db.add(
        RecommendationProfileArtist(
            profile_id=profile.id,
            artist_id=artist.id,
            affinity=0.9,
            confidence=0.8,
            distinct_tracks=32,
            distinct_playlists=7,
            weighted_memberships=20,
            repeated_memberships=2,
            represented_albums=3,
            collaboration_tracks=1,
            evidence={},
        )
    )
    db.add(UserLivePreference(user_id=user.id, country="JP", city="Tokyo"))
    db.flush()
    provider = FakeProvider([provider_event("ticketmaster", "tm-1")])
    service = LiveConcertService(db, ConcertAggregator([provider]), seed_budget=12)
    result = asyncio.run(service.refresh_for_user(user))
    recommendation = db.scalar(select(LiveRecommendation))
    assert result.seed_count == 1
    assert recommendation is not None
    assert recommendation.user_id == user.id
    assert recommendation.evidence["track_count"] == 32
    assert recommendation.evidence["playlist_count"] == 7
    assert recommendation.evidence["location_match"] is True
    assert len(service.cached_feed(user)) == 1
    assert service.cached_feed(other) == []
    assert provider.artist_calls == 1


def test_direct_search_zero_results_do_not_claim_artist_match() -> None:
    db, user = database()
    artist = Artist(name="Ado")
    db.add(artist)
    db.flush()
    profile = RecommendationProfile(user_id=user.id, profile_type="library_taste", version=2)
    db.add(profile)
    db.flush()
    db.add(
        RecommendationProfileArtist(
            profile_id=profile.id,
            artist_id=artist.id,
            affinity=0.9,
            confidence=0.8,
            distinct_tracks=4,
            distinct_playlists=2,
            weighted_memberships=3,
            repeated_memberships=0,
            represented_albums=1,
            collaboration_tracks=0,
            evidence={},
        )
    )
    db.flush()
    provider = DirectSearchProvider("showstart", [])
    result = asyncio.run(
        LiveConcertService(db, ConcertAggregator([provider])).refresh_for_user(user)
    )
    assert result.status == "NO_UPCOMING_EVENTS"
    assert result.matched_artists == 0


def test_cached_feed_read_performs_zero_provider_calls() -> None:
    db, user = database()
    provider = FakeProvider([])
    service = LiveConcertService(db, ConcertAggregator([provider]))
    assert service.cached_feed(user) == []
    assert provider.artist_calls == 0
    assert provider.event_calls == 0


def test_live_for_you_seed_budget_bounds_provider_requests() -> None:
    db, user = database()
    profile = RecommendationProfile(user_id=user.id, profile_type="library_taste", version=2)
    db.add(profile)
    db.flush()
    for index in range(20):
        artist = Artist(name=f"Bounded artist {index}")
        db.add(artist)
        db.flush()
        db.add(
            RecommendationProfileArtist(
                profile_id=profile.id,
                artist_id=artist.id,
                affinity=1 - index / 100,
                confidence=0.9,
                distinct_tracks=20 - index,
                distinct_playlists=2,
                weighted_memberships=2,
                repeated_memberships=0,
                represented_albums=1,
                collaboration_tracks=0,
                evidence={},
            )
        )
    db.flush()
    provider = FakeProvider([provider_event("ticketmaster", "bounded-event")])
    result = asyncio.run(
        LiveConcertService(
            db, ConcertAggregator([provider]), seed_budget=12
        ).refresh_for_user(user)
    )
    assert result.seed_count == 12
    assert provider.artist_calls == 12
    assert provider.event_calls == 12


def test_circuit_breaker_opens_and_recovers() -> None:
    breaker = ProviderCircuitBreaker(failure_threshold=2, cooldown_seconds=60)
    now = datetime.now(UTC)
    breaker.failure("kktix", now)
    assert not breaker.is_open("kktix", now)
    breaker.failure("kktix", now)
    assert breaker.is_open("kktix", now)
    assert not breaker.is_open("kktix", now.replace(year=now.year + 1))
