from __future__ import annotations

import hashlib
import io
import wave
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.domain.models import AudioAsset, StemArtifact, StemJob, User
from app.main import app
from app.services import audio_studio
from app.services.audio_studio import StudioError, processing_fingerprint, resolve_storage_key


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
    waveform_path.write_text(
        '{"version":"peaks-json-v1","duration_ms":1000,"stems":{}}', encoding="utf-8"
    )
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
