"use client";

import Link from "next/link";
import { useState } from "react";

import { Artwork } from "@/components/Artwork";
import { usePlayer } from "@/components/PlayerProvider";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";

type Recommendation = components["schemas"]["RecommendationItem"];

const STRATEGY_LABELS: Record<Recommendation["strategy"], string> = {
  REDISCOVER: "Rediscover",
  ARTIST_AFFINITY: "Strong affinity",
  ALBUM_AFFINITY: "Album affinity",
  CO_OCCURRENCE: "Shared context",
  ADJACENT_ARTIST: "Adjacent artist",
  EXPLORATION: "Hidden gem",
  EXTERNAL_ARTIST_CATALOG: "Explore",
  EXTERNAL_COLLABORATION: "Collaboration",
};

function entityHref(item: Recommendation) {
  if (item.source === "netease_external" && item.provider_identity) {
    return `/discover/${item.entity_type}/${item.provider_identity.provider}/${item.provider_identity.provider_id}`;
  }
  return `/${item.entity_type}/${item.canonical_entity_id}`;
}

export function recommendationKey(item: Recommendation) {
  if (item.provider_identity) return `provider:${item.provider_identity.provider}:${item.provider_identity.entity_type}:${item.provider_identity.provider_id}`;
  return `canonical:${item.canonical_entity_id}`;
}

export function RecommendationCard({
  item,
  onFeedback,
}: {
  item: Recommendation;
  onFeedback?: (item: Recommendation) => void;
}) {
  const player = usePlayer();
  const [saving, setSaving] = useState<"LIKE" | "NOT_INTERESTED" | null>(null);
  const externalPlayerId = item.external_track ? `provider:${item.external_track.provider}:track:${item.external_track.provider_id}` : null;
  const active = Boolean((item.track && player.current?.id === item.track.id) || (externalPlayerId && player.current?.id === externalPlayerId));

  const feedback = async (feedbackType: "LIKE" | "NOT_INTERESTED") => {
    setSaving(feedbackType);
    try {
      await apiRequest("/api/v1/recommendations/feedback", {
        method: "POST",
        body: JSON.stringify({
          entity_type: item.entity_type,
          ...(item.provider_identity ? { provider_identity: item.provider_identity } : { canonical_entity_id: item.canonical_entity_id }),
          strategy: item.strategy,
          feedback_type: feedbackType,
        }),
      });
      if (feedbackType === "NOT_INTERESTED") onFeedback?.(item);
    } finally {
      setSaving(null);
    }
  };

  return <article className="recommendation-card" data-strategy={item.strategy}>
    <Link href={entityHref(item)} aria-label={`Open ${item.title}`} className="recommendation-artwork-link">
      <Artwork src={item.artwork_url} alt={`${item.title} artwork`} className="recommendation-artwork" />
      <span className={`recommendation-kind ${item.is_in_library ? "is-saved" : "is-new"}`}>{item.is_in_library ? "Saved" : "New to your library"}</span>
      {(item.track || item.external_track) && <span className="recommendation-play-overlay" aria-hidden="true">▶</span>}
    </Link>
    <div className="recommendation-copy">
      <div className="recommendation-meta">
        <span>{STRATEGY_LABELS[item.strategy]}</span>
        <span>{item.confidence_label} evidence</span>
      </div>
      <Link href={entityHref(item)} className="recommendation-title">{item.title}</Link>
      {item.subtitle && <p className="recommendation-subtitle">{item.subtitle}</p>}
      <p className="recommendation-explanation">{item.explanation}</p>
      <div className="recommendation-evidence" aria-label={`Evidence for ${item.title}`}>
        {(item.evidence ?? []).slice(0, 2).map((evidence) => <span key={evidence.code} title={evidence.label}>
          {evidence.label}: {evidence.value}
        </span>)}
      </div>
    </div>
    <div className="recommendation-actions">
      {(item.track || item.external_track) && <button type="button" onClick={() => void (active ? player.toggle() : item.external_track ? player.playExternalTrack(item.external_track) : player.playTrack(item.track!))} aria-label={`${active && player.status === "playing" ? "Pause" : "Play"} ${item.title}`}>
        {active && player.status === "playing" ? "Ⅱ" : "▶"}
      </button>}
      <Link href={entityHref(item)} aria-label={`View details for ${item.title}`}>Open</Link>
      <button type="button" disabled={saving !== null} onClick={() => void feedback("LIKE")} aria-label={`Like ${item.title}`}>♥</button>
      <button type="button" disabled={saving !== null} onClick={() => void feedback("NOT_INTERESTED")} aria-label={`Not interested in ${item.title}`}>×</button>
    </div>
  </article>;
}
