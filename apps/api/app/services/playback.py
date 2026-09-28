from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from time import perf_counter
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.secrets import ProviderSecretCipher
from app.domain.enums import ConnectionStatus, EntityType
from app.domain.models import ExternalIdentity, MusicConnection, Track, User
from app.providers.netease import NetEaseProvider
from app.providers.types import ProviderPlaybackSource
from app.services.music_connections import MusicConnectionService

logger = logging.getLogger(__name__)
ProviderFactory = Callable[[str], NetEaseProvider]


@dataclass(frozen=True)
class PlaybackResolution:
    track: Track
    source: ProviderPlaybackSource
    resolution_ms: int


class PlaybackService:
    def __init__(
        self,
        session: Session,
        *,
        provider_factory: ProviderFactory | None = None,
        cipher: ProviderSecretCipher | None = None,
    ) -> None:
        self.session = session
        self.provider_factory = provider_factory or (lambda cookie: NetEaseProvider(session_cookie=cookie))
        self.cipher = cipher

    async def resolve(self, track_id: UUID, user: User | None = None) -> PlaybackResolution:
        track = self.session.get(Track, track_id)
        if track is None:
            raise LookupError("Track not found.")
        identity = self.session.scalar(
            select(ExternalIdentity).where(
                ExternalIdentity.provider == "netease",
                ExternalIdentity.entity_type == EntityType.TRACK.value,
                ExternalIdentity.entity_id == track.id,
            )
        )
        if identity is None:
            raise LookupError("Track has no NetEase identity.")
        connection_query = select(MusicConnection).where(
            MusicConnection.provider == "netease",
            MusicConnection.status == ConnectionStatus.CONNECTED.value,
        )
        if user is not None:
            connection_query = connection_query.where(MusicConnection.user_id == user.id)
        connection = self.session.scalar(
            connection_query.order_by(MusicConnection.updated_at.desc()).limit(1)
        )
        if connection is None:
            raise PermissionError("A connected NetEase account is required.")

        started = perf_counter()
        cookie = MusicConnectionService(self.session, cipher=self.cipher).decrypt_session(connection)
        source = await self.provider_factory(cookie).resolve_playback_source(identity.provider_id)
        resolution_ms = round((perf_counter() - started) * 1000)
        logger.info(
            {
                "category": "playback_resolution",
                "classification": "success",
                "duration_ms": resolution_ms,
            }
        )
        return PlaybackResolution(track=track, source=source, resolution_ms=resolution_ms)
