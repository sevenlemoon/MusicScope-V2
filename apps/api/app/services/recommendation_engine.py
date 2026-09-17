from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from time import perf_counter
from typing import Literal
from uuid import UUID

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.api.schemas import RecommendationEvidence, RecommendationItem, TrackItem
from app.domain.models import (
    Album,
    Artist,
    MusicConnection,
    Playlist,
    PlaylistTrack,
    RecommendationCandidate,
    RecommendationFeedback,
    RecommendationProfile,
    RecommendationProfileAlbum,
    RecommendationProfileArtist,
    RecommendationRelationship,
    Track,
    TrackArtist,
    User,
)
from app.services.library_queries import track_items

Strategy = Literal[
    "REDISCOVER",
    "ARTIST_AFFINITY",
    "ALBUM_AFFINITY",
    "CO_OCCURRENCE",
    "ADJACENT_ARTIST",
    "EXPLORATION",
]


@dataclass
class RankedCandidate:
    item: RecommendationItem
    artist_ids: tuple[str, ...] = ()
    album_id: str | None = None


@dataclass(frozen=True)
class RecommendationResult:
    generated_at: datetime
    items: list[RecommendationItem]
    candidate_counts: dict[str, int]
    timings_ms: dict[str, int]


def confidence_label(value: float) -> Literal["strong", "developing", "light"]:
    if value >= 0.72:
        return "strong"
    if value >= 0.42:
        return "developing"
    return "light"


class RecommendationEngine:
    """Generate explainable recommendations from a materialized, user-owned profile."""

    def __init__(self, session: Session, *, user: User, profile: RecommendationProfile) -> None:
        self.session = session
        self.user = user
        self.profile = profile
        self._candidate_pools: dict[str, list[RankedCandidate]] | None = None
        self._candidate_counts: dict[str, int] = {}
        self._candidate_ms = 0

    def generate(self, *, category: str = "for-you", limit: int = 20) -> RecommendationResult:
        started = perf_counter()
        generated_at = datetime.now(UTC)
        if self._candidate_pools is None:
            candidate_started = perf_counter()
            self._candidate_pools = self._load_materialized()
            self._candidate_ms = round((perf_counter() - candidate_started) * 1000)

        pools = self._candidate_pools
        if category in pools:
            selected = pools[category]
        else:
            selected = self._mix(
                pools["artists"],
                pools["albums"],
                pools["tracks"],
                pools["adjacent"],
                pools["external"],
                limit,
            )

        diversify_started = perf_counter()
        items = [candidate.item for candidate in self._diversify(selected, limit)]
        diversify_ms = round((perf_counter() - diversify_started) * 1000)
        total_ms = round((perf_counter() - started) * 1000)
        return RecommendationResult(
            generated_at=generated_at,
            items=items,
            candidate_counts=self._candidate_counts,
            timings_ms={
                "candidate_generation": self._candidate_ms,
                "diversification": diversify_ms,
                "total": total_ms,
            },
        )

    @staticmethod
    def identity_key(item: RecommendationItem) -> str:
        if item.canonical_entity_id:
            return f"canonical:{item.canonical_entity_id}"
        if item.provider_identity:
            identity = item.provider_identity
            return f"provider:{identity.provider}:{identity.entity_type}:{identity.provider_id}"
        raise ValueError("A recommendation candidate requires an unambiguous identity.")

    def materialize_internal(self) -> dict[str, int]:
        """Build reusable internal pools outside normal Home/Discover request paths."""
        generated_at = datetime.now(UTC)
        artists = self._artist_candidates(generated_at, {})
        albums = self._album_candidates(generated_at, {})
        tracks, hidden = self._track_candidates(generated_at, {})
        adjacent = self._adjacent_candidates(generated_at, {})
        pools = {
            "artists": artists,
            "albums": albums,
            "tracks": tracks,
            "rediscover": tracks,
            "hidden-gems": hidden,
            "adjacent": adjacent,
        }
        self.session.execute(
            delete(RecommendationCandidate).where(
                RecommendationCandidate.user_id == self.user.id,
                RecommendationCandidate.source == "musicscope_library",
            )
        )
        for category, candidates in pools.items():
            for candidate in candidates:
                item = candidate.item
                self.session.add(
                    RecommendationCandidate(
                        user_id=self.user.id,
                        profile_id=self.profile.id,
                        category=category,
                        source=item.source,
                        entity_type=item.entity_type,
                        canonical_entity_id=UUID(item.canonical_entity_id)
                        if item.canonical_entity_id
                        else None,
                        provider=item.provider_identity.provider if item.provider_identity else None,
                        provider_id=item.provider_identity.provider_id
                        if item.provider_identity
                        else None,
                        identity_key=self.identity_key(item),
                        score=item.score,
                        confidence=item.confidence,
                        strategy=item.strategy,
                        distance=item.discovery_distance,
                        payload={
                            "item": item.model_dump(mode="json"),
                            "artist_ids": list(candidate.artist_ids),
                            "album_id": candidate.album_id,
                        },
                        generated_at=generated_at,
                    )
                )
        self.session.flush()
        self._candidate_pools = None
        return {category: len(candidates) for category, candidates in pools.items()}

    def _load_materialized(self) -> dict[str, list[RankedCandidate]]:
        rows = list(
            self.session.scalars(
                select(RecommendationCandidate)
                .where(
                    RecommendationCandidate.user_id == self.user.id,
                    RecommendationCandidate.profile_id == self.profile.id,
                )
                .order_by(RecommendationCandidate.score.desc(), RecommendationCandidate.identity_key)
            )
        )
        pools: dict[str, list[RankedCandidate]] = defaultdict(list)
        feedback = self._feedback()
        for row in rows:
            if feedback.get(row.identity_key) in {"DISLIKE", "NOT_INTERESTED"}:
                continue
            item = RecommendationItem.model_validate(row.payload["item"])
            if feedback.get(row.identity_key) == "LIKE":
                item = item.model_copy(update={"score": min(1.0, item.score + 0.08)})
            pools[row.category].append(
                RankedCandidate(
                    item=item,
                    artist_ids=tuple(str(value) for value in row.payload.get("artist_ids", [])),
                    album_id=str(row.payload["album_id"]) if row.payload.get("album_id") else None,
                )
            )
        for category in ("artists", "albums", "tracks", "rediscover", "hidden-gems", "adjacent", "external"):
            pools.setdefault(category, [])
        pools["explore"] = [*pools["external"], *reversed(pools["adjacent"])]
        self._candidate_counts = {
            "artist_affinity": len(pools["artists"]),
            "album_affinity": len(pools["albums"]),
            "rediscover": len(pools["rediscover"]),
            "hidden_gems": len(pools["hidden-gems"]),
            "adjacent_artist": len(pools["adjacent"]),
            "external_discovery": len(pools["external"]),
        }
        return pools

    def _library_track_ids(self) -> list[UUID]:
        return list(
            self.session.scalars(
                select(PlaylistTrack.track_id)
                .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
                .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
                .where(MusicConnection.user_id == self.user.id)
                .distinct()
            )
        )

    def _feedback(self) -> dict[str, str]:
        return {
            row.identity_key: row.feedback_type
            for row in self.session.scalars(
                select(RecommendationFeedback).where(RecommendationFeedback.user_id == self.user.id)
            )
        }

    @staticmethod
    def _allowed(feedback: dict[str, str], kind: str, entity_id: UUID) -> bool:
        return feedback.get(f"canonical:{entity_id}") not in {"DISLIKE", "NOT_INTERESTED"}

    @staticmethod
    def _feedback_boost(feedback: dict[str, str], kind: str, entity_id: UUID) -> float:
        return 0.08 if feedback.get(f"canonical:{entity_id}") == "LIKE" else 0.0

    def _artist_candidates(
        self,
        generated_at: datetime,
        feedback: dict[str, str],
    ) -> list[RankedCandidate]:
        rows = list(
            self.session.execute(
                select(RecommendationProfileArtist, Artist)
                .join(Artist, Artist.id == RecommendationProfileArtist.artist_id)
                .where(RecommendationProfileArtist.profile_id == self.profile.id)
                .order_by(
                    RecommendationProfileArtist.affinity.desc(),
                    RecommendationProfileArtist.artist_id,
                )
                .limit(200)
            )
        )
        candidates: list[RankedCandidate] = []
        for profile_artist, artist in rows:
            if not self._allowed(feedback, "artist", artist.id):
                continue
            explanation = (
                f"{profile_artist.distinct_tracks} tracks across "
                f"{profile_artist.distinct_playlists} playlists represent this artist."
            )
            score = min(
                1.0,
                profile_artist.affinity * 0.82
                + profile_artist.confidence * 0.18
                + self._feedback_boost(feedback, "artist", artist.id),
            )
            evidence = [
                RecommendationEvidence(
                    code="ARTIST_LIBRARY_TRACK_COUNT",
                    label="Library tracks",
                    value=profile_artist.distinct_tracks,
                ),
                RecommendationEvidence(
                    code="ARTIST_PLAYLIST_COUNT",
                    label="Playlists represented",
                    value=profile_artist.distinct_playlists,
                ),
                RecommendationEvidence(
                    code="ARTIST_ALBUM_COUNT",
                    label="Albums represented",
                    value=profile_artist.represented_albums,
                ),
            ]
            candidates.append(
                RankedCandidate(
                    item=RecommendationItem(
                        entity_type="artist",
                        canonical_entity_id=str(artist.id),
                        title=artist.name,
                        artwork_url=artist.artwork_url,
                        score=round(score, 6),
                        confidence=profile_artist.confidence,
                        confidence_label=confidence_label(profile_artist.confidence),
                        strategy="ARTIST_AFFINITY",
                        evidence=evidence,
                        explanation=explanation,
                        is_in_library=True,
                        source="musicscope_library",
                        generated_at=generated_at,
                    ),
                    artist_ids=(str(artist.id),),
                )
            )
        return candidates

    def _album_candidates(
        self,
        generated_at: datetime,
        feedback: dict[str, str],
    ) -> list[RankedCandidate]:
        rows = list(
            self.session.execute(
                select(RecommendationProfileAlbum, Album)
                .join(Album, Album.id == RecommendationProfileAlbum.album_id)
                .where(RecommendationProfileAlbum.profile_id == self.profile.id)
                .order_by(
                    RecommendationProfileAlbum.affinity.desc(),
                    RecommendationProfileAlbum.album_id,
                )
                .limit(200)
            )
        )
        candidates: list[RankedCandidate] = []
        for profile_album, album in rows:
            if not self._allowed(feedback, "album", album.id):
                continue
            score = min(
                1.0,
                profile_album.affinity * 0.82
                + profile_album.confidence * 0.18
                + self._feedback_boost(feedback, "album", album.id),
            )
            candidates.append(
                RankedCandidate(
                    item=RecommendationItem(
                        entity_type="album",
                        canonical_entity_id=str(album.id),
                        title=album.title,
                        artwork_url=album.artwork_url,
                        score=round(score, 6),
                        confidence=profile_album.confidence,
                        confidence_label=confidence_label(profile_album.confidence),
                        strategy="ALBUM_AFFINITY",
                        evidence=[
                            RecommendationEvidence(
                                code="ALBUM_LIBRARY_TRACK_COUNT",
                                label="Library tracks",
                                value=profile_album.distinct_tracks,
                            ),
                            RecommendationEvidence(
                                code="ALBUM_PLAYLIST_COUNT",
                                label="Playlists represented",
                                value=profile_album.distinct_playlists,
                            ),
                            RecommendationEvidence(
                                code="RELATED_ARTIST_AFFINITY",
                                label="Related artist affinity",
                                value=round(profile_album.artist_affinity, 3),
                            ),
                        ],
                        explanation=(
                            f"{profile_album.distinct_tracks} saved tracks from this album appear "
                            f"across {profile_album.distinct_playlists} playlists."
                        ),
                        is_in_library=True,
                        source="musicscope_library",
                        generated_at=generated_at,
                    ),
                    album_id=str(album.id),
                )
            )
        return candidates

    def _track_candidates(
        self,
        generated_at: datetime,
        feedback: dict[str, str],
    ) -> tuple[list[RankedCandidate], list[RankedCandidate]]:
        track_ids = self._library_track_ids()
        if not track_ids:
            return [], []
        tracks = list(self.session.scalars(select(Track).where(Track.id.in_(track_ids))))
        track_models = {track.id: track for track in tracks}
        items = {UUID(item.id): item for item in track_items(self.session, tracks)}
        membership_counts = dict(
            self.session.execute(
                select(PlaylistTrack.track_id, func.count())
                .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
                .join(MusicConnection, MusicConnection.id == Playlist.owner_connection_id)
                .where(
                    MusicConnection.user_id == self.user.id,
                    PlaylistTrack.track_id.in_(track_ids),
                )
                .group_by(PlaylistTrack.track_id)
            ).all()
        )
        artist_affinity = {
            row.artist_id: row
            for row in self.session.scalars(
                select(RecommendationProfileArtist).where(
                    RecommendationProfileArtist.profile_id == self.profile.id
                )
            )
        }
        album_affinity = {
            row.album_id: row
            for row in self.session.scalars(
                select(RecommendationProfileAlbum).where(
                    RecommendationProfileAlbum.profile_id == self.profile.id
                )
            )
        }
        artists_by_track: dict[UUID, list[UUID]] = defaultdict(list)
        for track_id, artist_id in self.session.execute(
            select(TrackArtist.track_id, TrackArtist.artist_id).where(TrackArtist.track_id.in_(track_ids))
        ):
            artists_by_track[track_id].append(artist_id)

        candidates: list[RankedCandidate] = []
        hidden: list[RankedCandidate] = []
        for track_id in track_ids:
            if not self._allowed(feedback, "track", track_id):
                continue
            track = track_models[track_id]
            track_item: TrackItem = items[track_id]
            artist_rows = [
                artist_affinity[artist_id]
                for artist_id in artists_by_track[track_id]
                if artist_id in artist_affinity
            ]
            strongest = max(artist_rows, key=lambda row: row.affinity, default=None)
            strongest_affinity = strongest.affinity if strongest else 0.0
            strongest_confidence = strongest.confidence if strongest else 0.0
            album_row = album_affinity.get(track.album_id) if track.album_id else None
            album_score = album_row.affinity if album_row else 0.0
            appearances = int(membership_counts.get(track_id, 0))
            underrepresentation = 1.0 / max(appearances, 1)
            score = min(
                1.0,
                strongest_affinity * 0.67
                + album_score * 0.18
                + underrepresentation * 0.15
                + self._feedback_boost(feedback, "track", track_id),
            )
            confidence = min(1.0, strongest_confidence * 0.75 + min(appearances / 4, 1) * 0.25)
            artist_name = track_item.artists[0] if track_item.artists else "your library"
            candidate = RankedCandidate(
                item=RecommendationItem(
                    entity_type="track",
                    canonical_entity_id=str(track_id),
                    title=track.title,
                    subtitle=" · ".join(track_item.artists),
                    artwork_url=track.artwork_url,
                    score=round(score, 6),
                    confidence=round(confidence, 6),
                    confidence_label=confidence_label(confidence),
                    strategy="REDISCOVER",
                    evidence=[
                        RecommendationEvidence(
                            code="REDISCOVERY_SIGNAL",
                            label="Playlist appearances",
                            value=appearances,
                        ),
                        RecommendationEvidence(
                            code="RELATED_ARTIST_AFFINITY",
                            label="Strongest artist affinity",
                            value=round(strongest_affinity, 3),
                        ),
                    ],
                    explanation=(
                        f"Saved in your library; an underrepresented track connected to {artist_name}."
                    ),
                    is_in_library=True,
                    source="musicscope_library",
                    generated_at=generated_at,
                    track=track_item,
                ),
                artist_ids=tuple(str(value) for value in artists_by_track[track_id]),
                album_id=str(track.album_id) if track.album_id else None,
            )
            candidates.append(candidate)
            if appearances == 1 and strongest_affinity >= 0.28:
                hidden_item = candidate.item.model_copy(
                    update={
                        "strategy": "EXPLORATION",
                        "explanation": (
                            "Saved once in your library, with evidence from a represented artist "
                            "rather than global popularity."
                        ),
                    }
                )
                hidden.append(
                    RankedCandidate(
                        item=hidden_item,
                        artist_ids=candidate.artist_ids,
                        album_id=candidate.album_id,
                    )
                )
        candidates.sort(key=lambda row: (-row.item.score, row.item.canonical_entity_id))
        hidden.sort(key=lambda row: (-row.item.score, row.item.canonical_entity_id))
        return candidates[:500], hidden[:500]

    def _adjacent_candidates(
        self,
        generated_at: datetime,
        feedback: dict[str, str],
    ) -> list[RankedCandidate]:
        profile_artists = {
            row.artist_id: row
            for row in self.session.scalars(
                select(RecommendationProfileArtist).where(
                    RecommendationProfileArtist.profile_id == self.profile.id
                )
            )
        }
        anchors = sorted(profile_artists.values(), key=lambda row: (-row.affinity, str(row.artist_id)))[:24]
        anchor_ids = {row.artist_id for row in anchors}
        relationships = list(
            self.session.scalars(
                select(RecommendationRelationship)
                .where(
                    RecommendationRelationship.profile_id == self.profile.id,
                    or_(
                        RecommendationRelationship.source_artist_id.in_(anchor_ids),
                        RecommendationRelationship.target_artist_id.in_(anchor_ids),
                    ),
                )
                .order_by(RecommendationRelationship.weight.desc())
            )
        )
        if not relationships:
            return []
        artist_ids = {
            entity_id
            for relationship in relationships
            for entity_id in (
                relationship.source_artist_id,
                relationship.target_artist_id,
            )
        }
        artists = {
            artist.id: artist
            for artist in self.session.scalars(select(Artist).where(Artist.id.in_(artist_ids)))
        }
        max_weight = max(relationship.weight for relationship in relationships) or 1.0
        by_target: dict[UUID, RankedCandidate] = {}
        for relationship in relationships:
            if relationship.source_artist_id in anchor_ids:
                anchor_id = relationship.source_artist_id
                target_id = relationship.target_artist_id
            else:
                anchor_id = relationship.target_artist_id
                target_id = relationship.source_artist_id
            if target_id in anchor_ids or not self._allowed(feedback, "artist", target_id):
                continue
            anchor = artists.get(anchor_id)
            target = artists.get(target_id)
            target_profile = profile_artists.get(target_id)
            anchor_profile = profile_artists.get(anchor_id)
            if not anchor or not target or not target_profile or not anchor_profile:
                continue
            relation_strength = relationship.weight / max_weight
            score = min(
                1.0,
                0.55 * relation_strength
                + 0.25 * anchor_profile.affinity
                + 0.20 * target_profile.affinity
                + self._feedback_boost(feedback, "artist", target_id),
            )
            confidence = min(
                1.0,
                0.5 * target_profile.confidence
                + 0.3 * min(relationship.playlist_count / 4, 1)
                + 0.2 * min(relationship.collaboration_count / 3, 1),
            )
            if relationship.playlist_count:
                explanation = (
                    f"Appears alongside {anchor.name} across {relationship.playlist_count} of your playlists."
                )
            else:
                explanation = (
                    f"Connected to {anchor.name} through {relationship.collaboration_count} shared tracks."
                )
            item = RecommendationItem(
                entity_type="artist",
                canonical_entity_id=str(target.id),
                title=target.name,
                artwork_url=target.artwork_url,
                score=round(score, 6),
                confidence=round(confidence, 6),
                confidence_label=confidence_label(confidence),
                strategy="ADJACENT_ARTIST",
                evidence=[
                    RecommendationEvidence(
                        code="PLAYLIST_CO_OCCURRENCE",
                        label="Shared playlists",
                        value=relationship.playlist_count,
                    ),
                    RecommendationEvidence(
                        code="COLLABORATION_RELATIONSHIP",
                        label="Shared tracks",
                        value=relationship.collaboration_count,
                    ),
                    RecommendationEvidence(
                        code="AFFINITY_ANCHOR",
                        label="Affinity anchor",
                        value=anchor.name,
                    ),
                ],
                explanation=explanation,
                is_in_library=True,
                source="musicscope_library",
                generated_at=generated_at,
            )
            previous = by_target.get(target_id)
            candidate = RankedCandidate(item=item, artist_ids=(str(target_id),))
            if previous is None or item.score > previous.item.score:
                by_target[target_id] = candidate
        return sorted(by_target.values(), key=lambda row: (-row.item.score, row.item.canonical_entity_id))

    def _mix(
        self,
        artists: list[RankedCandidate],
        albums: list[RankedCandidate],
        tracks: list[RankedCandidate],
        adjacent: list[RankedCandidate],
        external: list[RankedCandidate],
        limit: int,
    ) -> list[RankedCandidate]:
        exploration = self.user.exploration_level / 100
        familiar = sorted(
            [*tracks, *artists, *albums],
            key=lambda row: (-(row.item.score + (1 - exploration) * 0.12), row.item.canonical_entity_id),
        )
        exploratory = sorted(
            [*external, *adjacent],
            key=lambda row: (-(row.item.score + exploration * 0.18), row.item.canonical_entity_id),
        )
        target_exploratory = round(limit * (0.10 + exploration * 0.70))
        target_familiar = max(0, limit - target_exploratory)
        familiar_selection = self._diversify(familiar, target_familiar)
        exploratory_selection = self._diversify(exploratory, target_exploratory)
        mixed = [*familiar_selection, *exploratory_selection]
        if len(mixed) < limit:
            selected_keys = {self.identity_key(candidate.item) for candidate in mixed}
            remaining = [
                candidate
                for candidate in [*familiar, *exploratory]
                if self.identity_key(candidate.item) not in selected_keys
            ]
            mixed.extend(self._diversify(remaining, limit - len(mixed)))
        return sorted(
            mixed,
            key=lambda row: (
                -(row.item.score + (exploration * 0.08 if not row.item.is_in_library else 0)),
                self.identity_key(row.item),
            ),
        )

    @staticmethod
    def _diversify(candidates: list[RankedCandidate], limit: int) -> list[RankedCandidate]:
        selected: list[RankedCandidate] = []
        entities: set[tuple[str, str]] = set()
        artist_counts: dict[str, int] = defaultdict(int)
        album_counts: dict[str, int] = defaultdict(int)
        seed_counts: dict[str, int] = defaultdict(int)
        strategy_counts: dict[str, int] = defaultdict(int)
        strategy_cap = max(3, (limit + 1) // 2)
        for candidate in candidates:
            identity = (candidate.item.entity_type, RecommendationEngine.identity_key(candidate.item))
            if identity in entities or strategy_counts[candidate.item.strategy] >= strategy_cap:
                continue
            if any(artist_counts[artist_id] >= 2 for artist_id in candidate.artist_ids):
                continue
            if candidate.album_id and album_counts[candidate.album_id] >= 2:
                continue
            seed = next(
                (
                    str(evidence.value)
                    for evidence in candidate.item.evidence
                    if evidence.code == "AFFINITY_SEED"
                ),
                "",
            )
            if seed and seed_counts[seed] >= 2:
                continue
            selected.append(candidate)
            entities.add(identity)
            strategy_counts[candidate.item.strategy] += 1
            for artist_id in candidate.artist_ids:
                artist_counts[artist_id] += 1
            if candidate.album_id:
                album_counts[candidate.album_id] += 1
            if seed:
                seed_counts[seed] += 1
            if len(selected) == limit:
                break
        return selected
