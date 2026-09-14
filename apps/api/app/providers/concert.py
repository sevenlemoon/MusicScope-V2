from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True)
class ProviderConcertEvent:
    provider_id: str
    artist_name: str
    title: str
    starts_at: datetime
    source_url: str
    venue_name: str | None = None
    city: str | None = None
    country: str | None = None
    ticket_url: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


class ConcertProvider(Protocol):
    provider_id: str

    async def search_artist_events(self, artist_name: str) -> list[ProviderConcertEvent]: ...

