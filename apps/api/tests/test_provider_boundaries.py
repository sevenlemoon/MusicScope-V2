import pytest

from app.domain.enums import ConnectionStatus
from app.providers.errors import ProviderNotConfigured
from app.providers.netease import NetEaseProvider, is_retryable_status, normalize_artwork_url
from app.services.connection_state import netease_qr_code_to_state, transition_connection_state
from app.services.sync_planning import batched, unique_in_order


def test_netease_qr_codes_map_to_domain_states() -> None:
    assert netease_qr_code_to_state(801) is ConnectionStatus.WAITING_SCAN
    assert netease_qr_code_to_state(802) is ConnectionStatus.WAITING_CONFIRM
    assert netease_qr_code_to_state(803) is ConnectionStatus.CONNECTED
    assert netease_qr_code_to_state(800) is ConnectionStatus.EXPIRED


def test_invalid_connection_transition_is_rejected() -> None:
    with pytest.raises(ValueError):
        transition_connection_state(ConnectionStatus.IDLE, ConnectionStatus.CONNECTED)


def test_netease_adapter_requires_loopback_sidecar() -> None:
    NetEaseProvider("http://127.0.0.1:36531")
    with pytest.raises(ProviderNotConfigured):
        NetEaseProvider("https://example.com")


def test_retry_classification_is_bounded_to_transient_statuses() -> None:
    assert is_retryable_status(429)
    assert is_retryable_status(503)
    assert not is_retryable_status(400)
    assert not is_retryable_status(401)


def test_netease_artwork_is_normalized_to_https() -> None:
    assert normalize_artwork_url("http://p1.music.126.net/art.jpg") == (
        "https://p1.music.126.net/art.jpg"
    )
    assert normalize_artwork_url("https://p2.music.126.net/art.jpg") == (
        "https://p2.music.126.net/art.jpg"
    )
    assert normalize_artwork_url(None) is None


def test_sync_planning_deduplicates_then_batches() -> None:
    provider_ids = unique_in_order(["123", "456", "123", "789"])
    assert provider_ids == ["123", "456", "789"]
    assert list(batched(provider_ids, 2)) == [["123", "456"], ["789"]]


def test_netease_track_normalization_deduplicates_repeated_artist_identities() -> None:
    track = NetEaseProvider._normalize_track(
        {
            "id": 1,
            "name": "Provider edge case",
            "ar": [
                {"id": 10, "name": "First"},
                {"id": 20, "name": "Second"},
                {"id": 10, "name": "First repeated"},
            ],
            "al": {"id": 100, "name": "Album"},
        }
    )

    assert [artist.provider_id for artist in track.artists] == ["10", "20"]
    assert track.artist_provider_ids == ("10", "20")
    assert track.album is not None
    assert track.album.artist_provider_ids == ("10", "20")
