"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ApiRequestError, apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { RecommendationCard, recommendationKey } from "@/components/RecommendationCard";

type HomeData = components["schemas"]["HomeRecommendationsResponse"];
type Profile = components["schemas"]["RecommendationProfileResponse"];
type Recommendation = components["schemas"]["RecommendationItem"];

function RecommendationSection({
  eyebrow,
  title,
  body,
  items,
  onFeedback,
}: {
  eyebrow: string;
  title: string;
  body: string;
  items: Recommendation[];
  onFeedback: (item: Recommendation) => void;
}) {
  return <section className="recommendation-section">
    <div className="recommendation-section-heading">
      <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{body}</p></div>
      <span>{items.length.toString().padStart(2, "0")} selections</span>
    </div>
    {items.length ? <div className="recommendation-grid">
      {items.map((item) => <RecommendationCard key={recommendationKey(item)} item={item} onFeedback={onFeedback} />)}
    </div> : <p className="recommendation-inline-empty">No evidence-backed selections are available in this section yet.</p>}
  </section>;
}

export function HomeExperience() {
  const [data, setData] = useState<HomeData | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [home, taste] = await Promise.all([
        apiRequest<HomeData>("/api/v1/recommendations/home"),
        apiRequest<Profile>("/api/v1/recommendations/profile"),
      ]);
      setData(home);
      setProfile(taste);
      setNeedsProfile(false);
    } catch (reason) {
      const status = reason instanceof ApiRequestError ? reason.status : 0;
      setNeedsProfile(status === 404 || status === 409);
      setError(status !== 404 && status !== 409);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      apiRequest<HomeData>("/api/v1/recommendations/home"),
      apiRequest<Profile>("/api/v1/recommendations/profile"),
    ]).then(([home, taste]) => {
      setData(home);
      setProfile(taste);
      setNeedsProfile(false);
    }).catch((reason: unknown) => {
      const status = reason instanceof ApiRequestError ? reason.status : 0;
      setNeedsProfile(status === 404 || status === 409);
      setError(status !== 404 && status !== 409);
    }).finally(() => setLoading(false));
  }, []);

  const rebuild = async () => {
    setBuilding(true);
    try {
      await apiRequest("/api/v1/recommendations/profile/rebuild", { method: "POST" });
      await load();
    } finally {
      setBuilding(false);
    }
  };

  const remove = (removed: Recommendation) => setData((current) => current ? {
    ...current,
    made_for_you: (current.made_for_you ?? []).filter((item) => recommendationKey(item) !== recommendationKey(removed)),
    rediscover: (current.rediscover ?? []).filter((item) => recommendationKey(item) !== recommendationKey(removed)),
    strong_artists: (current.strong_artists ?? []).filter((item) => recommendationKey(item) !== recommendationKey(removed)),
    explore_next: (current.explore_next ?? []).filter((item) => recommendationKey(item) !== recommendationKey(removed)),
  } : current);

  if (loading) return <div className="recommendation-loading"><span /><p>Reading your music profile…</p></div>;
  if (needsProfile) return <section className="recommendation-setup">
    <p className="eyebrow">PROFILE / EXPLICIT BUILD</p>
    <h1>Turn your library into a point of view.</h1>
    <p>MusicScope needs a materialized taste profile before it can make evidence-backed recommendations. This build reads only your synchronized library.</p>
    <button className="button button-primary" type="button" onClick={() => void rebuild()} disabled={building}>{building ? "Building profile…" : "Build my taste profile"}</button>
  </section>;
  if (error || !data || !profile) return <section className="recommendation-setup"><p className="eyebrow">HOME / UNAVAILABLE</p><h1>Your recommendations could not load.</h1><button className="button button-quiet" type="button" onClick={() => void load()}>Try again</button></section>;

  return <div className="personal-home">
    <header className="personal-hero">
      <div>
        <p className="eyebrow">HOME / YOUR MUSIC, IN CONTEXT</p>
        <h1>Listen inside<br />your own orbit.</h1>
        <p>Recommendations grounded in {profile.track_count.toLocaleString()} saved tracks, {profile.artist_count.toLocaleString()} artists, and the relationships already present in your collection.</p>
        <div className="action-row"><Link className="button button-primary" href="/discover">Explore your profile</Link><Link className="button button-quiet" href="/library">Open library</Link></div>
      </div>
      <div className="profile-orbit" aria-label="Taste profile summary">
        <span className="profile-orbit-core">{profile.artist_count.toLocaleString()}<small>artists</small></span>
        <i /><i /><i />
        <p>{profile.relationship_count.toLocaleString()} evidence-bearing connections</p>
      </div>
    </header>
    <RecommendationSection eyebrow="MADE FOR YOU / DIVERSE MIX" title="A place to start" body="A balanced set of tracks, artists, albums, and adjacent signals from your real library." items={data.made_for_you ?? []} onFeedback={remove} />
    <RecommendationSection eyebrow="REDISCOVER / ALREADY YOURS" title="Look again" body="Underrepresented tracks from artists and albums that have meaningful support in your collection." items={data.rediscover ?? []} onFeedback={remove} />
    <RecommendationSection eyebrow="PROFILE / STRONGEST SIGNALS" title="Artists strongly represented" body="Raw track, playlist, and album evidence is normalized before affinity is derived." items={data.strong_artists ?? []} onFeedback={remove} />
    <RecommendationSection eyebrow="EXPLORE NEXT / NEW" title="Step outside the library" body={data.external_state === "stale" ? "Cached provider discoveries remain available while a refresh is delayed." : "Unsaved NetEase tracks reached through artists strongly represented in your collection."} items={data.explore_next ?? []} onFeedback={remove} />
    <section className="future-teasers">
      <article><p className="eyebrow">LIVE FOR YOU</p><h3>Coming in a later phase</h3><p>No concert events are invented here. Live recommendations will appear only when real event data is available.</p></article>
      <article><p className="eyebrow">INSIGHTS PREVIEW</p><h3>{profile.playlist_count} playlists shape this profile</h3><p>Your largest playlist has {profile.largest_playlist.toLocaleString()} tracks and is normalized to {profile.largest_playlist_weight.toFixed(3)} per membership.</p></article>
    </section>
  </div>;
}
