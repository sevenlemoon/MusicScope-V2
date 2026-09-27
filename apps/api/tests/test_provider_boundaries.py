import asyncio
from unittest.mock import AsyncMock

import pytest

from app.domain.enums import ConnectionStatus
from app.providers.errors import (
    ProviderAuthenticationExpired,
    ProviderNotConfigured,
    ProviderTemporarilyUnavailable,
)
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


def test_collected_album_list_uses_explicit_provider_collection_and_paginates() -> None:
    provider = NetEaseProvider(session_cookie="test-session-placeholder")
    provider._post = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "code": 200,
            "count": 2,
            "data": [
                {
                    "id": 301,
                    "name": "Actually collected",
                    "picUrl": "http://p1.music.126.net/album.jpg",
                    "artists": [{"id": 11, "name": "Artist"}],
                }
            ],
        }
    )
    page = asyncio.run(provider.list_collected_albums())
    assert page.next_cursor == "1"
    assert [(item.provider_id, item.title) for item in page.items] == [("301", "Actually collected")]
    assert page.items[0].artist_provider_ids == ("11",)
    assert page.items[0].artwork_url == "https://p1.music.126.net/album.jpg"
    assert provider._post.call_args.args[1] == "/v1/albums/collected"

    provider._post.return_value = {"code": 200, "count": 2, "data": [{"id": 302, "name": "Two"}]}
    assert asyncio.run(provider.list_collected_albums("1")).next_cursor is None


def test_read_only_discovery_mapping_preserves_provider_metadata_and_multi_artist_ids() -> None:
    provider = NetEaseProvider(session_cookie="test-session-placeholder")
    provider._post = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "result": {
                "songs": [
                    {
                        "id": 901,
                        "name": "External song",
                        "dt": 201000,
                        "ar": [{"id": 11, "name": "One"}, {"id": 12, "name": "Two"}],
                        "al": {
                            "id": 301,
                            "name": "External album",
                            "picUrl": "http://p1.music.126.net/external.jpg",
                        },
                    }
                ]
            }
        }
    )

    results = asyncio.run(provider.search_tracks("External song", limit=7))

    assert len(results) == 1
    assert results[0].provider_id == "901"
    assert results[0].artist_provider_ids == ("11", "12")
    assert results[0].album_provider_id == "301"
    assert results[0].artwork_url == "https://p1.music.126.net/external.jpg"
    assert results[0].duration_ms == 201000


def test_artist_search_catalog_and_related_mapping_are_bounded_and_read_only() -> None:
    provider = NetEaseProvider(session_cookie="test-session-placeholder")
    provider._post = AsyncMock(  # type: ignore[method-assign]
        side_effect=[
            {"result": {"artists": [{"id": 22, "name": "Artist", "picUrl": "http://img"}]}},
            {"artists": [{"id": 23, "name": "Related", "img1v1Url": "http://related"}]},
        ]
    )

    searched = asyncio.run(provider.search_artists("Artist", limit=5))
    related = asyncio.run(provider.get_related_artists("22", limit=1))

    assert [(artist.provider_id, artist.name) for artist in searched] == [("22", "Artist")]
    assert [(artist.provider_id, artist.name) for artist in related] == [("23", "Related")]
    assert searched[0].artwork_url == "https://img"
    assert related[0].artwork_url == "https://related"


def test_discovery_requires_session_and_propagates_safe_provider_unavailability() -> None:
    without_session = NetEaseProvider()
    with pytest.raises(ProviderAuthenticationExpired):
        asyncio.run(without_session.search_tracks("query"))

    provider = NetEaseProvider(session_cookie="test-session-placeholder")
    provider._post = AsyncMock(  # type: ignore[method-assign]
        side_effect=ProviderTemporarilyUnavailable("safe failure")
    )
    with pytest.raises(ProviderTemporarilyUnavailable):
        asyncio.run(provider.get_artist_tracks("22"))
