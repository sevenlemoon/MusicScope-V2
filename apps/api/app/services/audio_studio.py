from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import V2_ROOT, get_settings
from app.domain.enums import StemJobStatus
from app.domain.models import AudioAsset, StemArtifact, StemJob, User, utc_now

if TYPE_CHECKING:
    from fastapi import UploadFile

STEM_TYPES = ("VOCALS", "DRUMS", "BASS", "OTHER")
PROCESSING_CONFIGURATION: dict[str, Any] = {
    "version": 1,
    "model": "htdemucs",
    "model_identity": "htdemucs-demucs-4.1.0",
    "demucs_version": "4.1.0",
    "input": {"sample_rate": 44100, "channels": 2, "codec": "pcm_s16le"},
    "segment_seconds": 7,
    "overlap": 0.25,
    "shifts": 1,
    "jobs": 0,
    "artifact_format": "flac-v1",
    "waveform_format": "peaks-json-v1",
}
ALLOWED_CODECS = {"aac", "flac", "mp3", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"}
ALLOWED_FORMATS = {"aac", "flac", "mov,mp4,m4a,3gp,3g2,mj2", "mp3", "wav"}
MEDIA_TYPES = {
    "aac": ("audio/aac", ".aac"),
    "flac": ("audio/flac", ".flac"),
    "mov,mp4,m4a,3gp,3g2,mj2": ("audio/mp4", ".m4a"),
    "mp3": ("audio/mpeg", ".mp3"),
    "wav": ("audio/wav", ".wav"),
}


class StudioError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass(frozen=True)
class AudioProbe:
    media_type: str
    extension: str
    format_name: str
    codec_name: str
    duration_ms: int
    sample_rate: int
    channels: int


def storage_root() -> Path:
    configured = Path(get_settings().audio_storage_dir).expanduser()
    root = configured if configured.is_absolute() else V2_ROOT / configured
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise StudioError(500, "STORAGE_UNAVAILABLE", "Studio storage is unavailable.")
    return root.resolve()


def resolve_storage_key(storage_key: str, *, must_exist: bool = True) -> Path:
    if not storage_key or "\\" in storage_key:
        raise StudioError(500, "STORAGE_KEY_INVALID", "Stored audio location is invalid.")
    relative = PurePosixPath(storage_key)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise StudioError(500, "STORAGE_KEY_INVALID", "Stored audio location is invalid.")
    root = storage_root()
    candidate = root.joinpath(*relative.parts)
    current = root
    for part in relative.parts:
        current = current / part
        if current.exists() and current.is_symlink():
            raise StudioError(500, "STORAGE_KEY_INVALID", "Stored audio location is invalid.")
    try:
        resolved = candidate.resolve(strict=must_exist)
    except FileNotFoundError as exc:
        raise StudioError(404, "ARTIFACT_MISSING", "The requested audio artifact is unavailable.") from exc
    if not resolved.is_relative_to(root):
        raise StudioError(500, "STORAGE_KEY_INVALID", "Stored audio location is invalid.")
    if must_exist and (not resolved.is_file() or resolved.is_symlink()):
        raise StudioError(404, "ARTIFACT_MISSING", "The requested audio artifact is unavailable.")
    return resolved


def _safe_filename(filename: str | None) -> str:
    candidate = (filename or "audio").replace("\\", "/").split("/")[-1]
    cleaned = "".join(character for character in candidate if character.isprintable() and character != "\x00")
    return (cleaned.strip() or "audio")[:255]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_audio(path: Path) -> AudioProbe:
    if path.is_symlink() or not path.is_file():
        raise StudioError(422, "INVALID_AUDIO", "The uploaded file is not a regular audio file.")
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
        payload = json.loads(completed.stdout)
    except (FileNotFoundError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise StudioError(422, "FFPROBE_FAILED", "The audio file could not be verified.") from exc
    streams = payload.get("streams") or []
    if len(streams) != 1 or streams[0].get("codec_type") != "audio":
        raise StudioError(422, "INVALID_AUDIO", "Upload exactly one supported audio stream.")
    stream = streams[0]
    format_name = str((payload.get("format") or {}).get("format_name") or "")
    codec_name = str(stream.get("codec_name") or "")
    if format_name not in ALLOWED_FORMATS or codec_name not in ALLOWED_CODECS:
        raise StudioError(415, "UNSUPPORTED_AUDIO", "Use MP3, WAV, FLAC, or M4A/AAC audio.")
    try:
        duration_seconds = float((payload.get("format") or {})["duration"])
        sample_rate = int(stream["sample_rate"])
        channels = int(stream["channels"])
    except (KeyError, TypeError, ValueError) as exc:
        raise StudioError(422, "INVALID_AUDIO", "The audio metadata is incomplete.") from exc
    if not math.isfinite(duration_seconds) or duration_seconds <= 0 or sample_rate <= 0 or channels <= 0:
        raise StudioError(422, "INVALID_AUDIO", "The audio metadata is invalid.")
    if duration_seconds > get_settings().audio_duration_max_seconds:
        raise StudioError(413, "DURATION_TOO_LONG", "Audio must be 15 minutes or shorter.")
    media_type, extension = MEDIA_TYPES[format_name]
    return AudioProbe(
        media_type=media_type,
        extension=extension,
        format_name=format_name,
        codec_name=codec_name,
        duration_ms=round(duration_seconds * 1000),
        sample_rate=sample_rate,
        channels=channels,
    )


def user_storage_bytes(db: Session, user_id: UUID) -> int:
    source_bytes = (
        db.scalar(
            select(func.coalesce(func.sum(AudioAsset.size_bytes), 0)).where(AudioAsset.user_id == user_id)
        )
        or 0
    )
    artifact_bytes = (
        db.scalar(
            select(func.coalesce(func.sum(StemArtifact.size_bytes), 0))
            .join(StemJob, StemJob.id == StemArtifact.stem_job_id)
            .where(StemJob.user_id == user_id)
        )
        or 0
    )
    return int(source_bytes) + int(artifact_bytes)


async def create_audio_asset(db: Session, user: User, upload: UploadFile) -> tuple[AudioAsset, bool]:
    root = storage_root()
    asset_id = uuid4()
    original_dir = root / "assets" / str(asset_id) / "original"
    original_dir.mkdir(parents=True, exist_ok=False)
    temporary = original_dir / f".{uuid4()}.upload"
    digest = hashlib.sha256()
    total = 0
    try:
        with temporary.open("xb") as handle:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > get_settings().audio_upload_max_bytes:
                    raise StudioError(413, "UPLOAD_TOO_LARGE", "Audio files are limited to 200 MiB.")
                digest.update(chunk)
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        if total == 0:
            raise StudioError(422, "INVALID_AUDIO", "The uploaded audio file is empty.")
        probe = probe_audio(temporary)
        checksum = digest.hexdigest()
        existing = db.scalar(
            select(AudioAsset).where(AudioAsset.user_id == user.id, AudioAsset.sha256 == checksum)
        )
        if existing is not None:
            try:
                resolve_storage_key(existing.storage_key)
            except StudioError:
                existing = None
        if existing is not None:
            shutil.rmtree(original_dir.parent)
            return existing, True
        if user_storage_bytes(db, user.id) + total > get_settings().audio_storage_quota_bytes:
            raise StudioError(413, "STORAGE_QUOTA_EXCEEDED", "Studio storage quota would be exceeded.")
        final_path = original_dir / f"source{probe.extension}"
        temporary.replace(final_path)
        storage_key = final_path.relative_to(root).as_posix()
        asset = AudioAsset(
            id=asset_id,
            user_id=user.id,
            original_filename=_safe_filename(upload.filename),
            media_type=probe.media_type,
            size_bytes=total,
            sample_rate=probe.sample_rate,
            channels=probe.channels,
            storage_key=storage_key,
            sha256=checksum,
            duration_ms=probe.duration_ms,
            metadata_json={"format": probe.format_name, "codec": probe.codec_name},
        )
        db.add(asset)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.scalar(
                select(AudioAsset).where(
                    AudioAsset.user_id == user.id, AudioAsset.sha256 == checksum
                )
            )
            if existing is None:
                raise
            shutil.rmtree(original_dir.parent)
            return existing, True
        db.refresh(asset)
        return asset, False
    except Exception:
        db.rollback()
        if original_dir.parent.exists():
            shutil.rmtree(original_dir.parent)
        raise
    finally:
        await upload.close()


def processing_fingerprint(source_sha256: str) -> str:
    canonical = {"source_sha256": source_sha256, **PROCESSING_CONFIGURATION}
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _artifacts_are_valid(job: StemJob, artifacts: list[StemArtifact]) -> bool:
    if job.status != StemJobStatus.SUCCEEDED.value or {item.stem_type for item in artifacts} != set(
        STEM_TYPES
    ):
        return False
    try:
        return all(
            resolve_storage_key(item.storage_key).stat().st_size == item.size_bytes for item in artifacts
        )
    except (OSError, StudioError):
        return False


def create_stem_job(db: Session, user: User, asset_id: UUID) -> tuple[StemJob, bool]:
    asset = db.scalar(select(AudioAsset).where(AudioAsset.id == asset_id, AudioAsset.user_id == user.id))
    if asset is None:
        raise StudioError(404, "AUDIO_ASSET_NOT_FOUND", "Audio asset not found.")
    fingerprint = processing_fingerprint(asset.sha256)
    existing = db.scalar(
        select(StemJob).where(StemJob.user_id == user.id, StemJob.fingerprint == fingerprint)
    )
    if existing is not None:
        artifacts = list(
            db.scalars(select(StemArtifact).where(StemArtifact.stem_job_id == existing.id))
        )
        if existing.status == StemJobStatus.SUCCEEDED.value and not _artifacts_are_valid(
            existing, artifacts
        ):
            existing.status = StemJobStatus.FAILED.value
            existing.stage = "FAILED"
            existing.safe_error_code = "ARTIFACT_VALIDATION_FAILED"
            existing.safe_error_message = "Stored stem artifacts require regeneration."
            existing.completed_at = utc_now()
            db.commit()
        return existing, True
    job = StemJob(
        user_id=user.id,
        audio_asset_id=asset.id,
        status=StemJobStatus.QUEUED.value,
        stage="QUEUED",
        fingerprint=fingerprint,
        model_name=str(PROCESSING_CONFIGURATION["model"]),
        model_version=str(PROCESSING_CONFIGURATION["model_identity"]),
        demucs_version=str(PROCESSING_CONFIGURATION["demucs_version"]),
        configuration=PROCESSING_CONFIGURATION,
        progress=0,
    )
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(
            select(StemJob).where(StemJob.user_id == user.id, StemJob.fingerprint == fingerprint)
        )
        if existing is None:
            raise
        return existing, existing.status == StemJobStatus.SUCCEEDED.value
    db.refresh(job)
    return job, False


def user_job(db: Session, user_id: UUID, job_id: UUID) -> StemJob:
    job = db.scalar(select(StemJob).where(StemJob.id == job_id, StemJob.user_id == user_id))
    if job is None:
        raise StudioError(404, "STEM_JOB_NOT_FOUND", "Studio job not found.")
    return job


def list_user_jobs(db: Session, user_id: UUID) -> list[StemJob]:
    return list(
        db.scalars(
            select(StemJob)
            .where(StemJob.user_id == user_id)
            .order_by(StemJob.created_at.desc(), StemJob.id.desc())
        )
    )


def cancel_job(db: Session, user_id: UUID, job_id: UUID) -> StemJob:
    job = user_job(db, user_id, job_id)
    if job.status in {
        StemJobStatus.SUCCEEDED.value,
        StemJobStatus.FAILED.value,
        StemJobStatus.CANCELLED.value,
    }:
        return job
    now = utc_now()
    job.cancellation_requested_at = now
    if job.status == StemJobStatus.QUEUED.value:
        job.status = StemJobStatus.CANCELLED.value
        job.stage = "CANCELLED"
        job.safe_error_code = "PROCESS_CANCELLED"
        job.safe_error_message = "Separation was cancelled."
        job.completed_at = now
    db.commit()
    db.refresh(job)
    return job


def retry_job(db: Session, user_id: UUID, job_id: UUID) -> StemJob:
    job = user_job(db, user_id, job_id)
    if job.status not in {StemJobStatus.FAILED.value, StemJobStatus.CANCELLED.value}:
        raise StudioError(409, "JOB_NOT_RETRYABLE", "Only failed or cancelled jobs can be retried.")
    db.execute(delete(StemArtifact).where(StemArtifact.stem_job_id == job.id))
    root = storage_root()
    job_root = root / "jobs" / str(job.id)
    if job_root.exists():
        resolved = job_root.resolve()
        if job_root.is_symlink() or not resolved.is_relative_to(root) or resolved == root:
            raise StudioError(500, "STORAGE_KEY_INVALID", "Stored audio location is invalid.")
        for directory in (resolved / "stems", resolved / "waveform", resolved / "tmp"):
            if directory.exists():
                if directory.is_symlink() or not directory.resolve().is_relative_to(root):
                    raise StudioError(500, "STORAGE_KEY_INVALID", "Stored audio location is invalid.")
                shutil.rmtree(directory)
    job.status = StemJobStatus.QUEUED.value
    job.stage = "QUEUED"
    job.safe_error_code = None
    job.safe_error_message = None
    job.diagnostic_error = {}
    job.worker_run_id = None
    job.heartbeat_at = None
    job.cancellation_requested_at = None
    job.started_at = None
    job.completed_at = None
    db.commit()
    db.refresh(job)
    return job


def artifact_for_user(db: Session, user_id: UUID, artifact_id: UUID) -> StemArtifact:
    artifact = db.scalar(
        select(StemArtifact)
        .join(StemJob, StemJob.id == StemArtifact.stem_job_id)
        .where(
            StemArtifact.id == artifact_id,
            StemJob.user_id == user_id,
            StemJob.status == StemJobStatus.SUCCEEDED.value,
        )
    )
    if artifact is None:
        raise StudioError(404, "STEM_ARTIFACT_NOT_FOUND", "Stem artifact not found.")
    return artifact


def waveform_for_user(db: Session, user_id: UUID, job_id: UUID) -> Path:
    job = user_job(db, user_id, job_id)
    if job.status != StemJobStatus.SUCCEEDED.value:
        raise StudioError(409, "WAVEFORM_NOT_READY", "Waveform is not ready.")
    artifact = db.scalar(select(StemArtifact).where(StemArtifact.stem_job_id == job.id).limit(1))
    if artifact is None or not artifact.waveform_storage_key:
        raise StudioError(404, "WAVEFORM_MISSING", "Waveform is unavailable.")
    return resolve_storage_key(artifact.waveform_storage_key)


def asset_for_job(db: Session, job: StemJob) -> AudioAsset:
    asset = db.get(AudioAsset, job.audio_asset_id)
    if asset is None:
        raise StudioError(500, "AUDIO_ASSET_MISSING", "The source audio is unavailable.")
    return asset


def artifacts_for_job(db: Session, job_id: UUID) -> list[StemArtifact]:
    return list(
        db.scalars(
            select(StemArtifact).where(StemArtifact.stem_job_id == job_id).order_by(StemArtifact.stem_type)
        )
    )
