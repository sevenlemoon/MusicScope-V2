"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiRequestError, apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { RecommendationCard, recommendationKey } from "@/components/RecommendationCard";

type DiscoverData = components["schemas"]["DiscoverRecommendationsResponse"];
type Recommendation = components["schemas"]["RecommendationItem"];

const CATEGORIES = [
  ["for-you", "For You", "Balanced across affinity and adjacency."],
  ["artists", "Artists", "Your strongest artist-level evidence."],
  ["albums", "Albums", "Album coverage with related artist support."],
  ["tracks", "Tracks", "Playable selections from your collection."],
  ["adjacent", "Adjacent", "Playlist and collaboration neighbors."],
  ["rediscover", "Rediscover", "Saved music outside the obvious repeats."],
  ["hidden-gems", "Hidden Gems", "Saved once; supported by your profile."],
  ["explore", "Explore", "More distance, still with an evidence path."],
  ["external", "New", "Unsaved tracks from evidence-backed artist catalogs."],
] as const;

export function DiscoverExperience() {
  const [category, setCategory] = useState("for-you");
  const [data, setData] = useState<DiscoverData | null>(null);
  const [exploration, setExploration] = useState(50);
  const [loading, setLoading] = useState(true);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (nextCategory: string) => {
    setLoading(true);
    try {
      const result = await apiRequest<DiscoverData>(`/api/v1/recommendations/discover?category=${nextCategory}&limit=24`);
      setData(result);
      setExploration(result.exploration_level);
      setNeedsProfile(false);
    } catch (reason) {
      setNeedsProfile(reason instanceof ApiRequestError && (reason.status === 404 || reason.status === 409));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void apiRequest<DiscoverData>(`/api/v1/recommendations/discover?category=${category}&limit=24`)
      .then((result) => {
        setData(result);
        setExploration(result.exploration_level);
        setNeedsProfile(false);
      })
      .catch((reason: unknown) => {
        setNeedsProfile(reason instanceof ApiRequestError && (reason.status === 404 || reason.status === 409));
      })
      .finally(() => setLoading(false));
  }, [category]);

  const chooseCategory = (value: string) => {
    setLoading(true);
    setCategory(value);
  };

  const persistExploration = async () => {
    await apiRequest("/api/v1/recommendations/settings", {
      method: "PATCH",
      body: JSON.stringify({ exploration_level: exploration }),
    });
    await load(category);
  };

  const refreshDiscovery = async () => {
    setRefreshing(true);
    try {
      await apiRequest("/api/v1/recommendations/candidates/refresh", { method: "POST" });
      await load(category);
    } finally {
      setRefreshing(false);
    }
  };

  const remove = (removed: Recommendation) => setData((current) => current ? {
    ...current,
    items: (current.items ?? []).filter((item) => recommendationKey(item) !== recommendationKey(removed)),
  } : current);

  return <div className="discover-experience">
    <header className="discover-hero">
      <p className="eyebrow">DISCOVER / EVIDENCE WITH RANGE</p>
      <h1>Move through<br />your music map.</h1>
      <p>Choose how close MusicScope stays to your strongest library signals. Exploratory still means connected—not random.</p>
    </header>
    <div className="discover-layout">
      <aside className="discover-controls">
        <div className="exploration-control">
          <div><span>Familiar</span><strong>{exploration}</strong><span>Exploratory</span></div>
          <input aria-label="Familiar to Exploratory" type="range" min="0" max="100" value={exploration} onChange={(event) => setExploration(Number(event.target.value))} onPointerUp={() => void persistExploration()} onKeyUp={() => void persistExploration()} />
          <p>This preference changes the affinity-to-adjacency mix.</p>
        </div>
        <nav aria-label="Recommendation categories">
          {CATEGORIES.map(([value, label, description]) => <button key={value} type="button" aria-current={category === value ? "page" : undefined} onClick={() => chooseCategory(value)}><strong>{label}</strong><span>{description}</span></button>)}
        </nav>
        {data && <div className="candidate-note"><strong>{data.candidate_counts?.external_discovery ?? 0} outside-library candidates</strong><br /><span>{data.external_state === "fresh" ? "Fresh provider catalog evidence." : data.external_state === "partial" ? "Partial refresh; verified candidates remain usable." : data.external_state === "stale" ? "Using a stale verified cache while refresh is unavailable." : data.external_state === "no_candidates" ? "No sufficiently strong unsaved candidates found." : "Provider discovery has not been refreshed."}</span><button className="button button-quiet" type="button" disabled={refreshing} onClick={() => void refreshDiscovery()}>{refreshing ? "Refreshing…" : "Refresh discovery"}</button></div>}
      </aside>
      <section className="discover-results" aria-live="polite">
        <div className="discover-results-heading"><div><p className="eyebrow">CURRENT LENS</p><h2>{CATEGORIES.find(([value]) => value === category)?.[1]}</h2></div><span>{data?.items?.length ?? 0} diversified results</span></div>
        {needsProfile ? <div className="recommendation-inline-empty">Build your taste profile from Home before exploring recommendations.</div> : loading ? <div className="recommendation-loading compact"><span /><p>Ranking real candidates…</p></div> : data?.items?.length ? <div className="recommendation-grid discover-grid">{data.items.map((item) => <RecommendationCard key={recommendationKey(item)} item={item} onFeedback={remove} />)}</div> : <div className="recommendation-inline-empty">{category === "external" && data?.external_state === "unavailable" ? "NetEase discovery is unavailable. Saved recommendations remain available." : category === "external" ? "No sufficiently strong unsaved candidates match this lens yet." : "No evidence-backed candidates match this lens yet."}</div>}
      </section>
    </div>
  </div>;
}
