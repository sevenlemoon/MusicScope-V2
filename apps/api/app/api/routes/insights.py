from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentUser
from app.api.insights_schemas import (
    InsightsOverviewResponse,
    InsightsPlaylistsResponse,
    InsightsRediscoveryResponse,
    InsightsUniverseResponse,
)
from app.core.database import get_db
from app.services.insights import InsightsService
from app.services.recommendation_profile import RecommendationProfileService

router = APIRouter(prefix="/insights", tags=["insights"])
DbSession = Annotated[Session, Depends(get_db)]


def _service(db: Session, user: CurrentUser) -> InsightsService:
    profile = RecommendationProfileService(db).get_current(user)
    return InsightsService(db, user=user, profile=profile)


@router.get("/overview", response_model=InsightsOverviewResponse)
def overview(db: DbSession, user: CurrentUser) -> InsightsOverviewResponse:
    return _service(db, user).overview()


@router.get("/universe", response_model=InsightsUniverseResponse)
def universe(db: DbSession, user: CurrentUser) -> InsightsUniverseResponse:
    return _service(db, user).universe()


@router.get("/playlists", response_model=InsightsPlaylistsResponse)
def playlists(db: DbSession, user: CurrentUser) -> InsightsPlaylistsResponse:
    return _service(db, user).playlists()


@router.get("/rediscovery", response_model=InsightsRediscoveryResponse)
def rediscovery(
    db: DbSession,
    user: CurrentUser,
    limit: int = Query(12, ge=1, le=24),
) -> InsightsRediscoveryResponse:
    return _service(db, user).rediscovery(limit)
