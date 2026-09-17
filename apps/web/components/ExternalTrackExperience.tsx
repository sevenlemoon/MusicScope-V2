"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { usePlayer } from "@/components/PlayerProvider";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";

type Recommendation = components["schemas"]["RecommendationItem"];

export function ExternalTrackExperience({ provider, providerId }: { provider: string; providerId: string }) {
  const [item, setItem] = useState<Recommendation | null>(null);
  const [failed, setFailed] = useState(false);
  const player = usePlayer();

  useEffect(() => {
    apiRequest<Recommendation>(`/api/v1/recommendations/external/${provider}/tracks/${providerId}`)
      .then(setItem)
      .catch(() => setFailed(true));
  }, [provider, providerId]);

  if (failed) return <section className="entity-empty"><span className="entity-token">NEW</span><div><p className="eyebrow">DISCOVER / PROVIDER PREVIEW</p><h1>This recommendation is unavailable.</h1><p>The cached provider candidate may have expired. Your saved library was not changed.</p><Link className="button button-quiet" href="/discover">Back to Discover</Link></div></section>;
  if (!item?.external_track) return <div className="recommendation-loading"><span /><p>Loading provider preview…</p></div>;

  const track = item.external_track;
  const activeId = `provider:${track.provider}:track:${track.provider_id}`;
  const active = player.current?.id === activeId;
  return <div className="external-detail">
    <header className="external-detail-hero">
      <Artwork src={track.artwork_url} alt={`${track.title} artwork`} className="external-detail-artwork" />
      <div>
        <p className="eyebrow">DISCOVER / NEW TO YOUR LIBRARY</p>
        <h1>{track.title}</h1>
        <p className="external-detail-artists">{(track.artists ?? []).map((artist) => artist.name).join(" · ") || "Unknown artist"}</p>
        {track.album && <p>{track.album.title}</p>}
        <p className="recommendation-explanation">{item.explanation}</p>
        <div className="action-row"><button className="button button-primary" type="button" onClick={() => void (active ? player.toggle() : player.playExternalTrack(track))}>{active && player.status === "playing" ? "Pause" : "Play from NetEase"}</button><Link className="button button-quiet" href="/discover">Back to Discover</Link></div>
      </div>
    </header>
    <section className="external-boundary"><p className="eyebrow">PROVIDER PREVIEW / READ ONLY</p><h2>Not currently saved</h2><p>This metadata is cached for recommendation display only. Opening or playing it does not add it to MusicScope or change your NetEase account.</p><div className="recommendation-evidence">{(item.evidence ?? []).map((evidence) => <span key={evidence.code}>{evidence.label}: {evidence.value}</span>)}</div></section>
  </div>;
}
