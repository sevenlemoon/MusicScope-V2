import asyncio
import json
from datetime import date, datetime

import httpx
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.domain.models import (
    ArtistSearchAlias,
    ConcertEvent,
    ConcertEventSource,
    LiveSearchCache,
    User,
)
from app.providers.errors import ProviderTemporarilyUnavailable
from app.providers.verified_live import (
    DEFAULT_VERIFIED_LIVE_REGISTRY,
    MAX_OFFICIAL_PAGE_BYTES,
    TOGENASHI_IDENTITY,
    VerifiedLiveSource,
    VerifiedLiveSourceRegistry,
    VerifiedOfficialSourceProvider,
)
from app.services.concert_aggregator import ConcertAggregator, LiveResultStatus
from app.services.live_concerts import LiveConcertService


async def public_resolver(_host: str, _port: int) -> list[str]:
    return ["93.184.216.34"]


def official_page(
    *,
    start: str = "2031-09-30",
    end: str = "2031-10-02",
    slots: tuple[str, ...] = ("2031-09-30 19:00", "2031-10-02 19:00"),
) -> str:
    schema = {
        "@context": "https://schema.org",
        "@type": "Event",
        "name": "TOGENASHI TOGEARI Live in HONG KONG「凛音の理」Special Edition",
        "startDate": start,
        "endDate": end,
        "location": {
            "@type": "Place",
            "name": "AsiaWorld-Expo",
            "address": {
                "@type": "PostalAddress",
                "streetAddress": "Hong Kong International Airport",
                "addressLocality": "Lantau",
                "addressCountry": "Hong Kong",
            },
        },
        "image": "https://www.asiaworld-expo.com/media/event.jpg",
    }
    options = "".join(
        f'<option value="/ics-generator?event=source&amp;startDate={value}">{value}</option>'
        for value in slots
    )
    return (
        '<html><script type="application/ld+json">'
        f"{json.dumps(schema)}"
        "</script><a class=\"detail-inner-main-location\">AsiaWorld-Summit (Hall 2)</a>"
        f'<select>{options}</select><article id="ticket-sales">'
        '<a href="http://www.cityline.com/">Tickets</a></article></html>'
    )


def source() -> VerifiedLiveSource:
    return DEFAULT_VERIFIED_LIVE_REGISTRY.sources_for_provider("asiaworld_expo")[0]


def response(request: httpx.Request, body: str, status: int = 200, **headers: str) -> httpx.Response:
    return httpx.Response(
        status,
        text=body,
        headers={"content-type": "text/html; charset=utf-8", **headers},
        request=request,
    )


def provider_with_handler(handler) -> tuple[VerifiedOfficialSourceProvider, httpx.AsyncClient]:  # type: ignore[no-untyped-def]
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = VerifiedOfficialSourceProvider(
        "asiaworld_expo", client=client, resolver=public_resolver
    )
    return provider, client


def database() -> tuple[Session, User]:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine)
    user = User(display_name="Verified source listener")
    session.add(user)
    session.flush()
    return session, user


def test_registry_matches_only_explicit_authoritatively_verified_aliases() -> None:
    assert DEFAULT_VERIFIED_LIVE_REGISTRY.artist_matches("TOGENASHI TOGEARI")[0].key == (
        "togenashi-togeari"
    )
    assert DEFAULT_VERIFIED_LIVE_REGISTRY.artist_matches("トゲナシトゲアリ")[0].key == (
        "togenashi-togeari"
    )
    assert DEFAULT_VERIFIED_LIVE_REGISTRY.artist_matches("Togenashi Togeari")
    assert not DEFAULT_VERIFIED_LIVE_REGISTRY.artist_matches("Hatsune Miku")
    assert TOGENASHI_IDENTITY.evidence_source == "universal_music_jp"
    assert all(
        url.startswith("https://www.universal-music.co.jp/")
        for url in TOGENASHI_IDENTITY.evidence_urls
    )


def test_json_ld_and_bounded_rendered_slots_drive_event_data() -> None:
    first_page = official_page(
        start="2032-11-04",
        end="2032-11-07",
        slots=("2032-11-04 18:15", "2032-11-07 20:45"),
    )
    events = VerifiedOfficialSourceProvider._parse_page(source(), first_page)
    assert [event.start_date.isoformat() for event in events] == ["2032-11-04", "2032-11-07"]
    assert [event.start_time.isoformat() for event in events] == ["18:15:00", "20:45:00"]
    assert {event.venue.name for event in events} == {"AsiaWorld-Summit (Hall 2)"}
    assert {event.venue.address for event in events} == {"Hong Kong International Airport"}
    assert {event.event_url for event in events} == {source().event_url}
    assert {event.ticket_url for event in events} == {"https://www.cityline.com/"}
    assert {event.provider for event in events} == {"asiaworld_expo"}
    assert all(event.metadata["source_type"] == "schema_org_event" for event in events)


def test_schema_start_date_is_used_when_optional_timeslot_markup_is_absent() -> None:
    events = VerifiedOfficialSourceProvider._parse_page(
        source(), official_page(start="2033-04-08", end="2033-04-08", slots=())
    )
    assert len(events) == 1
    assert events[0].start_date == date(2033, 4, 8)
    assert events[0].start_time is None
    assert events[0].metadata["performance_evidence"] == "schema_org_start_date"


def test_first_party_json_ld_literal_newline_is_tolerated() -> None:
    page = official_page().replace("Special Edition\"", "Special\nEdition\"")
    events = VerifiedOfficialSourceProvider._parse_page(source(), page)
    assert len(events) == 2


def test_parser_change_timeout_and_unavailable_are_not_verified_empty_results() -> None:
    async def malformed_handler(request: httpx.Request) -> httpx.Response:
        return response(request, "<html>layout changed</html>")

    async def timeout_handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow official source")

    async def unavailable_handler(request: httpx.Request) -> httpx.Response:
        return response(request, "maintenance", status=503)

    async def run(handler):  # type: ignore[no-untyped-def]
        provider, client = provider_with_handler(handler)
        try:
            return await ConcertAggregator([provider]).search_artist("TOGENASHI TOGEARI")
        finally:
            await client.aclose()

    malformed = asyncio.run(run(malformed_handler))
    timed_out = asyncio.run(run(timeout_handler))
    unavailable = asyncio.run(run(unavailable_handler))
    assert malformed.status == LiveResultStatus.PROVIDER_UNAVAILABLE
    assert malformed.provider_results[0].status == "PARSER_CHANGED"
    assert timed_out.status == LiveResultStatus.PROVIDER_UNAVAILABLE
    assert timed_out.provider_results[0].status == "TIMEOUT"
    assert unavailable.status == LiveResultStatus.PROVIDER_UNAVAILABLE
    assert unavailable.provider_results[0].status == "UNAVAILABLE"
    assert not malformed.events and not timed_out.events and not unavailable.events


def test_verified_past_event_is_a_real_zero_result() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return response(
            request,
            official_page(start="2020-01-01", end="2020-01-01", slots=("2020-01-01 19:00",)),
        )

    async def run():  # type: ignore[no-untyped-def]
        provider, client = provider_with_handler(handler)
        try:
            return await ConcertAggregator([provider]).search_artist("TOGENASHI TOGEARI")
        finally:
            await client.aclose()

    result = asyncio.run(run())
    assert result.status == LiveResultStatus.NO_UPCOMING_EVENTS
    assert result.provider_results[0].status == "SUCCESS"


def test_ssrf_policy_rejects_non_public_dns_and_cross_host_redirects() -> None:
    async def private_resolver(_host: str, _port: int) -> list[str]:
        return ["127.0.0.1"]

    blocked = VerifiedOfficialSourceProvider(
        "asiaworld_expo", resolver=private_resolver
    )
    with pytest.raises(ProviderTemporarilyUnavailable, match="non-public"):
        asyncio.run(blocked._validate_target(source().event_url, source().allowed_hosts))

    async def redirect_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"location": "https://127.0.0.1/internal"},
            request=request,
        )

    async def run_redirect() -> None:
        provider, client = provider_with_handler(redirect_handler)
        try:
            await provider.search_events(attraction_id="togenashi-togeari")
        finally:
            await client.aclose()

    with pytest.raises(ProviderTemporarilyUnavailable, match="URL was rejected"):
        asyncio.run(run_redirect())


def test_ssrf_configuration_rejects_http_credentials_ports_and_untrusted_hosts() -> None:
    invalid_urls = (
        "http://www.asiaworld-expo.com/event",
        "https://user:secret@www.asiaworld-expo.com/event",
        "https://www.asiaworld-expo.com:8443/event",
        "https://www.asiaworld-expo.com:invalid/event",
        "https://evil.example/event",
    )
    for url in invalid_urls:
        with pytest.raises(ValueError, match="Unsafe verified live source"):
            VerifiedLiveSourceRegistry(
                (
                    VerifiedLiveSource(
                        source_id="unsafe",
                        provider_name="official",
                        event_url=url,
                        allowed_hosts=frozenset({"www.asiaworld-expo.com"}),
                        artist=TOGENASHI_IDENTITY,
                    ),
                )
            )


def test_response_size_and_type_are_bounded() -> None:
    async def oversized_handler(request: httpx.Request) -> httpx.Response:
        return response(request, "ok", **{"content-length": str(MAX_OFFICIAL_PAGE_BYTES + 1)})

    async def wrong_type_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"{}",
            headers={"content-type": "application/json"},
            request=request,
        )

    async def run(handler):  # type: ignore[no-untyped-def]
        provider, client = provider_with_handler(handler)
        try:
            await provider.search_events(attraction_id="togenashi-togeari")
        finally:
            await client.aclose()

    with pytest.raises(ProviderTemporarilyUnavailable, match="size limit"):
        asyncio.run(run(oversized_handler))

    async def invalid_size_handler(request: httpx.Request) -> httpx.Response:
        return response(request, "ok", **{"content-length": "invalid"})

    with pytest.raises(ProviderTemporarilyUnavailable, match="size was invalid"):
        asyncio.run(run(invalid_size_handler))
    result = asyncio.run(
        _aggregated_provider_result(wrong_type_handler)
    )
    assert result.provider_results[0].status == "PARSER_CHANGED"


def test_ticket_navigation_accepts_only_the_explicit_verified_host() -> None:
    assert (
        VerifiedOfficialSourceProvider._safe_ticket_url(
            "http://www.cityline.com/shows/123", frozenset({"www.cityline.com"})
        )
        == "https://www.cityline.com/shows/123"
    )
    assert (
        VerifiedOfficialSourceProvider._safe_ticket_url(
            "https://evil.example/redirect", frozenset({"www.cityline.com"})
        )
        is None
    )
    assert (
        VerifiedOfficialSourceProvider._safe_ticket_url(
            "https://www.cityline.com:invalid/shows/123", frozenset({"www.cityline.com"})
        )
        is None
    )


async def _aggregated_provider_result(handler):  # type: ignore[no-untyped-def]
    provider, client = provider_with_handler(handler)
    try:
        return await ConcertAggregator([provider]).search_artist("TOGENASHI TOGEARI")
    finally:
        await client.aclose()


def test_materialization_preserves_official_provenance_alias_and_idempotency() -> None:
    db, user = database()

    async def handler(request: httpx.Request) -> httpx.Response:
        return response(request, official_page())

    async def run_search():  # type: ignore[no-untyped-def]
        provider, client = provider_with_handler(handler)
        service = LiveConcertService(db, ConcertAggregator([provider]), search_cache_minutes=30)
        try:
            first = await service.search("TOGENASHI TOGEARI", user=user)
            second = await service.search("トゲナシトゲアリ", user=user)
            return first, second
        finally:
            await client.aclose()

    first, second = asyncio.run(run_search())
    assert first.cache_state == "miss"
    assert second.cache_state == "fresh"
    assert len(first.events) == 2
    assert {source.provider for source in db.scalars(select(ConcertEventSource))} == {
        "asiaworld_expo"
    }
    assert db.scalar(select(func.count()).select_from(ConcertEvent)) == 2
    assert db.scalar(select(func.count()).select_from(ConcertEventSource)) == 2
    alias = db.scalar(select(ArtistSearchAlias))
    assert alias is not None
    assert alias.alias == "トゲナシトゲアリ"
    assert alias.canonical_name == "TOGENASHI TOGEARI"
    assert alias.source == "universal_music_jp"
    assert alias.verified is True
    assert first.events[0].source_metadata["canonical_provider"] == "asiaworld_expo"


def test_stale_official_events_survive_partial_zero_event_refresh() -> None:
    db, user = database()

    async def healthy_handler(request: httpx.Request) -> httpx.Response:
        return response(request, official_page())

    class VerifiedEmptyProvider:
        provider_name = "ticketmaster"
        capabilities = VerifiedOfficialSourceProvider.capabilities

        def __init__(self, delegate: VerifiedOfficialSourceProvider) -> None:
            self.delegate = delegate

        async def search_artists(self, query: str):  # type: ignore[no-untyped-def]
            return await self.delegate.search_artists(query)

        async def search_events(self, **_kwargs: object):  # type: ignore[no-untyped-def]
            return []

        def health(self):  # type: ignore[no-untyped-def]
            return self.delegate.health()

    provider, client = provider_with_handler(healthy_handler)
    empty = VerifiedEmptyProvider(provider)
    service = LiveConcertService(
        db, ConcertAggregator([empty, provider]), search_cache_minutes=30  # type: ignore[list-item]
    )
    asyncio.run(service.search("TOGENASHI TOGEARI", user=user))
    asyncio.run(client.aclose())
    cache = db.scalar(select(LiveSearchCache))
    assert cache is not None
    cache.expires_at = datetime(2020, 1, 1)

    async def changed_handler(request: httpx.Request) -> httpx.Response:
        return response(request, "<html>changed</html>")

    changed, changed_client = provider_with_handler(changed_handler)
    service.aggregator = ConcertAggregator(
        [VerifiedEmptyProvider(changed), changed]  # type: ignore[list-item]
    )
    stale = asyncio.run(service.search("TOGENASHI TOGEARI", user=user))
    asyncio.run(changed_client.aclose())
    assert stale.cache_state == "stale"
    assert stale.status == "PARTIAL_RESULTS"
    assert len(stale.events) == 2
