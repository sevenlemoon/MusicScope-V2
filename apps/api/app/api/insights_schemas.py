from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class InsightsCounts(BaseModel):
    tracks: int = 0
    artists: int = 0
    albums: int = 0
    playlists: int = 0


class LongTailBucket(BaseModel):
    key: Literal["one", "two_to_five", "six_to_twenty", "twenty_one_to_fifty", "fifty_one_plus"]
    minimum_tracks: int
    maximum_tracks: int | None = None
    artist_count: int


class ConcentrationMetrics(BaseModel):
    top_10_track_share: float = 0
    top_50_track_share: float = 0
    median_tracks_per_artist: float = 0
    long_tail: list[LongTailBucket] = Field(default_factory=list)


class CollaborationMetrics(BaseModel):
    multi_artist_tracks: int = 0
    multi_artist_track_share: float = 0
    relationship_pairs_with_collaboration: int = 0


class GenreCoverage(BaseModel):
    reliable_track_count: int = 0
    missing_track_count: int = 0
    coverage: float = 0
    sources: list[str] = Field(default_factory=list)
    sufficient_for_primary_insight: bool = False


class ProfileMetric(BaseModel):
    code: str
    value: float
    formula: str
    evidence: dict[str, float | int] = Field(default_factory=dict)


class InsightsArtist(BaseModel):
    id: str
    name: str
    artwork_url: str | None = None
    affinity: float
    confidence: float
    saved_track_count: int
    playlist_count: int
    represented_album_count: int
    collaboration_track_count: int


class CollaborationPair(BaseModel):
    source_artist_id: str
    source_artist_name: str
    target_artist_id: str
    target_artist_name: str
    shared_playlist_count: int
    collaboration_track_count: int
    relationship_weight: float


class InsightsOverviewResponse(BaseModel):
    profile_state: Literal["current", "missing_or_stale"]
    generated_at: datetime | None = None
    counts: InsightsCounts
    concentration: ConcentrationMetrics
    collaboration: CollaborationMetrics
    profile_metrics: list[ProfileMetric] = Field(default_factory=list)
    top_artists: list[InsightsArtist] = Field(default_factory=list)
    strongest_collaborations: list[CollaborationPair] = Field(default_factory=list)
    genre_coverage: GenreCoverage
    formulas: dict[str, str] = Field(default_factory=dict)
    timings_ms: dict[str, int] = Field(default_factory=dict)


class UniverseNode(BaseModel):
    id: str
    name: str
    artwork_url: str | None = None
    affinity: float
    saved_track_count: int
    playlist_count: int
    represented_album_count: int
    collaboration_track_count: int
    community_id: str


class UniverseEdge(BaseModel):
    id: str
    source: str
    target: str
    weight: float
    shared_playlist_count: int
    collaboration_track_count: int


class UniverseCommunity(BaseModel):
    id: str
    artist_count: int
    representative_artists: list[str] = Field(default_factory=list)


class InsightsUniverseResponse(BaseModel):
    profile_state: Literal["current", "missing_or_stale"]
    node_metric: Literal["canonical_library_affinity"] = "canonical_library_affinity"
    node_cap: int
    edge_cap: int
    per_node_edge_cap: int
    nodes: list[UniverseNode] = Field(default_factory=list)
    edges: list[UniverseEdge] = Field(default_factory=list)
    communities: list[UniverseCommunity] = Field(default_factory=list)
    formulas: dict[str, str] = Field(default_factory=dict)
    timings_ms: dict[str, int] = Field(default_factory=dict)


class PlaylistInsight(BaseModel):
    id: str
    name: str
    artwork_url: str | None = None
    track_count: int
    distinct_artist_count: int
    distinct_album_count: int
    multi_artist_track_count: int
    leading_artist_track_share: float
    unique_library_coverage: float


class PlaylistOverlap(BaseModel):
    source_playlist_id: str
    source_playlist_name: str
    source_track_count: int
    target_playlist_id: str
    target_playlist_name: str
    target_track_count: int
    shared_track_count: int
    jaccard_similarity: float


class InsightsPlaylistsResponse(BaseModel):
    playlists: list[PlaylistInsight] = Field(default_factory=list)
    strongest_overlaps: list[PlaylistOverlap] = Field(default_factory=list)
    similarity_formula: str
    uniqueness_formula: str
    timings_ms: dict[str, int] = Field(default_factory=dict)


class RediscoveryInsight(BaseModel):
    id: str
    title: str
    subtitle: str | None = None
    artwork_url: str | None = None
    score: float
    explanation: str
    strategy: str
    is_in_library: bool = True


class InsightsRediscoveryResponse(BaseModel):
    profile_state: Literal["current", "missing_or_stale"]
    semantics: str
    items: list[RediscoveryInsight] = Field(default_factory=list)
    timings_ms: dict[str, int] = Field(default_factory=dict)
