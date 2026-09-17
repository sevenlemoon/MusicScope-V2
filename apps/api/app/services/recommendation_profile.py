from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from itertools import combinations
from time import perf_counter
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.domain.models import (
    AlbumArtist,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    RecommendationProfile,
    RecommendationProfileAlbum,
    RecommendationProfileArtist,
    RecommendationRelationship,
    Track,
    TrackArtist,
    User,
)

PROFILE_TYPE = "library_taste"
PROFILE_VERSION = 2
MAX_PLAYLIST_ARTISTS_FOR_GRAPH = 80


def playlist_membership_weight(size: int) -> float:
    """Focused lists retain full weight; large archives decay by square root."""
    return min(1.0, math.sqrt(50.0 / max(size, 1)))


def saturate(value: float, scale: float) -> float:
    return 1.0 - math.exp(-max(value, 0.0) / scale)


@dataclass(frozen=True)
class ProfileBuildResult:
    profile_id: str
    artist_count: int
    album_count: int
    relationship_count: int
    timings_ms: dict[str, int]


class RecommendationProfileService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def rebuild(self, user: User) -> ProfileBuildResult:
        started = perf_counter()
        profile = self.session.scalar(
            select(RecommendationProfile).where(
                RecommendationProfile.user_id == user.id,
                RecommendationProfile.profile_type == PROFILE_TYPE,
            )
        )
        if profile is None:
            profile = RecommendationProfile(
                user_id=user.id,
                profile_type=PROFILE_TYPE,
                version=PROFILE_VERSION,
            )
            self.session.add(profile)
            self.session.flush()
        self.session.execute(
            delete(RecommendationRelationship).where(RecommendationRelationship.profile_id == profile.id)
        )
        self.session.execute(
            delete(RecommendationProfileAlbum).where(RecommendationProfileAlbum.profile_id == profile.id)
        )
        self.session.execute(
            delete(RecommendationProfileArtist).where(RecommendationProfileArtist.profile_id == profile.id)
        )

        load_started = perf_counter()
        rows = list(
            self.session.execute(
                select(
                    PlaylistTrack.playlist_id,
                    PlaylistTrack.track_id,
                    Track.album_id,
                    TrackArtist.artist_id,
                )
                .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
                .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
                .join(Track, Track.id == PlaylistTrack.track_id)
                .join(TrackArtist, TrackArtist.track_id == PlaylistTrack.track_id)
                .where(MusicConnection.user_id == user.id)
            )
        )
        playlist_sizes = dict(
            self.session.execute(
                select(PlaylistTrack.playlist_id, func.count())
                .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
                .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
                .where(MusicConnection.user_id == user.id)
                .group_by(PlaylistTrack.playlist_id)
            ).all()
        )
        load_ms = round((perf_counter() - load_started) * 1000)

        artist_started = perf_counter()
        track_artists: dict[UUID, set[UUID]] = defaultdict(set)
        playlist_artist_tracks: dict[UUID, dict[UUID, set[UUID]]] = defaultdict(lambda: defaultdict(set))
        artist_tracks: dict[UUID, set[UUID]] = defaultdict(set)
        artist_track_weight: dict[UUID, dict[UUID, float]] = defaultdict(dict)
        artist_playlists: dict[UUID, set[UUID]] = defaultdict(set)
        artist_albums: dict[UUID, set[UUID]] = defaultdict(set)
        artist_memberships: dict[UUID, set[tuple[UUID, UUID]]] = defaultdict(set)
        artist_weighted: dict[UUID, float] = defaultdict(float)
        album_tracks: dict[UUID, set[UUID]] = defaultdict(set)
        album_track_weight: dict[UUID, dict[UUID, float]] = defaultdict(dict)
        album_playlists: dict[UUID, set[UUID]] = defaultdict(set)
        album_memberships: dict[UUID, set[tuple[UUID, UUID]]] = defaultdict(set)
        album_weighted: dict[UUID, float] = defaultdict(float)

        for playlist_id, track_id, _album_id, artist_id in rows:
            track_artists[track_id].add(artist_id)
            playlist_artist_tracks[playlist_id][artist_id].add(track_id)
        for playlist_id, track_id, album_id, artist_id in rows:
            split = math.sqrt(len(track_artists[track_id]))
            weight = playlist_membership_weight(playlist_sizes[playlist_id]) / split
            membership = (playlist_id, track_id)
            artist_tracks[artist_id].add(track_id)
            artist_playlists[artist_id].add(playlist_id)
            artist_memberships[artist_id].add(membership)
            artist_weighted[artist_id] += weight
            artist_track_weight[artist_id][track_id] = max(
                artist_track_weight[artist_id].get(track_id, 0.0), weight
            )
            if album_id is not None:
                artist_albums[artist_id].add(album_id)
                album_tracks[album_id].add(track_id)
                album_playlists[album_id].add(playlist_id)
                if membership not in album_memberships[album_id]:
                    album_memberships[album_id].add(membership)
                    album_weight = playlist_membership_weight(playlist_sizes[playlist_id])
                    album_weighted[album_id] += album_weight
                    album_track_weight[album_id][track_id] = max(
                        album_track_weight[album_id].get(track_id, 0.0), album_weight
                    )

        max_track_log = max(
            (math.log1p(sum(value.values())) for value in artist_track_weight.values()),
            default=1.0,
        )
        max_weight_log = max((math.log1p(value) for value in artist_weighted.values()), default=1.0)
        artist_rows: dict[UUID, RecommendationProfileArtist] = {}
        for artist_id in sorted(artist_tracks, key=str):
            distinct_tracks = len(artist_tracks[artist_id])
            distinct_playlists = len(artist_playlists[artist_id])
            repeated = max(0, len(artist_memberships[artist_id]) - distinct_tracks)
            represented_albums = len(artist_albums[artist_id])
            collaborations = sum(
                1 for track_id in artist_tracks[artist_id] if len(track_artists[track_id]) > 1
            )
            weighted_track_breadth = sum(artist_track_weight[artist_id].values())
            features = {
                "track_breadth": math.log1p(weighted_track_breadth) / max_track_log,
                "playlist_strength": math.log1p(artist_weighted[artist_id]) / max_weight_log,
                "album_breadth": saturate(represented_albums, 5),
                "repeat_strength": saturate(repeated, 4),
                "collaboration_strength": saturate(collaborations, 6),
            }
            affinity = (
                0.42 * features["track_breadth"]
                + 0.25 * features["playlist_strength"]
                + 0.18 * features["album_breadth"]
                + 0.10 * features["repeat_strength"]
                + 0.05 * features["collaboration_strength"]
            )
            confidence = saturate(
                weighted_track_breadth + distinct_playlists * 0.8 + represented_albums * 0.4,
                8,
            )
            materialized = RecommendationProfileArtist(
                profile_id=profile.id,
                artist_id=artist_id,
                affinity=round(affinity, 8),
                confidence=round(confidence, 8),
                distinct_tracks=distinct_tracks,
                distinct_playlists=distinct_playlists,
                weighted_memberships=round(artist_weighted[artist_id], 8),
                repeated_memberships=repeated,
                represented_albums=represented_albums,
                collaboration_tracks=collaborations,
                evidence={
                    "features": {key: round(value, 8) for key, value in features.items()},
                    "weighted_track_breadth": round(weighted_track_breadth, 8),
                    "raw_distinct_tracks": distinct_tracks,
                },
            )
            artist_rows[artist_id] = materialized
            self.session.add(materialized)
        artist_ms = round((perf_counter() - artist_started) * 1000)

        album_started = perf_counter()
        artists_by_album: dict[UUID, list[UUID]] = defaultdict(list)
        for album_id, artist_id in self.session.execute(select(AlbumArtist.album_id, AlbumArtist.artist_id)):
            artists_by_album[album_id].append(artist_id)
        for album_id in sorted(album_tracks, key=str):
            related_scores = [
                artist_rows[artist_id].affinity
                for artist_id in artists_by_album.get(album_id, [])
                if artist_id in artist_rows
            ]
            related_affinity = sum(related_scores) / len(related_scores) if related_scores else 0.0
            weighted_track_breadth = sum(album_track_weight[album_id].values())
            track_signal = saturate(weighted_track_breadth, 4)
            membership_signal = saturate(album_weighted[album_id], 3)
            affinity = 0.45 * track_signal + 0.25 * membership_signal + 0.30 * related_affinity
            confidence = saturate(len(album_tracks[album_id]) + len(album_playlists[album_id]), 6)
            self.session.add(
                RecommendationProfileAlbum(
                    profile_id=profile.id,
                    album_id=album_id,
                    affinity=round(affinity, 8),
                    confidence=round(confidence, 8),
                    distinct_tracks=len(album_tracks[album_id]),
                    distinct_playlists=len(album_playlists[album_id]),
                    weighted_memberships=round(album_weighted[album_id], 8),
                    artist_affinity=round(related_affinity, 8),
                    evidence={
                        "features": {
                            "track_strength": round(track_signal, 8),
                            "playlist_strength": round(membership_signal, 8),
                            "artist_affinity": round(related_affinity, 8),
                        },
                        "weighted_track_breadth": round(weighted_track_breadth, 8),
                        "raw_distinct_tracks": len(album_tracks[album_id]),
                    },
                )
            )
        album_ms = round((perf_counter() - album_started) * 1000)

        graph_started = perf_counter()
        pair_weight: dict[tuple[UUID, UUID], float] = defaultdict(float)
        pair_playlists: dict[tuple[UUID, UUID], set[UUID]] = defaultdict(set)
        pair_collaborations: dict[tuple[UUID, UUID], int] = defaultdict(int)
        pair_collaboration_weight: dict[tuple[UUID, UUID], float] = defaultdict(float)
        for playlist_id, artist_map in playlist_artist_tracks.items():
            bounded = sorted(
                artist_map,
                key=lambda artist_id: (-len(artist_map[artist_id]), str(artist_id)),
            )[:MAX_PLAYLIST_ARTISTS_FOR_GRAPH]
            weight = playlist_membership_weight(playlist_sizes[playlist_id])
            for left, right in combinations(bounded, 2):
                pair = tuple(sorted((left, right), key=str))
                support = math.sqrt(min(len(artist_map[left]), len(artist_map[right])))
                pair_weight[pair] += weight * support
                pair_playlists[pair].add(playlist_id)
        for artists in track_artists.values():
            if len(artists) < 2:
                continue
            contribution = 0.5 / math.sqrt(len(artists) - 1)
            for left, right in combinations(sorted(artists, key=str), 2):
                pair = (left, right)
                pair_weight[pair] += contribution
                pair_collaborations[pair] += 1
                pair_collaboration_weight[pair] += contribution

        edges_by_artist: dict[UUID, list[tuple[tuple[UUID, UUID], float]]] = defaultdict(list)
        for pair, weight in pair_weight.items():
            edges_by_artist[pair[0]].append((pair, weight))
            edges_by_artist[pair[1]].append((pair, weight))
        retained_pairs: set[tuple[UUID, UUID]] = set()
        for edges in edges_by_artist.values():
            retained_pairs.update(
                pair for pair, _ in sorted(edges, key=lambda item: (-item[1], str(item[0])))[:30]
            )
        for left, right in sorted(retained_pairs, key=lambda pair: (str(pair[0]), str(pair[1]))):
            self.session.add(
                RecommendationRelationship(
                    profile_id=profile.id,
                    source_artist_id=left,
                    target_artist_id=right,
                    weight=round(pair_weight[(left, right)], 8),
                    playlist_count=len(pair_playlists[(left, right)]),
                    collaboration_count=pair_collaborations[(left, right)],
                    evidence={
                        "playlist_weight": round(
                            pair_weight[(left, right)] - pair_collaboration_weight[(left, right)],
                            8,
                        ),
                        "collaboration_weight": round(pair_collaboration_weight[(left, right)], 8),
                        "graph_playlist_artist_cap": MAX_PLAYLIST_ARTISTS_FOR_GRAPH,
                    },
                )
            )
        graph_ms = round((perf_counter() - graph_started) * 1000)

        latest_sync = self.session.scalar(
            select(func.max(MusicConnection.last_sync_at)).where(MusicConnection.user_id == user.id)
        )
        total_ms = round((perf_counter() - started) * 1000)
        timings = {
            "load": load_ms,
            "artist_affinity": artist_ms,
            "album_affinity": album_ms,
            "cooccurrence": graph_ms,
            "total": total_ms,
        }
        profile.version = PROFILE_VERSION
        profile.signals = {
            "exploration_level": user.exploration_level,
            "artist_count": len(artist_rows),
            "album_count": len(album_tracks),
            "relationship_count": len(retained_pairs),
            "playlist_count": len(playlist_sizes),
            "track_count": len(track_artists),
            "largest_playlist": max(playlist_sizes.values(), default=0),
            "largest_playlist_weight": round(
                playlist_membership_weight(max(playlist_sizes.values(), default=1)), 8
            ),
            "normalization": "min(1, sqrt(50 / playlist_membership_count))",
            "multi_artist_split": "1 / sqrt(track_artist_count)",
            "source_last_sync_at": latest_sync.isoformat() if latest_sync else None,
            "timings_ms": timings,
        }
        self.session.flush()
        return ProfileBuildResult(
            profile_id=str(profile.id),
            artist_count=len(artist_rows),
            album_count=len(album_tracks),
            relationship_count=len(retained_pairs),
            timings_ms=timings,
        )

    def get(self, user: User) -> RecommendationProfile | None:
        """Return the materialized profile without doing work during page rendering."""
        profile = self.session.scalar(
            select(RecommendationProfile).where(
                RecommendationProfile.user_id == user.id,
                RecommendationProfile.profile_type == PROFILE_TYPE,
            )
        )
        return profile

    def is_stale(self, user: User, profile: RecommendationProfile) -> bool:
        latest_sync = self.session.scalar(
            select(func.max(MusicConnection.last_sync_at)).where(MusicConnection.user_id == user.id)
        )
        source_value = profile.signals.get("source_last_sync_at")
        return profile.version != PROFILE_VERSION or (
            latest_sync is not None and source_value != latest_sync.isoformat()
        )

    def get_current(self, user: User) -> RecommendationProfile | None:
        profile = self.get(user)
        if profile is None or self.is_stale(user, profile):
            return None
        return profile
