from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.router import api_router
from app.api.schemas import HealthResponse
from app.core.config import get_settings
from app.core.database import check_database
from app.core.redaction import install_log_redaction


def create_app() -> FastAPI:
    install_log_redaction()
    settings = get_settings()
    application = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description="MusicScope API for canonical music intelligence and verified live discovery.",
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Authorization", "X-MusicScope-User-ID"],
    )
    application.include_router(api_router)

    @application.get(
        "/health", tags=["system"], response_model=HealthResponse, response_model_exclude_none=True
    )
    def health() -> HealthResponse:
        return HealthResponse(status="ok", service="musicscope-v2-api", release="R3")

    @application.get("/health/db", tags=["system"])
    def database_health() -> JSONResponse:
        try:
            check_database()
        except Exception:
            return JSONResponse(
                status_code=503,
                content={"status": "unavailable", "service": "database", "database": "musicscope_v2"},
            )
        return JSONResponse(content={"status": "ok", "service": "database", "database": "musicscope_v2"})

    return application


app = create_app()
