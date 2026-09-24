from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from itertools import combinations
from statistics import median
from time import perf_counter
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.insights_schemas import (
    CollaborationMetrics,
    CollaborationPair,
    ConcentrationMetrics,
    GenreCoverage,
    InsightsArtist,
    InsightsCounts,
    InsightsOverviewResponse,
    InsightsPlaylistsResponse,
    InsightsRediscoveryResponse,
    InsightsUniverseResponse,
    LongTailBucket,
    PlaylistInsight,
    PlaylistOverlap,
    ProfileMetric,
    RediscoveryInsight,
    UniverseCommunity,
    UniverseEdge,
    UniverseNode,
)
from app.domain.models import (
    Artist,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    RecommendationCandidate,
    RecommendationProfile,
    RecommendationProfileArtist,
    RecommendationRelationship,
    Track,
    TrackArtist,
    User,
)

UNIVERSE_NODE_CAP = 100
UNIVERSE_EDGE_CAP = 360
UNIVERSE_EDGES_PER_NODE = 8
PLAYLIST_OVERLAP_CAP = 24


@dataclass(frozen=True)
class PlaylistProjection:
    id: UUID
    name: str
    artwork_url: str | None


@dataclass
class LibraryProjection:
    playlists: dict[UUID, PlaylistProjection]
    playlist_tracks: dict[UUID, set[UUID]]
    track_artists: dict[UUID, set[UUID]]
    track_albums: dict[UUID, UUID]

    @property
    def track_ids(self) -> set[UUID]:
        return {track_id for tracks in self.playlist_tracks.values() for track_id in tracks}


def _ratio(numerator: int | float, denominator: int | float) -> float:
    return round(float(numerator) / denominator, 6) if denominator else 0.0


class InsightsService:
    """Read-only, user-scoped analytics over canonical library and R2 profile evidence."""

    def __init__(self, session: Session, *, user: User, profile: RecommendationProfile | None) -> None:
        self.session = session
        self.user = user
        self.profile = profile

    def _library(self) -> LibraryProjection:
        playlist_rows = list(
            self.session.execute(
                select(Playlist.id, Playlist.name, Playlist.artwork_url)
                .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
                .where(MusicConnection.user_id == self.user.id)
                .order_by(Playlist.id)
            )
        )
        playlists = {
            playlist_id: PlaylistProjection(playlist_id, name, artwork_url)
            for playlist_id, name, artwork_url in playlist_rows
        }
        playlist_tracks: dict[UUID, set[UUID]] = {playlist_id: set() for playlist_id in playlists}
        membership_rows = list(
            self.session.execute(
                select(PlaylistTrack.playlist_id, PlaylistTrack.track_id)
                .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
                .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
                .where(MusicConnection.user_id == self.user.id)
                .order_by(PlaylistTrack.playlist_id, PlaylistTrack.track_id)
            )
        )
        for playlist_id, track_id in membership_rows:
            playlist_tracks[playlist_id].add(track_id)
        owned_tracks = self._owned_tracks()
        track_albums = {
            track_id: album_id
            for track_id, album_id in self.session.execute(
                select(Track.id, Track.album_id).where(
                    Track.id.in_(select(owned_tracks.c.track_id))
                )
            )
            if album_id is not None
        }
        track_artists: dict[UUID, set[UUID]] = defaultdict(set)
        for track_id, artist_id in self.session.execute(
            select(TrackArtist.track_id, TrackArtist.artist_id)
            .where(TrackArtist.track_id.in_(select(owned_tracks.c.track_id)))
            .order_by(TrackArtist.track_id, TrackArtist.position, TrackArtist.artist_id)
        ):
            track_artists[track_id].add(artist_id)
        return LibraryProjection(
            playlists=playlists,
            playlist_tracks=playlist_tracks,
            track_artists=dict(track_artists),
            track_albums=track_albums,
        )

    def _owned_tracks(self):  # type: ignore[no-untyped-def]
        return (
            select(PlaylistTrack.track_id)
            .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
            .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
            .where(MusicConnection.user_id == self.user.id)
            .distinct()
            .subquery()
        )

    @staticmethod
    def _artist_tracks(library: LibraryProjection) -> dict[UUID, set[UUID]]:
        result: dict[UUID, set[UUID]] = defaultdict(set)
        for track_id in library.track_ids:
            for artist_id in library.track_artists.get(track_id, set()):
                result[artist_id].add(track_id)
        return dict(result)

    @staticmethod
    def _long_tail(counts: list[int]) -> list[LongTailBucket]:
        definitions = (
            ("one", 1, 1),
            ("two_to_five", 2, 5),
            ("six_to_twenty", 6, 20),
            ("twenty_one_to_fifty", 21, 50),
            ("fifty_one_plus", 51, None),
        )
        return [
            LongTailBucket(
                key=key,  # type: ignore[arg-type]
                minimum_tracks=minimum,
                maximum_tracks=maximum,
                artist_count=sum(
                    1 for value in counts if value >= minimum and (maximum is None or value <= maximum)
                ),
            )
            for key, minimum, maximum in definitions
        ]

    def _profile_artists(self, limit: int) -> list[tuple[RecommendationProfileArtist, Artist]]:
        if self.profile is None:
            return []
        return list(
            self.session.execute(
                select(RecommendationProfileArtist, Artist)
                .join(Artist, Artist.id == RecommendationProfileArtist.artist_id)
                .where(RecommendationProfileArtist.profile_id == self.profile.id)
                .order_by(
                    RecommendationProfileArtist.affinity.desc(),
                    RecommendationProfileArtist.artist_id,
                )
                .limit(limit)
            )
        )

    def overview(self) -> InsightsOverviewResponse:
        started = perf_counter()
        owned_tracks = self._owned_tracks()
        track_count = int(self.session.scalar(select(func.count()).select_from(owned_tracks)) or 0)
        playlist_count = int(
            self.session.scalar(
                select(func.count())
                .select_from(Playlist)
                .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
                .where(MusicConnection.user_id == self.user.id)
            )
            or 0
        )
        album_count = int(
            self.session.scalar(
                select(func.count(func.distinct(Track.album_id))).where(
                    Track.id.in_(select(owned_tracks.c.track_id)),
                    Track.album_id.is_not(None),
                )
            )
            or 0
        )
        if self.profile is not None:
            artist_count_rows = list(
                self.session.execute(
                    select(
                        RecommendationProfileArtist.artist_id,
                        RecommendationProfileArtist.distinct_tracks,
                    ).where(RecommendationProfileArtist.profile_id == self.profile.id)
                )
            )
        else:
            artist_count_rows = list(
                self.session.execute(
                    select(TrackArtist.artist_id, func.count(func.distinct(TrackArtist.track_id)))
                    .where(TrackArtist.track_id.in_(select(owned_tracks.c.track_id)))
                    .group_by(TrackArtist.artist_id)
                )
            )
        artist_count_rows.sort(key=lambda item: (-int(item[1]), str(item[0])))
        artist_counts = [int(item[1]) for item in artist_count_rows]

        def concentration(top_n: int) -> float:
            artist_ids = [item[0] for item in artist_count_rows[:top_n]]
            if not artist_ids:
                return 0
            represented = int(
                self.session.scalar(
                    select(func.count(func.distinct(TrackArtist.track_id))).where(
                        TrackArtist.artist_id.in_(artist_ids),
                        TrackArtist.track_id.in_(select(owned_tracks.c.track_id)),
                    )
                )
                or 0
            )
            return _ratio(represented, track_count)

        multi_artist_subquery = (
            select(TrackArtist.track_id)
            .where(TrackArtist.track_id.in_(select(owned_tracks.c.track_id)))
            .group_by(TrackArtist.track_id)
            .having(func.count(func.distinct(TrackArtist.artist_id)) > 1)
            .subquery()
        )
        multi_artist_tracks = int(
            self.session.scalar(select(func.count()).select_from(multi_artist_subquery)) or 0
        )
        loaded_ms = round((perf_counter() - started) * 1000)
        profile_rows = self._profile_artists(12)
        top_artists = [
            InsightsArtist(
                id=str(artist.id),
                name=artist.name,
                artwork_url=artist.artwork_url,
                affinity=row.affinity,
                confidence=row.confidence,
                saved_track_count=row.distinct_tracks,
                playlist_count=row.distinct_playlists,
                represented_album_count=row.represented_albums,
                collaboration_track_count=row.collaboration_tracks,
            )
            for row, artist in profile_rows
        ]
        collaboration_pairs: list[CollaborationPair] = []
        relationship_pair_count = 0
        if self.profile is not None:
            relationship_pair_count = int(
                self.session.scalar(
                    select(func.count())
                    .select_from(RecommendationRelationship)
                    .where(
                        RecommendationRelationship.profile_id == self.profile.id,
                        RecommendationRelationship.collaboration_count > 0,
                    )
                )
                or 0
            )
            rows = list(
                self.session.scalars(
                    select(RecommendationRelationship)
                    .where(
                        RecommendationRelationship.profile_id == self.profile.id,
                        RecommendationRelationship.collaboration_count > 0,
                    )
                    .order_by(
                        RecommendationRelationship.collaboration_count.desc(),
                        RecommendationRelationship.weight.desc(),
                        RecommendationRelationship.source_artist_id,
                        RecommendationRelationship.target_artist_id,
                    )
                    .limit(10)
                )
            )
            artist_ids = {
                artist_id
                for row in rows
                for artist_id in (row.source_artist_id, row.target_artist_id)
            }
            artists = {
                artist.id: artist
                for artist in self.session.scalars(select(Artist).where(Artist.id.in_(artist_ids)))
            }
            collaboration_pairs = [
                CollaborationPair(
                    source_artist_id=str(row.source_artist_id),
                    source_artist_name=artists[row.source_artist_id].name,
                    target_artist_id=str(row.target_artist_id),
                    target_artist_name=artists[row.target_artist_id].name,
                    shared_playlist_count=row.playlist_count,
                    collaboration_track_count=row.collaboration_count,
                    relationship_weight=row.weight,
                )
                for row in rows
                if row.source_artist_id in artists and row.target_artist_id in artists
            ]

        reliable_genres = 0
        genre_sources: Counter[str] = Counter()
        for metadata in self.session.scalars(
            select(Track.metadata_json).where(Track.id.in_(select(owned_tracks.c.track_id)))
        ):
            genre = metadata.get("genres") or metadata.get("genre")
            source = metadata.get("genre_source") or metadata.get("metadata_source")
            if genre and isinstance(source, str) and source.strip():
                reliable_genres += 1
                genre_sources[source.strip()] += 1
        counts = InsightsCounts(
            tracks=track_count,
            artists=len(artist_count_rows),
            albums=album_count,
            playlists=playlist_count,
        )
        top_10_share = concentration(10)
        collaboration_share = _ratio(multi_artist_tracks, track_count)
        metrics = [
            ProfileMetric(
                code="artist_concentration",
                value=top_10_share,
                formula=(
                    "distinct tracks represented by the top 10 saved-track artists "
                    "/ distinct saved tracks"
                ),
                evidence={
                    "top_artist_count": min(10, len(artist_count_rows)),
                    "track_count": track_count,
                },
            ),
            ProfileMetric(
                code="library_breadth",
                value=_ratio(len(artist_count_rows), track_count),
                formula="distinct canonical artists / distinct canonical tracks",
                evidence={"artist_count": len(artist_count_rows), "track_count": track_count},
            ),
            ProfileMetric(
                code="album_depth",
                value=round(track_count / album_count, 6) if album_count else 0,
                formula="distinct canonical tracks / represented canonical albums",
                evidence={"track_count": track_count, "album_count": album_count},
            ),
            ProfileMetric(
                code="collaboration_density",
                value=collaboration_share,
                formula="tracks with more than one canonical artist / distinct canonical tracks",
                evidence={"multi_artist_tracks": multi_artist_tracks, "track_count": track_count},
            ),
        ]
        total_ms = round((perf_counter() - started) * 1000)
        return InsightsOverviewResponse(
            profile_state="current" if self.profile is not None else "missing_or_stale",
            generated_at=self.profile.updated_at if self.profile else None,
            counts=counts,
            concentration=ConcentrationMetrics(
                top_10_track_share=top_10_share,
                top_50_track_share=concentration(50),
                median_tracks_per_artist=float(median(artist_counts)) if artist_counts else 0,
                long_tail=self._long_tail(artist_counts),
            ),
            collaboration=CollaborationMetrics(
                multi_artist_tracks=multi_artist_tracks,
                multi_artist_track_share=collaboration_share,
                relationship_pairs_with_collaboration=relationship_pair_count,
            ),
            profile_metrics=metrics,
            top_artists=top_artists,
            strongest_collaborations=collaboration_pairs,
            genre_coverage=GenreCoverage(
                reliable_track_count=reliable_genres,
                missing_track_count=max(0, track_count - reliable_genres),
                coverage=_ratio(reliable_genres, track_count),
                sources=sorted(genre_sources),
                sufficient_for_primary_insight=_ratio(reliable_genres, track_count) >= 0.8,
            ),
            formulas={
                "affinity": "R2 canonical library affinity; no second scoring model",
                "concentration": "union of distinct canonical tracks represented by ranked artists",
                "long_tail": "artist buckets by distinct canonical saved-track representation",
            },
            timings_ms={"library_projection": loaded_ms, "total": total_ms},
        )

    def universe(self) -> InsightsUniverseResponse:
        started = perf_counter()
        profile_rows = self._profile_artists(UNIVERSE_NODE_CAP)
        if self.profile is None or not profile_rows:
            return InsightsUniverseResponse(
                profile_state="missing_or_stale",
                node_cap=UNIVERSE_NODE_CAP,
                edge_cap=UNIVERSE_EDGE_CAP,
                per_node_edge_cap=UNIVERSE_EDGES_PER_NODE,
            )
        selected_ids = {row.artist_id for row, _artist in profile_rows}
        candidates = list(
            self.session.scalars(
                select(RecommendationRelationship)
                .where(
                    RecommendationRelationship.profile_id == self.profile.id,
                    RecommendationRelationship.source_artist_id.in_(selected_ids),
                    RecommendationRelationship.target_artist_id.in_(selected_ids),
                )
                .order_by(
                    RecommendationRelationship.weight.desc(),
                    RecommendationRelationship.source_artist_id,
                    RecommendationRelationship.target_artist_id,
                )
                .limit(UNIVERSE_EDGE_CAP * 8)
            )
        )
        degree: Counter[UUID] = Counter()
        retained: list[RecommendationRelationship] = []
        seen: set[tuple[UUID, UUID]] = set()
        for relationship in candidates:
            pair = tuple(
                sorted(
                    (relationship.source_artist_id, relationship.target_artist_id),
                    key=str,
                )
            )
            if pair in seen:
                continue
            if degree[pair[0]] >= UNIVERSE_EDGES_PER_NODE or degree[pair[1]] >= UNIVERSE_EDGES_PER_NODE:
                continue
            retained.append(relationship)
            seen.add(pair)
            degree[pair[0]] += 1
            degree[pair[1]] += 1
            if len(retained) >= UNIVERSE_EDGE_CAP:
                break

        adjacency: dict[UUID, set[UUID]] = {artist_id: set() for artist_id in selected_ids}
        for row in retained:
            adjacency[row.source_artist_id].add(row.target_artist_id)
            adjacency[row.target_artist_id].add(row.source_artist_id)
        affinity = {row.artist_id: row.affinity for row, _artist in profile_rows}
        names = {artist.id: artist.name for _row, artist in profile_rows}
        components: list[set[UUID]] = []
        remaining = set(selected_ids)
        while remaining:
            seed = min(remaining, key=str)
            stack = [seed]
            component: set[UUID] = set()
            while stack:
                current = stack.pop()
                if current in component:
                    continue
                component.add(current)
                stack.extend(sorted(adjacency[current] - component, key=str, reverse=True))
            remaining -= component
            components.append(component)
        components.sort(
            key=lambda group: (
                -max((affinity[value] for value in group), default=0),
                min(str(value) for value in group),
            )
        )
        community_by_artist: dict[UUID, str] = {}
        communities: list[UniverseCommunity] = []
        for index, component in enumerate(components, start=1):
            community_id = f"community-{index:02d}"
            ranked = sorted(component, key=lambda value: (-affinity[value], str(value)))
            for artist_id in component:
                community_by_artist[artist_id] = community_id
            communities.append(
                UniverseCommunity(
                    id=community_id,
                    artist_count=len(component),
                    representative_artists=[names[value] for value in ranked[:4]],
                )
            )
        nodes = [
            UniverseNode(
                id=str(artist.id),
                name=artist.name,
                artwork_url=artist.artwork_url,
                affinity=row.affinity,
                saved_track_count=row.distinct_tracks,
                playlist_count=row.distinct_playlists,
                represented_album_count=row.represented_albums,
                collaboration_track_count=row.collaboration_tracks,
                community_id=community_by_artist[row.artist_id],
            )
            for row, artist in profile_rows
        ]
        edges = [
            UniverseEdge(
                id=f"{row.source_artist_id}:{row.target_artist_id}",
                source=str(row.source_artist_id),
                target=str(row.target_artist_id),
                weight=row.weight,
                shared_playlist_count=row.playlist_count,
                collaboration_track_count=row.collaboration_count,
            )
            for row in retained
        ]
        return InsightsUniverseResponse(
            profile_state="current",
            node_cap=UNIVERSE_NODE_CAP,
            edge_cap=UNIVERSE_EDGE_CAP,
            per_node_edge_cap=UNIVERSE_EDGES_PER_NODE,
            nodes=nodes,
            edges=edges,
            communities=communities,
            formulas={
                "node_weight": "R2 canonical library affinity",
                "edge_weight": "R2 normalized playlist co-occurrence plus collaboration evidence",
                "community": "deterministic connected components in the bounded visible graph",
            },
            timings_ms={"total": round((perf_counter() - started) * 1000)},
        )

    def playlists(self) -> InsightsPlaylistsResponse:
        started = perf_counter()
        library = self._library()
        track_frequency: Counter[UUID] = Counter(
            track_id for tracks in library.playlist_tracks.values() for track_id in tracks
        )
        playlist_items: list[PlaylistInsight] = []
        for playlist_id, playlist in library.playlists.items():
            tracks = library.playlist_tracks.get(playlist_id, set())
            artist_track_counts: Counter[UUID] = Counter()
            artists: set[UUID] = set()
            albums: set[UUID] = set()
            multi_artist = 0
            for track_id in tracks:
                track_artist_ids = library.track_artists.get(track_id, set())
                artists.update(track_artist_ids)
                for artist_id in track_artist_ids:
                    artist_track_counts[artist_id] += 1
                if len(track_artist_ids) > 1:
                    multi_artist += 1
                if track_id in library.track_albums:
                    albums.add(library.track_albums[track_id])
            unique_tracks = sum(1 for track_id in tracks if track_frequency[track_id] == 1)
            playlist_items.append(
                PlaylistInsight(
                    id=str(playlist_id),
                    name=playlist.name,
                    artwork_url=playlist.artwork_url,
                    track_count=len(tracks),
                    distinct_artist_count=len(artists),
                    distinct_album_count=len(albums),
                    multi_artist_track_count=multi_artist,
                    leading_artist_track_share=_ratio(
                        max(artist_track_counts.values(), default=0), len(tracks)
                    ),
                    unique_library_coverage=_ratio(unique_tracks, len(tracks)),
                )
            )
        playlist_items.sort(key=lambda item: (-item.track_count, item.name.casefold(), item.id))
        overlaps: list[PlaylistOverlap] = []
        playlist_order = sorted(library.playlists, key=str)
        for source_id, target_id in combinations(playlist_order, 2):
            source_tracks = library.playlist_tracks.get(source_id, set())
            target_tracks = library.playlist_tracks.get(target_id, set())
            shared = len(source_tracks & target_tracks)
            if not shared:
                continue
            union = len(source_tracks | target_tracks)
            source = library.playlists[source_id]
            target = library.playlists[target_id]
            overlaps.append(
                PlaylistOverlap(
                    source_playlist_id=str(source_id),
                    source_playlist_name=source.name,
                    source_track_count=len(source_tracks),
                    target_playlist_id=str(target_id),
                    target_playlist_name=target.name,
                    target_track_count=len(target_tracks),
                    shared_track_count=shared,
                    jaccard_similarity=_ratio(shared, union),
                )
            )
        overlaps.sort(
            key=lambda item: (
                -item.jaccard_similarity,
                -item.shared_track_count,
                item.source_playlist_id,
                item.target_playlist_id,
            )
        )
        return InsightsPlaylistsResponse(
            playlists=playlist_items,
            strongest_overlaps=overlaps[:PLAYLIST_OVERLAP_CAP],
            similarity_formula="intersection of canonical track IDs / union of canonical track IDs",
            uniqueness_formula="playlist tracks appearing in no other owned playlist / playlist tracks",
            timings_ms={"total": round((perf_counter() - started) * 1000)},
        )

    def rediscovery(self, limit: int = 12) -> InsightsRediscoveryResponse:
        started = perf_counter()
        if self.profile is None:
            return InsightsRediscoveryResponse(
                profile_state="missing_or_stale",
                semantics="Saved tracks outside the strongest current library-profile signals.",
            )
        candidates = list(
            self.session.scalars(
                select(RecommendationCandidate)
                .where(
                    RecommendationCandidate.user_id == self.user.id,
                    RecommendationCandidate.profile_id == self.profile.id,
                    RecommendationCandidate.category == "rediscover",
                    RecommendationCandidate.source == "musicscope_library",
                )
                .order_by(RecommendationCandidate.score.desc(), RecommendationCandidate.identity_key)
                .limit(limit)
            )
        )
        items: list[RediscoveryInsight] = []
        for candidate in candidates:
            item = candidate.payload.get("item", {})
            if not isinstance(item, dict):
                continue
            title = item.get("title")
            if not isinstance(title, str) or not title:
                continue
            items.append(
                RediscoveryInsight(
                    id=str(candidate.canonical_entity_id or candidate.id),
                    title=title,
                    subtitle=item.get("subtitle") if isinstance(item.get("subtitle"), str) else None,
                    artwork_url=(
                        item.get("artwork_url") if isinstance(item.get("artwork_url"), str) else None
                    ),
                    score=candidate.score,
                    explanation=(
                        item.get("explanation")
                        if isinstance(item.get("explanation"), str)
                        else "Saved music outside the strongest current profile signals."
                    ),
                    strategy=candidate.strategy,
                    is_in_library=True,
                )
            )
        return InsightsRediscoveryResponse(
            profile_state="current",
            semantics="Saved tracks outside the strongest current library-profile signals.",
            items=items,
            timings_ms={"total": round((perf_counter() - started) * 1000)},
        )
