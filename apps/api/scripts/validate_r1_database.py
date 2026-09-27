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
    "orphan_saved_albums": """
        SELECT count(*) FROM saved_albums relationship
        LEFT JOIN albums album ON album.id = relationship.album_id
        LEFT JOIN music_connections connection ON connection.id = relationship.connection_id
        WHERE album.id IS NULL OR connection.id IS NULL
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
    "orphan_recommendation_profiles": """
        SELECT count(*) FROM recommendation_profiles profile
        LEFT JOIN users owner ON owner.id = profile.user_id
        WHERE owner.id IS NULL
    """,
    "orphan_recommendation_profile_artists": """
        SELECT count(*) FROM recommendation_profile_artists item
        LEFT JOIN recommendation_profiles profile ON profile.id = item.profile_id
        LEFT JOIN artists artist ON artist.id = item.artist_id
        WHERE profile.id IS NULL OR artist.id IS NULL
    """,
    "orphan_recommendation_profile_albums": """
        SELECT count(*) FROM recommendation_profile_albums item
        LEFT JOIN recommendation_profiles profile ON profile.id = item.profile_id
        LEFT JOIN albums album ON album.id = item.album_id
        WHERE profile.id IS NULL OR album.id IS NULL
    """,
    "orphan_recommendation_relationships": """
        SELECT count(*) FROM recommendation_relationships edge
        LEFT JOIN recommendation_profiles profile ON profile.id = edge.profile_id
        LEFT JOIN artists source ON source.id = edge.source_artist_id
        LEFT JOIN artists target ON target.id = edge.target_artist_id
        WHERE profile.id IS NULL OR source.id IS NULL OR target.id IS NULL
    """,
    "duplicate_recommendation_feedback": """
        SELECT count(*) FROM (
            SELECT user_id, entity_type, identity_key
            FROM recommendation_feedback
            GROUP BY user_id, entity_type, identity_key
            HAVING count(*) > 1
        ) duplicates
    """,
    "invalid_recommendation_feedback_references": """
        SELECT count(*) FROM recommendation_feedback feedback
        LEFT JOIN users owner ON owner.id = feedback.user_id
        WHERE owner.id IS NULL
           OR feedback.entity_type NOT IN ('track', 'artist', 'album')
           OR (feedback.entity_id IS NOT NULL AND feedback.entity_type = 'track' AND NOT EXISTS (
               SELECT 1 FROM tracks entity WHERE entity.id = feedback.entity_id
           ))
           OR (feedback.entity_id IS NOT NULL AND feedback.entity_type = 'artist' AND NOT EXISTS (
               SELECT 1 FROM artists entity WHERE entity.id = feedback.entity_id
           ))
           OR (feedback.entity_id IS NOT NULL AND feedback.entity_type = 'album' AND NOT EXISTS (
               SELECT 1 FROM albums entity WHERE entity.id = feedback.entity_id
           ))
           OR (feedback.entity_id IS NULL AND (
               feedback.provider IS NULL
               OR feedback.provider_id IS NULL
               OR feedback.identity_key <> (
                   'provider:' || feedback.provider || ':'
                   || feedback.entity_type || ':' || feedback.provider_id
               )
           ))
    """,
    "feedback_outside_user_library": """
        SELECT count(*) FROM recommendation_feedback feedback
        WHERE feedback.entity_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM playlist_tracks membership
            JOIN playlists playlist ON playlist.id = membership.playlist_id
            JOIN music_connections connection ON connection.id = playlist.owner_connection_id
            JOIN tracks track ON track.id = membership.track_id
            WHERE connection.user_id = feedback.user_id
              AND (
                  (feedback.entity_type = 'track' AND track.id = feedback.entity_id)
                  OR (feedback.entity_type = 'album' AND track.album_id = feedback.entity_id)
                  OR (feedback.entity_type = 'artist' AND EXISTS (
                      SELECT 1 FROM track_artists relation
                      WHERE relation.track_id = track.id
                        AND relation.artist_id = feedback.entity_id
                  ))
              )
        )
    """,
    "speculative_external_recommendation_library_items": """
        SELECT count(*) FROM library_items
        WHERE provenance::text ILIKE '%external_recommendation%'
    """,
    "orphan_recommendation_candidates": """
        SELECT count(*) FROM recommendation_candidates candidate
        LEFT JOIN users owner ON owner.id = candidate.user_id
        LEFT JOIN recommendation_profiles profile ON profile.id = candidate.profile_id
        WHERE owner.id IS NULL OR profile.id IS NULL OR profile.user_id <> candidate.user_id
    """,
    "invalid_external_recommendation_identities": """
        SELECT count(*) FROM recommendation_candidates candidate
        WHERE candidate.source = 'netease_external'
          AND (
              candidate.provider <> 'netease'
              OR candidate.provider_id IS NULL
              OR candidate.entity_type NOT IN ('track', 'artist', 'album')
              OR candidate.identity_key <> (
                  'provider:' || candidate.provider || ':'
                  || candidate.entity_type || ':' || candidate.provider_id
              )
          )
    """,
    "external_candidates_already_in_user_library": """
        SELECT count(*) FROM recommendation_candidates candidate
        WHERE candidate.source = 'netease_external'
          AND EXISTS (
              SELECT 1
              FROM external_identities identity
              JOIN playlist_tracks membership ON membership.track_id = identity.entity_id
              JOIN playlists playlist ON playlist.id = membership.playlist_id
              JOIN music_connections connection ON connection.id = playlist.owner_connection_id
              WHERE connection.user_id = candidate.user_id
                AND identity.provider = candidate.provider
                AND identity.entity_type = candidate.entity_type
                AND identity.provider_id = candidate.provider_id
          )
    """,
    "sensitive_recommendation_candidate_payload": """
        SELECT count(*) FROM recommendation_candidates
        WHERE lower(payload::text) ~ '(cookie|credential|password|private_key|secret|session|token)'
           OR lower(payload::text) ~ '(playback_url|source_url)'
    """,
    "duplicate_concert_source_identities": """
        SELECT count(*) FROM (
            SELECT provider, provider_event_id
            FROM concert_event_sources
            GROUP BY provider, provider_event_id
            HAVING count(*) > 1
        ) duplicates
    """,
    "orphan_concert_sources": """
        SELECT count(*) FROM concert_event_sources source
        LEFT JOIN concert_events event ON event.id = source.event_id
        WHERE event.id IS NULL
    """,
    "orphan_concert_performers": """
        SELECT count(*) FROM concert_performers performer
        LEFT JOIN concert_events event ON event.id = performer.event_id
        LEFT JOIN artists artist ON artist.id = performer.artist_id
        WHERE event.id IS NULL
           OR (performer.artist_id IS NOT NULL AND artist.id IS NULL)
    """,
    "orphan_live_recommendations": """
        SELECT count(*) FROM live_recommendations recommendation
        LEFT JOIN users owner ON owner.id = recommendation.user_id
        LEFT JOIN concert_events event ON event.id = recommendation.event_id
        LEFT JOIN artists artist ON artist.id = recommendation.artist_id
        WHERE owner.id IS NULL
           OR event.id IS NULL
           OR (recommendation.artist_id IS NOT NULL AND artist.id IS NULL)
    """,
    "orphan_live_preferences": """
        SELECT count(*) FROM user_live_preferences preference
        LEFT JOIN users owner ON owner.id = preference.user_id
        WHERE owner.id IS NULL
    """,
    "orphan_artist_search_aliases": """
        SELECT count(*) FROM artist_search_aliases alias
        LEFT JOIN users owner ON owner.id = alias.user_id
        LEFT JOIN artists artist ON artist.id = alias.artist_id
        WHERE (alias.user_id IS NOT NULL AND owner.id IS NULL)
           OR (alias.artist_id IS NOT NULL AND artist.id IS NULL)
    """,
    "unresolved_live_cache_event_ids": """
        SELECT count(*)
        FROM live_search_cache cache
        CROSS JOIN LATERAL json_array_elements_text(cache.event_ids) cached_event_id
        WHERE NOT EXISTS (
            SELECT 1 FROM concert_events event
            WHERE event.id::text = cached_event_id
        )
    """,
    "insecure_concert_urls": """
        SELECT count(*) FROM (
            SELECT event_url AS url FROM concert_events
            UNION ALL SELECT ticket_url FROM concert_events WHERE ticket_url IS NOT NULL
            UNION ALL SELECT event_url FROM concert_event_sources
            UNION ALL SELECT ticket_url FROM concert_event_sources WHERE ticket_url IS NOT NULL
        ) links
        WHERE url NOT LIKE 'https://%'
    """,
    "sensitive_concert_payload": """
        SELECT count(*) FROM (
            SELECT source_metadata AS payload FROM concert_events
            UNION ALL SELECT source_payload FROM concert_event_sources
            UNION ALL SELECT match_payload FROM live_search_cache
            UNION ALL SELECT provider_states FROM live_search_cache
        ) concert_payloads
        WHERE lower(payload::text) ~ '(cookie|credential|password|private_key|secret|session|token)'
           OR lower(payload::text) ~ '(playback_url|authorization)'
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
