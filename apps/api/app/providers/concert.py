from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, time
from enum import StrEnum
from typing import Protocol
from urllib.parse import urlsplit
from uuid import UUID

from app.providers.errors import ProviderCapabilityUnavailable


class ConcertCapability(StrEnum):
    ARTIST_SEARCH = "ARTIST_SEARCH"
    EVENT_SEARCH = "EVENT_SEARCH"
    EVENT_LIST = "EVENT_LIST"
    EVENT_DETAIL = "EVENT_DETAIL"
    PAGINATION = "PAGINATION"
    EVENT_STATUS = "EVENT_STATUS"
    VENUE_DETAIL = "VENUE_DETAIL"


class ProviderHealthState(StrEnum):
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    UNAVAILABLE = "UNAVAILABLE"
    NOT_CONFIGURED = "NOT_CONFIGURED"
    RATE_LIMITED = "RATE_LIMITED"
    CIRCUIT_OPEN = "CIRCUIT_OPEN"


class ArtistMatchState(StrEnum):
    MATCHED = "MATCHED"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_FOUND = "NOT_FOUND"


@dataclass(frozen=True)
class ProviderHealth:
    provider: str
    state: ProviderHealthState
    checked_at: datetime
    safe_code: str | None = None


@dataclass(frozen=True)
class ProviderArtistMatch:
    provider_id: str
    name: str
    aliases: tuple[str, ...] = ()
    image_url: str | None = None


@dataclass(frozen=True)
class ArtistMatchResult:
    state: ArtistMatchState
    query: str
    matches: tuple[ProviderArtistMatch, ...] = ()


@dataclass(frozen=True)
class ProviderPerformer:
    name: str
    provider_id: str | None = None
    canonical_artist_id: UUID | None = None


@dataclass(frozen=True)
class ProviderVenue:
    name: str | None = None
    address: str | None = None
    city: str | None = None
    region: str | None = None
    country: str | None = None
    latitude: float | None = None
    longitude: float | None = None


@dataclass(frozen=True)
class ProviderConcertEvent:
    provider: str
    provider_event_id: str
    title: str
    performers: tuple[ProviderPerformer, ...]
    start_date: date
    start_time: time | None
    timezone: str | None
    venue: ProviderVenue
    event_url: str
    ticket_url: str | None = None
    artwork_url: str | None = None
    status: str | None = None
    primary_artist_name: str | None = None
    observed_at: datetime | None = None
    metadata: dict[str, object] = field(default_factory=dict)


def normalize_artist_name(value: str) -> str:
    """Normalize comparable text without transliterating across writing systems."""
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    return re.sub(r"[^\w]+", "", normalized, flags=re.UNICODE)


def is_safe_public_url(value: str | None) -> bool:
    if not value:
        return False
    parsed = urlsplit(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


class ConcertProvider(Protocol):
    provider_name: str
    capabilities: frozenset[ConcertCapability]

    async def search_artists(self, query: str) -> ArtistMatchResult: ...

    async def search_events(
        self,
        *,
        query: str | None = None,
        attraction_id: str | None = None,
        country: str | None = None,
        city: str | None = None,
        page_budget: int = 1,
    ) -> list[ProviderConcertEvent]: ...

    async def get_event(self, provider_event_id: str) -> ProviderConcertEvent: ...

    def health(self) -> ProviderHealth: ...


class CapabilityProvider:
    provider_name: str
    capabilities: frozenset[ConcertCapability]

    def require(self, capability: ConcertCapability) -> None:
        if capability not in self.capabilities:
            raise ProviderCapabilityUnavailable(
                f"{self.provider_name} does not support {capability.value}."
            )
