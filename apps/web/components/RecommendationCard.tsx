"use client";

import Link from "next/link";
import { useState } from "react";

import { Artwork } from "@/components/Artwork";
import { usePlayer } from "@/components/PlayerProvider";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useLocale } from "./LocaleProvider";
import { evidenceLabel, recommendationExplanation } from "@/lib/recommendation-copy";

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
  priority = false,
}: {
  item: Recommendation;
  onFeedback?: (item: Recommendation) => void;
  priority?: boolean;
}) {
  const player = usePlayer();
  const { locale, provided } = useLocale();
  const zh = provided && locale === "zh";
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
    <Link href={entityHref(item)} aria-label={`${zh ? "打开 " : "Open "}${item.title}`} className="recommendation-artwork-link">
      <Artwork src={item.artwork_url} alt={`${item.title} artwork`} className="recommendation-artwork" eager={priority} />
      <span className={`recommendation-kind ${item.is_in_library ? "is-saved" : "is-new"}`}>{item.is_in_library ? (zh ? "已收藏" : "Saved") : (zh ? "资料库之外" : "New to your library")}</span>
      {(item.track || item.external_track) && <span className="recommendation-play-overlay" aria-hidden="true">▶</span>}
    </Link>
    <div className="recommendation-copy">
      <div className="recommendation-meta">
        <span>{zh ? ({ REDISCOVER: "重新发现", ARTIST_AFFINITY: "资料库亲和度", ALBUM_AFFINITY: "专辑亲和度", CO_OCCURRENCE: "共同语境", ADJACENT_ARTIST: "相邻艺人", EXPLORATION: "隐藏曲目", EXTERNAL_ARTIST_CATALOG: "探索", EXTERNAL_COLLABORATION: "合作" } as Record<Recommendation["strategy"], string>)[item.strategy] : STRATEGY_LABELS[item.strategy]}</span>
        <span>{zh ? ({ strong: "充分", developing: "逐步积累", light: "有限" } as Record<string, string>)[item.confidence_label.toLowerCase()] ?? item.confidence_label : item.confidence_label} {zh ? "证据" : "evidence"}</span>
      </div>
      <Link href={entityHref(item)} className="recommendation-title">{item.title}</Link>
      {item.subtitle && <p className="recommendation-subtitle">{item.subtitle}</p>}
      <p className="recommendation-explanation">{recommendationExplanation(item, zh ? "zh" : "en")}</p>
      <div className="recommendation-evidence" aria-label={`${zh ? "证据：" : "Evidence for "}${item.title}`}>
        {(item.evidence ?? []).slice(0, 2).map((evidence) => <span key={evidence.code} title={evidenceLabel(evidence.code, evidence.label, zh ? "zh" : "en")}>
          {evidenceLabel(evidence.code, evidence.label, zh ? "zh" : "en")}: {evidence.value}
        </span>)}
      </div>
    </div>
    <div className="recommendation-actions">
      {(item.track || item.external_track) && <button type="button" onClick={() => void (active ? player.toggle() : item.external_track ? player.playExternalTrack(item.external_track) : player.playTrack(item.track!))} aria-label={`${active && player.status === "playing" ? (zh ? "暂停 " : "Pause ") : (zh ? "播放 " : "Play ")}${item.title}`}>
        {active && player.status === "playing" ? "Ⅱ" : "▶"}
      </button>}
        <Link href={entityHref(item)} aria-label={`${zh ? "打开详情：" : "View details for "}${item.title}`}>{zh ? "打开" : "Open"}</Link>
      <button type="button" disabled={saving !== null} onClick={() => void feedback("LIKE")} aria-label={`${zh ? "喜欢 " : "Like "}${item.title}`}>♥</button>
      <button type="button" disabled={saving !== null} onClick={() => void feedback("NOT_INTERESTED")} aria-label={`${zh ? "不感兴趣：" : "Not interested in "}${item.title}`}>×</button>
    </div>
  </article>;
}
