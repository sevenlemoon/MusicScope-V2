from fastapi import APIRouter

from app.api.schemas import ProductStatus

router = APIRouter(tags=["system"])


@router.get("/status", response_model=ProductStatus)
def product_status() -> ProductStatus:
    return ProductStatus(
        **{
            "release": "R2.1",
            "stage": "library_experience_and_playback",
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
                "recommendations": "designed",
                "concert_search": "designed",
                "stem_separation": "designed",
            },
        }
    )
