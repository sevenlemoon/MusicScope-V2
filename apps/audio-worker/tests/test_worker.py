from __future__ import annotations

import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest
from app.core.database import Base
from app.domain.models import AudioAsset, StemJob, User, utc_now
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from audio_worker import worker


def make_database() -> tuple[object, Session, User, AudioAsset]:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    user = User(display_name="Worker User")
    db.add(user)
    db.flush()
    asset = AudioAsset(
        user_id=user.id,
        original_filename="source.wav",
        media_type="audio/wav",
        size_bytes=100,
        sample_rate=44100,
        channels=2,
        storage_key="assets/source.wav",
        sha256="a" * 64,
        duration_ms=1000,
    )
    db.add(asset)
    db.commit()
    return engine, db, user, asset


def make_job(db: Session, user: User, asset: AudioAsset, **values: object) -> StemJob:
    fields: dict[str, object] = {
        "user_id": user.id,
        "audio_asset_id": asset.id,
        "status": "QUEUED",
        "stage": "QUEUED",
        "fingerprint": uuid4().hex + uuid4().hex,
        "model_name": "htdemucs",
        "configuration": {},
        "progress": 0,
        **values,
    }
    job = StemJob(**fields)
    db.add(job)
    db.commit()
    return job


def test_claim_is_ordered_and_records_attempt_identity() -> None:
    engine, db, user, asset = make_database()
    try:
        first = make_job(db, user, asset)
        second = make_job(db, user, asset)
        run_id = uuid4()
        claimed = worker.claim_next_job(db, run_id)
        assert claimed is not None and claimed.id == first.id
        assert claimed.status == "PREPARING" and claimed.stage == "PROBING"
        assert claimed.worker_run_id == run_id and claimed.attempt_count == 1
        assert db.get(StemJob, second.id).status == "QUEUED"
    finally:
        db.close()
        engine.dispose()


def test_stale_jobs_fail_safely_and_can_be_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    engine, db, user, asset = make_database()
    try:
        stale = make_job(
            db,
            user,
            asset,
            status="RUNNING",
            stage="SEPARATING",
            heartbeat_at=utc_now() - timedelta(minutes=10),
        )
        monkeypatch.setattr(worker, "_cleanup_job_tmp", lambda _job_id: None)
        assert worker.recover_stale_jobs(db) == [stale.id]
        db.refresh(stale)
        assert stale.status == "FAILED"
        assert stale.safe_error_code == "WORKER_INTERRUPTED"
        assert stale.worker_run_id is None and stale.heartbeat_at is None
    finally:
        db.close()
        engine.dispose()


def test_exactly_four_stems_are_required(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    for stem in worker.STEM_TYPES:
        (output / f"{stem.casefold()}.flac").write_bytes(b"flac")
    assert set(worker._find_stems(output)) == set(worker.STEM_TYPES)
    (output / "bass.flac").unlink()
    with pytest.raises(worker.WorkerFailure, match="exactly 4"):
        worker._find_stems(output)
    (output / "bass.flac").write_bytes(b"flac")
    nested = output / "duplicate"
    nested.mkdir()
    (nested / "vocals.flac").write_bytes(b"flac")
    with pytest.raises(worker.WorkerFailure, match="Duplicate"):
        worker._find_stems(output)


def test_six_stem_model_requires_guitar_and_piano(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    expected = ("VOCALS", "DRUMS", "BASS", "GUITAR", "PIANO", "OTHER")
    for stem in expected:
        (output / f"{stem.casefold()}.flac").write_bytes(b"flac")
    assert set(worker._find_stems(output, expected)) == set(expected)
    (output / "piano.flac").unlink()
    with pytest.raises(worker.WorkerFailure, match="exactly 6"):
        worker._find_stems(output, expected)


def test_stem_validation_rejects_corrupt_or_desynchronized_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = {stem: tmp_path / f"{stem}.flac" for stem in worker.STEM_TYPES}
    for path in paths.values():
        path.write_bytes(b"audio")
    valid = SimpleNamespace(media_type="audio/flac", duration_ms=1000, sample_rate=44100, channels=2)
    monkeypatch.setattr(worker, "probe_audio", lambda _path: valid)
    metadata = worker._validate_stems(paths, 1000)
    assert set(metadata) == set(worker.STEM_TYPES)
    monkeypatch.setattr(
        worker,
        "probe_audio",
        lambda _path: SimpleNamespace(
            media_type="audio/flac", duration_ms=1200, sample_rate=44100, channels=2
        ),
    )
    with pytest.raises(worker.WorkerFailure, match="synchronization"):
        worker._validate_stems(paths, 1000)


class ProcessDb:
    def __init__(self, job: object) -> None:
        self.job = job
        self.commits = 0

    def expire_all(self) -> None: pass
    def get(self, _model: object, _id: object) -> object: return self.job
    def commit(self) -> None: self.commits += 1


def test_owned_process_maps_nonzero_oom_timeout_and_cancellation(tmp_path: Path) -> None:
    job = SimpleNamespace(id=uuid4(), cancellation_requested_at=None, heartbeat_at=None)
    db = ProcessDb(job)
    with pytest.raises(worker.WorkerFailure) as oom:
        worker._run_owned_process(
            db, job, [sys.executable, "-c", "print('MPS backend out of memory'); raise SystemExit(2)"],
            tmp_path / "oom.log", 5,
        )
    assert oom.value.code == "OUT_OF_MEMORY"
    with pytest.raises(worker.WorkerFailure) as timeout:
        worker._run_owned_process(
            db, job, [sys.executable, "-c", "import time; time.sleep(3)"],
            tmp_path / "timeout.log", 0,
        )
    assert timeout.value.code == "SEPARATION_FAILED"
    job.cancellation_requested_at = utc_now()
    with pytest.raises(worker.WorkerFailure) as cancelled:
        worker._run_owned_process(
            db, job, [sys.executable, "-c", "import time; time.sleep(3)"],
            tmp_path / "cancel.log", 5,
        )
    assert cancelled.value.code == "PROCESS_CANCELLED"
    assert worker.ACTIVE_PROCESS is None


def test_owned_process_heartbeats(tmp_path: Path) -> None:
    job = SimpleNamespace(id=uuid4(), cancellation_requested_at=None, heartbeat_at=None)
    db = ProcessDb(job)
    worker._run_owned_process(
        db, job, [sys.executable, "-c", "import time; time.sleep(.2)"],
        tmp_path / "ok.log", 5,
    )
    assert db.commits >= 1 and job.heartbeat_at is not None


def test_waveform_uses_real_sample_extrema(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    samples = np.array([-0.75, 0.5, -0.25, 0.9], dtype="<f4")
    monkeypatch.setattr(
        worker.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, stdout=samples.tobytes()),
    )
    paths = {stem: tmp_path / f"{stem}.flac" for stem in worker.STEM_TYPES}
    destination = tmp_path / "peaks.json"
    payload = worker.generate_waveform(paths, 1000, destination)
    assert destination.is_file()
    assert payload["version"] == "peaks-json-v1"
    assert payload["stems"]["VOCALS"]["peaks"] == [[-0.75, -0.75], [0.5, 0.5], [-0.25, -0.25], [0.9, 0.9]]


def test_device_policy_is_explicit_and_never_silently_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_torch = SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)))
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    monkeypatch.setenv("AUDIO_WORKER_DEVICE", "cpu")
    assert worker.select_device() == "cpu"

    monkeypatch.setenv("AUDIO_WORKER_DEVICE", "cuda")
    with pytest.raises(worker.WorkerFailure) as invalid:
        worker.select_device()
    assert invalid.value.code == "MODEL_UNAVAILABLE"

    monkeypatch.setenv("AUDIO_WORKER_DEVICE", "mps")
    with pytest.raises(worker.WorkerFailure) as unavailable:
        worker.select_device()
    assert unavailable.value.code == "MODEL_UNAVAILABLE"

    monkeypatch.delenv("AUDIO_WORKER_DEVICE")
    assert worker.select_device() == "cpu"


def test_failure_mapping_persists_only_safe_public_error(monkeypatch: pytest.MonkeyPatch) -> None:
    engine, db, user, asset = make_database()
    try:
        job = make_job(db, user, asset, status="RUNNING", stage="SEPARATING")
        monkeypatch.setattr(worker, "_cleanup_job_tmp", lambda _job_id: None)
        failure = worker.WorkerFailure(
            "PROCESS_CANCELLED", "Separation was cancelled.", "/private/path"
        )
        worker.fail_job(db, job, failure)
        refreshed = db.scalar(select(StemJob).where(StemJob.id == job.id))
        assert refreshed is not None and refreshed.status == "CANCELLED"
        assert refreshed.safe_error_message == "Separation was cancelled."
        assert "/private/path" not in refreshed.safe_error_message
        assert refreshed.diagnostic_error == {"summary": "/private/path"}
    finally:
        db.close()
        engine.dispose()
