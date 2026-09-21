"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";

type LiveFeed = components["schemas"]["LiveFeedResponse"];
type LiveSearch = components["schemas"]["LiveSearchResponse"];
type LiveEvent = components["schemas"]["ConcertEventResponse"];
type LivePreference = components["schemas"]["LivePreferenceResponse"];
type Provider = components["schemas"]["ConcertProviderResponse"];
type DateFilter = "all" | "month" | "three_months";

export function EventCard({ event }: { event: LiveEvent }) {
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric",
  }).format(new Date(`${event.start_date}T12:00:00`));
  const performers = (event.performers ?? []).map((performer) => performer.name).join(", ");
  return <article className="event-card">
    <Link className="event-artwork-link" href={`/live/events/${event.id}`}>
      <Artwork src={event.artwork_url} alt="" className="event-artwork" sizes="(max-width: 767px) 100vw, 33vw" />
      <span className="event-date-token"><strong>{date.split(" ")[1]?.replace(",", "")}</strong><small>{date.split(" ")[0]}</small></span>
    </Link>
    <div className="event-card-copy">
      <div className="event-card-meta"><span>{event.city || event.country || "Location pending"}</span>{event.status && <span>{statusLabel(event.status)}</span>}</div>
      <Link className="event-card-title" href={`/live/events/${event.id}`}>{event.title}</Link>
      <p>{performers || event.primary_artist_name || "Performer details pending"}</p>
      <div className="event-venue"><span>{event.venue_name || "Venue to be announced"}</span><span>{formatEventTime(event)}</span></div>
      {event.explanation && <p className="event-reason">{event.explanation}</p>}
    </div>
  </article>;
}

export function LiveExperience() {
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
      <div><p className="eyebrow">LIVE / VERIFIED CONCERT INTELLIGENCE</p><h1>Find the next<br />room that matters.</h1><p>Search any artist across configured concert sources, then keep the results tied to real provider identities and public ticket pages.</p></div>
      <div className="live-signal"><span>LIVE</span><i /><i /><p>{ticketmaster?.enabled ? "Core source ready" : "Core source needs configuration"}</p></div>
    </header>
    <form className="live-search" onSubmit={(event) => void submitSearch(event)}>
      <label htmlFor="live-artist">Artist concert search</label>
      <div><span aria-hidden="true">⌕</span><input id="live-artist" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="milet, 花譜, 初音ミク, 陈奕迅…" />{query && <button className="search-clear" type="button" onClick={clearSearch}>Clear</button>}<button className="button button-primary" type="submit" disabled={searching || !query.trim()}>{searching ? "Searching real sources…" : "Search artist"}</button></div>
    </form>
    <section className="live-controls" aria-label="Concert filters">
      <div className="live-filter"><span>Date</span>{(["all", "month", "three_months"] as const).map((value) => <button type="button" key={value} aria-pressed={dateFilter === value} onClick={() => { setDateFilter(value); setSearch(null); replaceSearchQuery(null); }}>{value === "all" ? "All upcoming" : value === "month" ? "This month" : "Next 3 months"}</button>)}</div>
      <div className="live-location"><label>Country<input maxLength={2} value={preference.country ?? ""} placeholder="All" onChange={(event) => setPreference((current) => ({ ...current, country: event.target.value.toUpperCase() || null }))} /></label><label>City<input value={preference.city ?? ""} placeholder="All locations" onChange={(event) => setPreference((current) => ({ ...current, city: event.target.value || null }))} /></label><button className="button button-quiet" type="button" disabled={saving} onClick={() => void savePreference()}>{saving ? "Saving…" : "Save location"}</button></div>
    </section>
    <section className="live-results" aria-live="polite" aria-busy={loading || searching}>
      <div className="live-results-heading"><div><p className="eyebrow">{search ? "ARTIST SEARCH / REAL SOURCES" : "LIVE FOR YOU / PROFILE EVIDENCE"}</p><h2>{search ? `Results for ${search.query}` : "Upcoming events"}</h2><p>{active?.coverage_message || "Reading the verified concert cache…"}</p></div><span>{events.length.toString().padStart(2, "0")} events</span></div>
      {(searching || search) && <div className="live-provider-results" role="status" aria-label="Concert provider search status">
        {searching ? providers.filter((provider) => provider.capabilities.includes("ARTIST_SEARCH") || provider.capabilities.includes("EVENT_SEARCH")).map((provider) => <span key={provider.provider}><i />{provider.provider}<small>{statusLabel("SEARCHING")}</small></span>) : (search?.provider_results ?? []).map((result) => <span key={result.provider}><i className={result.status === "SUCCESS" ? "is-ready" : ""} />{result.provider}<small>{statusLabel(result.status)} · {result.result_count}</small></span>)}
      </div>}
      {loading ? <div className="live-loading"><span /><p>Reading verified concert materialization…</p></div> : failed ? <CoverageState title="Live sources could not be reached." body="The music library and cached concert data remain unchanged. Try again when the API is available." /> : events.length ? <div className="event-grid">{events.map((event) => <EventCard event={event} key={event.id} />)}</div> : <CoverageState title={liveStateTitle(active?.status)} body={active?.coverage_message || "No verified personalized events are cached yet."} />}
    </section>
    <footer className="live-coverage"><div><p className="eyebrow">COVERAGE / HONEST BY DESIGN</p><h3>Available sources, not the whole world.</h3><p>A zero-result response means the configured sources returned no upcoming events. It does not prove an artist has no concerts.</p></div><div>{providers.map((provider) => <span key={provider.provider}><i className={provider.enabled ? "is-ready" : ""} />{provider.provider} · {provider.health.replaceAll("_", " ").toLowerCase()}</span>)}</div></footer>
  </div>;
}

export function HomeLiveTeaser() {
  const [feed, setFeed] = useState<LiveFeed | null>(null);
  useEffect(() => { apiRequest<LiveFeed>("/api/v1/live?limit=3").then(setFeed).catch(() => setFeed(null)); }, []);
  const events = feed?.events ?? [];
  return <article className="home-live-teaser"><p className="eyebrow">LIVE FOR YOU</p>{events.length ? <><h3>{events.length} upcoming {events.length === 1 ? "event" : "events"}</h3><div>{events.map((event) => <Link key={event.id} href={`/live/events/${event.id}`}><strong>{event.primary_artist_name || event.title}</strong><span>{event.start_date} · {event.city || event.country || "Location pending"}</span></Link>)}</div><Link className="text-link" href="/live">View all Live →</Link></> : <><h3>No verified events cached yet</h3><p>{feed?.coverage_message || "Live For You will appear after a configured concert source returns verified events."}</p><Link className="text-link" href="/live">Open Live search →</Link></>}</article>;
}

export function ArtistLiveSection({ artistId }: { artistId: string }) {
  const [feed, setFeed] = useState<LiveFeed | null>(null);
  useEffect(() => { apiRequest<LiveFeed>(`/api/v1/artists/${artistId}/live`).then(setFeed).catch(() => setFeed(null)); }, [artistId]);
  const events = feed?.events ?? [];
  return <section className="detail-section artist-live-section"><div className="detail-section-heading"><h2>Upcoming Live</h2><span>{events.length}</span></div>{events.length ? <div className="artist-live-list">{events.map((event) => <Link key={event.id} href={`/live/events/${event.id}`}><span>{event.start_date}</span><strong>{event.title}</strong><small>{event.city || event.country || "Location pending"}</small></Link>)}</div> : <div className="artist-live-empty"><p>{feed?.coverage_message || "No cached verified concert is connected to this artist."}</p><Link className="text-link" href="/live">Search concert sources explicitly →</Link></div>}</section>;
}

function CoverageState({ title, body }: { title: string; body: string }) {
  return <div className="live-empty"><span>∅</span><div><p className="eyebrow">VERIFIED DATA / CURRENT STATE</p><h3>{title}</h3><p>{body}</p></div></div>;
}

export function formatEventTime(event: LiveEvent) {
  if (!event.start_time) return "Date confirmed · time pending";
  const [hour, minute] = event.start_time.split(":");
  return `${hour}:${minute}${event.timezone ? ` · ${event.timezone}` : ""}`;
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
