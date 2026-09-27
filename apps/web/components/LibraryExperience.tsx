"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { EmptyState } from "@/components/EmptyState";
import { TrackRow } from "@/components/TrackRow";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

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
const TAB_ZH: Record<Tab, string> = { playlists: "歌单", albums: "涉及专辑", artists: "主艺人", tracks: "曲目" };
const TAB_EN: Record<Tab, string> = { playlists: "Playlists", albums: "Related albums", artists: "Lead artists", tracks: "Tracks" };
const LIBRARY_SCOPE = "liked";

export function LibraryExperience() {
  const t = useText();
  const [tab, setTab] = useState<Tab>("tracks");
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
    let current = true;
    apiRequest<Summary>(`/api/v1/library/summary?scope=${LIBRARY_SCOPE}`)
      .then((result) => { if (current) setSummary(result); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({ sort, limit: tab === "tracks" ? "50" : "24", scope: LIBRARY_SCOPE });
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
    const query = new URLSearchParams({ q: searchQuery, limit: "24", scope: LIBRARY_SCOPE });
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

  if (failed && !page) return <EmptyState eyebrow={t("LIBRARY / UNAVAILABLE", "资料库 / 暂不可用")} title={t("Library could not be loaded.", "无法读取资料库。") } body={t("Your synchronized data remains stored. Retry after the MusicScope API is available.", "已同步数据仍安全保存。请在 MusicScope 服务恢复后重试。") } marker="!" />;
  if (!summary) return <div className="library-loading">{t("Loading your synchronized library…", "正在读取已同步资料库…")}</div>;
  if (!Object.values(counts ?? {}).some(Boolean)) return <EmptyState eyebrow={t("LIBRARY / EMPTY", "资料库 / 空")} title={t("No library synchronized.", "资料库尚未同步。") } body={t("Connect NetEase Cloud Music, confirm the QR login, then synchronize your read-only library.", "连接网易云音乐并确认二维码登录，然后以只读方式同步资料库。") } action={{ href: "/connect", label: t("Connect music", "连接音乐") }} marker="03" />;

  const searchMode = Boolean(searchQuery);
  const visiblePage = searchMode ? searchPage : page;
  const visibleLoading = searchMode ? searchLoading : loading;
  const range = visiblePage?.range_start ? `${visiblePage.range_start}–${visiblePage.range_end} ${t("of", "/")} ${visiblePage.total}` : visibleLoading ? t("Loading…", "加载中…") : t("No results", "暂无结果");

  return <section className="library-browser" aria-label={t("Canonical music library", "规范化音乐资料库")}>
    <header className="library-compact-heading"><div><span className="eyebrow">LIBRARY</span><h1>{t("Your library", "资料库")}</h1></div><p>{t("Choose a track to separate, or browse its album and artist.", "选一首曲目直接分轨，也可以浏览专辑与艺人。")}</p></header>
    <p className="library-scope-note">{t("Only your liked-songs playlist is shown. Albums come from its tracks; lead artists mean first credited artists, not verified vocalists.", "仅显示“我喜欢的音乐”歌单及其曲目、涉及专辑和首位署名艺人；首位署名不等于已核实的主唱身份。")}</p>
    <form className="library-search" role="search" onSubmit={submitSearch}>
      <label className="sr-only" htmlFor="library-search-input">{t("Search your synchronized library", "搜索已同步资料库")}</label>
      <span aria-hidden="true">⌕</span>
      <input id="library-search-input" type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={handleSearchKey} placeholder={t("Search liked tracks, lead artists, related albums and the playlist", "搜索喜欢的曲目、主艺人、涉及专辑和歌单")} autoComplete="off" />
      {(searchInput || searchMode) && <button className="search-clear" type="button" onClick={clearSearch} aria-label={t("Clear library search", "清除资料库搜索")}>{t("Clear", "清除")}</button>}
      <button className="button button-primary search-submit" type="submit">{t("Search", "搜索")}</button>
    </form>
    <div className="section-tabs" role="tablist" aria-label={t("Library views", "资料库分类")}>{(["tracks", "albums", "playlists", "artists"] as Tab[]).map((name) => <button key={name} role="tab" aria-selected={!searchMode && tab === name} onClick={() => chooseTab(name)}>{t(TAB_EN[name], TAB_ZH[name])}<span>{counts?.[name] ?? 0}</span></button>)}</div>
    <div className="library-toolbar">
      {searchMode ? <p className="search-context">{t("Results for", "搜索结果：")} <strong>“{searchQuery}”</strong> {t("in your liked songs", "（我喜欢的音乐）")}</p> : <div className="sort-control" aria-label={t("Sort order", "排序方式")}><button type="button" aria-pressed={sort === "asc"} onClick={() => chooseSort("asc")}>A–Z</button><button type="button" aria-pressed={sort === "desc"} onClick={() => chooseSort("desc")}>Z–A</button></div>}
      <span className="page-range">{range}</span>
    </div>
    {!searchMode && <nav className="alphabet-strip" aria-label={t("Filter by first character", "按首字母筛选")}>
      <button type="button" aria-current={group === null ? "true" : undefined} onClick={() => chooseGroup(null)}>{t("ALL", "全部")}</button>
      {alphabet.map((letter) => <button type="button" key={letter} disabled={!groupCounts.get(letter)} aria-current={group === letter ? "true" : undefined} title={groupCounts.get(letter) ? `${groupCounts.get(letter)} ${t("items", "项")}` : t("No items", "无项目")} onClick={() => chooseGroup(letter)}>{letter}</button>)}
    </nav>}
    <div className={visibleLoading ? "library-results results-loading" : "library-results"} aria-live="polite" aria-busy={visibleLoading}>
      {searchMode ? <SearchResults result={searchPage} failed={searchFailed} likedTrackCount={counts?.tracks ?? 0} /> : <BrowseResults page={page} tab={tab} loading={loading} likedTrackCount={counts?.tracks ?? 0} />}
    </div>
    <div className="pagination-controls">
      <button className="button button-quiet" type="button" disabled={!visiblePage?.previous_cursor || visibleLoading} onClick={() => { if (searchMode) { setSearchLoading(true); setSearchCursor(visiblePage?.previous_cursor ?? null); } else chooseCursor(visiblePage?.previous_cursor ?? null); }}>{t("Previous", "上一页")}</button>
      <span>{visiblePage?.range_start ? `${visiblePage.range_start}–${visiblePage.range_end} ${t("of", "/")} ${visiblePage.total}` : t("0 items", "0 项")}</span>
      <button className="button button-quiet" type="button" disabled={!visiblePage?.next_cursor || visibleLoading} onClick={() => { if (searchMode) { setSearchLoading(true); setSearchCursor(visiblePage?.next_cursor ?? null); } else chooseCursor(visiblePage?.next_cursor ?? null); }}>{t("Next", "下一页")}</button>
    </div>
  </section>;
}

function BrowseResults({ page, tab, loading, likedTrackCount }: { page: LibraryPage | null; tab: Tab; loading: boolean; likedTrackCount: number }) {
  const t = useText();
  return <>
    {page && tab === "playlists" && <CardGroups items={(page as Pages["playlists"]).items} render={(item, index) => <Link className="library-card" href={`/playlist/${item.id}`}><Artwork src={item.artwork_url} alt="" eager={index < 4} /><strong>{item.name}</strong><small>{likedTrackCount} {t("synchronized tracks", "首已同步曲目")}</small></Link>} />}
    {page && tab === "albums" && <CardGroups items={(page as Pages["albums"]).items} render={(item, index) => <Link className="library-card" href={`/album/${item.id}`}><Artwork src={item.artwork_url} alt="" eager={index < 4} /><strong>{item.title}</strong><small>{item.artists?.[0]?.name || t("Album", "专辑")}</small></Link>} />}
    {page && tab === "artists" && <CardGroups items={(page as Pages["artists"]).items} render={(item, index) => <Link className="library-card" href={`/artist/${item.id}`}><Artwork src={item.artwork_url} alt="" eager={index < 4} /><strong>{item.name}</strong><small>{t("Artist", "艺人")}</small></Link>} />}
    {page && tab === "tracks" && <div className="track-list">{(page as Pages["tracks"]).items.map((item, index) => <TrackRow key={item.id} track={item} index={(page.range_start || 1) + index} />)}</div>}
    {!loading && page?.items.length === 0 && <div className="inline-empty">{t(`No ${tab} in this group.`, `此分组暂无${TAB_ZH[tab]}。`)}</div>}
  </>;
}

function SearchResults({ result, failed, likedTrackCount }: { result: SearchResponse | null; failed: boolean; likedTrackCount: number }) {
  const t = useText();
  if (failed) return <div className="inline-empty">{t("Search is temporarily unavailable. Your synchronized library is unchanged.", "搜索暂时不可用；已同步资料库没有变化。")}</div>;
  if (!result) return null;
  if (!result.total) return <div className="inline-empty">{t(`No tracks, artists, albums, or playlists match “${result.query}”.`, `没有与“${result.query}”匹配的曲目、艺人、专辑或歌单。`)}</div>;
  const tracks = result.tracks ?? [];
  const artists = result.artists ?? [];
  const albums = result.albums ?? [];
  const playlists = result.playlists ?? [];
  return <div className="search-results">
    {tracks.length > 0 && <SearchSection title={t("Tracks", "曲目")} count={tracks.length}><div className="track-list">{tracks.map((item, index) => <TrackRow key={item.track.id} track={item.track} index={result.range_start + index} />)}</div></SearchSection>}
    {artists.length > 0 && <SearchSection title={t("Artists", "艺人")} count={artists.length}><div className="library-grid search-grid">{artists.map(({ artist, library_track_count: trackCount, match }) => <Link className="library-card" href={`/artist/${artist.id}`} key={artist.id}><Artwork src={artist.artwork_url} alt="" /><strong>{artist.name}</strong><small>{trackCount} {t("library tracks", "首资料库曲目")} · {match} {t("match", "处匹配")}</small></Link>)}</div></SearchSection>}
    {albums.length > 0 && <SearchSection title={t("Albums", "专辑")} count={albums.length}><div className="library-grid search-grid">{albums.map(({ album, match }) => <Link className="library-card" href={`/album/${album.id}`} key={album.id}><Artwork src={album.artwork_url} alt="" /><strong>{album.title}</strong><small>{album.artists?.[0]?.name || t("Album", "专辑")} · {match} {t("match", "处匹配")}</small></Link>)}</div></SearchSection>}
    {playlists.length > 0 && <SearchSection title={t("Playlists", "歌单")} count={playlists.length}><div className="library-grid search-grid">{playlists.map(({ playlist, match }) => <Link className="library-card" href={`/playlist/${playlist.id}`} key={playlist.id}><Artwork src={playlist.artwork_url} alt="" /><strong>{playlist.name}</strong><small>{likedTrackCount} {t("synchronized tracks", "首已同步曲目")} · {match} {t("match", "处匹配")}</small></Link>)}</div></SearchSection>}
  </div>;
}

function SearchSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const t = useText();
  return <section className="search-section" aria-labelledby={`search-${title.toLowerCase()}`}><div className="search-section-heading"><h2 id={`search-${title.toLowerCase()}`}>{title}</h2><span>{count} {t("on this page", "项（本页）")}</span></div>{children}</section>;
}

function CardGroups<T extends { id: string; sort_group: string }>({ items, render }: { items: T[]; render: (item: T, index: number) => React.ReactNode }) {
  return <div className="library-grid">{items.map((item, index) => {
    const heading = index === 0 || item.sort_group !== items[index - 1].sort_group;
    return <div className="library-card-cell" key={item.id}>{heading && <h2 className="group-heading">{item.sort_group}</h2>}{render(item, index)}</div>;
  })}</div>;
}
