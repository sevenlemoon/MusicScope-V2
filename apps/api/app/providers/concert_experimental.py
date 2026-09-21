from __future__ import annotations

import asyncio
import html
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any

import httpx

from app.providers.concert import (
    ArtistMatchResult,
    CapabilityProvider,
    ConcertCapability,
    ProviderConcertEvent,
    ProviderHealth,
    ProviderHealthState,
    ProviderPerformer,
    ProviderVenue,
    is_safe_public_url,
    normalize_artist_name,
)
from app.providers.errors import (
    ProviderCapabilityUnavailable,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderTemporarilyUnavailable,
)

SHOWSTART_BASE_URL = "https://www.showstart.com"


class ExperimentalConcertProvider(CapabilityProvider):
    def __init__(self, *, enabled: bool = False) -> None:
        self.enabled = enabled
        self._health = ProviderHealthState.HEALTHY if enabled else ProviderHealthState.NOT_CONFIGURED
        self._safe_code: str | None = None

    def health(self) -> ProviderHealth:
        return ProviderHealth(self.provider_name, self._health, datetime.now(UTC), self._safe_code)

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise ProviderNotConfigured(f"{self.provider_name} is disabled.")

    async def search_artists(self, query: str) -> ArtistMatchResult:
        self.require(ConcertCapability.ARTIST_SEARCH)
        self._require_enabled()
        raise ProviderCapabilityUnavailable(f"{self.provider_name} artist search is unavailable.")

    async def search_events(self, **_: object) -> list[ProviderConcertEvent]:
        self.require(ConcertCapability.EVENT_SEARCH)
        self._require_enabled()
        raise ProviderCapabilityUnavailable(f"{self.provider_name} event search is unavailable.")

    async def get_event(self, provider_event_id: str) -> ProviderConcertEvent:
        self.require(ConcertCapability.EVENT_DETAIL)
        self._require_enabled()
        raise ProviderCapabilityUnavailable(f"{self.provider_name} event detail is unavailable.")


class MaoyanProvider(ExperimentalConcertProvider):
    provider_name = "maoyan"
    capabilities = frozenset(
        {ConcertCapability.EVENT_LIST, ConcertCapability.PAGINATION, ConcertCapability.EVENT_STATUS}
    )


class KktixProvider(ExperimentalConcertProvider):
    provider_name = "kktix"
    capabilities = frozenset(
        {
            ConcertCapability.EVENT_SEARCH,
            ConcertCapability.EVENT_LIST,
            ConcertCapability.EVENT_DETAIL,
            ConcertCapability.PAGINATION,
            ConcertCapability.EVENT_STATUS,
            ConcertCapability.VENUE_DETAIL,
        }
    )


class _ShowStartListParser(HTMLParser):
    fields = {"title", "artist", "time", "addr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cards: list[dict[str, str]] = []
        self._card: dict[str, str] | None = None
        self._field: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        href = values.get("href") or ""
        if tag == "a" and "show-item" in classes and re.fullmatch(r"/event/\d+", href):
            self._card = {"provider_event_id": href.rsplit("/", 1)[-1]}
            self._field = None
        elif self._card is not None and tag == "div":
            field = next((value for value in self.fields if value in classes), None)
            if field:
                self._field = field
                self._card.setdefault(field, "")

    def handle_endtag(self, tag: str) -> None:
        if self._card is None:
            return
        if tag == "div" and self._field:
            self._field = None
        elif tag == "a":
            self.cards.append(self._card)
            self._card = None
            self._field = None

    def handle_data(self, data: str) -> None:
        if self._card is not None and self._field:
            self._card[self._field] += data


class ShowStartProvider(ExperimentalConcertProvider):
    """Anonymous public-HTML discovery; scripts are never executed or persisted."""

    provider_name = "showstart"
    capabilities = frozenset(
        {
            ConcertCapability.EVENT_SEARCH,
            ConcertCapability.EVENT_LIST,
            ConcertCapability.EVENT_DETAIL,
            ConcertCapability.PAGINATION,
            ConcertCapability.VENUE_DETAIL,
        }
    )

    def __init__(
        self,
        *,
        enabled: bool = False,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 5.0,
        min_interval_seconds: float = 1.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        super().__init__(enabled=enabled)
        self._client = client
        self._timeout = max(1.0, min(timeout_seconds, 8.0))
        self._min_interval = max(0.0, min_interval_seconds)
        self._sleep = sleep
        self._last_request_at = 0.0

    async def search_events(
        self,
        *,
        query: str | None = None,
        attraction_id: str | None = None,
        country: str | None = None,
        city: str | None = None,
        page_budget: int = 1,
    ) -> list[ProviderConcertEvent]:
        self.require(ConcertCapability.EVENT_SEARCH)
        self._require_enabled()
        if not query or attraction_id:
            raise ProviderCapabilityUnavailable("ShowStart supports public keyword event search only.")
        if country and country.upper() not in {"CN", "CHN"}:
            return []
        clean_query = " ".join(query.split())[:300]
        normalized_query = normalize_artist_name(clean_query)
        page_limit = max(1, min(page_budget, 2))
        events: list[ProviderConcertEvent] = []
        seen: set[str] = set()
        for page in range(1, page_limit + 1):
            payload = await self._request("/event/list", {"keyword": clean_query, "pageNo": page})
            parsed = self._parse_list(payload)
            if not parsed:
                break
            for event in parsed:
                if event.provider_event_id in seen:
                    continue
                title_match = normalized_query in normalize_artist_name(event.title)
                performer_match = any(
                    normalized_query == normalize_artist_name(performer.name)
                    for performer in event.performers
                )
                if not title_match and not performer_match:
                    continue
                if city and normalize_artist_name(event.venue.city or "") != normalize_artist_name(city):
                    continue
                seen.add(event.provider_event_id)
                events.append(event)
            if len(parsed) < 20:
                break
        return events

    async def get_event(self, provider_event_id: str) -> ProviderConcertEvent:
        self.require(ConcertCapability.EVENT_DETAIL)
        self._require_enabled()
        if not provider_event_id.isdigit():
            raise ProviderCapabilityUnavailable("ShowStart event identity must be numeric.")
        detail_html = await self._request(f"/event/{provider_event_id}", {})
        detail = self._parse_detail(detail_html)
        candidates = await self.search_events(query=detail["title"], page_budget=1)
        event = next(
            (value for value in candidates if value.provider_event_id == provider_event_id),
            None,
        )
        if event is None:
            raise ProviderTemporarilyUnavailable(
                "ShowStart detail did not expose a complete, verifiable event date."
            )
        venue = replace(
            event.venue,
            name=detail.get("venue") or event.venue.name,
            address=detail.get("address") or event.venue.address,
            city=detail.get("city") or event.venue.city,
            latitude=detail.get("latitude"),
            longitude=detail.get("longitude"),
        )
        performers = detail.get("performers") or event.performers
        return replace(
            event,
            title=detail["title"],
            performers=performers,
            primary_artist_name=performers[0].name if performers else event.primary_artist_name,
            venue=venue,
            artwork_url=detail.get("artwork_url") or event.artwork_url,
        )

    async def _request(self, path: str, params: dict[str, object]) -> str:
        await self._rate_limit()
        headers = {"User-Agent": "MusicScope/2.0 read-only concert discovery"}
        try:
            if self._client is not None:
                response = await self._client.get(
                    path, params=params, headers=headers, timeout=self._timeout
                )
            else:
                async with httpx.AsyncClient(
                    base_url=SHOWSTART_BASE_URL, follow_redirects=True
                ) as client:
                    response = await client.get(
                        path, params=params, headers=headers, timeout=self._timeout
                    )
            if response.status_code == 429:
                self._health = ProviderHealthState.RATE_LIMITED
                self._safe_code = "RATE_LIMITED"
                raise ProviderRateLimited("ShowStart public discovery is rate limited.")
            if response.status_code in {401, 403} or response.status_code >= 500:
                self._health = ProviderHealthState.UNAVAILABLE
                self._safe_code = f"HTTP_{response.status_code}"
                raise ProviderTemporarilyUnavailable("ShowStart public discovery is unavailable.")
            if response.status_code >= 400:
                self._health = ProviderHealthState.UNAVAILABLE
                self._safe_code = f"HTTP_{response.status_code}"
                raise ProviderTemporarilyUnavailable(
                    "ShowStart rejected the public discovery request."
                )
            response.raise_for_status()
            self._health = ProviderHealthState.HEALTHY
            self._safe_code = None
            return response.text
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            self._health = ProviderHealthState.UNAVAILABLE
            self._safe_code = "TIMEOUT"
            raise ProviderTemporarilyUnavailable("ShowStart public discovery timed out.") from exc

    async def _rate_limit(self) -> None:
        loop = asyncio.get_running_loop()
        delay = self._min_interval - (loop.time() - self._last_request_at)
        if delay > 0:
            await self._sleep(delay)
        self._last_request_at = loop.time()

    @classmethod
    def _parse_list(cls, payload: str) -> list[ProviderConcertEvent]:
        parser = _ShowStartListParser()
        parser.feed(payload)
        artwork = cls._artwork_by_id(payload)
        events: list[ProviderConcertEvent] = []
        for card in parser.cards:
            try:
                when = datetime.strptime(
                    card.get("time", "").removeprefix("时间：").strip(), "%Y/%m/%d %H:%M"
                )
            except ValueError:
                continue
            provider_event_id = card["provider_event_id"]
            title = " ".join(card.get("title", "").split())
            if not title:
                continue
            performer_text = card.get("artist", "").removeprefix("艺人：").strip()
            performer_names = [
                value.strip()
                for value in performer_text.split("/")
                if value.strip() and value.strip() != "待定"
            ]
            location = card.get("addr", "").strip()
            match = re.fullmatch(r"\[([^]]+)](.*)", location)
            city = match.group(1).strip() if match else None
            venue_name = match.group(2).strip() if match else location or None
            event_url = f"{SHOWSTART_BASE_URL}/event/{provider_event_id}"
            image = artwork.get(provider_event_id)
            events.append(
                ProviderConcertEvent(
                    provider="showstart",
                    provider_event_id=provider_event_id,
                    title=title,
                    performers=tuple(ProviderPerformer(value) for value in performer_names),
                    primary_artist_name=performer_names[0] if performer_names else None,
                    start_date=when.date(),
                    start_time=when.time(),
                    timezone=None,
                    venue=ProviderVenue(name=venue_name, city=city),
                    artwork_url=image if is_safe_public_url(image) else None,
                    event_url=event_url,
                    ticket_url=event_url,
                    observed_at=datetime.now(UTC),
                    metadata={"source_type": "public_html"},
                )
            )
        return events

    @staticmethod
    def _artwork_by_id(payload: str) -> dict[str, str]:
        values: dict[str, str] = {}
        pattern = re.compile(
            r'id:(\d+),title:(?:"(?:\\.|[^"])*"|[A-Za-z_$][\w$]*),poster:"((?:\\.|[^"])*)"'
        )
        for provider_id, encoded_url in pattern.findall(payload):
            try:
                values[provider_id] = json.loads(f'"{encoded_url}"')
            except json.JSONDecodeError:
                continue
        return values

    @classmethod
    def _parse_detail(cls, payload: str) -> dict[str, Any]:
        title_match = re.search(r'<div class="title"[^>]*>(.*?)</div>', payload, re.DOTALL)
        if title_match is None:
            raise ProviderTemporarilyUnavailable("ShowStart event detail was incomplete.")
        title = cls._plain_text(title_match.group(1))
        performers_match = re.search(r'<p[^>]*>艺人：(.*?)</p>', payload, re.DOTALL)
        performer_names = re.findall(
            r'<a href="/artist/\d+"[^>]*>([^<]+)',
            performers_match.group(1) if performers_match else "",
        )
        venue_match = re.search(
            r'<p[^>]*>场地：\s*<a href="/venue/\d+"[^>]*>(.*?)</a>', payload, re.DOTALL
        )
        address_match = re.search(r'<p[^>]*>地址：(.*?)<span', payload, re.DOTALL)
        poster_match = re.search(
            r'detail:\{title:(?:"(?:\\.|[^"])*"|[A-Za-z_$][\w$]*),poster:"((?:\\.|[^"])*)"',
            payload,
        )
        coordinate_match = re.search(
            r'longitude:([-\d.]+),latitude:([-\d.]+),cityName:"((?:\\.|[^"])*)",address:',
            payload,
        )
        artwork = None
        if poster_match:
            try:
                artwork = json.loads(f'"{poster_match.group(1)}"')
            except json.JSONDecodeError:
                artwork = None
        city = None
        longitude = None
        latitude = None
        if coordinate_match:
            longitude = float(coordinate_match.group(1))
            latitude = float(coordinate_match.group(2))
            try:
                city = json.loads(f'"{coordinate_match.group(3)}"')
            except json.JSONDecodeError:
                city = None
        venue = cls._plain_text(venue_match.group(1)) if venue_match else None
        if city and venue and venue.startswith(city):
            venue = venue[len(city) :].strip()
        return {
            "title": title,
            "performers": tuple(ProviderPerformer(html.unescape(value.strip())) for value in performer_names),
            "venue": venue,
            "address": cls._plain_text(address_match.group(1)) if address_match else None,
            "city": city,
            "latitude": latitude,
            "longitude": longitude,
            "artwork_url": artwork if is_safe_public_url(artwork) else None,
        }

    @staticmethod
    def _plain_text(value: str) -> str:
        return " ".join(html.unescape(re.sub(r"<[^>]+>", "", value)).split())
