from __future__ import annotations

import asyncio
import hashlib
import io
import wave
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.domain.models import (
    AudioAsset,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    StemArtifact,
    StemJob,
    Track,
    User,
)
from app.main import app
from app.providers.types import ProviderPlaybackSource
from app.services import audio_studio, studio_provider_import
from app.services.audio_studio import StudioError, processing_fingerprint, resolve_storage_key
from app.services.playback import PlaybackResolution, PlaybackService


def wav_bytes(seconds: float = 0.1) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(44100)
        target.writeframes(b"\0\0\0\0" * int(44100 * seconds))
    return output.getvalue()


def database_session() -> tuple[Session, object]:
    dependency = app.dependency_overrides[get_db]
    generator = dependency()
    return next(generator), generator


def create_user(name: str = "Studio User") -> User:
    db, generator = database_session()
    try:
        user = User(display_name=name)
        db.add(user)
        db.commit()
        db.refresh(user)
        db.expunge(user)
        return user
    finally:
        generator.close()  # type: ignore[attr-defined]


@pytest.fixture
def studio_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "audio"
    root.mkdir()
    monkeypatch.setattr(audio_studio, "storage_root", lambda: root)
    return root


def upload(client: TestClient, user: User, payload: bytes, filename: str = "sample.wav"):
    return client.post(
        "/api/v1/studio/assets",
        headers={"X-MusicScope-User-ID": str(user.id)},
        files={"file": (filename, payload, "application/octet-stream")},
    )


def test_upload_streams_hashes_and_uses_verified_media(studio_storage: Path) -> None:
    user = create_user()
    payload = wav_bytes()
    with TestClient(app) as client:
        response = upload(client, user, payload, "spoofed.mp3")
    assert response.status_code == 201
    body = response.json()
    assert body["media_type"] == "audio/wav"
    assert body["sha256"] == hashlib.sha256(payload).hexdigest()
    assert body["size_bytes"] == len(payload)
    assert not list(studio_storage.rglob("*.upload"))


def test_upload_rejects_invalid_and_oversized_content(
    studio_storage: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = create_user()
    with TestClient(app) as client:
        invalid = upload(client, user, b"not audio", "track.flac")
        assert invalid.status_code == 422
        assert invalid.json()["detail"]["code"] == "FFPROBE_FAILED"
        monkeypatch.setattr(audio_studio.get_settings(), "audio_upload_max_bytes", 16)
        oversized = upload(client, user, wav_bytes(), "track.wav")
    assert oversized.status_code == 413
    assert oversized.json()["detail"]["code"] == "UPLOAD_TOO_LARGE"


def test_upload_rejects_audio_over_duration_limit(
    studio_storage: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = create_user()
    monkeypatch.setattr(audio_studio.get_settings(), "audio_duration_max_seconds", 0.01)
    with TestClient(app) as client:
        response = upload(client, user, wav_bytes(0.1), "short-but-over-limit.wav")
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "DURATION_TOO_LONG"


def test_processing_fingerprint_is_filename_independent_and_versioned() -> None:
    checksum = "a" * 64
    assert processing_fingerprint(checksum) == processing_fingerprint(checksum)
    assert processing_fingerprint(checksum) != processing_fingerprint("b" * 64)
    assert processing_fingerprint(checksum, "htdemucs_6s") != processing_fingerprint(checksum)


def test_new_jobs_use_only_six_stem_model(studio_storage: Path) -> None:
    user = create_user("Six stems")
    with TestClient(app) as client:
        asset = upload(client, user, wav_bytes()).json()
        base = f"/api/v1/studio/assets/{asset['id']}/jobs"
        headers = {"X-MusicScope-User-ID": str(user.id)}
        six = client.post(base, headers=headers)
        four = client.post(f"{base}?model=htdemucs", headers=headers)
        invalid = client.post(f"{base}?model=unknown", headers=headers)
    assert four.status_code == 422
    assert six.status_code == 201
    assert six.json()["model_name"] == "htdemucs_6s"
    assert four.json()["detail"]["code"] == "UNSUPPORTED_STEM_MODEL"
    assert invalid.status_code == 422


def test_library_track_link_is_durable_and_user_scoped(studio_storage: Path) -> None:
    owner = create_user("Track owner")
    stranger = create_user("Unrelated listener")
    db, generator = database_session()
    try:
        connection = MusicConnection(user_id=owner.id, provider="netease", status="CONNECTED")
        track = Track(title="Library song")
        db.add_all([connection, track])
        db.flush()
        playlist = Playlist(owner_connection_id=connection.id, name="Owned playlist")
        db.add(playlist)
        db.flush()
        db.add(PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=0))
        db.commit()
        track_id = track.id
    finally:
        generator.close()  # type: ignore[attr-defined]
    with TestClient(app) as client:
        owned_asset = upload(client, owner, wav_bytes()).json()
        other_asset = upload(client, stranger, wav_bytes()).json()
        owner_headers = {"X-MusicScope-User-ID": str(owner.id)}
        stranger_headers = {"X-MusicScope-User-ID": str(stranger.id)}
        created = client.post(
            f"/api/v1/studio/assets/{owned_asset['id']}/jobs?track_id={track_id}",
            headers=owner_headers,
        )
        reopened = client.get(f"/api/v1/studio/jobs/{created.json()['id']}", headers=owner_headers)
        denied = client.post(
            f"/api/v1/studio/assets/{other_asset['id']}/jobs?track_id={track_id}",
            headers=stranger_headers,
        )
    assert created.status_code == 201
    assert created.json()["source_track_ids"] == [str(track_id)]
    assert reopened.json()["source_track_ids"] == [str(track_id)]
    assert denied.status_code == 404


def provider_source(url: str = "http://m1.music.126.net/sample?token=test") -> ProviderPlaybackSource:
    return ProviderPlaybackSource(
        provider="netease",
        url=url,
        mime_type="audio/wav",
        duration_ms=100,
        expires_at=None,
        quality=None,
    )


def test_account_song_creates_job_without_upload_and_rejects_other_user(
    studio_storage: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = create_user("Account owner")
    stranger = create_user("Account stranger")
    db, generator = database_session()
    try:
        connection = MusicConnection(user_id=owner.id, provider="netease", status="CONNECTED")
        track = Track(title="Account song")
        db.add_all([connection, track])
        db.flush()
        playlist = Playlist(owner_connection_id=connection.id, name="Owned")
        db.add(playlist)
        db.flush()
        db.add(PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=0))
        db.commit()
        track_id = track.id
    finally:
        generator.close()  # type: ignore[attr-defined]

    calls: list[str] = []

    async def resolve(
        self: PlaybackService, requested_id: UUID, user: User | None = None
    ) -> PlaybackResolution:
        assert requested_id == track_id and user is not None and user.id == owner.id
        calls.append("resolve")
        return PlaybackResolution(
            track=Track(id=track_id, title="Account song"), source=provider_source(), resolution_ms=1
        )

    async def import_asset(db: Session, user: User, track: Track, source: ProviderPlaybackSource):
        assert user.id == owner.id and track.id == track_id and source.provider == "netease"
        calls.append("import")
        return await audio_studio.create_audio_asset(
            db, user, UploadFile(file=io.BytesIO(wav_bytes()), filename="account.wav")
        )

    monkeypatch.setattr(PlaybackService, "resolve", resolve)
    monkeypatch.setattr("app.api.routes.studio.create_provider_audio_asset", import_asset)
    url = f"/api/v1/studio/tracks/{track_id}/jobs?model=htdemucs_6s"
    with TestClient(app) as client:
        denied = client.post(url, headers={"X-MusicScope-User-ID": str(stranger.id)})
        created = client.post(url, headers={"X-MusicScope-User-ID": str(owner.id)})
    assert denied.status_code == 404
    assert created.status_code == 201
    assert created.json()["model_name"] == "htdemucs_6s"
    assert created.json()["source_track_ids"] == [str(track_id)]
    assert calls == ["resolve", "import"]


def test_provider_import_enforces_cdn_and_cleans_temporary_audio(
    studio_storage: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(studio_provider_import, "storage_root", lambda: studio_storage)
    user = create_user("Provider import")
    db, generator = database_session()
    requested_urls: list[str] = []
    source = provider_source()

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "audio/wav"}, content=wav_bytes())

    async def run() -> tuple[AudioAsset, bool]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await studio_provider_import.create_provider_audio_asset(
                db,
                user,
                Track(title="Imported song"),
                source,
                client=client,
            )

    try:
        asset, reused = asyncio.run(run())
        assert not reused and asset.media_type == "audio/wav"
        assert requested_urls == ["https://m1.music.126.net/sample?token=test"]
        assert "token=test" not in str(asset.metadata_json)
        assert not list((studio_storage / "imports").iterdir())
    finally:
        generator.close()  # type: ignore[attr-defined]


def test_provider_import_rejects_unsafe_url_and_oversized_audio(
    studio_storage: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(studio_provider_import, "storage_root", lambda: studio_storage)
    user = create_user("Import safety")
    db, generator = database_session()
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "audio/wav", "content-length": "999999999"})

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(StudioError) as unsafe:
                await studio_provider_import.create_provider_audio_asset(
                    db,
                    user,
                    Track(title="Unsafe"),
                    provider_source("https://evil.example/audio"),
                    client=client,
                )
            assert unsafe.value.code == "PROVIDER_SOURCE_UNSUPPORTED"
            with pytest.raises(StudioError) as too_large:
                await studio_provider_import.create_provider_audio_asset(
                    db,
                    user,
                    Track(title="Large"),
                    provider_source(),
                    client=client,
                )
            assert too_large.value.code == "PROVIDER_AUDIO_TOO_LARGE"

    try:
        asyncio.run(run())
        assert calls == ["https://m1.music.126.net/sample?token=test"]
        assert not list((studio_storage / "imports").iterdir())
    finally:
        generator.close()  # type: ignore[attr-defined]


def test_same_user_reuses_asset_and_job_but_other_user_does_not(studio_storage: Path) -> None:
    first = create_user("First")
    second = create_user("Second")
    payload = wav_bytes()
    with TestClient(app) as client:
        first_asset = upload(client, first, payload).json()
        duplicate = upload(client, first, payload)
        second_asset = upload(client, second, payload).json()
        assert duplicate.status_code == 200
        assert duplicate.json()["id"] == first_asset["id"]
        assert duplicate.json()["reused"] is True
        assert second_asset["id"] != first_asset["id"]
        first_job = client.post(
            f"/api/v1/studio/assets/{first_asset['id']}/jobs",
            headers={"X-MusicScope-User-ID": str(first.id)},
        )
        repeated_job = client.post(
            f"/api/v1/studio/assets/{first_asset['id']}/jobs",
            headers={"X-MusicScope-User-ID": str(first.id)},
        )
        forbidden = client.post(
            f"/api/v1/studio/assets/{first_asset['id']}/jobs",
            headers={"X-MusicScope-User-ID": str(second.id)},
        )
    assert first_job.status_code == 201
    assert repeated_job.status_code == 200
    assert repeated_job.json()["id"] == first_job.json()["id"]
    assert forbidden.status_code == 404


def test_cancel_retry_and_cross_user_job_isolation(studio_storage: Path) -> None:
    owner = create_user("Owner")
    stranger = create_user("Stranger")
    with TestClient(app) as client:
        asset = upload(client, owner, wav_bytes()).json()
        job = client.post(
            f"/api/v1/studio/assets/{asset['id']}/jobs",
            headers={"X-MusicScope-User-ID": str(owner.id)},
        ).json()
        hidden = client.get(
            f"/api/v1/studio/jobs/{job['id']}",
            headers={"X-MusicScope-User-ID": str(stranger.id)},
        )
        cancelled = client.post(
            f"/api/v1/studio/jobs/{job['id']}/cancel",
            headers={"X-MusicScope-User-ID": str(owner.id)},
        )
        retried = client.post(
            f"/api/v1/studio/jobs/{job['id']}/retry",
            headers={"X-MusicScope-User-ID": str(owner.id)},
        )
    assert hidden.status_code == 404
    assert cancelled.json()["status"] == "CANCELLED"
    assert retried.json()["status"] == "QUEUED"


def test_private_range_serving_and_missing_artifact(studio_storage: Path) -> None:
    owner = create_user("Owner")
    stranger = create_user("Stranger")
    artifact_id = uuid4()
    job_id = uuid4()
    asset_id = uuid4()
    payload = bytes(range(100))
    path = studio_storage / "jobs" / str(job_id) / "stems" / "vocals.flac"
    path.parent.mkdir(parents=True)
    path.write_bytes(payload)
    waveform_path = path.parents[1] / "waveform" / "peaks-v1.json"
    waveform_path.parent.mkdir(parents=True)
    waveform_path.write_text('{"version":"peaks-json-v1","duration_ms":1000,"stems":{}}', encoding="utf-8")
    db, generator = database_session()
    try:
        db.add(
            AudioAsset(
                id=asset_id,
                user_id=owner.id,
                original_filename="source.wav",
                media_type="audio/wav",
                size_bytes=1,
                sample_rate=44100,
                channels=2,
                storage_key="assets/source.wav",
                sha256="1" * 64,
                duration_ms=1000,
            )
        )
        db.add(
            StemJob(
                id=job_id,
                user_id=owner.id,
                audio_asset_id=asset_id,
                status="SUCCEEDED",
                stage="COMPLETE",
                fingerprint="2" * 64,
                model_name="htdemucs",
                configuration={},
                progress=0,
            )
        )
        db.add(
            StemArtifact(
                id=artifact_id,
                stem_job_id=job_id,
                stem_type="VOCALS",
                storage_key=path.relative_to(studio_storage).as_posix(),
                waveform_storage_key=waveform_path.relative_to(studio_storage).as_posix(),
                media_type="audio/flac",
                size_bytes=len(payload),
                duration_ms=1000,
                sample_rate=44100,
                channels=2,
                sha256=hashlib.sha256(payload).hexdigest(),
            )
        )
        db.commit()
    finally:
        generator.close()  # type: ignore[attr-defined]
    url = f"/api/v1/studio/artifacts/{artifact_id}/stream"
    with TestClient(app) as client:
        full = client.get(url, headers={"X-MusicScope-User-ID": str(owner.id)})
        download = client.get(f"{url}?download=true", headers={"X-MusicScope-User-ID": str(owner.id)})
        partial = client.get(
            url,
            headers={"X-MusicScope-User-ID": str(owner.id), "Range": "bytes=10-19"},
        )
        invalid = client.get(
            url,
            headers={"X-MusicScope-User-ID": str(owner.id), "Range": "bytes=1000-1100"},
        )
        hidden = client.get(url, headers={"X-MusicScope-User-ID": str(stranger.id)})
        head = client.head(url, headers={"X-MusicScope-User-ID": str(owner.id)})
        cached = client.get(
            url,
            headers={"X-MusicScope-User-ID": str(owner.id), "If-None-Match": full.headers["etag"]},
        )
        waveform = client.get(
            f"/api/v1/studio/jobs/{job_id}/waveform",
            headers={"X-MusicScope-User-ID": str(owner.id)},
        )
        hidden_waveform = client.get(
            f"/api/v1/studio/jobs/{job_id}/waveform",
            headers={"X-MusicScope-User-ID": str(stranger.id)},
        )
    assert full.status_code == 200 and full.content == payload
    assert full.headers["cache-control"].startswith("private")
    assert full.headers["x-content-type-options"] == "nosniff"
    assert partial.status_code == 206 and partial.content == payload[10:20]
    assert partial.headers["content-range"] == "bytes 10-19/100"
    assert invalid.status_code == 416
    assert hidden.status_code == 404
    assert head.status_code == 200 and head.content == b""
    assert cached.status_code == 304
    assert download.status_code == 200 and download.headers["content-disposition"].startswith("attachment;")
    assert waveform.status_code == 200 and waveform.json()["version"] == "peaks-json-v1"
    assert hidden_waveform.status_code == 404
    assert str(studio_storage) not in full.headers.get("content-disposition", "")
    path.unlink()
    with TestClient(app) as client:
        missing = client.get(url, headers={"X-MusicScope-User-ID": str(owner.id)})
    assert missing.status_code == 404


def test_retry_removes_only_failed_jobs_published_outputs(studio_storage: Path) -> None:
    owner = create_user("Retry Owner")
    with TestClient(app) as client:
        asset = upload(client, owner, wav_bytes()).json()
        job = client.post(
            f"/api/v1/studio/assets/{asset['id']}/jobs",
            headers={"X-MusicScope-User-ID": str(owner.id)},
        ).json()
    job_root = studio_storage / "jobs" / job["id"]
    stem_path = job_root / "stems" / "vocals.flac"
    waveform_path = job_root / "waveform" / "peaks-v1.json"
    stem_path.parent.mkdir(parents=True)
    waveform_path.parent.mkdir(parents=True)
    stem_path.write_bytes(b"invalid-old-output")
    waveform_path.write_text("{}", encoding="utf-8")
    db, generator = database_session()
    try:
        stored_job = db.get(StemJob, UUID(job["id"]))
        assert stored_job is not None
        stored_job.status = "FAILED"
        stored_job.stage = "FAILED"
        db.add(
            StemArtifact(
                stem_job_id=stored_job.id,
                stem_type="VOCALS",
                storage_key=stem_path.relative_to(studio_storage).as_posix(),
                waveform_storage_key=waveform_path.relative_to(studio_storage).as_posix(),
                media_type="audio/flac",
                size_bytes=stem_path.stat().st_size,
                duration_ms=100,
                sample_rate=44100,
                channels=2,
                sha256="f" * 64,
            )
        )
        db.commit()
    finally:
        generator.close()  # type: ignore[attr-defined]
    with TestClient(app) as client:
        retried = client.post(
            f"/api/v1/studio/jobs/{job['id']}/retry",
            headers={"X-MusicScope-User-ID": str(owner.id)},
        )
    assert retried.status_code == 200 and retried.json()["status"] == "QUEUED"
    assert not (job_root / "stems").exists()
    assert not (job_root / "waveform").exists()
    db, generator = database_session()
    try:
        assert not list(db.query(StemArtifact).filter_by(stem_job_id=UUID(job["id"])))
    finally:
        generator.close()  # type: ignore[attr-defined]


def test_storage_resolution_rejects_traversal_and_symlink(
    studio_storage: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(StudioError):
        resolve_storage_key("../outside.flac", must_exist=False)
    outside = studio_storage.parent / "outside.flac"
    outside.write_bytes(b"x")
    link = studio_storage / "linked.flac"
    link.symlink_to(outside)
    with pytest.raises(StudioError):
        resolve_storage_key("linked.flac")
