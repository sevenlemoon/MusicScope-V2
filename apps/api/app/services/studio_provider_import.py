"""Bounded, local import of a currently playable NetEase source for Studio."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import BinaryIO
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.domain.models import AudioAsset, Track, User
from app.providers.types import ProviderPlaybackSource
from app.services.audio_studio import StudioError, create_audio_asset, storage_root

_EXTENSIONS = {
    "audio/mpeg": ".mp3",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/wav": ".wav",
}
_ALLOWED_CDN_SUFFIXES = (".music.126.net", ".music.163.com")


def _safe_playback_url(source: ProviderPlaybackSource) -> str:
    try:
        parsed = urlsplit(source.url)
        host = (parsed.hostname or "").casefold()
        port = parsed.port
    except ValueError as exc:
        raise StudioError(
            422, "PROVIDER_SOURCE_UNSUPPORTED", "This playback source cannot be imported safely."
        ) from exc
    if (
        source.provider != "netease"
        or parsed.scheme not in {"http", "https"}
        or not any(host.endswith(suffix) for suffix in _ALLOWED_CDN_SUFFIXES)
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise StudioError(
            422, "PROVIDER_SOURCE_UNSUPPORTED", "This playback source cannot be imported safely."
        )
    # NetEase may return HTTP URLs, but its music CDN supports TLS. Never fetch audio over HTTP.
    return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, ""))


async def _download(client: httpx.AsyncClient, url: str, output: BinaryIO, max_bytes: int) -> None:
    try:
        async with asyncio.timeout(120):
            async with client.stream("GET", url, follow_redirects=False) as response:
                if response.status_code != 200:
                    raise StudioError(
                        422,
                        "PROVIDER_AUDIO_UNAVAILABLE",
                        "The selected song is not available for direct separation.",
                    )
                media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().casefold()
                if media_type not in _EXTENSIONS and media_type != "application/octet-stream":
                    raise StudioError(
                        422, "PROVIDER_AUDIO_INVALID", "The provider did not return supported audio."
                    )
                length = response.headers.get("content-length")
                if length and length.isdecimal() and int(length) > max_bytes:
                    raise StudioError(
                        413, "PROVIDER_AUDIO_TOO_LARGE", "The provider audio exceeds the 200 MiB limit."
                    )
                total = 0
                async for chunk in response.aiter_bytes(1024 * 1024):
                    total += len(chunk)
                    if total > max_bytes:
                        raise StudioError(
                            413, "PROVIDER_AUDIO_TOO_LARGE", "The provider audio exceeds the 200 MiB limit."
                        )
                    output.write(chunk)
                if total == 0:
                    raise StudioError(422, "PROVIDER_AUDIO_INVALID", "The provider returned empty audio.")
    except (httpx.HTTPError, TimeoutError) as exc:
        raise StudioError(
            503, "PROVIDER_AUDIO_FETCH_FAILED", "The provider audio could not be fetched."
        ) from exc


async def create_provider_audio_asset(
    db: Session,
    user: User,
    track: Track,
    source: ProviderPlaybackSource,
    *,
    client: httpx.AsyncClient | None = None,
) -> tuple[AudioAsset, bool]:
    if source.duration_ms and source.duration_ms > get_settings().audio_duration_max_seconds * 1000:
        raise StudioError(413, "DURATION_TOO_LONG", "Audio must be 15 minutes or shorter.")
    suffix = _EXTENSIONS.get(source.mime_type)
    if suffix is None:
        raise StudioError(415, "UNSUPPORTED_AUDIO", "The provider audio format is not supported.")
    url = _safe_playback_url(source)
    temporary_root = storage_root() / "imports"
    temporary_root.mkdir(parents=True, exist_ok=True)
    if temporary_root.is_symlink() or not temporary_root.resolve().is_relative_to(storage_root()):
        raise StudioError(500, "STORAGE_UNAVAILABLE", "Studio storage is unavailable.")
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix="netease-", suffix=suffix, dir=temporary_root, delete=False
        ) as temporary:
            path = Path(temporary.name)
            if client is None:
                async with httpx.AsyncClient(timeout=httpx.Timeout(30), trust_env=False) as managed_client:
                    await _download(managed_client, url, temporary, get_settings().audio_upload_max_bytes)
            else:
                await _download(client, url, temporary, get_settings().audio_upload_max_bytes)
        upload = UploadFile(file=path.open("rb"), filename=f"{track.title}{suffix}")
        return await create_audio_asset(db, user, upload)
    finally:
        if path is not None:
            path.unlink(missing_ok=True)
