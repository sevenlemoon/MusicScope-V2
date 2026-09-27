from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import (
    ConnectionList,
    ConnectionSummary,
    NeteaseCapabilities,
    OperationResponse,
    QrChallengeResponse,
    QrStatusResponse,
    SavedAlbumSyncResponse,
    SyncResponse,
    SyncStateResponse,
)
from app.core.database import get_db
from app.core.secrets import ProviderSecretCipher, SecretConfigurationError
from app.domain.enums import ConnectionStatus
from app.domain.models import MusicConnection, SyncState
from app.providers.errors import ProviderAuthenticationExpired, ProviderError
from app.services.library_sync import LibrarySyncService
from app.services.music_connections import MusicConnectionService

router = APIRouter(prefix="/music-connections", tags=["music-connections"])
DbSession = Annotated[Session, Depends(get_db)]


def summary(connection: MusicConnection) -> ConnectionSummary:
    return ConnectionSummary(
        id=str(connection.id),
        provider=connection.provider,
        status=connection.status,
        provider_user_id=connection.provider_user_id,
        nickname=connection.metadata_json.get("nickname"),
        avatar_url=connection.metadata_json.get("avatar_url"),
    )


@router.get("/netease/capabilities", response_model=NeteaseCapabilities)
def netease_capabilities(db: DbSession) -> NeteaseCapabilities:
    connection = db.scalar(
        select(MusicConnection).order_by(MusicConnection.updated_at.desc()).limit(1)
    )
    sync_state = None
    if connection is not None:
        sync_state = db.scalar(
            select(SyncState).where(
                SyncState.connection_id == connection.id,
                SyncState.scope == "library",
            )
        )
    verified = bool(
        connection
        and connection.status == ConnectionStatus.CONNECTED.value
        and sync_state
        and sync_state.status == "COMPLETED"
    )
    return NeteaseCapabilities(
        **{
            "provider": "netease",
            "implementation_stage": "implemented",
            "real_world_verified": verified,
            "current_state": ConnectionStatus(connection.status)
            if connection
            else ConnectionStatus.IDLE,
            "auth_states": [
                state.value for state in ConnectionStatus if state != ConnectionStatus.DISCONNECTED
            ],
            "message": "Real NetEase QR authentication and library synchronization are available.",
        }
    )


@router.post("/netease/qr", response_model=QrChallengeResponse, status_code=201)
async def create_netease_qr(db: DbSession) -> QrChallengeResponse:
    try:
        service = MusicConnectionService(db, cipher=ProviderSecretCipher())
        challenge, auth = await service.create_netease_challenge()
        db.commit()
        return QrChallengeResponse(
            challenge_id=str(challenge.id),
            status=challenge.status,
            qr_url=auth.qr_content,
            qr_image_data_url=auth.qr_image_data_url or "",
            expires_at=challenge.expires_at,
        )
    except SecretConfigurationError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="Secure session storage is not configured.") from exc
    except ProviderError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="NetEase connection is temporarily unavailable.") from exc


@router.get("/netease/qr/{challenge_id}", response_model=QrStatusResponse)
async def poll_netease_qr(challenge_id: UUID, db: DbSession) -> QrStatusResponse:
    try:
        service = MusicConnectionService(db, cipher=ProviderSecretCipher())
        challenge, connection = await service.poll_netease_challenge(str(challenge_id))
        db.commit()
        return QrStatusResponse(
            challenge_id=str(challenge.id),
            status=challenge.status,
            connection=summary(connection) if connection else None,
        )
    except LookupError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail="QR challenge not found.") from exc
    except SecretConfigurationError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="Secure session storage is not configured.") from exc
    except ProviderError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="NetEase connection is temporarily unavailable.") from exc


@router.get("", response_model=ConnectionList)
def list_connections(db: DbSession) -> ConnectionList:
    connections = list(db.scalars(select(MusicConnection).order_by(MusicConnection.created_at)))
    return ConnectionList(items=[summary(connection) for connection in connections])


@router.delete("/{connection_id}", response_model=OperationResponse)
def disconnect(connection_id: UUID, db: DbSession) -> OperationResponse:
    connection = db.get(MusicConnection, connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail="Music connection not found.")
    MusicConnectionService(db).disconnect(connection)
    db.commit()
    return OperationResponse(status=ConnectionStatus.DISCONNECTED.value)


@router.post("/{connection_id}/sync", response_model=SyncResponse)
async def synchronize(connection_id: UUID, db: DbSession) -> SyncResponse:
    connection = db.get(MusicConnection, connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail="Music connection not found.")
    if connection.status != ConnectionStatus.CONNECTED.value:
        raise HTTPException(status_code=409, detail="Reconnect NetEase Cloud Music before syncing.")
    try:
        result = await LibrarySyncService(db).sync(connection)
        db.commit()
        return SyncResponse(**result.__dict__)
    except ProviderAuthenticationExpired as exc:
        db.commit()
        raise HTTPException(
            status_code=401, detail="NetEase session expired. Reconnect to continue."
        ) from exc
    except ProviderError as exc:
        db.commit()
        raise HTTPException(status_code=503, detail="Library synchronization could not complete.") from exc
    except Exception as exc:
        db.commit()
        raise HTTPException(status_code=503, detail="Library synchronization could not complete.") from exc


@router.post("/{connection_id}/saved-albums/sync", response_model=SavedAlbumSyncResponse)
async def synchronize_saved_albums(connection_id: UUID, db: DbSession) -> SavedAlbumSyncResponse:
    connection = db.get(MusicConnection, connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail="Music connection not found.")
    if connection.status != ConnectionStatus.CONNECTED.value:
        raise HTTPException(status_code=409, detail="Reconnect NetEase before syncing saved albums.")
    try:
        count = await LibrarySyncService(db).sync_collected_albums_only(connection)
        db.commit()
        return SavedAlbumSyncResponse(status="SYNCED", albums=count)
    except ProviderAuthenticationExpired as exc:
        db.rollback()
        raise HTTPException(
            status_code=401, detail="NetEase session expired. Reconnect to continue."
        ) from exc
    except ProviderError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="Saved albums could not be refreshed.") from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="Saved albums could not be refreshed.") from exc


@router.get("/{connection_id}/sync", response_model=SyncStateResponse)
def synchronization_state(connection_id: UUID, db: DbSession) -> SyncStateResponse:
    active = LibrarySyncService.active_progress(str(connection_id))
    if active is not None:
        return SyncStateResponse(**active)
    state = db.scalar(
        select(SyncState).where(SyncState.connection_id == connection_id, SyncState.scope == "library")
    )
    if state is None:
        return SyncStateResponse(status="READY", processed_items=0)
    public_status = {
        "PENDING": "READY",
        "RUNNING": "SYNCING",
        "COMPLETED": "SYNCED",
    }.get(state.status, state.status)
    return SyncStateResponse(
        status=public_status,
        processed_items=state.processed_items,
        total_items=state.total_items,
        checkpoint=state.checkpoint,
        safe_error=state.last_error_message,
    )
