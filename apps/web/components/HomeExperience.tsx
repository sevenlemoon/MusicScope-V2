"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ApiRequestError, apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { RecommendationCard, recommendationKey } from "@/components/RecommendationCard";
import { HomeLiveTeaser } from "@/components/LiveExperience";
import { useLocale } from "./LocaleProvider";

type HomeData = components["schemas"]["HomeRecommendationsResponse"];
type Profile = components["schemas"]["RecommendationProfileResponse"];
type Recommendation = components["schemas"]["RecommendationItem"];
type LibrarySummary = components["schemas"]["LibrarySummary"];

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
  const { locale, provided } = useLocale();
  const zh = provided && locale === "zh";
  const visibleItems = items.slice(0, 4);
  return <section className="recommendation-section">
    <div className="recommendation-section-heading">
      <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{body}</p></div>
      <span>{visibleItems.length.toString().padStart(2, "0")} {zh ? "精选" : "selections"}</span>
    </div>
    {visibleItems.length ? <div className="recommendation-grid">
      {visibleItems.map((item, index) => <RecommendationCard key={recommendationKey(item)} item={item} onFeedback={onFeedback} priority={index === 0} />)}
    </div> : <p className="recommendation-inline-empty">{zh ? "这一部分暂时没有有据可循的推荐。" : "No evidence-backed selections are available in this section yet."}</p>}
  </section>;
}

export function HomeExperience() {
  const { locale, provided } = useLocale();
  const zh = provided && locale === "zh";
  const [data, setData] = useState<HomeData | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [emptyLibrary, setEmptyLibrary] = useState(false);
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
      setEmptyLibrary(false);
    } catch (reason) {
      const status = reason instanceof ApiRequestError ? reason.status : 0;
      setNeedsProfile(status === 404 || status === 409);
      setError(status !== 404 && status !== 409);
      if (status === 404 || status === 409) {
        const summary = await apiRequest<LibrarySummary>("/api/v1/library/summary").catch(() => null);
        setEmptyLibrary(Boolean(summary && !Object.values(summary.counts).some(Boolean)));
      }
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
      setEmptyLibrary(false);
    }).catch(async (reason: unknown) => {
      const status = reason instanceof ApiRequestError ? reason.status : 0;
      setNeedsProfile(status === 404 || status === 409);
      setError(status !== 404 && status !== 409);
      if (status === 404 || status === 409) {
        const summary = await apiRequest<LibrarySummary>("/api/v1/library/summary").catch(() => null);
        setEmptyLibrary(Boolean(summary && !Object.values(summary.counts).some(Boolean)));
      }
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

  if (loading) return <div className="recommendation-loading"><span /><p>{zh ? "正在读取音乐资料…" : "Reading your music profile…"}</p></div>;
  if (needsProfile && emptyLibrary) return <section className="recommendation-setup"><p className="eyebrow">{zh ? "首页 / 开始使用" : "HOME / GET STARTED"}</p><h1>{zh ? "先连接你的音乐资料库。" : "Connect your music library first."}</h1><p>{zh ? "连接网易云音乐并以只读方式同步收藏后，就能建立资料库画像与有据可循的推荐。" : "Connect NetEase and synchronize your saved library read-only, then build a library profile for evidence-backed recommendations."}</p><Link className="button button-primary" href="/connect">{zh ? "连接音乐" : "Connect music"}</Link></section>;
  if (needsProfile) return <section className="recommendation-setup">
    <p className="eyebrow">{zh ? "资料库画像 / 手动建立" : "PROFILE / EXPLICIT BUILD"}</p>
    <h1>{zh ? "把你的资料库变成清晰的音乐视角。" : "Turn your library into a point of view."}</h1>
    <p>{zh ? "MusicScope 需要先生成资料库画像，推荐只读取已同步的真实收藏。" : "MusicScope needs a materialized taste profile before it can make evidence-backed recommendations. This build reads only your synchronized library."}</p>
    <button className="button button-primary" type="button" onClick={() => void rebuild()} disabled={building}>{building ? (zh ? "正在生成画像…" : "Building profile…") : (zh ? "生成我的资料库画像" : "Build my taste profile")}</button>
  </section>;
  if (error || !data || !profile) return <section className="recommendation-setup"><p className="eyebrow">{zh ? "首页 / 暂不可用" : "HOME / UNAVAILABLE"}</p><h1>{zh ? "推荐暂时无法读取。" : "Your recommendations could not load."}</h1><button className="button button-quiet" type="button" onClick={() => void load()}>{zh ? "重试" : "Try again"}</button></section>;

  return <div className="personal-home">
    <header className="personal-hero">
      <div>
        <p className="eyebrow">{zh ? "首页 / 你的音乐关系" : "HOME / YOUR MUSIC, IN CONTEXT"}</p>
        <h1>{zh ? <>听见自己的<br />音乐轨道。</> : <>Listen inside<br />your own orbit.</>}</h1>
        <p>{zh ? <>推荐来自 {profile.track_count.toLocaleString()} 首收藏曲目、{profile.artist_count.toLocaleString()} 位艺人，以及资料库中真实存在的关系。</> : <>Recommendations grounded in {profile.track_count.toLocaleString()} saved tracks, {profile.artist_count.toLocaleString()} artists, and the relationships already present in your collection.</>}</p>
        <div className="action-row"><Link className="button button-primary" href="/discover">{zh ? "探索推荐" : "Explore recommendations"}</Link><Link className="button button-quiet" href="/library">{zh ? "打开资料库" : "Open library"}</Link></div>
      </div>
      <div className="profile-orbit" aria-label={zh ? "资料库画像摘要" : "Library profile summary"}>
        <span className="profile-orbit-core">{profile.artist_count.toLocaleString()}<small>{zh ? "艺人" : "artists"}</small></span>
        <i /><i /><i />
        <p>{profile.relationship_count.toLocaleString()} {zh ? "条有证据的关系" : "evidence-bearing connections"}</p>
      </div>
    </header>
    <RecommendationSection eyebrow={zh ? "为你准备 / 多样入口" : "MADE FOR YOU / DIVERSE MIX"} title={zh ? "从这里开始" : "A place to start"} body={zh ? "来自真实资料库的曲目、艺人与相邻信号。" : "A balanced set of tracks, artists, albums, and adjacent signals from your real library."} items={data.made_for_you ?? []} onFeedback={remove} />
    <RecommendationSection eyebrow={zh ? "重新发现 / 已经收藏" : "REDISCOVER / ALREADY YOURS"} title={zh ? "再听一遍" : "Look again"} body={zh ? "来自资料库中有充分支持、但当前画像代表性较低的收藏。" : "Underrepresented tracks from artists and albums that have meaningful support in your collection."} items={data.rediscover ?? []} onFeedback={remove} />
    <section className="future-teasers">
      <HomeLiveTeaser />
      <article><p className="eyebrow">{zh ? "洞察预览" : "INSIGHTS PREVIEW"}</p><h3>{zh ? `${profile.playlist_count} 个歌单塑造了这份资料库画像` : `${profile.playlist_count} playlists shape this profile`}</h3><p>{zh ? `最大歌单有 ${profile.largest_playlist.toLocaleString()} 首曲目，按每条收录归一化为 ${profile.largest_playlist_weight.toFixed(3)}。` : `Your largest playlist has ${profile.largest_playlist.toLocaleString()} tracks and is normalized to ${profile.largest_playlist_weight.toFixed(3)} per membership.`}</p><Link className="text-link" href="/insights">{zh ? "查看音乐宇宙 →" : "Open Music Universe →"}</Link></article>
      <article><p className="eyebrow">{zh ? "工作室 / 本地音频" : "STUDIO / LOCAL AUDIO"}</p><h3>{zh ? "探索声音的四个声部" : "Explore sound in four stems"}</h3><p>{zh ? "上传本地音频，生成可同步播放的人声、鼓组、贝斯与其他声部。" : "Upload an audio file you own and explore synchronized vocals, drums, bass, and other stems."}</p><Link className="text-link" href="/studio">{zh ? "打开工作室 →" : "Open Studio →"}</Link></article>
    </section>
  </div>;
}
