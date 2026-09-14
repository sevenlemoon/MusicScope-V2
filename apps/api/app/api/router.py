from fastapi import APIRouter

from app.api.routes import catalog, connections, library, system

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(system.router)
api_router.include_router(connections.router)
api_router.include_router(library.router)
api_router.include_router(catalog.router)
