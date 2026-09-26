"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiRequestError, apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { RecommendationCard, recommendationKey } from "@/components/RecommendationCard";
import { useText } from "./LocaleProvider";

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

const CATEGORY_ZH: Record<string, [string, string]> = {
  "for-you": ["为你推荐", "平衡资料库亲和度与相邻关系。"],
  artists: ["艺人", "资料库中证据最强的艺人。"],
  albums: ["专辑", "专辑收录与相关艺人证据。"],
  tracks: ["曲目", "资料库中可播放的曲目。"],
  adjacent: ["相邻关系", "歌单与合作关系中的邻近音乐。"],
  rediscover: ["重新发现", "值得再听的已收藏音乐。"],
  "hidden-gems": ["隐藏曲目", "收藏过且有资料库画像支持的曲目。"],
  explore: ["继续探索", "距离更远，但仍有证据路径。"],
  external: ["新发现", "来自相关艺人目录的未收藏曲目。"],
};

export function DiscoverExperience() {
  const t = useText();
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
      <p className="eyebrow">{t("DISCOVER / EVIDENCE WITH RANGE", "发现 / 有据可循")}</p>
      <h1>{t("Move through your music map.", "沿着音乐关系，继续探索。")}</h1>
      <p>{t("Choose how close MusicScope stays to your strongest library signals. Exploratory still means connected—not random.", "选择推荐与资料库最强信号的距离。探索仍有真实关系作为依据，并非随机推荐。")}</p>
    </header>
    <div className="discover-layout">
      <aside className="discover-controls">
        <div className="exploration-control">
          <div><span>{t("Familiar", "熟悉")}</span><strong>{exploration}</strong><span>{t("Exploratory", "探索")}</span></div>
          <input aria-label={t("Familiar to Exploratory", "从熟悉到探索")} type="range" min="0" max="100" value={exploration} onChange={(event) => setExploration(Number(event.target.value))} onPointerUp={() => void persistExploration()} onKeyUp={() => void persistExploration()} />
          <p>{t("This preference changes the affinity-to-adjacency mix.", "此偏好会调整资料库亲和度与相邻关系的比例。")}</p>
        </div>
        <nav aria-label={t("Recommendation categories", "推荐分类")}>
          {CATEGORIES.map(([value, label, description]) => <button key={value} type="button" aria-current={category === value ? "page" : undefined} onClick={() => chooseCategory(value)}><strong>{t(label, CATEGORY_ZH[value][0])}</strong><span>{t(description, CATEGORY_ZH[value][1])}</span></button>)}
        </nav>
        {data && <div className="candidate-note"><strong>{data.candidate_counts?.external_discovery ?? 0} {t("outside-library candidates", "个资料库之外的候选")}</strong><br /><span>{data.external_state === "fresh" ? t("Fresh provider catalog evidence.", "提供方目录证据已更新。") : data.external_state === "partial" ? t("Partial refresh; verified candidates remain usable.", "部分更新；已验证候选仍可使用。") : data.external_state === "stale" ? t("Using a stale verified cache while refresh is unavailable.", "更新暂不可用，正在使用已验证缓存。") : data.external_state === "no_candidates" ? t("No sufficiently strong unsaved candidates found.", "暂未找到证据充分的未收藏候选。") : t("Provider discovery has not been refreshed.", "尚未更新提供方发现结果。")}</span><button className="button button-quiet" type="button" disabled={refreshing} onClick={() => void refreshDiscovery()}>{refreshing ? t("Refreshing…", "正在更新…") : t("Refresh discovery", "更新发现结果")}</button></div>}
      </aside>
      <section className="discover-results" aria-live="polite">
        <div className="discover-results-heading"><div><p className="eyebrow">{t("CURRENT LENS", "当前视角")}</p><h2>{t(CATEGORIES.find(([value]) => value === category)?.[1] ?? "", CATEGORY_ZH[category]?.[0] ?? "")}</h2></div><span>{data?.items?.length ?? 0} {t("diversified results", "条多样结果")}</span></div>
        {needsProfile ? <div className="recommendation-inline-empty">{t("Connect and synchronize a library, then build its profile from Home before exploring recommendations.", "请先连接并同步资料库，再从首页建立资料库画像。")}</div> : loading ? <div className="recommendation-loading compact"><span /><p>{t("Ranking real candidates…", "正在排列真实候选…")}</p></div> : data?.items?.length ? <div className="recommendation-grid discover-grid">{data.items.map((item, index) => <RecommendationCard key={recommendationKey(item)} item={item} onFeedback={remove} priority={index === 0} />)}</div> : <div className="recommendation-inline-empty">{category === "external" && data?.external_state === "unavailable" ? t("NetEase discovery is unavailable. Saved recommendations remain available.", "网易云发现服务暂不可用；已收藏的推荐仍可使用。") : category === "external" ? t("No sufficiently strong unsaved candidates match this lens yet.", "当前视角下暂无证据充分的未收藏候选。") : t("No evidence-backed candidates match this lens yet.", "当前视角下暂无有证据支持的候选。")}</div>}
      </section>
    </div>
  </div>;
}
