import asyncio

import httpx
import pytest

from app.providers.concert import ArtistMatchState, normalize_artist_name
from app.providers.ticketmaster import (
    TicketmasterProvider,
    TicketmasterProviderError,
    TicketmasterRateLimited,
    TicketmasterUnauthorized,
)


def response(payload: dict[str, object], status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload)


def event_payload(event_id: str = "tm-1", *, include_time: bool = True) -> dict[str, object]:
    start: dict[str, object] = {"localDate": "2027-03-14"}
    if include_time:
        start["localTime"] = "19:30:00"
    return {
        "id": event_id,
        "name": "milet Asia Tour",
        "url": "https://www.ticketmaster.example/event/tm-1",
        "dates": {
            "start": start,
            "timezone": "Asia/Tokyo",
            "status": {"code": "onsale"},
        },
        "images": [
            {"url": "https://img.example/small.jpg", "ratio": "4_3", "width": 320},
            {"url": "https://img.example/wide.jpg", "ratio": "16_9", "width": 1024},
        ],
        "_embedded": {
            "attractions": [
                {"id": "artist-1", "name": "milet"},
                {"id": "artist-2", "name": "Guest Artist"},
            ],
            "venues": [
                {
                    "name": "Tokyo Garden Theater",
                    "address": {"line1": "2-1 Ariake"},
                    "city": {"name": "Tokyo"},
                    "state": {"name": "Tokyo"},
                    "country": {"countryCode": "JP"},
                    "location": {"latitude": "35.63", "longitude": "139.79"},
                }
            ],
        },
    }


def test_artist_matching_is_exact_unicode_aware_and_preserves_aliases() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert "apikey" in request.url.params
        return response(
            {
                "_embedded": {
                    "attractions": [
                        {
                            "id": "a1",
                            "name": "TOGENASHI TOGEARI",
                            "aliases": ["トゲナシトゲアリ"],
                        }
                    ]
                }
            }
        )

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://ticketmaster.test"
        ) as client:
            provider = TicketmasterProvider("test-key", client=client, min_interval_seconds=0)
            return await provider.search_artists("トゲナシトゲアリ")

    result = asyncio.run(run())
    assert result.state == ArtistMatchState.MATCHED
    assert result.matches[0].name == "TOGENASHI TOGEARI"


def test_ambiguous_exact_artist_does_not_choose_first() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return response(
            {
                "_embedded": {
                    "attractions": [
                        {"id": "a1", "name": "Artist"},
                        {"id": "a2", "name": "ARTIST"},
                    ]
                }
            }
        )

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://ticketmaster.test"
        ) as client:
            return await TicketmasterProvider(
                "test-key", client=client, min_interval_seconds=0
            ).search_artists("artist")

    assert asyncio.run(run()).state == ArtistMatchState.AMBIGUOUS


def test_name_normalization_handles_case_punctuation_and_unicode_without_transliteration() -> None:
    assert normalize_artist_name(" M.I.L.E.T ") == normalize_artist_name("milet")
    assert normalize_artist_name("陈奕迅") == "陈奕迅"
    assert normalize_artist_name("初音ミク") == "初音ミク"
    assert normalize_artist_name("初音ミク") != normalize_artist_name("Hatsune Miku")


def test_event_mapping_preserves_multi_performer_local_time_venue_status_and_artwork() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.params["attractionId"] == "artist-1"
        return response(
            {"_embedded": {"events": [event_payload()]}, "page": {"totalPages": 1}}
        )

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://ticketmaster.test"
        ) as client:
            return await TicketmasterProvider(
                "test-key", client=client, min_interval_seconds=0
            ).search_events(attraction_id="artist-1", page_budget=3)

    events = asyncio.run(run())
    assert calls == 1
    assert [performer.name for performer in events[0].performers] == ["milet", "Guest Artist"]
    assert str(events[0].start_time) == "19:30:00"
    assert events[0].timezone == "Asia/Tokyo"
    assert events[0].venue.address == "2-1 Ariake"
    assert events[0].venue.latitude == 35.63
    assert events[0].status == "onsale"
    assert events[0].artwork_url == "https://img.example/wide.jpg"


def test_date_only_event_keeps_unknown_time_unknown() -> None:
    mapped = TicketmasterProvider._event(event_payload(include_time=False))
    assert mapped.start_time is None


def test_missing_optional_event_fields_remain_unknown() -> None:
    payload = event_payload()
    payload["_embedded"] = {"attractions": [{"id": "artist-1", "name": "milet"}]}
    payload["images"] = []
    mapped = TicketmasterProvider._event(payload)
    assert mapped.venue.name is None
    assert mapped.venue.city is None
    assert mapped.artwork_url is None


def test_pagination_is_bounded() -> None:
    pages: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        pages.append(request.url.params["page"])
        return response(
            {
                "_embedded": {"events": [event_payload(f"event-{len(pages)}")]},
                "page": {"totalPages": 50},
            }
        )

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://ticketmaster.test"
        ) as client:
            return await TicketmasterProvider(
                "test-key", client=client, min_interval_seconds=0
            ).search_events(query="milet", page_budget=99)

    assert len(asyncio.run(run())) == 3
    assert pages == ["0", "1", "2"]


@pytest.mark.parametrize(
    "status,error",
    [
        (400, TicketmasterProviderError),
        (401, TicketmasterUnauthorized),
        (429, TicketmasterRateLimited),
    ],
)
def test_safe_api_errors(status: int, error: type[Exception]) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return response({}, status)

    async def run():  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://ticketmaster.test"
        ) as client:
            await TicketmasterProvider(
                "test-key",
                client=client,
                min_interval_seconds=0,
                sleep=lambda _delay: asyncio.sleep(0),
            ).search_artists("milet")

    with pytest.raises(error):
        asyncio.run(run())


def test_timeout_and_5xx_retry_once_then_fail_safely() -> None:
    timeout_calls = 0

    async def timeout_handler(_request: httpx.Request) -> httpx.Response:
        nonlocal timeout_calls
        timeout_calls += 1
        raise httpx.ReadTimeout("timeout")

    async def server_handler(_request: httpx.Request) -> httpx.Response:
        return response({}, 503)

    async def run(handler):  # type: ignore[no-untyped-def]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://ticketmaster.test"
        ) as client:
            await TicketmasterProvider(
                "test-key",
                client=client,
                min_interval_seconds=0,
                sleep=lambda _delay: asyncio.sleep(0),
            ).search_artists("milet")

    with pytest.raises(TicketmasterProviderError, match="timed out"):
        asyncio.run(run(timeout_handler))
    assert timeout_calls == 2
    with pytest.raises(TicketmasterProviderError, match="temporarily unavailable"):
        asyncio.run(run(server_handler))
