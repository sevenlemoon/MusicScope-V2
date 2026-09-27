from __future__ import annotations

import json
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, File, Header, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import select

from app.api.dependencies import CurrentUser, DbSession
from app.api.schemas import (
    StudioArtifactResponse,
    StudioAssetResponse,
    StudioJobListResponse,
    StudioJobResponse,
)
from app.domain.enums import StemJobStatus
from app.domain.models import AudioAsset, StemArtifact, StemJob, StudioTrackJob, Track
from app.providers.errors import ProviderAuthenticationExpired, ProviderError, ProviderPlaybackUnavailable
from app.services.audio_studio import (
    StudioError,
    artifact_for_user,
    artifacts_for_job,
    asset_for_job,
    cancel_job,
    create_audio_asset,
    create_stem_job,
    list_user_jobs,
    resolve_storage_key,
    retry_job,
    user_job,
    validate_library_track,
    waveform_for_user,
)
from app.services.playback import PlaybackService
from app.services.studio_provider_import import create_provider_audio_asset

router = APIRouter(prefix="/studio", tags=["studio"])


def _require_six_stems(model: str) -> None:
    if model != "htdemucs_6s":
        raise StudioError(422, "UNSUPPORTED_STEM_MODEL", "New Studio jobs use six-stem separation only.")


def _raise(error: StudioError) -> None:
    raise HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message})


def _asset_response(asset: AudioAsset, *, reused: bool = False) -> StudioAssetResponse:
    return StudioAssetResponse(
        id=str(asset.id),
        original_filename=asset.original_filename,
        media_type=asset.media_type,
        size_bytes=asset.size_bytes,
        duration_ms=asset.duration_ms or 0,
        sample_rate=asset.sample_rate,
        channels=asset.channels,
        sha256=asset.sha256,
        reused=reused,
        created_at=asset.created_at,
    )


def _artifact_response(artifact: StemArtifact) -> StudioArtifactResponse:
    return StudioArtifactResponse(
        id=str(artifact.id),
        stem_type=artifact.stem_type,  # type: ignore[arg-type]
        size_bytes=artifact.size_bytes,
        duration_ms=artifact.duration_ms,
        sample_rate=artifact.sample_rate,
        channels=artifact.channels,
        sha256=artifact.sha256,
        stream_url=f"/api/v1/studio/artifacts/{artifact.id}/stream",
    )


def _job_response(db: DbSession, job: StemJob, *, reused: bool = False) -> StudioJobResponse:
    asset = asset_for_job(db, job)
    artifacts = artifacts_for_job(db, job.id)
    return StudioJobResponse(
        id=str(job.id),
        status=job.status,  # type: ignore[arg-type]
        stage=job.stage,
        model_name=job.model_name,
        model_version=job.model_version,
        demucs_version=job.demucs_version,
        device=job.device,
        attempt_count=job.attempt_count,
        safe_error_code=job.safe_error_code,
        safe_error_message=job.safe_error_message,
        configuration=job.configuration,
        asset=_asset_response(asset),
        artifacts=[_artifact_response(item) for item in artifacts],
        source_track_ids=[
            str(track_id)
            for track_id in db.scalars(
                select(StudioTrackJob.track_id)
                .where(StudioTrackJob.stem_job_id == job.id, StudioTrackJob.user_id == job.user_id)
                .order_by(StudioTrackJob.created_at.desc())
            )
        ],
        waveform_url=f"/api/v1/studio/jobs/{job.id}/waveform" if artifacts else None,
        cancellable=job.status
        in {
            StemJobStatus.QUEUED.value,
            StemJobStatus.PREPARING.value,
            StemJobStatus.RUNNING.value,
        },
        retryable=job.status in {StemJobStatus.FAILED.value, StemJobStatus.CANCELLED.value},
        reused=reused,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
    )


@router.post("/assets", response_model=StudioAssetResponse, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    db: DbSession,
    user: CurrentUser,
    file: Annotated[UploadFile, File(description="Local MP3, WAV, FLAC, or M4A/AAC audio")],
    response: Response,
) -> StudioAssetResponse:
    try:
        asset, reused = await create_audio_asset(db, user, file)
    except StudioError as error:
        _raise(error)
    if reused:
        response.status_code = status.HTTP_200_OK
    return _asset_response(asset, reused=reused)


@router.post("/assets/{asset_id}/jobs", response_model=StudioJobResponse, status_code=201)
def start_job(
    asset_id: UUID,
    db: DbSession,
    user: CurrentUser,
    response: Response,
    model: str = "htdemucs_6s",
    track_id: UUID | None = None,
) -> StudioJobResponse:
    try:
        _require_six_stems(model)
        job, reused = create_stem_job(db, user, asset_id, model, track_id)
    except StudioError as error:
        _raise(error)
    if reused or job.status != StemJobStatus.QUEUED.value:
        response.status_code = status.HTTP_200_OK
    return _job_response(db, job, reused=reused)


@router.post("/tracks/{track_id}/jobs", response_model=StudioJobResponse, status_code=201)
async def start_library_track_job(
    track_id: UUID,
    db: DbSession,
    user: CurrentUser,
    response: Response,
    model: str = "htdemucs_6s",
) -> StudioJobResponse:
    """Import playable account audio locally, then queue a normal Studio job."""
    try:
        _require_six_stems(model)
        validate_library_track(db, user, track_id)
        track = db.get(Track, track_id)
        if track is None:
            raise StudioError(404, "LIBRARY_TRACK_NOT_FOUND", "Track is not in this user's library.")
        resolved = await PlaybackService(db).resolve(track_id, user)
        asset, _ = await create_provider_audio_asset(db, user, track, resolved.source)
        job, reused = create_stem_job(db, user, asset.id, model, track_id)
    except StudioError as error:
        _raise(error)
    except PermissionError:
        _raise(
            StudioError(409, "NETEASE_NOT_CONNECTED", "Connect NetEase before separating an account song.")
        )
    except LookupError:
        _raise(
            StudioError(
                422, "PROVIDER_AUDIO_UNAVAILABLE", "This library song has no playable NetEase source."
            )
        )
    except ProviderPlaybackUnavailable:
        _raise(
            StudioError(
                422, "PROVIDER_AUDIO_UNAVAILABLE", "This song cannot be played with the current account."
            )
        )
    except ProviderAuthenticationExpired:
        _raise(StudioError(401, "NETEASE_SESSION_EXPIRED", "Reconnect NetEase before separating this song."))
    except ProviderError:
        _raise(
            StudioError(
                503, "PROVIDER_UNAVAILABLE", "The NetEase playback source is temporarily unavailable."
            )
        )
    if reused or job.status != StemJobStatus.QUEUED.value:
        response.status_code = status.HTTP_200_OK
    return _job_response(db, job, reused=reused)


@router.get("/jobs", response_model=StudioJobListResponse)
def jobs(db: DbSession, user: CurrentUser) -> StudioJobListResponse:
    return StudioJobListResponse(items=[_job_response(db, item) for item in list_user_jobs(db, user.id)])


@router.get("/jobs/{job_id}", response_model=StudioJobResponse)
def job_detail(job_id: UUID, db: DbSession, user: CurrentUser) -> StudioJobResponse:
    try:
        return _job_response(db, user_job(db, user.id, job_id))
    except StudioError as error:
        _raise(error)


@router.post("/jobs/{job_id}/cancel", response_model=StudioJobResponse)
def request_cancellation(job_id: UUID, db: DbSession, user: CurrentUser) -> StudioJobResponse:
    try:
        return _job_response(db, cancel_job(db, user.id, job_id))
    except StudioError as error:
        _raise(error)


@router.post("/jobs/{job_id}/retry", response_model=StudioJobResponse)
def retry(job_id: UUID, db: DbSession, user: CurrentUser) -> StudioJobResponse:
    try:
        return _job_response(db, retry_job(db, user.id, job_id))
    except StudioError as error:
        _raise(error)


@router.get("/jobs/{job_id}/waveform", response_model=dict[str, Any])
def waveform(job_id: UUID, db: DbSession, user: CurrentUser) -> JSONResponse:
    try:
        path = waveform_for_user(db, user.id, job_id)
        if path.stat().st_size > 2 * 1024 * 1024:
            raise StudioError(500, "WAVEFORM_INVALID", "Waveform data is invalid.")
        payload = json.loads(path.read_text(encoding="utf-8"))
    except StudioError as error:
        _raise(error)
    except (OSError, json.JSONDecodeError):
        _raise(StudioError(500, "WAVEFORM_INVALID", "Waveform data is invalid."))
    return JSONResponse(
        payload, headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"}
    )


def _stream_artifact(
    artifact_id: UUID,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    if_none_match: Annotated[str | None, Header()] = None,
    download: bool = False,
) -> Response:
    try:
        artifact = artifact_for_user(db, user.id, artifact_id)
        path = resolve_storage_key(artifact.storage_key)
    except StudioError as error:
        _raise(error)
    etag = f'"{artifact.sha256}"'
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=300",
        "ETag": etag,
        "X-Content-Type-Options": "nosniff",
    }
    if if_none_match == etag and "range" not in request.headers:
        return Response(status_code=304, headers=headers)
    return FileResponse(
        path,
        media_type="audio/flac",
        filename=f"{artifact.stem_type.casefold()}.flac",
        content_disposition_type="attachment" if download else "inline",
        headers=headers,
    )


@router.get("/artifacts/{artifact_id}/stream", operation_id="stream_studio_artifact")
def stream_artifact(
    artifact_id: UUID,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    if_none_match: Annotated[str | None, Header()] = None,
    download: bool = False,
) -> Response:
    return _stream_artifact(artifact_id, request, db, user, if_none_match, download)


@router.head("/artifacts/{artifact_id}/stream", include_in_schema=False)
def head_artifact(
    artifact_id: UUID,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    return _stream_artifact(artifact_id, request, db, user, if_none_match)
