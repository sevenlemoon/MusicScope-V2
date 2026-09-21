from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

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
    normalize_artist_name,
)
from app.providers.errors import (
    ProviderCapabilityUnavailable,
    ProviderNotConfigured,
    ProviderParserChanged,
    ProviderRateLimited,
    ProviderTemporarilyUnavailable,
    ProviderTimeout,
)

MAX_OFFICIAL_PAGE_BYTES = 2_000_000
MAX_REDIRECTS = 3


@dataclass(frozen=True)
class VerifiedArtistIdentity:
    key: str
    canonical_name: str
    aliases: tuple[str, ...]
    evidence_source: str
    evidence_urls: tuple[str, ...]

    @property
    def normalized_names(self) -> frozenset[str]:
        return frozenset(
            normalize_artist_name(value) for value in (self.canonical_name, *self.aliases)
        )


@dataclass(frozen=True)
class VerifiedLiveSource:
    source_id: str
    provider_name: str
    event_url: str
    allowed_hosts: frozenset[str]
    artist: VerifiedArtistIdentity
    timezone: str | None = None
    allowed_ticket_hosts: frozenset[str] = frozenset()


class VerifiedLiveSourceRegistry:
    """Fixed, reviewed source configuration; no request URL comes from a browser query."""

    def __init__(self, sources: Iterable[VerifiedLiveSource]) -> None:
        self._sources = tuple(sources)
        for source in self._sources:
            self._validate_configuration(source)

    def artist_matches(self, query: str) -> tuple[VerifiedArtistIdentity, ...]:
        normalized = normalize_artist_name(query)
        identities: dict[str, VerifiedArtistIdentity] = {}
        for source in self._sources:
            if normalized and normalized in source.artist.normalized_names:
                identities[source.artist.key] = source.artist
        return tuple(identities.values())

    def sources_for_artist(self, artist_key: str) -> tuple[VerifiedLiveSource, ...]:
        return tuple(source for source in self._sources if source.artist.key == artist_key)

    def sources_for_provider(self, provider_name: str) -> tuple[VerifiedLiveSource, ...]:
        return tuple(source for source in self._sources if source.provider_name == provider_name)

    @staticmethod
    def _validate_configuration(source: VerifiedLiveSource) -> None:
        parsed = urlsplit(source.event_url)
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError(
                f"Unsafe verified live source configuration: {source.source_id}"
            ) from exc
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.hostname.casefold() not in source.allowed_hosts
            or parsed.username
            or parsed.password
            or port not in {None, 443}
            or parsed.fragment
        ):
            raise ValueError(f"Unsafe verified live source configuration: {source.source_id}")
        if not source.artist.evidence_urls:
            raise ValueError(f"Missing alias evidence for verified source: {source.source_id}")
        for evidence_url in source.artist.evidence_urls:
            evidence = urlsplit(evidence_url)
            if evidence.scheme != "https" or not evidence.hostname:
                raise ValueError(f"Unsafe alias evidence URL: {source.source_id}")


TOGENASHI_IDENTITY = VerifiedArtistIdentity(
    key="togenashi-togeari",
    canonical_name="TOGENASHI TOGEARI",
    aliases=("トゲナシトゲアリ",),
    evidence_source="universal_music_jp",
    evidence_urls=(
        "https://www.universal-music.co.jp/togenashitogeari/",
        "https://www.universal-music.co.jp/togenashitogeari/news/2026-08-17/",
        "https://www.universal-music.co.jp/togenashitogeari/news/2026-07-21/",
    ),
)

DEFAULT_VERIFIED_LIVE_REGISTRY = VerifiedLiveSourceRegistry(
    (
        VerifiedLiveSource(
            source_id="asiaworld-expo:togenashi-togeari-live-in-hong-kong-2026",
            provider_name="asiaworld_expo",
            event_url=(
                "https://www.asiaworld-expo.com/en-us/whats-on/upcoming-events/events/"
                "togenashi-togeari-live-in-hong-kong-2026/"
            ),
            allowed_hosts=frozenset({"www.asiaworld-expo.com"}),
            artist=TOGENASHI_IDENTITY,
            timezone="Asia/Hong_Kong",
            allowed_ticket_hosts=frozenset({"www.cityline.com"}),
        ),
    )
)


class _OfficialPageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.json_ld: list[str] = []
        self.timeslot_values: list[str] = []
        self.ticket_urls: list[str] = []
        self.location = ""
        self._in_json_ld = False
        self._json_parts: list[str] = []
        self._in_location = False
        self._in_ticket_sales = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        if tag == "script" and (values.get("type") or "").casefold() == "application/ld+json":
            self._in_json_ld = True
            self._json_parts = []
        if "detail-inner-main-location" in classes:
            self._in_location = True
        if tag == "article" and values.get("id") == "ticket-sales":
            self._in_ticket_sales = True
        if tag in {"a", "option"}:
            value = values.get("href") or values.get("value")
            if value and "startDate=" in value and "/ics-generator" in value:
                self.timeslot_values.append(value)
            if tag == "a" and value and self._in_ticket_sales:
                self.ticket_urls.append(value)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._in_json_ld:
            self.json_ld.append("".join(self._json_parts))
            self._json_parts = []
            self._in_json_ld = False
        if tag == "a" and self._in_location:
            self._in_location = False
        if tag == "article" and self._in_ticket_sales:
            self._in_ticket_sales = False

    def handle_data(self, data: str) -> None:
        if self._in_json_ld:
            self._json_parts.append(data)
        if self._in_location:
            self.location += data


Resolver = Callable[[str, int], Awaitable[list[str]]]


class VerifiedOfficialSourceProvider(CapabilityProvider):
    capabilities = frozenset(
        {
            ConcertCapability.ARTIST_SEARCH,
            ConcertCapability.EVENT_SEARCH,
            ConcertCapability.EVENT_LIST,
            ConcertCapability.EVENT_DETAIL,
            ConcertCapability.EVENT_STATUS,
            ConcertCapability.VENUE_DETAIL,
        }
    )

    def __init__(
        self,
        provider_name: str,
        *,
        registry: VerifiedLiveSourceRegistry = DEFAULT_VERIFIED_LIVE_REGISTRY,
        enabled: bool = True,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 6.0,
        resolver: Resolver | None = None,
    ) -> None:
        self.provider_name = provider_name
        self.registry = registry
        self.enabled = enabled
        self._client = client
        self._timeout = max(1.0, min(timeout_seconds, 10.0))
        self._resolver = resolver or self._resolve_host
        self._state = ProviderHealthState.HEALTHY if enabled else ProviderHealthState.NOT_CONFIGURED
        self._safe_code: str | None = None

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            self.provider_name, self._state, datetime.now(UTC), self._safe_code
        )

    async def search_artists(self, query: str) -> ArtistMatchResult:
        self._require_enabled()
        matches = self.registry.artist_matches(query)
        provider_matches = tuple(
            ProviderArtistMatch(
                provider_id=value.key,
                name=value.canonical_name,
                aliases=value.aliases,
            )
            for value in matches
        )
        if len(provider_matches) == 1:
            return ArtistMatchResult(ArtistMatchState.MATCHED, query, provider_matches)
        if len(provider_matches) > 1:
            return ArtistMatchResult(ArtistMatchState.AMBIGUOUS, query, provider_matches)
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
        del page_budget
        self._require_enabled()
        if attraction_id:
            sources = self.registry.sources_for_artist(attraction_id)
        elif query:
            matches = self.registry.artist_matches(query)
            sources = self.registry.sources_for_artist(matches[0].key) if len(matches) == 1 else ()
        else:
            raise ProviderCapabilityUnavailable("Official source search requires a verified artist.")
        sources = tuple(source for source in sources if source.provider_name == self.provider_name)
        events: list[ProviderConcertEvent] = []
        for source in sources:
            payload = await self._fetch(source)
            try:
                parsed = self._parse_page(source, payload)
            except ProviderParserChanged:
                self._state = ProviderHealthState.DEGRADED
                self._safe_code = "PARSER_CHANGED"
                raise
            events.extend(
                event
                for event in parsed
                if self._location_matches(event, country=country, city=city)
                and event.start_date >= datetime.now(UTC).date()
            )
        self._state = ProviderHealthState.HEALTHY
        self._safe_code = None
        return events

    async def get_event(self, provider_event_id: str) -> ProviderConcertEvent:
        self._require_enabled()
        for source in self.registry.sources_for_provider(self.provider_name):
            events = self._parse_page(source, await self._fetch(source))
            match = next(
                (event for event in events if event.provider_event_id == provider_event_id), None
            )
            if match is not None:
                return match
        raise ProviderCapabilityUnavailable("Verified official event identity was not found.")

    def _require_enabled(self) -> None:
        if not self.enabled:
            self._state = ProviderHealthState.NOT_CONFIGURED
            raise ProviderNotConfigured(f"{self.provider_name} is disabled.")

    async def _fetch(self, source: VerifiedLiveSource) -> str:
        url = source.event_url
        headers = {
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": "MusicScope/2.0 read-only verified concert discovery",
        }
        try:
            for redirect_count in range(MAX_REDIRECTS + 1):
                await self._validate_target(url, source.allowed_hosts)
                if self._client is not None:
                    response = await self._client.get(
                        url, headers=headers, timeout=self._timeout, follow_redirects=False
                    )
                else:
                    async with httpx.AsyncClient(follow_redirects=False) as client:
                        response = await client.get(url, headers=headers, timeout=self._timeout)
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location or redirect_count == MAX_REDIRECTS:
                        raise ProviderTemporarilyUnavailable(
                            "Verified official source redirect was invalid."
                        )
                    url = urljoin(url, location)
                    continue
                if response.status_code == 429:
                    self._state = ProviderHealthState.RATE_LIMITED
                    self._safe_code = "RATE_LIMITED"
                    raise ProviderRateLimited("Verified official source is rate limited.")
                if response.status_code >= 400:
                    self._state = ProviderHealthState.UNAVAILABLE
                    self._safe_code = f"HTTP_{response.status_code}"
                    raise ProviderTemporarilyUnavailable(
                        "Verified official source is unavailable."
                    )
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip()
                if content_type not in {"text/html", "application/xhtml+xml"}:
                    self._state = ProviderHealthState.DEGRADED
                    self._safe_code = "UNEXPECTED_CONTENT_TYPE"
                    raise ProviderParserChanged(
                        "Verified official source returned an unexpected document type."
                    )
                declared_size = response.headers.get("content-length")
                if declared_size:
                    try:
                        declared_bytes = int(declared_size)
                    except ValueError as exc:
                        raise ProviderTemporarilyUnavailable(
                            "Verified official source response size was invalid."
                        ) from exc
                    if declared_bytes < 0 or declared_bytes > MAX_OFFICIAL_PAGE_BYTES:
                        raise ProviderTemporarilyUnavailable(
                            "Verified official source response exceeded the safe size limit."
                        )
                if len(response.content) > MAX_OFFICIAL_PAGE_BYTES:
                    raise ProviderTemporarilyUnavailable(
                        "Verified official source response exceeded the safe size limit."
                    )
                return response.text
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            self._state = ProviderHealthState.UNAVAILABLE
            self._safe_code = "TIMEOUT"
            raise ProviderTimeout("Verified official source request timed out.") from exc
        raise ProviderTemporarilyUnavailable("Verified official source redirect limit exceeded.")

    async def _validate_target(self, url: str, allowed_hosts: frozenset[str]) -> None:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").casefold()
        try:
            port = parsed.port
        except ValueError as exc:
            raise ProviderTemporarilyUnavailable(
                "Verified official source URL was rejected."
            ) from exc
        if (
            parsed.scheme != "https"
            or host not in allowed_hosts
            or parsed.username
            or parsed.password
            or port not in {None, 443}
            or parsed.fragment
        ):
            raise ProviderTemporarilyUnavailable("Verified official source URL was rejected.")
        addresses = await self._resolver(host, 443)
        if not addresses:
            raise ProviderTemporarilyUnavailable("Verified official source host did not resolve.")
        for address in addresses:
            try:
                parsed_address = ipaddress.ip_address(address)
            except ValueError as exc:
                raise ProviderTemporarilyUnavailable(
                    "Verified official source host resolution was invalid."
                ) from exc
            if not parsed_address.is_global:
                raise ProviderTemporarilyUnavailable(
                    "Verified official source host resolved to a non-public address."
                )

    @staticmethod
    async def _resolve_host(host: str, port: int) -> list[str]:
        records = await asyncio.get_running_loop().getaddrinfo(
            host, port, type=socket.SOCK_STREAM
        )
        return list(dict.fromkeys(str(record[4][0]) for record in records))

    @classmethod
    def _parse_page(
        cls, source: VerifiedLiveSource, payload: str
    ) -> list[ProviderConcertEvent]:
        parser = _OfficialPageParser()
        parser.feed(payload)
        schema_events: list[dict[str, Any]] = []
        for raw in parser.json_ld:
            try:
                # Some first-party CMS templates emit a literal newline in JSON-LD
                # descriptions. `strict=False` tolerates that control character while
                # the bounded JSON parser still supplies all event structure.
                schema_events.extend(cls._event_nodes(json.loads(raw, strict=False)))
            except json.JSONDecodeError:
                continue
        if not schema_events:
            raise ProviderParserChanged("Verified official source Event JSON-LD was not found.")
        slots = cls._timeslots(parser.timeslot_values)
        ticket_url = next(
            (
                safe_url
                for value in parser.ticket_urls
                if (
                    safe_url := cls._safe_ticket_url(
                        value, source.allowed_ticket_hosts
                    )
                )
            ),
            None,
        )
        events: list[ProviderConcertEvent] = []
        for schema in schema_events:
            events.extend(
                cls._schema_event(
                    source, schema, slots, parser.location.strip(), ticket_url
                )
            )
        if not events:
            raise ProviderParserChanged("Verified official source Event JSON-LD was incomplete.")
        return events

    @classmethod
    def _event_nodes(cls, value: object) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        if isinstance(value, list):
            for item in value:
                found.extend(cls._event_nodes(item))
        elif isinstance(value, dict):
            value_type = value.get("@type")
            types = value_type if isinstance(value_type, list) else [value_type]
            if "Event" in types:
                found.append(value)
            graph = value.get("@graph")
            if graph is not None:
                found.extend(cls._event_nodes(graph))
        return found

    @staticmethod
    def _timeslots(values: list[str]) -> tuple[datetime, ...]:
        slots: dict[str, datetime] = {}
        for value in values:
            raw = next(iter(parse_qs(urlsplit(value).query).get("startDate", [])), None)
            if not raw:
                continue
            try:
                parsed = datetime.fromisoformat(raw)
            except ValueError:
                continue
            slots[parsed.isoformat()] = parsed
        return tuple(sorted(slots.values()))

    @classmethod
    def _schema_event(
        cls,
        source: VerifiedLiveSource,
        schema: dict[str, Any],
        slots: tuple[datetime, ...],
        rendered_location: str,
        ticket_url: str | None,
    ) -> list[ProviderConcertEvent]:
        title = schema.get("name")
        start_raw = schema.get("startDate")
        if not isinstance(title, str) or not title.strip() or not isinstance(start_raw, str):
            return []
        try:
            schema_start = datetime.fromisoformat(start_raw.replace("Z", "+00:00"))
        except ValueError:
            return []
        end_raw = schema.get("endDate")
        try:
            schema_end = (
                datetime.fromisoformat(end_raw.replace("Z", "+00:00"))
                if isinstance(end_raw, str)
                else schema_start
            )
        except ValueError:
            schema_end = schema_start
        normalized_title = normalize_artist_name(title)
        if not any(name in normalized_title for name in source.artist.normalized_names):
            return []
        bounded_slots = tuple(
            value
            for value in slots
            if schema_start.date() <= value.date() <= schema_end.date()
        )
        performances = bounded_slots or (schema_start,)
        location = schema.get("location") if isinstance(schema.get("location"), dict) else {}
        address = (
            location.get("address") if isinstance(location.get("address"), dict) else {}
        )
        venue_name = rendered_location or cls._string(location.get("name"))
        artwork = cls._safe_same_host_url(schema.get("image"), source.allowed_hosts)
        verified_identity = {
            "canonical_name": source.artist.canonical_name,
            "aliases": list(source.artist.aliases),
            "source": source.artist.evidence_source,
            "evidence_urls": list(source.artist.evidence_urls),
        }
        return [
            ProviderConcertEvent(
                provider=source.provider_name,
                provider_event_id=f"{source.source_id}:{performance.isoformat()}",
                title=" ".join(title.split()),
                performers=(ProviderPerformer(source.artist.canonical_name, source.artist.key),),
                primary_artist_name=source.artist.canonical_name,
                start_date=performance.date(),
                start_time=(
                    performance.time().replace(tzinfo=None)
                    if performance.time() != datetime.min.time()
                    else None
                ),
                timezone=source.timezone,
                venue=ProviderVenue(
                    name=venue_name,
                    address=cls._string(address.get("streetAddress")),
                    city=cls._string(address.get("addressLocality")),
                    region=cls._string(address.get("addressRegion")),
                    country=cls._string(address.get("addressCountry")),
                ),
                event_url=source.event_url,
                ticket_url=ticket_url,
                artwork_url=artwork,
                observed_at=datetime.now(UTC),
                metadata={
                    "source_type": "schema_org_event",
                    "parser_version": 1,
                    "performance_evidence": (
                        "server_rendered_calendar_slot" if bounded_slots else "schema_org_start_date"
                    ),
                    "schema_start_date": start_raw,
                    "schema_end_date": end_raw,
                    "verified_artist_identity": verified_identity,
                },
            )
            for performance in performances
        ]

    @staticmethod
    def _safe_same_host_url(value: object, allowed_hosts: frozenset[str]) -> str | None:
        if not isinstance(value, str):
            return None
        parsed = urlsplit(value)
        try:
            port = parsed.port
        except ValueError:
            return None
        if (
            parsed.scheme == "https"
            and (parsed.hostname or "").casefold() in allowed_hosts
            and not parsed.username
            and not parsed.password
            and port in {None, 443}
        ):
            return value
        return None

    @staticmethod
    def _safe_ticket_url(value: str, allowed_hosts: frozenset[str]) -> str | None:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").casefold()
        try:
            port = parsed.port
        except ValueError:
            return None
        if (
            parsed.scheme not in {"http", "https"}
            or host not in allowed_hosts
            or parsed.username
            or parsed.password
            or port is not None
        ):
            return None
        return urlunsplit(("https", parsed.netloc, parsed.path or "/", parsed.query, ""))

    @staticmethod
    def _string(value: object) -> str | None:
        return value.strip() if isinstance(value, str) and value.strip() else None

    @staticmethod
    def _location_matches(
        event: ProviderConcertEvent, *, country: str | None, city: str | None
    ) -> bool:
        if country:
            normalized_country = normalize_artist_name(event.venue.country or "")
            wanted = normalize_artist_name(country)
            country_aliases = {
                "hongkong": {"hk", "hkg", "hongkong"},
            }
            comparable = country_aliases.get(normalized_country, {normalized_country})
            if wanted not in comparable:
                return False
        if city:
            wanted_city = normalize_artist_name(city)
            location_values = {
                normalize_artist_name(value)
                for value in (
                    event.venue.city,
                    event.venue.region,
                    event.venue.country,
                )
                if value
            }
            if wanted_city not in location_values:
                return False
        return True
