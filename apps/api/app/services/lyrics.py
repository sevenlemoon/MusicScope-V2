import re
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import TrackLyricsResponse
from app.domain.enums import ConnectionStatus, EntityType
from app.domain.models import ExternalIdentity, MusicConnection, Track
from app.providers.netease import NetEaseProvider
from app.services.music_connections import MusicConnectionService


def normalize_lyrics(track_id: UUID, payload: dict[str, object]) -> TrackLyricsResponse:
    def text(key: str) -> str:
        part = payload.get(key)
        value = part.get("lyric") if isinstance(part, dict) else None
        return value[:200_000].strip() if isinstance(value, str) else ""

    original, translated = text("lrc"), text("tlyric")
    content = re.sub(r"\[[^\]]*\]", "", original).strip()
    instrumental = payload.get("nolyric") is True or content in {
        "纯音乐，请欣赏", "纯音乐，请欣赏。", "纯音乐,请欣赏", "Instrumental",
    }
    timed = bool(re.search(r"\[\d+:[0-5]\d(?:[.:]\d{1,3})?\]", original))
    kind = "instrumental" if instrumental else "none" if not content else "synced" if timed else "plain"
    return TrackLyricsResponse(
        track_id=str(track_id), kind=kind,
        original=original if kind in {"synced", "plain"} else "",
        translated=translated if kind in {"synced", "plain"} else "",
        precision="line" if kind == "synced" else "none",
    )


class TrackLyricsService:
    def __init__(self, session: Session) -> None:
        self.session = session

    async def get(self, track_id: UUID) -> TrackLyricsResponse:
        if self.session.get(Track, track_id) is None:
            raise LookupError("Track not found.")
        identity = self.session.scalar(select(ExternalIdentity).where(
            ExternalIdentity.provider == "netease",
            ExternalIdentity.entity_type == EntityType.TRACK.value,
            ExternalIdentity.entity_id == track_id,
        ))
        if identity is None:
            return TrackLyricsResponse(track_id=str(track_id), kind="none")
        connection = self.session.scalar(select(MusicConnection).where(
            MusicConnection.provider == "netease",
            MusicConnection.status == ConnectionStatus.CONNECTED.value,
        ).order_by(MusicConnection.updated_at.desc()).limit(1))
        if connection is None:
            raise PermissionError("A connected NetEase account is required.")
        cookie = MusicConnectionService(self.session).decrypt_session(connection)
        payload = await NetEaseProvider(session_cookie=cookie).get_lyrics(identity.provider_id)
        return normalize_lyrics(track_id, payload)
