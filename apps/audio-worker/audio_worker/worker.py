from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from importlib.metadata import version
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

REPO_ROOT = Path(__file__).resolve().parents[3]
API_ROOT = REPO_ROOT / "apps" / "api"
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.core.config import get_settings  # noqa: E402
from app.core.database import get_engine  # noqa: E402
from app.domain.enums import StemJobStatus  # noqa: E402
from app.domain.models import AudioAsset, StemArtifact, StemJob, utc_now  # noqa: E402
from app.services.audio_studio import (  # noqa: E402
    STEM_TYPES,
    StudioError,
    probe_audio,
    resolve_storage_key,
    stem_types_for_model,
    storage_root,
    user_storage_bytes,
)
from sqlalchemy import delete, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from audio_worker.beat_analysis import estimate_beat_grid  # noqa: E402

ADVISORY_LOCK_ID = 4_672_041
STOP_REQUESTED = False
ACTIVE_PROCESS: subprocess.Popen[bytes] | None = None


class WorkerFailure(Exception):
    def __init__(self, code: str, message: str, diagnostic: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.diagnostic = diagnostic[-8000:]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the MusicScope local audio worker.")
    parser.add_argument("--once", action="store_true", help="Claim at most one queued job, then exit.")
    parser.add_argument("--health-file", type=Path)
    return parser.parse_args()


def _signal_stop(_signum: int, _frame: object) -> None:
    global STOP_REQUESTED
    STOP_REQUESTED = True
    if ACTIVE_PROCESS is not None and ACTIVE_PROCESS.poll() is None:
        _terminate_process_group(ACTIVE_PROCESS)


def _health(path: Path | None, state: str, job_id: UUID | None = None) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "state": state,
                "job_id": str(job_id) if job_id else None,
                "updated_at": datetime.now(UTC).isoformat(),
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    temporary.replace(path)


def recover_stale_jobs(db: Session) -> list[UUID]:
    cutoff = utc_now() - timedelta(seconds=get_settings().audio_worker_stale_seconds)
    jobs = list(
        db.scalars(
            select(StemJob).where(
                StemJob.status.in_([StemJobStatus.PREPARING.value, StemJobStatus.RUNNING.value]),
                (StemJob.heartbeat_at.is_(None)) | (StemJob.heartbeat_at < cutoff),
            )
        )
    )
    now = utc_now()
    for job in jobs:
        job.status = StemJobStatus.FAILED.value
        job.stage = "FAILED"
        job.safe_error_code = "WORKER_INTERRUPTED"
        job.safe_error_message = "The audio worker stopped before this job completed. Retry when ready."
        job.diagnostic_error = {}
        job.worker_run_id = None
        job.heartbeat_at = None
        job.completed_at = now
        _cleanup_job_tmp(job.id)
    db.commit()
    return [job.id for job in jobs]


def claim_next_job(db: Session, run_id: UUID) -> StemJob | None:
    statement = (
        select(StemJob)
        .where(StemJob.status == StemJobStatus.QUEUED.value)
        .order_by(StemJob.created_at, StemJob.id)
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    job = db.scalar(statement)
    if job is None:
        db.rollback()
        return None
    now = utc_now()
    job.status = StemJobStatus.PREPARING.value
    job.stage = "PROBING"
    job.worker_run_id = run_id
    job.heartbeat_at = now
    job.started_at = now
    job.completed_at = None
    job.cancellation_requested_at = None
    job.attempt_count += 1
    db.commit()
    db.refresh(job)
    return job


def set_stage(db: Session, job: StemJob, status: StemJobStatus, stage: str) -> None:
    job.status = status.value
    job.stage = stage
    job.heartbeat_at = utc_now()
    db.commit()


def select_device() -> str:
    configured = os.getenv("AUDIO_WORKER_DEVICE", "").strip().casefold()
    if configured:
        if configured not in {"mps", "cuda", "cpu"}:
            raise WorkerFailure("MODEL_UNAVAILABLE", "Configured audio device is invalid.")
        if configured == "mps":
            import torch

            if not torch.backends.mps.is_available():
                raise WorkerFailure("MODEL_UNAVAILABLE", "The configured MPS device is unavailable.")
        if configured == "cuda":
            import torch

            if not torch.cuda.is_available():
                raise WorkerFailure("MODEL_UNAVAILABLE", "The configured CUDA device is unavailable.")
        return configured
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _worker_cache() -> Path:
    configured = os.getenv("MUSICSCOPE_MODEL_CACHE")
    if configured:
        cache = Path(configured).expanduser()
    elif os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        cache = Path(local_app_data) / "MusicScope" / "models"
    else:
        cache = Path.home() / "Library" / "Caches" / "MusicScope" / "models"
    cache.mkdir(parents=True, exist_ok=True)
    return cache.resolve()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=5)
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def _run_owned_process(
    db: Session,
    job: StemJob,
    command: list[str],
    log_path: Path,
    timeout_seconds: int,
    environment: dict[str, str] | None = None,
) -> str:
    global ACTIVE_PROCESS
    started = time.monotonic()
    return_code: int | None = None
    try:
        with log_path.open("wb") as log:
            ACTIVE_PROCESS = subprocess.Popen(
                command,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                env=environment,
            )
            last_heartbeat = 0.0
            while ACTIVE_PROCESS.poll() is None:
                now = time.monotonic()
                if now - started > timeout_seconds:
                    _terminate_process_group(ACTIVE_PROCESS)
                    raise WorkerFailure("SEPARATION_FAILED", "Audio separation exceeded its time limit.")
                db.expire_all()
                refreshed = db.get(StemJob, job.id)
                if refreshed is None:
                    _terminate_process_group(ACTIVE_PROCESS)
                    raise WorkerFailure("PROCESS_CANCELLED", "The Studio job no longer exists.")
                if STOP_REQUESTED:
                    _terminate_process_group(ACTIVE_PROCESS)
                    raise WorkerFailure("WORKER_INTERRUPTED", "The audio worker stopped before completion.")
                if refreshed.cancellation_requested_at is not None:
                    _terminate_process_group(ACTIVE_PROCESS)
                    raise WorkerFailure("PROCESS_CANCELLED", "Separation was cancelled.")
                if now - last_heartbeat >= 5:
                    refreshed.heartbeat_at = utc_now()
                    db.commit()
                    last_heartbeat = now
                time.sleep(0.5)
            return_code = ACTIVE_PROCESS.returncode
    except FileNotFoundError as exc:
        raise WorkerFailure("MODEL_UNAVAILABLE", "A required audio tool is unavailable.") from exc
    finally:
        ACTIVE_PROCESS = None
    diagnostic = log_path.read_text(encoding="utf-8", errors="replace")[-8000:]
    if return_code != 0:
        lowered = diagnostic.casefold()
        if "out of memory" in lowered or "mps backend out of memory" in lowered:
            raise WorkerFailure("OUT_OF_MEMORY", "Audio separation ran out of memory.", diagnostic)
        if "download" in lowered or "model" in lowered and "not found" in lowered:
            raise WorkerFailure(
                "MODEL_LOAD_FAILED", "The separation model could not be prepared.", diagnostic
            )
        raise WorkerFailure("SEPARATION_FAILED", "Audio separation failed.", diagnostic)
    return diagnostic


def _canonical_input(db: Session, job: StemJob, source: Path, work: Path) -> Path:
    target = work / "input.wav"
    set_stage(db, job, StemJobStatus.PREPARING, "TRANSCODING")
    command = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        str(target),
    ]
    try:
        _run_owned_process(db, job, command, work / "ffmpeg.log", 180)
    except WorkerFailure as exc:
        if exc.code in {"PROCESS_CANCELLED", "WORKER_INTERRUPTED"}:
            raise
        raise WorkerFailure(
            "TRANSCODE_FAILED", "The audio file could not be prepared.", exc.diagnostic
        ) from exc
    if not target.is_file() or target.stat().st_size == 0:
        raise WorkerFailure("TRANSCODE_FAILED", "The audio file could not be prepared.")
    return target


def _find_stems(output: Path, expected: tuple[str, ...] = STEM_TYPES) -> dict[str, Path]:
    discovered: dict[str, Path] = {}
    for candidate in output.rglob("*.flac"):
        stem = candidate.stem.upper()
        if stem in expected:
            if stem in discovered:
                raise WorkerFailure("ARTIFACT_VALIDATION_FAILED", "Duplicate stem output was produced.")
            discovered[stem] = candidate
    if set(discovered) != set(expected):
        raise WorkerFailure(
            "ARTIFACT_VALIDATION_FAILED", f"Separation did not produce exactly {len(expected)} stems."
        )
    return discovered


def _validate_stems(paths: dict[str, Path], duration_ms: int) -> dict[str, dict[str, Any]]:
    metadata: dict[str, dict[str, Any]] = {}
    for stem, path in paths.items():
        try:
            probe = probe_audio(path)
        except StudioError as exc:
            raise WorkerFailure("ARTIFACT_VALIDATION_FAILED", "A separated stem is not valid audio.") from exc
        if probe.media_type != "audio/flac" or abs(probe.duration_ms - duration_ms) > 100:
            raise WorkerFailure(
                "ARTIFACT_VALIDATION_FAILED", "Separated stems failed synchronization checks."
            )
        metadata[stem] = {
            "duration_ms": probe.duration_ms,
            "sample_rate": probe.sample_rate,
            "channels": probe.channels,
            "size_bytes": path.stat().st_size,
            "sha256": _sha256(path),
        }
    return metadata


def generate_waveform(paths: dict[str, Path], duration_ms: int, destination: Path) -> dict[str, Any]:
    import numpy as np

    target_buckets = 2000
    stems: dict[str, Any] = {}
    beat_grid: dict[str, object] | None = None
    for stem, path in sorted(paths.items()):
        try:
            completed = subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-i",
                    str(path),
                    "-ac",
                    "1",
                    "-ar",
                    "4000",
                    "-f",
                    "f32le",
                    "pipe:1",
                ],
                check=True,
                capture_output=True,
                timeout=max(120, math.ceil(duration_ms / 1000)),
            )
        except (FileNotFoundError, subprocess.SubprocessError) as exc:
            raise WorkerFailure("ARTIFACT_VALIDATION_FAILED", "Waveform generation failed.") from exc
        samples = np.frombuffer(completed.stdout, dtype="<f4")
        if samples.size == 0 or not np.isfinite(samples).all():
            raise WorkerFailure("ARTIFACT_VALIDATION_FAILED", "Waveform samples are invalid.")
        if stem == "DRUMS":
            beat_grid = estimate_beat_grid(samples, duration_ms)
        bucket_count = min(target_buckets, int(samples.size))
        boundaries = np.linspace(0, samples.size, bucket_count + 1, dtype=np.int64)
        peaks = [
            [
                round(float(samples[boundaries[index] : boundaries[index + 1]].min()), 5),
                round(float(samples[boundaries[index] : boundaries[index + 1]].max()), 5),
            ]
            for index in range(bucket_count)
        ]
        stems[stem] = {"bucket_count": bucket_count, "peaks": peaks}
    payload = {
        "version": "peaks-json-v1",
        "duration_ms": duration_ms,
        "stems": stems,
        "beat_grid": beat_grid,
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    return payload


def _cleanup_job_tmp(job_id: UUID) -> None:
    root = storage_root()
    target = root / "jobs" / str(job_id) / "tmp"
    if (
        target.exists()
        and target.is_dir()
        and not target.is_symlink()
        and target.resolve().is_relative_to(root)
    ):
        shutil.rmtree(target)


def _publish(
    db: Session,
    job: StemJob,
    paths: dict[str, Path],
    metadata: dict[str, dict[str, Any]],
    waveform: Path,
    run_dir: Path,
) -> None:
    root = storage_root()
    job_root = root / "jobs" / str(job.id)
    staging = run_dir / "publish"
    stem_staging = staging / "stems"
    waveform_staging = staging / "waveform"
    stem_staging.mkdir(parents=True, exist_ok=True)
    waveform_staging.mkdir(parents=True, exist_ok=True)
    for stem, source in paths.items():
        shutil.copy2(source, stem_staging / f"{stem.casefold()}.flac")
    shutil.copy2(waveform, waveform_staging / "peaks-v1.json")
    final_stems = job_root / "stems"
    final_waveform = job_root / "waveform"
    if final_stems.exists() or final_waveform.exists():
        raise WorkerFailure("ARTIFACT_WRITE_FAILED", "Existing Studio artifacts require manual review.")
    artifact_bytes = sum(int(item["size_bytes"]) for item in metadata.values())
    if user_storage_bytes(db, job.user_id) + artifact_bytes > get_settings().audio_storage_quota_bytes:
        raise WorkerFailure("STORAGE_QUOTA_EXCEEDED", "Studio storage quota would be exceeded.")
    published: list[Path] = []
    try:
        stem_staging.replace(final_stems)
        published.append(final_stems)
        waveform_staging.replace(final_waveform)
        published.append(final_waveform)
    except OSError as exc:
        for directory in reversed(published):
            if (
                directory.exists()
                and not directory.is_symlink()
                and directory.resolve().is_relative_to(root)
            ):
                shutil.rmtree(directory)
        raise WorkerFailure(
            "ARTIFACT_WRITE_FAILED", "Studio artifacts could not be published."
        ) from exc
    waveform_key = (final_waveform / "peaks-v1.json").relative_to(root).as_posix()
    db.execute(delete(StemArtifact).where(StemArtifact.stem_job_id == job.id))
    for stem in stem_types_for_model(job.model_name):
        final_path = final_stems / f"{stem.casefold()}.flac"
        item = metadata[stem]
        db.add(
            StemArtifact(
                stem_job_id=job.id,
                stem_type=stem,
                storage_key=final_path.relative_to(root).as_posix(),
                waveform_storage_key=waveform_key,
                media_type="audio/flac",
                size_bytes=item["size_bytes"],
                duration_ms=item["duration_ms"],
                sample_rate=item["sample_rate"],
                channels=item["channels"],
                sha256=item["sha256"],
                artifact_version="flac-v1",
            )
        )
    db.commit()


def process_job(db: Session, job: StemJob) -> None:
    started = time.monotonic()
    timings: dict[str, float] = {}
    asset = db.get(AudioAsset, job.audio_asset_id)
    if asset is None:
        raise WorkerFailure("INVALID_AUDIO", "The source audio is unavailable.")
    source = resolve_storage_key(asset.storage_key)
    device = select_device()
    job.device = device
    job.demucs_version = version("demucs")
    job.heartbeat_at = utc_now()
    db.commit()
    root = storage_root()
    run_id = job.worker_run_id or uuid4()
    run_dir = root / "jobs" / str(job.id) / "tmp" / str(run_id)
    run_dir.mkdir(parents=True, exist_ok=False)
    try:
        phase_started = time.monotonic()
        canonical = _canonical_input(db, job, source, run_dir)
        timings["preparation_seconds"] = round(time.monotonic() - phase_started, 3)
        output = run_dir / "demucs"
        log_path = run_dir / "demucs.log"
        set_stage(db, job, StemJobStatus.RUNNING, "LOADING_MODEL")
        model_cache = _worker_cache()
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(Path.home()),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "HF_HOME": str(model_cache / "huggingface"),
            "TORCH_HOME": str(model_cache / "torch"),
        }
        command = [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            job.model_name,
            "-d",
            device,
            "--segment",
            "7",
            "--overlap",
            "0.25",
            "--shifts",
            "1",
            "-j",
            "0",
            "--flac",
            "-o",
            str(output),
            str(canonical),
        ]
        job.stage = "SEPARATING"
        db.commit()
        phase_started = time.monotonic()
        _run_owned_process(
            db,
            job,
            command,
            log_path,
            timeout_seconds=max(900, math.ceil((asset.duration_ms or 0) / 1000 * 8)),
            environment=environment,
        )
        timings["separation_seconds"] = round(time.monotonic() - phase_started, 3)
        set_stage(db, job, StemJobStatus.RUNNING, "VALIDATING")
        phase_started = time.monotonic()
        stems = _find_stems(output, stem_types_for_model(job.model_name))
        metadata = _validate_stems(stems, asset.duration_ms or 0)
        timings["validation_seconds"] = round(time.monotonic() - phase_started, 3)
        set_stage(db, job, StemJobStatus.RUNNING, "GENERATING_WAVEFORM")
        waveform = run_dir / "peaks-v1.json"
        phase_started = time.monotonic()
        generate_waveform(stems, asset.duration_ms or 0, waveform)
        timings["waveform_seconds"] = round(time.monotonic() - phase_started, 3)
        set_stage(db, job, StemJobStatus.RUNNING, "FINALIZING")
        phase_started = time.monotonic()
        _publish(db, job, stems, metadata, waveform, run_dir)
        timings["finalization_seconds"] = round(time.monotonic() - phase_started, 3)
        job.status = StemJobStatus.SUCCEEDED.value
        job.stage = "COMPLETE"
        job.safe_error_code = None
        job.safe_error_message = None
        job.diagnostic_error = {**timings, "total_seconds": round(time.monotonic() - started, 3)}
        job.heartbeat_at = None
        job.worker_run_id = None
        job.completed_at = utc_now()
        db.commit()
    finally:
        _cleanup_job_tmp(job.id)


def fail_job(db: Session, job: StemJob, failure: WorkerFailure) -> None:
    db.rollback()
    refreshed = db.get(StemJob, job.id)
    if refreshed is None:
        return
    now = utc_now()
    if failure.code == "PROCESS_CANCELLED":
        refreshed.status = StemJobStatus.CANCELLED.value
        refreshed.stage = "CANCELLED"
    else:
        refreshed.status = StemJobStatus.FAILED.value
        refreshed.stage = "FAILED"
    refreshed.safe_error_code = failure.code
    refreshed.safe_error_message = failure.message[:300]
    refreshed.diagnostic_error = {"summary": failure.diagnostic} if failure.diagnostic else {}
    refreshed.worker_run_id = None
    refreshed.heartbeat_at = None
    refreshed.completed_at = now
    db.commit()
    _cleanup_job_tmp(refreshed.id)


def _acquire_worker_lock() -> Any:
    engine = get_engine()
    if engine.dialect.name == 'sqlite' and engine.url.database != ':memory:':
        # SQLite lacks PostgreSQL advisory locks. The OS releases this exclusive
        # file lock even if the worker crashes, allowing safe restart/recovery.
        path = Path(str(engine.url.database) + '.worker-lock')
        lock = path.open('a+b')
        try:
            if path.stat().st_size == 0:
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except OSError:
            lock.close()
            return None
    connection = engine.connect()
    if connection.dialect.name == "postgresql":
        acquired = connection.scalar(
            text("SELECT pg_try_advisory_lock(:lock_id)"), {"lock_id": ADVISORY_LOCK_ID}
        )
        if not acquired:
            connection.close()
            return None
    return connection


def run(*, once: bool = False, health_file: Path | None = None) -> int:
    run_id = uuid4()
    lock_connection = _acquire_worker_lock()
    if lock_connection is None:
        _health(health_file, "standby")
        return 0 if once else 2
    try:
        with Session(get_engine(), expire_on_commit=False) as db:
            recover_stale_jobs(db)
            while not STOP_REQUESTED:
                _health(health_file, "idle")
                job = claim_next_job(db, run_id)
                if job is None:
                    if once:
                        return 0
                    time.sleep(get_settings().audio_worker_poll_seconds)
                    continue
                _health(health_file, "processing", job.id)
                try:
                    process_job(db, job)
                except WorkerFailure as failure:
                    fail_job(db, job, failure)
                except Exception as exc:
                    fail_job(
                        db,
                        job,
                        WorkerFailure("SEPARATION_FAILED", "Audio separation failed.", type(exc).__name__),
                    )
                if once:
                    return 0
        return 0
    finally:
        lock_connection.close()
        _health(health_file, "stopped")


def main() -> int:
    signal.signal(signal.SIGINT, _signal_stop)
    signal.signal(signal.SIGTERM, _signal_stop)
    args = parse_args()
    return run(once=args.once, health_file=args.health_file)
