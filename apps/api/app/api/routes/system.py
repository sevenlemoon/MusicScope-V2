from fastapi import APIRouter

from app.api.schemas import ProductStatus

router = APIRouter(tags=["system"])


@router.get("/status", response_model=ProductStatus)
def product_status() -> ProductStatus:
    return ProductStatus(
        **{
            "release": "R4.1",
            "stage": "production_audio_studio",
            "capabilities": {
                "application_shell": "implemented",
                "domain_schema": "implemented",
                "provider_contracts": "implemented",
                "netease_qr": "implemented",
                "library_sync": "implemented",
                "library_pagination": "implemented",
                "canonical_detail_pages": "implemented",
                "provider_playback": "implemented",
                "artist_artwork_enrichment": "implemented",
                "stem_entry": "implemented",
                "recommendation_profile": "implemented",
                "recommendations": "implemented",
                "recommendation_feedback": "implemented",
                "home_discover": "implemented",
                "external_discovery": "designed",
                "concert_provider": "verification_pending",
                "concert_search": "verification_pending",
                "live_materialization": "implemented",
                "stem_separation": "implemented",
            },
        }
    )
