from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_is_honest_r21_status() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "musicscope-v2-api",
        "release": "R2.1",
    }


def test_product_status_marks_real_integration_implemented() -> None:
    response = client.get("/api/v1/status")
    capabilities = response.json()["capabilities"]
    assert capabilities["application_shell"] == "implemented"
    assert capabilities["netease_qr"] == "implemented"
    assert capabilities["library_sync"] == "implemented"
    assert capabilities["provider_playback"] == "implemented"
    assert capabilities["canonical_detail_pages"] == "implemented"
    assert capabilities["artist_artwork_enrichment"] == "implemented"
    assert capabilities["stem_entry"] == "implemented"
    assert capabilities["stem_separation"] == "designed"


def test_library_summary_is_empty_without_connection() -> None:
    response = client.get("/api/v1/library/summary")
    assert response.status_code == 200
    assert response.json()["connection_state"] == "not_connected"
    assert response.json()["counts"]["tracks"] == 0
