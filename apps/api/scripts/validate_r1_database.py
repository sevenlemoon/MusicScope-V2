from __future__ import annotations

from sqlalchemy import text

from app.core.database import get_engine

CHECKS = {
    "duplicate_provider_identities": """
        SELECT count(*) FROM (
            SELECT provider, entity_type, provider_id
            FROM external_identities
            GROUP BY provider, entity_type, provider_id
            HAVING count(*) > 1
        ) duplicates
    """,
    "invalid_external_identity_types": """
        SELECT count(*) FROM external_identities
        WHERE entity_type NOT IN ('track', 'artist', 'album', 'playlist')
    """,
    "unresolved_external_identities": """
        SELECT count(*) FROM external_identities identity
        WHERE (identity.entity_type = 'track' AND NOT EXISTS (
            SELECT 1 FROM tracks entity WHERE entity.id = identity.entity_id
        )) OR (identity.entity_type = 'artist' AND NOT EXISTS (
            SELECT 1 FROM artists entity WHERE entity.id = identity.entity_id
        )) OR (identity.entity_type = 'album' AND NOT EXISTS (
            SELECT 1 FROM albums entity WHERE entity.id = identity.entity_id
        )) OR (identity.entity_type = 'playlist' AND NOT EXISTS (
            SELECT 1 FROM playlists entity WHERE entity.id = identity.entity_id
        ))
    """,
    "orphan_track_artists": """
        SELECT count(*) FROM track_artists relationship
        LEFT JOIN tracks track ON track.id = relationship.track_id
        LEFT JOIN artists artist ON artist.id = relationship.artist_id
        WHERE track.id IS NULL OR artist.id IS NULL
    """,
    "orphan_album_artists": """
        SELECT count(*) FROM album_artists relationship
        LEFT JOIN albums album ON album.id = relationship.album_id
        LEFT JOIN artists artist ON artist.id = relationship.artist_id
        WHERE album.id IS NULL OR artist.id IS NULL
    """,
    "orphan_playlist_tracks": """
        SELECT count(*) FROM playlist_tracks relationship
        LEFT JOIN playlists playlist ON playlist.id = relationship.playlist_id
        LEFT JOIN tracks track ON track.id = relationship.track_id
        WHERE playlist.id IS NULL OR track.id IS NULL
    """,
    "plaintext_provider_secret_markers": """
        SELECT count(*) FROM music_connection_secrets
        WHERE encrypted_session ILIKE '%MUSIC_U%'
           OR encrypted_session ILIKE '%__csrf%'
           OR encrypted_session ILIKE '%NMTID%'
    """,
    "invalid_secret_envelopes": """
        SELECT count(*) FROM music_connection_secrets
        WHERE NOT (
            encrypted_session::jsonb ? 'algorithm'
            AND encrypted_session::jsonb ? 'ciphertext'
            AND encrypted_session::jsonb ? 'nonce'
            AND encrypted_session::jsonb ->> 'algorithm' = 'AES-256-GCM'
        )
    """,
    "sensitive_connection_metadata": """
        SELECT count(*) FROM music_connections
        WHERE lower(metadata::text) ~ '(cookie|token|session|authorization|password)'
    """,
    "insecure_artwork_urls": """
        SELECT count(*) FROM (
            SELECT artwork_url FROM playlists
            UNION ALL SELECT artwork_url FROM albums
            UNION ALL SELECT artwork_url FROM tracks
            UNION ALL SELECT artwork_url FROM artists
        ) artwork
        WHERE artwork_url IS NOT NULL AND artwork_url NOT LIKE 'https://%'
    """,
}


def main() -> None:
    failures: dict[str, int] = {}
    with get_engine().connect() as connection:
        for name, statement in CHECKS.items():
            count = int(connection.scalar(text(statement)) or 0)
            if count:
                failures[name] = count

    if failures:
        for name, count in failures.items():
            print(f"{name}={count}")
        raise SystemExit("database_integrity=invalid")
    print("database_integrity=valid")


if __name__ == "__main__":
    main()
