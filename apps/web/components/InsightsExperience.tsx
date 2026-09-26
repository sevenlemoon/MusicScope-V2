"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Artwork } from "./Artwork";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { layoutUniverse } from "@/lib/insights-layout";
import { useLocale } from "./LocaleProvider";

type Overview = components["schemas"]["InsightsOverviewResponse"];
type Universe = components["schemas"]["InsightsUniverseResponse"];
type UniverseNode = components["schemas"]["UniverseNode"];
type UniverseEdge = components["schemas"]["UniverseEdge"];
type Playlists = components["schemas"]["InsightsPlaylistsResponse"];
type Rediscovery = components["schemas"]["InsightsRediscoveryResponse"];
type Lang = "zh" | "en";
type Loadable<T> = { state: "loading" | "ready" | "error"; data?: T };

const copy = {
  zh: {
    eyebrow: "洞察 / 你的音乐宇宙", title: "你的音乐宇宙", lede: "从收藏、歌单与真实艺人关系中，看见自己的音乐版图。这里衡量的是资料库关联，不是播放次数。",
    chinese: "中文", english: "EN", tracks: "首收藏曲目", artists: "位艺人", albums: "张专辑", playlists: "个歌单",
    universe: "音乐宇宙", universeKicker: "音乐宇宙 / 关系图", universeBody: "节点大小仅代表资料库亲和度；连线来自共同歌单与真实合作曲目。",
    searchLabel: "在音乐宇宙中搜索艺人", searchPlaceholder: "搜索当前宇宙中的艺人", search: "搜索", reset: "重置选择", noMatch: "当前有界音乐宇宙中没有匹配艺人。",
    graphLabel: "可选择的艺人关系图", nodeMetric: "节点大小：资料库亲和度", selectHint: "选择一位艺人，查看真实关系证据。",
    strongestAffinity: "资料库亲和度", savedTracks: "收藏曲目", playlistAppearances: "出现于歌单", representedAlbums: "收录专辑", collaborationTracks: "合作曲目",
    connectedArtists: "最强资料库关系", sharedPlaylists: "共同歌单", relationshipWeight: "关系权重", viewArtist: "打开艺人页面", selectArtist: "选择艺人",
    accessibleTitle: "可访问的关系列表", accessibleBody: "这份文字列表与图形使用相同的关系证据。",
    structure: "资料库结构", structureKicker: "资料库结构 / 真实收藏", structureBody: "以规范化曲目、艺人、专辑与歌单计数描述你的资料库。",
    concentration: "艺人集中度", top10: "前 10 位艺人覆盖的收藏曲目", top50: "前 50 位艺人覆盖的收藏曲目", median: "每位艺人收藏曲目中位数",
    profile: "音乐资料库指标", formula: "计算方式", longTail: "长尾分布", longTailBody: "按每位艺人所代表的不同收藏曲目数分组。",
    one: "1 首", two_to_five: "2–5 首", six_to_twenty: "6–20 首", twenty_one_to_fifty: "21–50 首", fifty_one_plus: "51+ 首", artistUnit: "位艺人",
    collaboration: "合作网络", collaborationBody: "只使用一首曲目关联多位规范化艺人的 TrackArtist 证据。", multiArtistTracks: "多艺人曲目", collaborationDensity: "多艺人曲目占比", collaborationPairs: "含合作证据的关系",
    noCollaboration: "目前没有足够的规范化合作证据。", playlistIntelligence: "歌单智能", playlistBody: "相似度由后端按规范化曲目 ID 的 Jaccard 交并比计算。",
    strongestOverlaps: "最强歌单重叠", sharedTracks: "共同曲目", similarity: "Jaccard 相似度", uniqueCoverage: "独有资料库覆盖", tracksShort: "首曲目", noOverlap: "没有足够的歌单重叠可供比较。",
    rediscovery: "重新发现候选", rediscoveryBody: "位于最强资料库画像信号之外的已收藏曲目。", inLibrary: "已在资料库", noRediscovery: "目前没有重新发现候选。",
    boundaries: "数据边界", genreTitle: "曲风资料", genreMissing: "可靠曲风元数据尚不足以为这个资料库生成有意义的曲风摘要。", timelineTitle: "时间线", timelineMissing: "当前没有可靠的历史聆听记录，因此不会生成推测性的音乐时间线。",
    loading: "正在构建音乐宇宙…", errorTitle: "这一部分暂时无法读取", retry: "重试", emptyTitle: "连接音乐资料库，建立你的音乐宇宙。", emptyBody: "同步真实收藏后，这里才会呈现分析；不会用示例数据代替。", connect: "连接音乐",
    nodes: "个节点", edges: "条关系", notEnough: "关系证据不足，暂时无法绘制宇宙。", profileStale: "音乐画像尚未生成或需要更新。",
  },
  en: {
    eyebrow: "INSIGHTS / YOUR MUSIC UNIVERSE", title: "Your Music Universe", lede: "See the shape of your collection through saved music, playlists, and real artist relationships. This measures library affinity—not play counts.",
    chinese: "中文", english: "EN", tracks: "saved tracks", artists: "artists", albums: "albums", playlists: "playlists",
    universe: "Music Universe", universeKicker: "MUSIC UNIVERSE / RELATIONSHIP MAP", universeBody: "Node size represents library affinity only. Connections come from shared playlists and real collaboration tracks.",
    searchLabel: "Search artists in Music Universe", searchPlaceholder: "Search artists in this universe", search: "Search", reset: "Reset selection", noMatch: "No matching artist is present in this bounded Music Universe.",
    graphLabel: "Selectable artist relationship graph", nodeMetric: "Node size: library affinity", selectHint: "Select an artist to inspect real relationship evidence.",
    strongestAffinity: "Library affinity", savedTracks: "Saved tracks", playlistAppearances: "Playlist appearances", representedAlbums: "Represented albums", collaborationTracks: "Collaboration tracks",
    connectedArtists: "Strongest library relationships", sharedPlaylists: "Shared playlists", relationshipWeight: "Relationship weight", viewArtist: "Open Artist page", selectArtist: "Select artist",
    accessibleTitle: "Accessible relationship list", accessibleBody: "This text view exposes the same relationship evidence as the graph.",
    structure: "Library structure", structureKicker: "LIBRARY STRUCTURE / REAL COLLECTION", structureBody: "Canonical track, artist, album, and playlist counts describe the collection without implying listening behavior.",
    concentration: "Artist concentration", top10: "Saved tracks represented by the top 10 artists", top50: "Saved tracks represented by the top 50 artists", median: "Median saved tracks per artist",
    profile: "Music library metrics", formula: "Formula", longTail: "Long-tail distribution", longTailBody: "Artists grouped by their distinct saved-track representation.",
    one: "1 track", two_to_five: "2–5 tracks", six_to_twenty: "6–20 tracks", twenty_one_to_fifty: "21–50 tracks", fifty_one_plus: "51+ tracks", artistUnit: "artists",
    collaboration: "Collaboration network", collaborationBody: "Uses only TrackArtist evidence where a canonical track is linked to multiple canonical artists.", multiArtistTracks: "Multi-artist tracks", collaborationDensity: "Multi-artist track share", collaborationPairs: "Relationships with collaboration evidence",
    noCollaboration: "Not enough canonical collaboration evidence is available yet.", playlistIntelligence: "Playlist intelligence", playlistBody: "Similarity is calculated by the backend as Jaccard overlap over canonical track IDs.",
    strongestOverlaps: "Strongest playlist overlaps", sharedTracks: "Shared tracks", similarity: "Jaccard similarity", uniqueCoverage: "Unique library coverage", tracksShort: "tracks", noOverlap: "Not enough playlist overlap is available to compare.",
    rediscovery: "Rediscovery candidates", rediscoveryBody: "Saved tracks outside your strongest library-profile signals.", inLibrary: "In your library", noRediscovery: "There are no rediscovery candidates yet.",
    boundaries: "Data-quality boundaries", genreTitle: "Genre metadata", genreMissing: "Reliable genre metadata is not available for enough of this library to produce a meaningful genre summary.", timelineTitle: "Timeline", timelineMissing: "Reliable historical listening evidence is unavailable, so MusicScope does not generate a speculative music timeline.",
    loading: "Building your Music Universe…", errorTitle: "This section could not be loaded", retry: "Retry", emptyTitle: "Connect your music library to build your Music Universe.", emptyBody: "Insights appear only after real saved music is synchronized; no demo data will take its place.", connect: "Connect music",
    nodes: "nodes", edges: "relationships", notEnough: "Not enough relationship evidence is available to draw the universe.", profileStale: "The music profile is missing or needs to be refreshed.",
  },
} as const;

const metricNames: Record<Lang, Record<string, string>> = {
  zh: { artist_concentration: "艺人集中度", library_breadth: "资料库广度", album_depth: "专辑深度", collaboration_density: "合作密度" },
  en: { artist_concentration: "Artist concentration", library_breadth: "Library breadth", album_depth: "Album depth", collaboration_density: "Collaboration density" },
};

const number = (value: number, lang: Lang) => new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US").format(value);
const percent = (value: number, lang: Lang) => new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);

function SectionError({ lang, retry }: { lang: Lang; retry: () => void }) {
  const t = copy[lang];
  return <div className="insights-section-state" role="alert"><p>{t.errorTitle}</p><button className="button button-quiet" onClick={retry}>{t.retry}</button></div>;
}

function LoadingSection({ lang }: { lang: Lang }) {
  return <div className="insights-loading" role="status"><span aria-hidden="true" /><p>{copy[lang].loading}</p></div>;
}

export function InsightsExperience() {
  const { locale, setLocale } = useLocale();
  const lang: Lang = locale;
  const [overview, setOverview] = useState<Loadable<Overview>>({ state: "loading" });
  const [universe, setUniverse] = useState<Loadable<Universe>>({ state: "loading" });
  const [playlists, setPlaylists] = useState<Loadable<Playlists>>({ state: "loading" });
  const [rediscovery, setRediscovery] = useState<Loadable<Rediscovery>>({ state: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchMessage, setSearchMessage] = useState("");
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const t = copy[lang];

  const load = useCallback(() => {
    setOverview({ state: "loading" });
    setUniverse({ state: "loading" });
    setPlaylists({ state: "loading" });
    setRediscovery({ state: "loading" });
    void apiRequest<Overview>("/api/v1/insights/overview").then((data) => setOverview({ state: "ready", data })).catch(() => setOverview({ state: "error" }));
    void apiRequest<Universe>("/api/v1/insights/universe").then((data) => {
      setUniverse({ state: "ready", data });
      setSelectedId((current) => current && (data.nodes ?? []).some((node) => node.id === current) ? current : (data.nodes ?? [])[0]?.id ?? null);
    }).catch(() => setUniverse({ state: "error" }));
    void apiRequest<Playlists>("/api/v1/insights/playlists").then((data) => setPlaylists({ state: "ready", data })).catch(() => setPlaylists({ state: "error" }));
    void apiRequest<Rediscovery>("/api/v1/insights/rediscovery?limit=12").then((data) => setRediscovery({ state: "ready", data })).catch(() => setRediscovery({ state: "error" }));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const nodes = useMemo(() => universe.data?.nodes ?? [], [universe.data?.nodes]);
  const edges = useMemo(() => universe.data?.edges ?? [], [universe.data?.edges]);
  const positions = useMemo(() => layoutUniverse(nodes), [nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;
  const selectedEdges = useMemo(() => selectedId ? edges.filter((edge) => edge.source === selectedId || edge.target === selectedId).sort((a, b) => b.weight - a.weight || b.collaboration_track_count - a.collaboration_track_count) : [...edges].sort((a, b) => b.weight - a.weight).slice(0, 10), [edges, selectedId]);
  const neighbors = useMemo(() => new Set(selectedEdges.flatMap((edge) => edge.source === selectedId ? [edge.target] : edge.target === selectedId ? [edge.source] : [])), [selectedEdges, selectedId]);
  const affinityValues = nodes.map((node) => node.affinity);
  const minAffinity = affinityValues.length ? Math.min(...affinityValues) : 0;
  const maxAffinity = affinityValues.length ? Math.max(...affinityValues) : 1;
  const radius = (affinity: number) => 6 + 16 * Math.sqrt(Math.max(0, (affinity - minAffinity) / Math.max(.000001, maxAffinity - minAffinity)));

  function selectArtist(id: string, focus = false) {
    setSelectedId(id);
    setSearchMessage("");
    if (focus) window.requestAnimationFrame(() => nodeRefs.current.get(id)?.focus());
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const normalized = query.trim().toLocaleLowerCase();
    const match = nodes.find((node) => node.name.toLocaleLowerCase().includes(normalized));
    if (normalized && match) selectArtist(match.id, true);
    else if (normalized) setSearchMessage(t.noMatch);
  }

  const empty = overview.state === "ready" && overview.data?.counts.tracks === 0;
  return <div className="insights-page" lang={lang === "zh" ? "zh-CN" : "en"}>
    <section className="insights-hero">
      <div className="insights-hero-copy">
        <div className="insights-language" aria-label={lang === "zh" ? "语言" : "Language"}><button aria-pressed={lang === "zh"} onClick={() => setLocale("zh")}>{t.chinese}</button><button aria-pressed={lang === "en"} onClick={() => setLocale("en")}>{t.english}</button></div>
        <p className="eyebrow">{t.eyebrow}</p><h1>{t.title}</h1><p>{t.lede}</p>
        {overview.state === "ready" && overview.data && !empty ? <div className="insights-hero-counts" aria-label={t.structure}>
          <span><strong>{number(overview.data.counts.tracks, lang)}</strong>{t.tracks}</span>
          <span><strong>{number(overview.data.counts.artists, lang)}</strong>{t.artists}</span>
          <span><strong>{number(overview.data.counts.albums, lang)}</strong>{t.albums}</span>
          <span><strong>{number(overview.data.counts.playlists, lang)}</strong>{t.playlists}</span>
        </div> : null}
      </div>
      <div className="insights-hero-orbit" aria-hidden="true"><div><span>{nodes.length || "—"}</span><small>{lang === "zh" ? <>音乐<br />宇宙</> : <>MUSIC<br />UNIVERSE</>}</small></div>{(overview.data?.top_artists ?? []).slice(0, 4).map((artist, index) => <i key={artist.id} style={{ "--i": index } as React.CSSProperties}>{artist.name}</i>)}</div>
    </section>

    {overview.state === "loading" ? <LoadingSection lang={lang} /> : overview.state === "error" ? <SectionError lang={lang} retry={load} /> : empty ? <section className="insights-empty"><div aria-hidden="true">○</div><p className="eyebrow">{lang === "zh" ? "音乐宇宙 / 暂无数据" : "MUSIC UNIVERSE / EMPTY"}</p><h2>{t.emptyTitle}</h2><p>{t.emptyBody}</p><Link className="button button-primary" href="/connect">{t.connect}</Link></section> : <>
      <section className="insights-universe-section" aria-labelledby="universe-title">
        <header className="insights-section-heading"><div><p className="eyebrow">{t.universeKicker}</p><h2 id="universe-title">{t.universe}</h2><p>{t.universeBody}</p></div>{universe.data ? <span>{number(nodes.length, lang)} {t.nodes} · {number(edges.length, lang)} {t.edges}</span> : null}</header>
        {universe.state === "loading" ? <LoadingSection lang={lang} /> : universe.state === "error" ? <SectionError lang={lang} retry={load} /> : nodes.length === 0 ? <div className="insights-section-state"><p>{universe.data?.profile_state === "missing_or_stale" ? t.profileStale : t.notEnough}</p></div> : <>
          <form className="universe-search" role="search" onSubmit={submitSearch}><label className="sr-only" htmlFor="universe-artist-search">{t.searchLabel}</label><span aria-hidden="true">⌕</span><input id="universe-artist-search" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setSearchMessage(""); }} placeholder={t.searchPlaceholder} /><button className="button button-primary" type="submit">{t.search}</button><button className="button button-quiet" type="button" onClick={() => { setSelectedId(null); setQuery(""); setSearchMessage(""); }}>{t.reset}</button></form>
          {searchMessage ? <p className="universe-search-message" role="status">{searchMessage}</p> : null}
          <div className="universe-layout">
            <div className="universe-graph-shell"><div className="universe-legend"><span><i />{t.nodeMetric}</span><small>{t.selectHint}</small></div><svg className="universe-graph" viewBox="0 0 1000 620" role="img" aria-label={t.graphLabel}>
              <g className="universe-edges" aria-hidden="true">{edges.map((edge) => { const source = positions.get(edge.source); const target = positions.get(edge.target); if (!source || !target) return null; const active = !!selectedId && (edge.source === selectedId || edge.target === selectedId); return <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={selectedId ? active ? "is-active" : "is-muted" : ""} />; })}</g>
              <g className="universe-nodes">{nodes.map((node, index) => { const position = positions.get(node.id); if (!position) return null; const isSelected = node.id === selectedId; const isNeighbor = neighbors.has(node.id); const isMuted = !!selectedId && !isSelected && !isNeighbor; const showLabel = isSelected || isNeighbor || index < 12; return <g key={node.id} ref={(element) => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }} data-node-id={node.id} role="button" tabIndex={0} aria-label={`${t.selectArtist}: ${node.name}`} aria-pressed={isSelected} className={`${isSelected ? "is-selected" : ""} ${isNeighbor ? "is-neighbor" : ""} ${isMuted ? "is-muted" : ""}`} transform={`translate(${position.x} ${position.y})`} onClick={() => selectArtist(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectArtist(node.id); } }}><title>{node.name} · {t.strongestAffinity} {percent(node.affinity, lang)}</title><circle r={radius(node.affinity)} /><circle className="node-core" r={Math.max(3, radius(node.affinity) - 5)} />{showLabel ? <text y={radius(node.affinity) + 15} textAnchor="middle">{node.name}</text> : null}</g>; })}</g>
            </svg></div>
            <ArtistPanel lang={lang} selected={selected} edges={selectedEdges} nodeById={nodeById} onSelect={selectArtist} />
          </div>
          <RelationshipList lang={lang} selected={selected} edges={selectedEdges} nodeById={nodeById} onSelect={selectArtist} />
        </>}
      </section>

      {overview.data ? <OverviewSections lang={lang} overview={overview.data} /> : null}

      <section className="insights-playlists" aria-labelledby="playlist-insights-title"><header className="insights-section-heading"><div><p className="eyebrow">{lang === "zh" ? "歌单 / 规范化重叠" : "PLAYLISTS / CANONICAL OVERLAP"}</p><h2 id="playlist-insights-title">{t.playlistIntelligence}</h2><p>{t.playlistBody}</p></div></header>
        {playlists.state === "loading" ? <LoadingSection lang={lang} /> : playlists.state === "error" ? <SectionError lang={lang} retry={load} /> : <PlaylistSections lang={lang} data={playlists.data!} />}
      </section>

      <section className="insights-rediscovery" aria-labelledby="rediscovery-title"><header className="insights-section-heading"><div><p className="eyebrow">{lang === "zh" ? "重新发现 / 已收藏音乐" : "REDISCOVERY / SAVED MUSIC"}</p><h2 id="rediscovery-title">{t.rediscovery}</h2><p>{t.rediscoveryBody}</p></div></header>
        {rediscovery.state === "loading" ? <LoadingSection lang={lang} /> : rediscovery.state === "error" ? <SectionError lang={lang} retry={load} /> : (rediscovery.data?.items ?? []).length === 0 ? <p className="insights-evidence-empty">{t.noRediscovery}</p> : <div className="rediscovery-grid">{(rediscovery.data?.items ?? []).map((item) => <article key={item.id} className="rediscovery-card"><Artwork src={item.artwork_url} alt="" className="rediscovery-artwork" sizes="(max-width: 767px) 96px, 160px" /><div><span>{t.inLibrary}</span><h3>{item.title}</h3>{item.subtitle ? <p>{item.subtitle}</p> : null}<small>{item.explanation}</small></div></article>)}</div>}
      </section>

      <section className="insights-boundaries" aria-labelledby="boundaries-title"><div><p className="eyebrow">{lang === "zh" ? "数据 / 如实呈现" : "DATA / HONEST BOUNDARIES"}</p><h2 id="boundaries-title">{t.boundaries}</h2></div><article><span>01</span><h3>{t.genreTitle}</h3><p>{t.genreMissing}</p></article><article><span>02</span><h3>{t.timelineTitle}</h3><p>{t.timelineMissing}</p></article></section>
    </>}
  </div>;
}

function ArtistPanel({ lang, selected, edges, nodeById, onSelect }: { lang: Lang; selected: UniverseNode | null; edges: UniverseEdge[]; nodeById: Map<string, UniverseNode>; onSelect: (id: string) => void }) {
  const t = copy[lang];
  if (!selected) return <aside className="artist-insight-panel artist-insight-empty"><div aria-hidden="true">◌</div><p>{t.selectHint}</p></aside>;
  return <aside className="artist-insight-panel" aria-live="polite"><Artwork src={selected.artwork_url} alt="" className="artist-insight-artwork" sizes="180px" /><p className="eyebrow">{lang === "zh" ? "已选择 / 艺人" : "SELECTED / ARTIST"}</p><h3>{selected.name}</h3><div className="artist-insight-affinity"><span>{t.strongestAffinity}</span><strong>{percent(selected.affinity, lang)}</strong><i><b style={{ width: `${Math.min(100, selected.affinity * 100)}%` }} /></i></div><dl><div><dt>{t.savedTracks}</dt><dd>{number(selected.saved_track_count, lang)}</dd></div><div><dt>{t.playlistAppearances}</dt><dd>{number(selected.playlist_count, lang)}</dd></div><div><dt>{t.representedAlbums}</dt><dd>{number(selected.represented_album_count, lang)}</dd></div><div><dt>{t.collaborationTracks}</dt><dd>{number(selected.collaboration_track_count, lang)}</dd></div></dl><h4>{t.connectedArtists}</h4><div className="artist-mini-relations">{edges.slice(0, 4).map((edge) => { const relatedId = edge.source === selected.id ? edge.target : edge.source; const related = nodeById.get(relatedId); return related ? <button key={edge.id} onClick={() => onSelect(related.id)}><strong>{related.name}</strong><span>{number(edge.shared_playlist_count, lang)} {t.sharedPlaylists} · {number(edge.collaboration_track_count, lang)} {t.collaborationTracks}</span></button> : null; })}</div><Link className="button button-primary" href={`/artist/${selected.id}`}>{t.viewArtist}</Link></aside>;
}

function RelationshipList({ lang, selected, edges, nodeById, onSelect }: { lang: Lang; selected: UniverseNode | null; edges: UniverseEdge[]; nodeById: Map<string, UniverseNode>; onSelect: (id: string) => void }) {
  const t = copy[lang];
  return <section className="universe-text-fallback" aria-labelledby="relationship-list-title"><header><div><p className="eyebrow">{lang === "zh" ? "关系 / 证据" : "RELATIONSHIPS / EVIDENCE"}</p><h3 id="relationship-list-title">{t.accessibleTitle}</h3></div><p>{t.accessibleBody}</p></header>{edges.length === 0 ? <p className="insights-evidence-empty">{t.notEnough}</p> : <ol>{edges.map((edge) => { const relatedId = selected ? (edge.source === selected.id ? edge.target : edge.source) : edge.target; const source = nodeById.get(edge.source); const target = nodeById.get(edge.target); const related = nodeById.get(relatedId); return source && target && related ? <li key={edge.id}><button onClick={() => onSelect(related.id)}><span>{selected ? related.name : `${source.name} ↔ ${target.name}`}</span><strong>{number(edge.shared_playlist_count, lang)} {t.sharedPlaylists}</strong><strong>{number(edge.collaboration_track_count, lang)} {t.collaborationTracks}</strong><small>{t.relationshipWeight} {edge.weight.toFixed(3)}</small></button></li> : null; })}</ol>}</section>;
}

function OverviewSections({ lang, overview }: { lang: Lang; overview: Overview }) {
  const t = copy[lang];
  const buckets = overview.concentration.long_tail ?? [];
  const maxBucket = Math.max(...buckets.map((bucket) => bucket.artist_count), 1);
  return <>
    <section className="insights-structure" aria-labelledby="structure-title"><header className="insights-section-heading"><div><p className="eyebrow">{t.structureKicker}</p><h2 id="structure-title">{t.structure}</h2><p>{t.structureBody}</p></div></header><div className="profile-metrics">{(overview.profile_metrics ?? []).map((metric, index) => <article key={metric.code}><span>0{index + 1}</span><h3>{metricNames[lang][metric.code] ?? metric.code}</h3><strong>{metric.code === "album_depth" ? metric.value.toFixed(2) : percent(metric.value, lang)}</strong><details><summary>{t.formula}</summary><p>{metric.formula}</p></details></article>)}</div></section>
    <section className="concentration-section"><div className="concentration-copy"><p className="eyebrow">{lang === "zh" ? "集中度 / 累计" : "CONCENTRATION / CUMULATIVE"}</p><h2>{t.concentration}</h2><div className="concentration-median"><strong>{overview.concentration.median_tracks_per_artist.toFixed(1)}</strong><span>{t.median}</span></div></div><div className="concentration-bars"><ConcentrationBar label={t.top10} value={overview.concentration.top_10_track_share} lang={lang} /><ConcentrationBar label={t.top50} value={overview.concentration.top_50_track_share} lang={lang} /></div></section>
    <section className="long-tail-section"><header><div><p className="eyebrow">{lang === "zh" ? "分布 / 收藏曲目" : "DISTRIBUTION / SAVED TRACKS"}</p><h2>{t.longTail}</h2></div><p>{t.longTailBody}</p></header><div className="long-tail-chart">{buckets.map((bucket) => <div key={bucket.key}><span>{t[bucket.key]}</span><i><b style={{ width: `${bucket.artist_count / maxBucket * 100}%` }} /></i><strong>{number(bucket.artist_count, lang)} {t.artistUnit}</strong></div>)}</div></section>
    <section className="collaboration-section"><header className="insights-section-heading"><div><p className="eyebrow">{lang === "zh" ? "合作 / 艺人曲目关系" : "COLLABORATION / TRACKARTIST"}</p><h2>{t.collaboration}</h2><p>{t.collaborationBody}</p></div></header><div className="collaboration-summary"><span><strong>{number(overview.collaboration.multi_artist_tracks, lang)}</strong>{t.multiArtistTracks}</span><span><strong>{percent(overview.collaboration.multi_artist_track_share, lang)}</strong>{t.collaborationDensity}</span><span><strong>{number(overview.collaboration.relationship_pairs_with_collaboration, lang)}</strong>{t.collaborationPairs}</span></div>{(overview.strongest_collaborations ?? []).length === 0 ? <p className="insights-evidence-empty">{t.noCollaboration}</p> : <ol className="collaboration-list">{(overview.strongest_collaborations ?? []).map((pair) => <li key={`${pair.source_artist_id}:${pair.target_artist_id}`}><div><Link href={`/artist/${pair.source_artist_id}`}>{pair.source_artist_name}</Link><span>↔</span><Link href={`/artist/${pair.target_artist_id}`}>{pair.target_artist_name}</Link></div><p>{number(pair.shared_playlist_count, lang)} {t.sharedPlaylists} · {number(pair.collaboration_track_count, lang)} {t.collaborationTracks}</p></li>)}</ol>}</section>
  </>;
}

function ConcentrationBar({ label, value, lang }: { label: string; value: number; lang: Lang }) {
  return <div><header><span>{label}</span><strong>{percent(value, lang)}</strong></header><i><b style={{ width: `${Math.min(100, value * 100)}%` }} /></i></div>;
}

function PlaylistSections({ lang, data }: { lang: Lang; data: Playlists }) {
  const t = copy[lang];
  return <>{(data.strongest_overlaps ?? []).length === 0 ? <p className="insights-evidence-empty">{t.noOverlap}</p> : <div className="playlist-overlap-grid">{(data.strongest_overlaps ?? []).slice(0, 8).map((overlap, index) => <article key={`${overlap.source_playlist_id}:${overlap.target_playlist_id}`}><span>0{index + 1}</span><div className="playlist-pair"><Link href={`/playlist/${overlap.source_playlist_id}`}>{overlap.source_playlist_name}</Link><i>↔</i><Link href={`/playlist/${overlap.target_playlist_id}`}>{overlap.target_playlist_name}</Link></div><div className="playlist-overlap-meter"><i><b style={{ width: `${overlap.jaccard_similarity * 100}%` }} /></i><strong>{percent(overlap.jaccard_similarity, lang)}</strong></div><dl><div><dt>{t.sharedTracks}</dt><dd>{number(overlap.shared_track_count, lang)}</dd></div><div><dt>{overlap.source_playlist_name}</dt><dd>{number(overlap.source_track_count, lang)} {t.tracksShort}</dd></div><div><dt>{overlap.target_playlist_name}</dt><dd>{number(overlap.target_track_count, lang)} {t.tracksShort}</dd></div></dl></article>)}</div>}<div className="playlist-coverage"><h3>{t.uniqueCoverage}</h3>{(data.playlists ?? []).slice(0, 8).map((playlist) => <div key={playlist.id}><Link href={`/playlist/${playlist.id}`}>{playlist.name}</Link><i><b style={{ width: `${playlist.unique_library_coverage * 100}%` }} /></i><strong>{percent(playlist.unique_library_coverage, lang)}</strong><small>{number(playlist.track_count, lang)} {t.tracksShort} · {number(playlist.distinct_artist_count, lang)} {t.artists}</small></div>)}</div></>;
}
