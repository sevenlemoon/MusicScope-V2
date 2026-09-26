"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { usePlayer } from "@/components/PlayerProvider";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";
import { evidenceLabel, recommendationExplanation } from "@/lib/recommendation-copy";

type Recommendation = components["schemas"]["RecommendationItem"];

export function ExternalTrackExperience({ provider, providerId }: { provider: string; providerId: string }) {
  const t = useText();
  const [item, setItem] = useState<Recommendation | null>(null);
  const [failed, setFailed] = useState(false);
  const player = usePlayer();

  useEffect(() => {
    apiRequest<Recommendation>(`/api/v1/recommendations/external/${provider}/tracks/${providerId}`)
      .then(setItem)
      .catch(() => setFailed(true));
  }, [provider, providerId]);

  if (failed) return <section className="entity-empty"><span className="entity-token">{t("NEW", "新")}</span><div><p className="eyebrow">{t("DISCOVER / PROVIDER PREVIEW", "发现 / 来源预览")}</p><h1>{t("This recommendation is unavailable.", "此推荐暂不可用。")}</h1><p>{t("The cached provider candidate may have expired. Your saved library was not changed.", "来源缓存可能已过期；已收藏资料库没有变化。")}</p><Link className="button button-quiet" href="/discover">{t("Back to Discover", "返回发现")}</Link></div></section>;
  if (!item?.external_track) return <div className="recommendation-loading"><span /><p>{t("Loading provider preview…", "正在读取来源预览…")}</p></div>;

  const track = item.external_track;
  const activeId = `provider:${track.provider}:track:${track.provider_id}`;
  const active = player.current?.id === activeId;
  return <div className="external-detail">
    <header className="external-detail-hero">
      <Artwork src={track.artwork_url} alt={`${track.title} artwork`} className="external-detail-artwork" />
      <div>
        <p className="eyebrow">{t("DISCOVER / NEW TO YOUR LIBRARY", "发现 / 资料库之外")}</p>
        <h1>{track.title}</h1>
        <p className="external-detail-artists">{(track.artists ?? []).map((artist) => artist.name).join(" · ") || t("Unknown artist", "未知艺人")}</p>
        {track.album && <p>{track.album.title}</p>}
        <p className="recommendation-explanation">{recommendationExplanation(item, t("en", "zh") === "zh" ? "zh" : "en")}</p>
        <div className="action-row"><button className="button button-primary" type="button" onClick={() => void (active ? player.toggle() : player.playExternalTrack(track))}>{active && player.status === "playing" ? t("Pause", "暂停") : t("Play from NetEase", "从网易云音乐播放")}</button><Link className="button button-quiet" href="/discover">{t("Back to Discover", "返回发现")}</Link></div>
      </div>
    </header>
    <section className="external-boundary"><p className="eyebrow">{t("PROVIDER PREVIEW / READ ONLY", "来源预览 / 只读")}</p><h2>{t("Not currently saved", "尚未收藏")}</h2><p>{t("This metadata is cached for recommendation display only. Opening or playing it does not add it to MusicScope or change your NetEase account.", "这些资料仅缓存用于展示推荐。打开或播放不会将其加入 MusicScope，也不会修改网易云音乐账号。")}</p><div className="recommendation-evidence">{(item.evidence ?? []).map((evidence) => <span key={evidence.code}>{evidenceLabel(evidence.code, evidence.label, t("en", "zh") === "zh" ? "zh" : "en")}: {evidence.value}</span>)}</div></section>
  </div>;
}
