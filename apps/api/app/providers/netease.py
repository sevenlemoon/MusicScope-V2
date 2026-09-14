import asyncio
import logging
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from time import perf_counter
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from app.core.config import get_settings
from app.domain.enums import ConnectionStatus
from app.providers.errors import (
    ProviderAuthenticationExpired,
    ProviderNotConfigured,
    ProviderPlaybackUnavailable,
    ProviderTemporarilyUnavailable,
)
from app.providers.types import (
    AuthChallenge,
    AuthPollResult,
    Page,
    ProviderAlbum,
    ProviderArtist,
    ProviderPlaybackSource,
    ProviderPlaylist,
    ProviderTrack,
)
from app.services.connection_state import netease_qr_code_to_state

logger = logging.getLogger(__name__)


def is_retryable_status(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


def normalize_artwork_url(value: object) -> str | None:
    if not value:
        return None
    url = str(value)
    return f"https://{url[7:]}" if url.startswith("http://") else url


class NetEaseProvider:
    """Narrow adapter for the loopback-only enhanced NetEase API sidecar."""

    provider_id = "netease"

    def __init__(self, api_base_url: str | None = None, session_cookie: str | None = None) -> None:
        settings = get_settings()
        self.settings = settings
        self.api_base_url = (api_base_url or settings.netease_api_base_url).rstrip("/")
        host = urlsplit(self.api_base_url).hostname
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ProviderNotConfigured("NetEase sidecar must use a loopback address.")
        self.session_cookie = session_cookie
        self.timeout = settings.netease_request_timeout_seconds
        self.playlist_page_size = settings.netease_playlist_page_size

    async def _post(self, category: str, path: str, payload: dict[str, object]) -> dict[str, object]:
        for attempt in range(1, 4):
            started = perf_counter()
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(f"{self.api_base_url}{path}", json=payload)
                duration_ms = round((perf_counter() - started) * 1000)
                if response.status_code == 401:
                    logger.warning(
                        {
                            "category": category,
                            "classification": "authentication_expired",
                            "duration_ms": duration_ms,
                        }
                    )
                    raise ProviderAuthenticationExpired("Provider session expired.")
                if is_retryable_status(response.status_code) and attempt < 3:
                    logger.warning(
                        {
                            "category": category,
                            "classification": "retryable",
                            "attempt": attempt,
                            "duration_ms": duration_ms,
                        }
                    )
                    await asyncio.sleep(0.2 * attempt)
                    continue
                response.raise_for_status()
                result = response.json()
                if not isinstance(result, dict):
                    raise ProviderTemporarilyUnavailable("Provider returned an invalid response.")
                logger.info(
                    {
                        "category": category,
                        "classification": "success",
                        "attempt": attempt,
                        "duration_ms": duration_ms,
                    }
                )
                return result
            except ProviderAuthenticationExpired:
                raise
            except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError, ValueError) as exc:
                if attempt == 3:
                    raise ProviderTemporarilyUnavailable(f"Provider request failed: {category}.") from exc
                await asyncio.sleep(0.2 * attempt)
        raise ProviderTemporarilyUnavailable(f"Provider request failed: {category}.")

    def _authenticated_payload(self, **values: object) -> dict[str, object]:
        if not self.session_cookie:
            raise ProviderAuthenticationExpired("Provider session is unavailable.")
        return {"session_cookie": self.session_cookie, **values}

    async def create_auth_challenge(self) -> AuthChallenge:
        public_id = str(uuid4())
        result = await self._post("qr_create", "/v1/qr/create", {"challenge_id": public_id})
        expires_at = datetime.fromisoformat(str(result["expires_at"]).replace("Z", "+00:00"))
        return AuthChallenge(
            public_id=public_id,
            state=ConnectionStatus.WAITING_SCAN,
            qr_content=str(result["qr_url"]),
            qr_image_data_url=str(result["qr_image_data_url"]),
            expires_at=expires_at,
        )

    async def poll_auth_challenge(self, challenge_id: str) -> AuthPollResult:
        result = await self._post("qr_check", "/v1/qr/check", {"challenge_id": challenge_id})
        state = netease_qr_code_to_state(int(result["code"]))
        session = result.get("session_cookie")
        return AuthPollResult(
            state=state,
            session_material={"cookie": str(session)}
            if state == ConnectionStatus.CONNECTED and session
            else None,
        )

    async def cancel_auth_challenge(self, challenge_id: str) -> None:
        await self._post("qr_cancel", "/v1/qr/cancel", {"challenge_id": challenge_id})

    async def get_profile(self) -> dict[str, object]:
        result = await self._post("account", "/v1/account", self._authenticated_payload())
        profile = result.get("profile") or (result.get("data") or {}).get("profile")
        if not isinstance(profile, dict) or profile.get("userId") is None:
            raise ProviderAuthenticationExpired("Provider account profile is unavailable.")
        return {
            "provider_user_id": str(profile["userId"]),
            "nickname": str(profile.get("nickname") or "NetEase user"),
            "avatar_url": str(profile["avatarUrl"]) if profile.get("avatarUrl") else None,
        }

    async def list_playlists(self, cursor: str | None = None) -> Page[ProviderPlaylist]:
        profile = await self.get_profile()
        offset = int(cursor or 0)
        result = await self._post(
            "playlists",
            "/v1/playlists",
            self._authenticated_payload(
                uid=profile["provider_user_id"], limit=self.playlist_page_size, offset=offset
            ),
        )
        raw_items = result.get("playlist") or []
        items = [
            ProviderPlaylist(
                provider_id=str(item["id"]),
                name=str(item.get("name") or "Untitled playlist"),
                artwork_url=normalize_artwork_url(item.get("coverImgUrl")),
                track_count=int(item["trackCount"]) if item.get("trackCount") is not None else None,
                metadata={
                    "description": item.get("description"),
                    "creator_nickname": (item.get("creator") or {}).get("nickname"),
                    "subscribed": bool(item.get("subscribed", False)),
                    "provider_update_time": item.get("updateTime"),
                },
            )
            for item in raw_items
            if isinstance(item, dict) and item.get("id") is not None
        ]
        next_cursor = str(offset + len(items)) if result.get("more") and items else None
        return Page(items=items, next_cursor=next_cursor)

    async def list_playlist_track_ids(self, playlist_id: str, cursor: str | None = None) -> Page[str]:
        if cursor:
            return Page(items=[])
        result = await self._post(
            "playlist_detail",
            "/v1/playlist/detail",
            self._authenticated_payload(id=playlist_id),
        )
        playlist = result.get("playlist") or {}
        track_ids = [str(item["id"]) for item in playlist.get("trackIds", []) if item.get("id") is not None]
        total = int(playlist["trackCount"]) if playlist.get("trackCount") is not None else len(track_ids)
        return Page(items=track_ids, total=total)

    async def get_tracks(self, provider_ids: Sequence[str]) -> list[ProviderTrack]:
        if not provider_ids:
            return []
        result = await self._post(
            "song_detail",
            "/v1/songs/detail",
            self._authenticated_payload(ids=",".join(provider_ids)),
        )
        return [self._normalize_track(item) for item in result.get("songs", []) if isinstance(item, dict)]

    @staticmethod
    def _normalize_track(item: dict[str, object]) -> ProviderTrack:
        raw_artists = item.get("ar") or item.get("artists") or []
        artists_by_id: dict[str, ProviderArtist] = {}
        for artist in raw_artists:
            if not isinstance(artist, dict) or artist.get("id") is None:
                continue
            provider_id = str(artist["id"])
            artists_by_id.setdefault(
                provider_id,
                ProviderArtist(
                    provider_id=provider_id,
                    name=str(artist.get("name") or "Unknown artist"),
                    artwork_url=normalize_artwork_url(artist.get("img1v1Url")),
                ),
            )
        artists = tuple(artists_by_id.values())
        raw_album = item.get("al") or item.get("album") or {}
        album = None
        if isinstance(raw_album, dict) and raw_album.get("id") is not None:
            album = ProviderAlbum(
                provider_id=str(raw_album["id"]),
                title=str(raw_album.get("name") or "Unknown album"),
                artist_provider_ids=tuple(artist.provider_id for artist in artists),
                artwork_url=normalize_artwork_url(raw_album.get("picUrl")),
            )
        return ProviderTrack(
            provider_id=str(item["id"]),
            title=str(item.get("name") or "Untitled track"),
            duration_ms=int(item["dt"]) if item.get("dt") is not None else None,
            album_provider_id=album.provider_id if album else None,
            artist_provider_ids=tuple(artist.provider_id for artist in artists),
            artwork_url=album.artwork_url if album else None,
            artists=artists,
            album=album,
        )

    async def get_artists(self, provider_ids: Sequence[str]) -> list[ProviderArtist]:
        items = []
        for provider_id in provider_ids:
            result = await self._post(
                "artist_detail", "/v1/artist/detail", self._authenticated_payload(id=provider_id)
            )
            artist = result.get("data", {}).get("artist") or result.get("artist")
            if isinstance(artist, dict):
                items.append(
                    ProviderArtist(
                        str(artist["id"]),
                        str(artist.get("name") or "Unknown artist"),
                        normalize_artwork_url(artist.get("cover") or artist.get("img1v1Url")),
                    )
                )
        return items

    async def get_albums(self, provider_ids: Sequence[str]) -> list[ProviderAlbum]:
        items = []
        for provider_id in provider_ids:
            result = await self._post(
                "album_detail", "/v1/album/detail", self._authenticated_payload(id=provider_id)
            )
            album = result.get("album")
            if isinstance(album, dict):
                items.append(
                    ProviderAlbum(
                        str(album["id"]),
                        str(album.get("name") or "Unknown album"),
                        tuple(str(a["id"]) for a in album.get("artists", []) if a.get("id") is not None),
                        normalize_artwork_url(album.get("picUrl")),
                    )
                )
        return items

    async def resolve_playback_source(self, provider_id: str) -> ProviderPlaybackSource:
        result = await self._post(
            "playback_source",
            "/v1/song/url",
            self._authenticated_payload(
                id=provider_id,
                level=self.settings.netease_playback_level,
            ),
        )
        raw_sources = result.get("data") or []
        source = raw_sources[0] if raw_sources and isinstance(raw_sources[0], dict) else None
        if not source or not source.get("url"):
            raise ProviderPlaybackUnavailable("Playback is unavailable for the current account.")
        media_type = str(source.get("type") or source.get("encodeType") or "mpeg").casefold()
        mime_type = {
            "mp3": "audio/mpeg",
            "mpeg": "audio/mpeg",
            "flac": "audio/flac",
            "m4a": "audio/mp4",
            "aac": "audio/aac",
        }.get(media_type, "audio/mpeg")
        expires_in = int(source.get("expi") or 0)
        return ProviderPlaybackSource(
            provider="netease",
            url=str(source["url"]),
            mime_type=mime_type,
            duration_ms=int(source["time"]) if source.get("time") is not None else None,
            expires_at=datetime.now(UTC) + timedelta(seconds=max(60, expires_in - 30))
            if expires_in
            else None,
            quality=str(source.get("level")) if source.get("level") else None,
        )

    async def refresh_session(self) -> None:
        await self.get_profile()

    async def disconnect(self) -> None:
        self.session_cookie = None
