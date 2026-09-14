from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from time import perf_counter

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.secrets import ProviderSecretCipher
from app.domain.enums import ConnectionStatus, EntityType
from app.domain.models import Artist, ExternalIdentity, MusicConnection
from app.providers.errors import ProviderError
from app.providers.netease import NetEaseProvider
from app.providers.types import ProviderArtist
from app.services.music_connections import MusicConnectionService

ProviderFactory = Callable[[str], NetEaseProvider]


@dataclass(frozen=True)
class ArtistEnrichmentResult:
    total_artists: int
    artists_with_artwork: int
    unavailable_artwork: int
    attempted: int
    enriched: int
    failures: int
    duration_ms: int


class ArtistEnrichmentService:
    def __init__(
        self,
        session: Session,
        *,
        provider_factory: ProviderFactory | None = None,
        cipher: ProviderSecretCipher | None = None,
        concurrency: int | None = None,
    ) -> None:
        self.session = session
        self.provider_factory = provider_factory or (lambda cookie: NetEaseProvider(session_cookie=cookie))
        self.cipher = cipher
        self.concurrency = concurrency or get_settings().netease_artist_concurrency

    async def enrich(self) -> ArtistEnrichmentResult:
        total_artists = self.session.scalar(select(func.count()).select_from(Artist)) or 0
        connection = self.session.scalar(
            select(MusicConnection)
            .where(
                MusicConnection.provider == "netease",
                MusicConnection.status == ConnectionStatus.CONNECTED.value,
            )
            .order_by(MusicConnection.updated_at.desc())
            .limit(1)
        )
        if connection is None:
            raise PermissionError("A connected NetEase account is required.")
        targets = list(
            self.session.execute(
                select(Artist, ExternalIdentity.provider_id)
                .join(
                    ExternalIdentity,
                    (ExternalIdentity.entity_id == Artist.id)
                    & (ExternalIdentity.entity_type == EntityType.ARTIST.value),
                )
                .where(
                    ExternalIdentity.provider == "netease",
                    Artist.artwork_url.is_(None),
                )
                .order_by(Artist.id)
            )
        )
        cookie = MusicConnectionService(self.session, cipher=self.cipher).decrypt_session(connection)
        provider = self.provider_factory(cookie)
        semaphore = asyncio.Semaphore(self.concurrency)

        async def fetch(artist: Artist, provider_id: str) -> tuple[Artist, ProviderArtist | None, bool]:
            async with semaphore:
                try:
                    values = await provider.get_artists([provider_id])
                    return artist, values[0] if values else None, False
                except ProviderError:
                    return artist, None, True

        started = perf_counter()
        enriched = 0
        unavailable = 0
        failures = 0
        for completed in asyncio.as_completed([fetch(*target) for target in targets]):
            artist, provider_artist, failed = await completed
            if failed:
                failures += 1
            elif provider_artist and provider_artist.artwork_url:
                artist.artwork_url = provider_artist.artwork_url
                enriched += 1
            else:
                unavailable += 1
        self.session.flush()
        artists_with_artwork = (
            self.session.scalar(
                select(func.count()).select_from(Artist).where(Artist.artwork_url.is_not(None))
            )
            or 0
        )
        return ArtistEnrichmentResult(
            total_artists=total_artists,
            artists_with_artwork=artists_with_artwork,
            unavailable_artwork=unavailable,
            attempted=len(targets),
            enriched=enriched,
            failures=failures,
            duration_ms=round((perf_counter() - started) * 1000),
        )
