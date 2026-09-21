from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, time
from typing import Any

import httpx

from app.providers.concert import (
    ArtistMatchResult,
    ArtistMatchState,
    CapabilityProvider,
    ConcertCapability,
    ProviderArtistMatch,
    ProviderConcertEvent,
    ProviderHealth,
    ProviderHealthState,
    ProviderPerformer,
    ProviderVenue,
    is_safe_public_url,
    normalize_artist_name,
)
from app.providers.errors import ProviderNotConfigured, ProviderRateLimited, ProviderTemporarilyUnavailable

TICKETMASTER_BASE_URL = "https://app.ticketmaster.com/discovery/v2"


class TicketmasterProviderError(ProviderTemporarilyUnavailable):
    code = "ticketmaster_unavailable"


class TicketmasterRateLimited(ProviderRateLimited):
    code = "ticketmaster_rate_limited"


class TicketmasterUnauthorized(TicketmasterProviderError):
    code = "ticketmaster_unauthorized"
    retryable = False


class TicketmasterProvider(CapabilityProvider):
    provider_name = "ticketmaster"
    capabilities = frozenset(ConcertCapability)

    def __init__(
        self,
        api_key: str | None,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 6.0,
        min_interval_seconds: float = 0.5,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._api_key = api_key
        self._client = client
        self._timeout = timeout_seconds
        self._min_interval = min_interval_seconds
        self._sleep = sleep
        self._last_request_at = 0.0
        self._state = ProviderHealthState.HEALTHY if api_key else ProviderHealthState.NOT_CONFIGURED
        self._safe_code: str | None = None

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider_name,
            state=self._state,
            checked_at=datetime.now(UTC),
            safe_code=self._safe_code,
        )

    async def search_artists(self, query: str) -> ArtistMatchResult:
        payload = await self._request(
            "/attractions.json", {"keyword": query, "size": 20, "locale": "*"}
        )
        attractions = payload.get("_embedded", {}).get("attractions", [])
        candidates = tuple(self._artist_match(item) for item in attractions if item.get("id"))
        normalized_query = normalize_artist_name(query)
        exact = tuple(
            candidate
            for candidate in candidates
            if normalized_query
            in {
                normalize_artist_name(candidate.name),
                *(normalize_artist_name(alias) for alias in candidate.aliases),
            }
        )
        if len(exact) == 1:
            return ArtistMatchResult(ArtistMatchState.MATCHED, query, exact)
        if len(exact) > 1:
            return ArtistMatchResult(ArtistMatchState.AMBIGUOUS, query, exact)
        return ArtistMatchResult(ArtistMatchState.NOT_FOUND, query)

    async def search_events(
        self,
        *,
        query: str | None = None,
        attraction_id: str | None = None,
        country: str | None = None,
        city: str | None = None,
        page_budget: int = 1,
    ) -> list[ProviderConcertEvent]:
        page_limit = max(1, min(page_budget, 3))
        events: list[ProviderConcertEvent] = []
        for page in range(page_limit):
            params: dict[str, object] = {
                "size": 20,
                "page": page,
                "sort": "date,asc",
                "classificationName": "music",
                "locale": "*",
            }
            if query:
                params["keyword"] = query
            if attraction_id:
                params["attractionId"] = attraction_id
            if country:
                params["countryCode"] = country.upper()
            if city:
                params["city"] = city
            payload = await self._request("/events.json", params)
            raw_events = payload.get("_embedded", {}).get("events", [])
            events.extend(self._event(item) for item in raw_events if self._valid_event(item))
            total_pages = int(payload.get("page", {}).get("totalPages", 0) or 0)
            if page + 1 >= total_pages or (page + 1) * 20 >= 1000:
                break
        return events

    async def get_event(self, provider_event_id: str) -> ProviderConcertEvent:
        payload = await self._request(f"/events/{provider_event_id}.json", {"locale": "*"})
        if not self._valid_event(payload):
            raise TicketmasterProviderError("Ticketmaster event data was incomplete.")
        return self._event(payload)

    async def _request(self, path: str, params: dict[str, object]) -> dict[str, Any]:
        if not self._api_key:
            self._state = ProviderHealthState.NOT_CONFIGURED
            raise ProviderNotConfigured("Ticketmaster is not configured.")
        request_params = {**params, "apikey": self._api_key}
        for attempt in range(2):
            try:
                await self._rate_limit()
                if self._client is not None:
                    response = await self._client.get(path, params=request_params, timeout=self._timeout)
                else:
                    async with httpx.AsyncClient(base_url=TICKETMASTER_BASE_URL) as client:
                        response = await client.get(path, params=request_params, timeout=self._timeout)
                if response.status_code == 401:
                    self._state = ProviderHealthState.UNAVAILABLE
                    self._safe_code = "UNAUTHORIZED"
                    raise TicketmasterUnauthorized("Ticketmaster rejected the configured API key.")
                if response.status_code == 429:
                    self._state = ProviderHealthState.RATE_LIMITED
                    self._safe_code = "RATE_LIMITED"
                    if attempt == 0:
                        await self._sleep(0.5)
                        continue
                    raise TicketmasterRateLimited("Ticketmaster rate limit reached.")
                if response.status_code >= 500:
                    if attempt == 0:
                        await self._sleep(0.25)
                        continue
                    raise TicketmasterProviderError("Ticketmaster is temporarily unavailable.")
                if response.status_code >= 400:
                    self._state = ProviderHealthState.UNAVAILABLE
                    self._safe_code = f"HTTP_{response.status_code}"
                    raise TicketmasterProviderError("Ticketmaster rejected the discovery request.")
                response.raise_for_status()
                self._state = ProviderHealthState.HEALTHY
                self._safe_code = None
                return response.json()
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt == 0:
                    await self._sleep(0.25)
                    continue
                self._state = ProviderHealthState.UNAVAILABLE
                self._safe_code = "TIMEOUT"
                raise TicketmasterProviderError("Ticketmaster request timed out.") from exc
        raise TicketmasterProviderError("Ticketmaster request failed.")

    async def _rate_limit(self) -> None:
        loop = asyncio.get_running_loop()
        delay = self._min_interval - (loop.time() - self._last_request_at)
        if delay > 0:
            await self._sleep(delay)
        self._last_request_at = loop.time()

    @staticmethod
    def _artist_match(item: dict[str, Any]) -> ProviderArtistMatch:
        images = item.get("images", [])
        artwork = max(images, key=lambda image: image.get("width", 0), default={}).get("url")
        aliases = tuple(
            alias for alias in item.get("aliases", []) if isinstance(alias, str) and alias.strip()
        )
        return ProviderArtistMatch(str(item["id"]), str(item.get("name") or "Unknown"), aliases, artwork)

    @staticmethod
    def _valid_event(item: dict[str, Any]) -> bool:
        start = item.get("dates", {}).get("start", {})
        return bool(
            item.get("id")
            and item.get("name")
            and start.get("localDate")
            and is_safe_public_url(item.get("url"))
        )

    @staticmethod
    def _event(item: dict[str, Any]) -> ProviderConcertEvent:
        embedded = item.get("_embedded", {})
        performers = tuple(
            ProviderPerformer(str(value.get("name") or "Unknown"), value.get("id"))
            for value in embedded.get("attractions", [])
        )
        venue_raw = next(iter(embedded.get("venues", [])), {})
        location = venue_raw.get("location", {})
        start = item["dates"]["start"]
        local_time = None
        if start.get("localTime") and not start.get("noSpecificTime") and not start.get("timeTBA"):
            local_time = time.fromisoformat(start["localTime"])
        image = max(
            item.get("images", []),
            key=lambda value: (
                value.get("ratio") == "16_9",
                not value.get("fallback", False),
                value.get("width", 0),
            ),
            default={},
        ).get("url")
        url = str(item["url"])
        return ProviderConcertEvent(
            provider="ticketmaster",
            provider_event_id=str(item["id"]),
            title=str(item["name"]),
            performers=performers,
            primary_artist_name=performers[0].name if performers else None,
            start_date=date.fromisoformat(start["localDate"]),
            start_time=local_time,
            timezone=item.get("dates", {}).get("timezone"),
            venue=ProviderVenue(
                name=venue_raw.get("name"),
                address=venue_raw.get("address", {}).get("line1"),
                city=venue_raw.get("city", {}).get("name"),
                region=venue_raw.get("state", {}).get("name") or venue_raw.get("state", {}).get("stateCode"),
                country=venue_raw.get("country", {}).get("countryCode")
                or venue_raw.get("country", {}).get("name"),
                latitude=float(location["latitude"]) if location.get("latitude") else None,
                longitude=float(location["longitude"]) if location.get("longitude") else None,
            ),
            artwork_url=image,
            event_url=url,
            ticket_url=url,
            status=item.get("dates", {}).get("status", {}).get("code"),
            observed_at=datetime.now(UTC),
            metadata={"source": item.get("source", {}).get("name")},
        )
