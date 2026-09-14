from app.core.database import Base, assert_safe_database_url
from app.domain import models  # noqa: F401


def test_core_domain_tables_exist() -> None:
    required = {
        "users",
        "music_connections",
        "music_connection_secrets",
        "playlists",
        "playlist_tracks",
        "tracks",
        "artists",
        "track_artists",
        "albums",
        "external_identities",
        "library_items",
        "sync_states",
        "recommendation_profiles",
        "recommendation_feedback",
        "concert_events",
        "audio_assets",
        "stem_jobs",
        "stem_artifacts",
    }
    assert required <= set(Base.metadata.tables)


def test_external_identity_is_unique_per_provider_entity() -> None:
    constraints = Base.metadata.tables["external_identities"].constraints
    unique_names = {constraint.name for constraint in constraints if constraint.name}
    assert "uq_external_identity_provider_entity" in unique_names
    assert "uq_external_identity_canonical_provider" in unique_names
    check_names = {constraint.name for constraint in constraints if constraint.name}
    assert "ck_external_identities_external_identity_entity_type" in check_names


def test_database_safety_guard_rejects_legacy_name() -> None:
    assert_safe_database_url("postgresql+psycopg://u:p@localhost/musicscope_v2")
    with __import__("pytest").raises(RuntimeError):
        assert_safe_database_url("postgresql+psycopg://u:p@localhost/musicscope")
