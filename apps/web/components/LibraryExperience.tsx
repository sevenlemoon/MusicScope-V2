"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { EmptyState } from "@/components/EmptyState";
import { TrackRow } from "@/components/TrackRow";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";

type Tab = "playlists" | "albums" | "artists" | "tracks";
type Sort = "asc" | "desc";
type Pages = {
  playlists: components["schemas"]["PlaylistPage"];
  albums: components["schemas"]["AlbumPage"];
  artists: components["schemas"]["ArtistPage"];
  tracks: components["schemas"]["TrackPage"];
};
type LibraryPage = Pages[Tab];
type Summary = components["schemas"]["LibrarySummary"];
type SearchResponse = components["schemas"]["LibrarySearchResponse"];

const alphabet = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];

export function LibraryExperience() {
  const [tab, setTab] = useState<Tab>("playlists");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<LibraryPage | null>(null);
  const [sort, setSort] = useState<Sort>("asc");
  const [group, setGroup] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchRevision, setSearchRevision] = useState(0);
  const [searchPage, setSearchPage] = useState<SearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  useEffect(() => {
    apiRequest<Summary>("/api/v1/library/summary").then(setSummary).catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({ sort, limit: tab === "tracks" ? "50" : "24" });
    if (group) query.set("group", group);
    if (cursor) query.set("cursor", cursor);
    apiRequest<LibraryPage>(`/api/v1/library/${tab}?${query}`).then((result) => {
      if (current) { setPage(result); setLoading(false); }
    }).catch(() => { if (current) { setFailed(true); setLoading(false); } });
    return () => { current = false; };
  }, [cursor, group, sort, tab]);

  useEffect(() => {
    if (!searchQuery) return;
    let current = true;
    const query = new URLSearchParams({ q: searchQuery, limit: "24" });
    if (searchCursor) query.set("cursor", searchCursor);
    apiRequest<SearchResponse>(`/api/v1/library/search?${query}`).then((result) => {
      if (current) { setSearchPage(result); setSearchLoading(false); }
    }).catch(() => { if (current) { setSearchFailed(true); setSearchLoading(false); } });
    return () => { current = false; };
  }, [searchCursor, searchQuery, searchRevision]);

  const counts = summary?.counts;
  const groupCounts = useMemo(() => new Map((page?.groups ?? []).map((item) => [item.key, item.count])), [page]);
  const chooseTab = (next: Tab) => { setLoading(true); setTab(next); setGroup(null); setCursor(null); setPage(null); setSearchInput(""); setSearchQuery(""); setSearchCursor(null); setSearchPage(null); };
  const chooseSort = (next: Sort) => { setLoading(true); setSort(next); setCursor(null); };
  const chooseGroup = (next: string | null) => { setLoading(true); setGroup(next); setCursor(null); };
  const chooseCursor = (next: string | null) => { setLoading(true); setCursor(next); };
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const next = searchInput.trim();
    if (!next) { clearSearch(); return; }
    setSearchLoading(true);
    setSearchFailed(false);
    setSearchCursor(null);
    setSearchQuery(next);
    setSearchRevision((value) => value + 1);
  };
  const clearSearch = () => {
    setSearchInput("");
    setSearchQuery("");
    setSearchCursor(null);
    setSearchPage(null);
  };
  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") clearSearch();
  };

  if (failed && !page) return <EmptyState eyebrow="LIBRARY / UNAVAILABLE" title="Library could not be loaded." body="Your synchronized data remains stored. Retry after the MusicScope API is available." marker="!" />;
  if (!summary) return <div className="library-loading">Loading your synchronized library…</div>;
  if (!Object.values(counts ?? {}).some(Boolean)) return <EmptyState eyebrow="LIBRARY / EMPTY" title="No library synchronized." body="Connect NetEase Cloud Music, confirm the QR login, then synchronize your read-only library." action={{ href: "/connect", label: "Connect music" }} marker="03" />;

  const searchMode = Boolean(searchQuery);
  const visiblePage = searchMode ? searchPage : page;
  const visibleLoading = searchMode ? searchLoading : loading;
  const range = visiblePage?.range_start ? `${visiblePage.range_start}–${visiblePage.range_end} of ${visiblePage.total}` : visibleLoading ? "Loading…" : "No results";

  return <section className="library-browser" aria-label="Canonical music library">
    <form className="library-search" role="search" onSubmit={submitSearch}>
      <label className="sr-only" htmlFor="library-search-input">Search your synchronized library</label>
      <span aria-hidden="true">⌕</span>
      <input id="library-search-input" type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={handleSearchKey} placeholder="Search tracks, artists, albums, playlists" autoComplete="off" />
      {(searchInput || searchMode) && <button className="search-clear" type="button" onClick={clearSearch} aria-label="Clear library search">Clear</button>}
      <button className="button button-primary search-submit" type="submit">Search</button>
    </form>
    <div className="section-tabs" role="tablist" aria-label="Library views">{(["playlists", "albums", "artists", "tracks"] as Tab[]).map((name) => <button key={name} role="tab" aria-selected={!searchMode && tab === name} onClick={() => chooseTab(name)}>{name}<span>{counts?.[name] ?? 0}</span></button>)}</div>
    <div className="library-toolbar">
      {searchMode ? <p className="search-context">Results for <strong>“{searchQuery}”</strong> across your library</p> : <div className="sort-control" aria-label="Sort order"><button type="button" aria-pressed={sort === "asc"} onClick={() => chooseSort("asc")}>A–Z</button><button type="button" aria-pressed={sort === "desc"} onClick={() => chooseSort("desc")}>Z–A</button></div>}
      <span className="page-range">{range}</span>
    </div>
    {!searchMode && <nav className="alphabet-strip" aria-label="Filter by first character">
      <button type="button" aria-current={group === null ? "true" : undefined} onClick={() => chooseGroup(null)}>ALL</button>
      {alphabet.map((letter) => <button type="button" key={letter} disabled={!groupCounts.get(letter)} aria-current={group === letter ? "true" : undefined} title={groupCounts.get(letter) ? `${groupCounts.get(letter)} items` : "No items"} onClick={() => chooseGroup(letter)}>{letter}</button>)}
    </nav>}
    <div className={visibleLoading ? "library-results results-loading" : "library-results"} aria-live="polite" aria-busy={visibleLoading}>
      {searchMode ? <SearchResults result={searchPage} failed={searchFailed} /> : <BrowseResults page={page} tab={tab} loading={loading} />}
    </div>
    <div className="pagination-controls">
      <button className="button button-quiet" type="button" disabled={!visiblePage?.previous_cursor || visibleLoading} onClick={() => { if (searchMode) { setSearchLoading(true); setSearchCursor(visiblePage?.previous_cursor ?? null); } else chooseCursor(visiblePage?.previous_cursor ?? null); }}>Previous</button>
      <span>{visiblePage?.range_start ? `${visiblePage.range_start}–${visiblePage.range_end} of ${visiblePage.total}` : "0 items"}</span>
      <button className="button button-quiet" type="button" disabled={!visiblePage?.next_cursor || visibleLoading} onClick={() => { if (searchMode) { setSearchLoading(true); setSearchCursor(visiblePage?.next_cursor ?? null); } else chooseCursor(visiblePage?.next_cursor ?? null); }}>Next</button>
    </div>
  </section>;
}

function BrowseResults({ page, tab, loading }: { page: LibraryPage | null; tab: Tab; loading: boolean }) {
  return <>
    {page && tab === "playlists" && <CardGroups items={(page as Pages["playlists"]).items} render={(item) => <Link className="library-card" href={`/playlist/${item.id}`}><Artwork src={item.artwork_url} alt="" /><strong>{item.name}</strong><small>{item.track_count ?? 0} tracks</small></Link>} />}
    {page && tab === "albums" && <CardGroups items={(page as Pages["albums"]).items} render={(item) => <Link className="library-card" href={`/album/${item.id}`}><Artwork src={item.artwork_url} alt="" /><strong>{item.title}</strong><small>{(item.artists ?? []).map((artist) => artist.name).join(", ") || "Album"}</small></Link>} />}
    {page && tab === "artists" && <CardGroups items={(page as Pages["artists"]).items} render={(item) => <Link className="library-card" href={`/artist/${item.id}`}><Artwork src={item.artwork_url} alt="" /><strong>{item.name}</strong><small>Artist</small></Link>} />}
    {page && tab === "tracks" && <div className="track-list">{(page as Pages["tracks"]).items.map((item, index) => <TrackRow key={item.id} track={item} index={(page.range_start || 1) + index} />)}</div>}
    {!loading && page?.items.length === 0 && <div className="inline-empty">No {tab} in this group.</div>}
  </>;
}

function SearchResults({ result, failed }: { result: SearchResponse | null; failed: boolean }) {
  if (failed) return <div className="inline-empty">Search is temporarily unavailable. Your synchronized library is unchanged.</div>;
  if (!result) return null;
  if (!result.total) return <div className="inline-empty">No tracks, artists, albums, or playlists match “{result.query}”.</div>;
  const tracks = result.tracks ?? [];
  const artists = result.artists ?? [];
  const albums = result.albums ?? [];
  const playlists = result.playlists ?? [];
  return <div className="search-results">
    {tracks.length > 0 && <SearchSection title="Tracks" count={tracks.length}><div className="track-list">{tracks.map((item, index) => <TrackRow key={item.track.id} track={item.track} index={result.range_start + index} />)}</div></SearchSection>}
    {artists.length > 0 && <SearchSection title="Artists" count={artists.length}><div className="library-grid search-grid">{artists.map(({ artist, library_track_count: trackCount, match }) => <Link className="library-card" href={`/artist/${artist.id}`} key={artist.id}><Artwork src={artist.artwork_url} alt="" /><strong>{artist.name}</strong><small>{trackCount} library tracks · {match} match</small></Link>)}</div></SearchSection>}
    {albums.length > 0 && <SearchSection title="Albums" count={albums.length}><div className="library-grid search-grid">{albums.map(({ album, match }) => <Link className="library-card" href={`/album/${album.id}`} key={album.id}><Artwork src={album.artwork_url} alt="" /><strong>{album.title}</strong><small>{(album.artists ?? []).map((artist) => artist.name).join(", ") || "Album"} · {match} match</small></Link>)}</div></SearchSection>}
    {playlists.length > 0 && <SearchSection title="Playlists" count={playlists.length}><div className="library-grid search-grid">{playlists.map(({ playlist, match }) => <Link className="library-card" href={`/playlist/${playlist.id}`} key={playlist.id}><Artwork src={playlist.artwork_url} alt="" /><strong>{playlist.name}</strong><small>{playlist.track_count ?? 0} tracks · {match} match</small></Link>)}</div></SearchSection>}
  </div>;
}

function SearchSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <section className="search-section" aria-labelledby={`search-${title.toLowerCase()}`}><div className="search-section-heading"><h2 id={`search-${title.toLowerCase()}`}>{title}</h2><span>{count} on this page</span></div>{children}</section>;
}

function CardGroups<T extends { id: string; sort_group: string }>({ items, render }: { items: T[]; render: (item: T) => React.ReactNode }) {
  return <div className="library-grid">{items.map((item, index) => {
    const heading = index === 0 || item.sort_group !== items[index - 1].sort_group;
    return <div className="library-card-cell" key={item.id}>{heading && <h2 className="group-heading">{item.sort_group}</h2>}{render(item)}</div>;
  })}</div>;
}
