from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class MetadataCandidate:
    provider: str
    provider_id: str
    title: str
    artist_names: tuple[str, ...]
    album: str | None = None
    artwork_url: str | None = None
    source_url: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


class MetadataProvider(Protocol):
    provider_id: str

    async def search_track(self, title: str, artist_names: Sequence[str]) -> list[MetadataCandidate]: ...

