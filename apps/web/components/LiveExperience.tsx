"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

type LiveFeed = components["schemas"]["LiveFeedResponse"];
type LiveSearch = components["schemas"]["LiveSearchResponse"];
type LiveEvent = components["schemas"]["ConcertEventResponse"];
type LivePreference = components["schemas"]["LivePreferenceResponse"];
type Provider = components["schemas"]["ConcertProviderResponse"];
type DateFilter = "all" | "month" | "three_months";

export function EventCard({ event, priority = false }: { event: LiveEvent; priority?: boolean }) {
  const t = useText();
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric",
  }).format(new Date(`${event.start_date}T12:00:00`));
  const performers = (event.performers ?? []).map((performer) => performer.name).join(", ");
  return <article className="event-card">
    <Link className="event-artwork-link" href={`/live/events/${event.id}`}>
      <Artwork src={event.artwork_url} alt="" className="event-artwork" sizes="(max-width: 767px) 100vw, 33vw" eager={priority} />
      <span className="event-date-token"><strong>{date.split(" ")[1]?.replace(",", "")}</strong><small>{date.split(" ")[0]}</small></span>
    </Link>
    <div className="event-card-copy">
      <div className="event-card-meta"><span>{event.city || event.country || t("Location pending", "地点待确认")}</span>{event.status && <span>{statusLabel(event.status)}</span>}</div>
      <Link className="event-card-title" href={`/live/events/${event.id}`}>{event.title}</Link>
      <p>{performers || event.primary_artist_name || t("Performer details pending", "演出艺人待确认")}</p>
      <div className="event-venue"><span>{event.venue_name || t("Venue to be announced", "场馆待公布")}</span><span>{formatEventTime(event, t("en", "zh") === "zh" ? "zh" : "en")}</span></div>
      {event.explanation && <p className="event-reason">{event.explanation}</p>}
    </div>
  </article>;
}

export function LiveExperience() {
  const t = useText();
  const [feed, setFeed] = useState<LiveFeed | null>(null);
  const [search, setSearch] = useState<LiveSearch | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [preference, setPreference] = useState<LivePreference>({ country: null, city: null });
  const [query, setQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const filterQuery = useMemo(() => {
    const params = new URLSearchParams({ date_filter: dateFilter });
    if (preference.country) params.set("country", preference.country);
    if (preference.city) params.set("city", preference.city);
    return params.toString();
  }, [dateFilter, preference.city, preference.country]);

  useEffect(() => {
    Promise.all([
      apiRequest<LiveFeed>("/api/v1/live"),
      apiRequest<LivePreference>("/api/v1/live/preferences"),
      apiRequest<Provider[]>("/api/v1/live/providers"),
    ]).then(([nextFeed, nextPreference, nextProviders]) => {
      setFeed(nextFeed);
      setPreference(nextPreference);
      setProviders(nextProviders);
      const initialQuery = new URLSearchParams(window.location.search).get("q")?.trim();
      if (initialQuery) {
        setQuery(initialQuery);
        setSearching(true);
        const params = new URLSearchParams({ date_filter: "all", query: initialQuery });
        if (nextPreference.country) params.set("country", nextPreference.country);
        if (nextPreference.city) params.set("city", nextPreference.city);
        void apiRequest<LiveSearch>(`/api/v1/live/search?${params}`)
          .then(setSearch)
          .catch(() => setFailed(true))
          .finally(() => setSearching(false));
      }
    }).catch(() => setFailed(true)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (loading || search) return;
    apiRequest<LiveFeed>(`/api/v1/live?${filterQuery}`).then(setFeed).catch(() => setFailed(true));
  }, [filterQuery, loading, search]);

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault();
    const clean = query.trim();
    if (!clean) return;
    setSearching(true);
    setFailed(false);
    replaceSearchQuery(clean);
    try {
      const params = new URLSearchParams(filterQuery);
      params.set("query", clean);
      setSearch(await apiRequest<LiveSearch>(`/api/v1/live/search?${params}`));
    } catch {
      setFailed(true);
    } finally {
      setSearching(false);
    }
  };

  const savePreference = async () => {
    setSaving(true);
    try {
      setPreference(await apiRequest<LivePreference>("/api/v1/live/preferences", {
        method: "PATCH", body: JSON.stringify(preference),
      }));
      setSearch(null);
    } finally {
      setSaving(false);
    }
  };

  const clearSearch = () => {
    setQuery("");
    setSearch(null);
    setFailed(false);
    replaceSearchQuery(null);
  };
  const active = search ?? feed;
  const events = active?.events ?? [];
  const ticketmaster = providers.find((provider) => provider.provider === "ticketmaster");

  return <div className="live-page">
    <header className="live-hero">
      <div><p className="eyebrow">{t("LIVE / VERIFIED CONCERT INTELLIGENCE", "现场 / 经验证的演出信息")}</p><h1>{t("Find the next room that matters.", "寻找下一场值得到场的演出。")}</h1><p>{t("Search any artist across configured concert sources, then keep the results tied to real provider identities and public ticket pages.", "在已配置的演出来源中搜索艺人，查看真实来源身份与公开票务页面。")}</p></div>
      <div className="live-signal"><span>LIVE</span><i /><i /><p>{ticketmaster?.enabled ? t("Core source ready", "主要来源已就绪") : t("Core source needs configuration", "主要来源尚需配置")}</p></div>
    </header>
    <form className="live-search" onSubmit={(event) => void submitSearch(event)}>
      <label htmlFor="live-artist">{t("Artist concert search", "搜索艺人演出")}</label>
      <div><span aria-hidden="true">⌕</span><input id="live-artist" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="milet, 花譜, 初音ミク, 陈奕迅…" />{query && <button className="search-clear" type="button" onClick={clearSearch}>{t("Clear", "清除")}</button>}<button className="button button-primary" type="submit" disabled={searching || !query.trim()}>{searching ? t("Searching real sources…", "正在搜索真实来源…") : t("Search artist", "搜索艺人")}</button></div>
    </form>
    <section className="live-controls" aria-label={t("Concert filters", "演出筛选")}>
      <div className="live-filter"><span>{t("Date", "日期")}</span>{(["all", "month", "three_months"] as const).map((value) => <button type="button" key={value} aria-pressed={dateFilter === value} onClick={() => { setDateFilter(value); setSearch(null); replaceSearchQuery(null); }}>{value === "all" ? t("All upcoming", "全部即将举行") : value === "month" ? t("This month", "本月") : t("Next 3 months", "未来三个月")}</button>)}</div>
      <div className="live-location"><label>{t("Country", "国家/地区")}<input maxLength={2} value={preference.country ?? ""} placeholder={t("All", "全部")} onChange={(event) => setPreference((current) => ({ ...current, country: event.target.value.toUpperCase() || null }))} /></label><label>{t("City", "城市")}<input value={preference.city ?? ""} placeholder={t("All locations", "全部地点")} onChange={(event) => setPreference((current) => ({ ...current, city: event.target.value || null }))} /></label><button className="button button-quiet" type="button" disabled={saving} onClick={() => void savePreference()}>{saving ? t("Saving…", "正在保存…") : t("Save location", "保存地点")}</button></div>
    </section>
    <section className="live-results" aria-live="polite" aria-busy={loading || searching}>
      <div className="live-results-heading"><div><p className="eyebrow">{search ? t("ARTIST SEARCH / REAL SOURCES", "艺人搜索 / 真实来源") : t("LIVE FOR YOU / PROFILE EVIDENCE", "为你推荐的现场 / 资料库证据")}</p><h2>{search ? t(`Results for ${search.query}`, `“${search.query}”的结果`) : t("Upcoming events", "即将举行的演出")}</h2><p>{active ? t(active.coverage_message, coverageZh(active.status)) : t("Reading the verified concert cache…", "正在读取已验证演出缓存…")}</p></div><span>{events.length.toString().padStart(2, "0")} {t("events", "场演出")}</span></div>
      {(searching || search) && <div className="live-provider-results" role="status" aria-label={t("Concert provider search status", "演出来源搜索状态")}>
        {searching ? providers.filter((provider) => provider.capabilities.includes("ARTIST_SEARCH") || provider.capabilities.includes("EVENT_SEARCH")).map((provider) => <span key={provider.provider}><i />{provider.provider}<small>{statusLabel("SEARCHING")}</small></span>) : (search?.provider_results ?? []).map((result) => <span key={result.provider}><i className={result.status === "SUCCESS" ? "is-ready" : ""} />{result.provider}<small>{statusLabel(result.status)} · {result.result_count}</small></span>)}
      </div>}
      {loading ? <div className="live-loading"><span /><p>{t("Reading verified concert materialization…", "正在读取已验证演出数据…")}</p></div> : failed ? <CoverageState title={t("Live sources could not be reached.", "暂时无法访问演出来源。")} body={t("The music library and cached concert data remain unchanged. Try again when the API is available.", "音乐资料库与已缓存演出数据没有变化。服务恢复后请重试。")} /> : events.length ? <div className="event-grid">{events.map((event, index) => <EventCard event={event} key={event.id} priority={index === 0} />)}</div> : <CoverageState title={t(liveStateTitle(active?.status), liveStateTitleZh(active?.status))} body={active ? t(active.coverage_message, coverageZh(active.status)) : t("No verified personalized events are cached yet.", "尚无已缓存且经过验证的个性化演出。") } />}
    </section>
    <footer className="live-coverage"><div><p className="eyebrow">{t("COVERAGE / HONEST BY DESIGN", "覆盖范围 / 如实呈现")}</p><h3>{t("Available sources, not the whole world.", "仅涵盖当前可用来源。")}</h3><p>{t("A zero-result response means the configured sources returned no upcoming events. It does not prove an artist has no concerts.", "零结果只表示当前可用来源未找到经验证的近期演出，并不代表该艺人没有演出。")}</p></div><div>{providers.map((provider) => <span key={provider.provider}><i className={provider.enabled ? "is-ready" : ""} />{provider.provider} · {t(provider.health.replaceAll("_", " ").toLowerCase(), ({ HEALTHY: "正常", NOT_CONFIGURED: "未配置", UNAVAILABLE: "不可用", DEGRADED: "部分可用" } as Record<string, string>)[provider.health] ?? provider.health)}</span>)}</div></footer>
  </div>;
}

export function HomeLiveTeaser() {
  const t = useText();
  const [feed, setFeed] = useState<LiveFeed | null>(null);
  useEffect(() => { apiRequest<LiveFeed>("/api/v1/live?limit=3").then(setFeed).catch(() => setFeed(null)); }, []);
  const events = feed?.events ?? [];
  return <article className="home-live-teaser"><p className="eyebrow">{t("LIVE FOR YOU", "为你推荐的现场")}</p>{events.length ? <><h3>{events.length} {t(events.length === 1 ? "upcoming event" : "upcoming events", "场即将举行的演出")}</h3><div>{events.map((event) => <Link key={event.id} href={`/live/events/${event.id}`}><strong>{event.primary_artist_name || event.title}</strong><span>{event.start_date} · {event.city || event.country || t("Location pending", "地点待确认")}</span></Link>)}</div><Link className="text-link" href="/live">{t("View all Live →", "查看全部现场 →")}</Link></> : <><h3>{t("No verified events cached yet", "尚无已验证的缓存演出")}</h3><p>{feed ? t(feed.coverage_message, coverageZh(feed.status)) : t("Live For You will appear after a configured concert source returns verified events.", "已配置来源返回真实演出后，这里才会显示个性化现场推荐。")}</p><Link className="text-link" href="/live">{t("Open Live search →", "打开现场搜索 →")}</Link></>}</article>;
}

export function ArtistLiveSection({ artistId }: { artistId: string }) {
  const t = useText();
  const [feed, setFeed] = useState<LiveFeed | null>(null);
  useEffect(() => { apiRequest<LiveFeed>(`/api/v1/artists/${artistId}/live`).then(setFeed).catch(() => setFeed(null)); }, [artistId]);
  const events = feed?.events ?? [];
  return <section className="detail-section artist-live-section"><div className="detail-section-heading"><h2>{t("Upcoming Live", "即将举行的演出")}</h2><span>{events.length}</span></div>{events.length ? <div className="artist-live-list">{events.map((event) => <Link key={event.id} href={`/live/events/${event.id}`}><span>{event.start_date}</span><strong>{event.title}</strong><small>{event.city || event.country || t("Location pending", "地点待确认")}</small></Link>)}</div> : <div className="artist-live-empty"><p>{feed ? t(feed.coverage_message, coverageZh(feed.status)) : t("No cached verified concert is connected to this artist.", "尚无与此艺人关联的已验证缓存演出。")}</p><Link className="text-link" href="/live">{t("Search concert sources explicitly →", "搜索演出来源 →")}</Link></div>}</section>;
}

function CoverageState({ title, body }: { title: string; body: string }) {
  const t = useText();
  return <div className="live-empty"><span>∅</span><div><p className="eyebrow">{t("VERIFIED DATA / CURRENT STATE", "已验证数据 / 当前状态")}</p><h3>{title}</h3><p>{body}</p></div></div>;
}

export function formatEventTime(event: LiveEvent, locale: "en" | "zh" = "en") {
  if (!event.start_time) return locale === "zh" ? "日期已确认 · 时间待公布" : "Date confirmed · time pending";
  const [hour, minute] = event.start_time.split(":");
  return `${hour}:${minute}${event.timezone ? ` · ${event.timezone}` : ""}`;
}

function coverageZh(status?: string) {
  return ({
    OK: "当前可用演出来源返回了即将举行的演出。",
    PARTIAL_RESULTS: "部分来源暂不可用；正在显示可用来源已验证的结果。",
    ARTIST_NOT_FOUND: "当前可用来源未识别出完全匹配的艺人。",
    NO_UPCOMING_EVENTS: "当前可用来源未找到经验证的近期演出。",
    AMBIGUOUS_ARTIST: "提供方返回多个完全匹配的艺人；请选择结果继续。",
    PROVIDER_NOT_CONFIGURED: "此 MusicScope 安装尚未配置演出搜索来源。",
    PROVIDER_UNAVAILABLE: "演出来源暂不可用；已验证的缓存演出仍可查看。",
    PROVIDER_RATE_LIMITED: "演出搜索暂时受限，请稍后重试。",
    PROFILE_NOT_READY: "请先建立资料库画像，再更新个性化现场推荐。",
    EMPTY: "尚无已缓存且经过验证的个性化演出。",
  } as Record<string, string>)[status ?? ""] || "当前无法确认演出覆盖范围。";
}

function liveStateTitleZh(status?: string) {
  return ({
    PROVIDER_NOT_CONFIGURED: "演出搜索尚需配置来源。",
    AMBIGUOUS_ARTIST: "此艺人名称存在歧义。",
    ARTIST_NOT_FOUND: "来源未返回完全匹配的艺人。",
    PROVIDER_RATE_LIMITED: "演出来源暂时限制请求。",
    PROVIDER_UNAVAILABLE: "演出来源暂不可用。",
    NO_UPCOMING_EVENTS: "当前可用来源未找到经验证的近期演出。",
    PARTIAL_RESULTS: "目前只有部分已验证结果。",
  } as Record<string, string>)[status ?? ""] || "尚无已验证的缓存演出。";
}

export function liveStateTitle(status?: string) {
  if (status === "PROVIDER_NOT_CONFIGURED") return "Concert search needs a provider key.";
  if (status === "AMBIGUOUS_ARTIST") return "This artist name is ambiguous.";
  if (status === "ARTIST_NOT_FOUND") return "No exact artist match was returned.";
  if (status === "PROVIDER_RATE_LIMITED") return "The concert source is taking a breath.";
  if (status === "PROVIDER_UNAVAILABLE") return "Concert sources are temporarily unavailable.";
  if (status === "NO_UPCOMING_EVENTS") return "No upcoming events were returned.";
  if (status === "PARTIAL_RESULTS") return "Only partial verified results are available.";
  return "No verified events are cached yet.";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").replace("onsale", "on sale");
}

function replaceSearchQuery(query: string | null) {
  const url = new URL(window.location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}
