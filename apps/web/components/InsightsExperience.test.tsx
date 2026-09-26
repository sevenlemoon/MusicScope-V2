import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { InsightsExperience } from "./InsightsExperience";
import { LocaleProvider } from "./LocaleProvider";
import type { components } from "@/lib/api-schema.generated";
import { layoutUniverse } from "@/lib/insights-layout";

type UniverseNode = components["schemas"]["UniverseNode"];

const nodes: UniverseNode[] = [
  { id: "a1", name: "Artist A", artwork_url: null, affinity: .92, saved_track_count: 24, playlist_count: 7, represented_album_count: 5, collaboration_track_count: 3, community_id: "community-01" },
  { id: "a2", name: "Artist B", artwork_url: null, affinity: .64, saved_track_count: 12, playlist_count: 4, represented_album_count: 3, collaboration_track_count: 2, community_id: "community-01" },
  { id: "a3", name: "Artist C", artwork_url: null, affinity: .31, saved_track_count: 4, playlist_count: 1, represented_album_count: 1, collaboration_track_count: 0, community_id: "community-02" },
];

const overview = {
  profile_state: "current",
  generated_at: "2026-09-24T00:00:00Z",
  counts: { tracks: 120, artists: 48, albums: 72, playlists: 8 },
  concentration: {
    top_10_track_share: .48,
    top_50_track_share: .92,
    median_tracks_per_artist: 2,
    long_tail: [
      { key: "one", minimum_tracks: 1, maximum_tracks: 1, artist_count: 20 },
      { key: "two_to_five", minimum_tracks: 2, maximum_tracks: 5, artist_count: 18 },
      { key: "six_to_twenty", minimum_tracks: 6, maximum_tracks: 20, artist_count: 8 },
      { key: "twenty_one_to_fifty", minimum_tracks: 21, maximum_tracks: 50, artist_count: 2 },
      { key: "fifty_one_plus", minimum_tracks: 51, maximum_tracks: null, artist_count: 0 },
    ],
  },
  collaboration: { multi_artist_tracks: 14, multi_artist_track_share: .116667, relationship_pairs_with_collaboration: 6 },
  profile_metrics: [
    { code: "artist_concentration", value: .48, formula: "top artist tracks / saved tracks", evidence: {} },
    { code: "library_breadth", value: .4, formula: "canonical artists / canonical tracks", evidence: {} },
    { code: "album_depth", value: 1.666667, formula: "canonical tracks / represented albums", evidence: {} },
    { code: "collaboration_density", value: .116667, formula: "multi-artist tracks / canonical tracks", evidence: {} },
  ],
  top_artists: [{ id: "a1", name: "Artist A", artwork_url: null, affinity: .92, confidence: .8, saved_track_count: 24, playlist_count: 7, represented_album_count: 5, collaboration_track_count: 3 }],
  strongest_collaborations: [{ source_artist_id: "a1", source_artist_name: "Artist A", target_artist_id: "a2", target_artist_name: "Artist B", shared_playlist_count: 3, collaboration_track_count: 2, relationship_weight: .82 }],
  genre_coverage: { reliable_track_count: 0, missing_track_count: 120, coverage: 0, sources: [], sufficient_for_primary_insight: false },
  formulas: {}, timings_ms: { total: 12 },
};

const universe = {
  profile_state: "current",
  node_metric: "canonical_library_affinity",
  node_cap: 100,
  edge_cap: 360,
  per_node_edge_cap: 8,
  nodes,
  edges: [
    { id: "a1:a2", source: "a1", target: "a2", weight: .82, shared_playlist_count: 3, collaboration_track_count: 2 },
    { id: "a2:a3", source: "a2", target: "a3", weight: .35, shared_playlist_count: 1, collaboration_track_count: 0 },
  ],
  communities: [{ id: "community-01", artist_count: 2, representative_artists: ["Artist A", "Artist B"] }],
  formulas: {}, timings_ms: { total: 8 },
};

const playlists = {
  playlists: [
    { id: "p1", name: "Playlist One", artwork_url: null, track_count: 30, distinct_artist_count: 20, distinct_album_count: 24, multi_artist_track_count: 4, leading_artist_track_share: .2, unique_library_coverage: .4 },
    { id: "p2", name: "Playlist Two", artwork_url: null, track_count: 20, distinct_artist_count: 13, distinct_album_count: 17, multi_artist_track_count: 3, leading_artist_track_share: .15, unique_library_coverage: .25 },
  ],
  strongest_overlaps: [{ source_playlist_id: "p1", source_playlist_name: "Playlist One", source_track_count: 30, target_playlist_id: "p2", target_playlist_name: "Playlist Two", target_track_count: 20, shared_track_count: 10, jaccard_similarity: .25 }],
  similarity_formula: "intersection / union",
  uniqueness_formula: "unique / playlist tracks",
  timings_ms: { total: 14 },
};

const rediscovery = {
  profile_state: "current",
  semantics: "Saved tracks outside the strongest current library-profile signals.",
  items: [{ id: "t1", title: "Quiet Track", subtitle: "Saved Artist", artwork_url: null, score: .44, explanation: "Saved music outside the strongest current profile signals.", strategy: "REDISCOVER", is_in_library: true }],
  timings_ms: { total: 2 },
};

function response(payload: object, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

function installFetch(overrides?: { overview?: object; universe?: object; playlists?: object; rediscovery?: object; fail?: string }) {
  global.fetch = jest.fn((input) => {
    const url = String(input);
    if (overrides?.fail && url.includes(overrides.fail)) return response({ detail: "Unavailable" }, 500) as never;
    if (url.includes("/overview")) return response(overrides?.overview ?? overview) as never;
    if (url.includes("/universe")) return response(overrides?.universe ?? universe) as never;
    if (url.includes("/playlists")) return response(overrides?.playlists ?? playlists) as never;
    if (url.includes("/rediscovery")) return response(overrides?.rediscovery ?? rediscovery) as never;
    throw new Error(`Unexpected request ${url}`);
  });
}

function renderExperience() {
  return render(<LocaleProvider><InsightsExperience /></LocaleProvider>);
}

describe("R5 Insights experience", () => {
  beforeEach(() => {
    window.localStorage.removeItem("musicscope.locale");
    installFetch();
    window.requestAnimationFrame = (callback) => { callback(0); return 1; };
  });

  afterEach(() => jest.restoreAllMocks());

  it("starts in a truthful Chinese loading state and renders overview metrics", async () => {
    renderExperience();
    expect(screen.getByRole("heading", { name: "你的音乐宇宙" })).toBeInTheDocument();
    expect(screen.getByText("正在构建音乐宇宙…")).toBeInTheDocument();
    expect(await screen.findByText("120")).toBeInTheDocument();
    expect(screen.getAllByText("艺人集中度").length).toBeGreaterThan(0);
    expect(screen.getByText("长尾分布")).toBeInTheDocument();
    expect(screen.queryByText(/Most listened/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Most played/i)).not.toBeInTheDocument();
  });

  it("renders a deterministic graph, selects artists, searches, and exposes textual evidence", async () => {
    renderExperience();
    const graph = await screen.findByRole("img", { name: "可选择的艺人关系图" });
    expect(graph.querySelectorAll("[data-node-id]")).toHaveLength(3);
    const artistB = within(graph).getByRole("button", { name: "选择艺人: Artist B" });
    fireEvent.keyDown(artistB, { key: "Enter" });
    expect(artistB).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("3 共同歌单").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 合作曲目").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "打开艺人页面" })).toHaveAttribute("href", "/artist/a2");

    const search = screen.getByLabelText("在音乐宇宙中搜索艺人");
    fireEvent.change(search, { target: { value: "Artist C" } });
    fireEvent.submit(search.closest("form")!);
    await waitFor(() => expect(within(graph).getByRole("button", { name: "选择艺人: Artist C" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("heading", { name: "可访问的关系列表" })).toBeInTheDocument();
  });

  it("renders backend-owned playlist overlap and truthful rediscovery semantics", async () => {
    renderExperience();
    expect(await screen.findByRole("heading", { name: "歌单智能" })).toBeInTheDocument();
    expect(screen.getByText("10", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getAllByText("25%").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Playlist One" })[0]).toHaveAttribute("href", "/playlist/p1");
    expect(screen.getByRole("heading", { name: "重新发现候选" })).toBeInTheDocument();
    expect(screen.getByText("Quiet Track")).toBeInTheDocument();
    expect(screen.queryByText(/haven't listened|recently/i)).not.toBeInTheDocument();
  });

  it("shows genre and timeline data boundaries and supports English", async () => {
    renderExperience();
    expect(await screen.findByRole("heading", { name: "数据边界" })).toBeInTheDocument();
    expect(screen.getByText(/可靠曲风元数据尚不足/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("heading", { name: "Your Music Universe" })).toBeInTheDocument();
    expect(screen.getByText("Reliable genre metadata is not available for enough of this library to produce a meaningful genre summary.")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("handles an empty library without rendering fake analytics", async () => {
    installFetch({ overview: { ...overview, counts: { tracks: 0, artists: 0, albums: 0, playlists: 0 }, top_artists: [], profile_metrics: [] }, universe: { ...universe, profile_state: "missing_or_stale", nodes: [], edges: [], communities: [] }, playlists: { ...playlists, playlists: [], strongest_overlaps: [] }, rediscovery: { ...rediscovery, items: [] } });
    renderExperience();
    expect(await screen.findByRole("heading", { name: "连接音乐资料库，建立你的音乐宇宙。" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "连接音乐" })).toHaveAttribute("href", "/connect");
    expect(screen.queryByRole("img", { name: "可选择的艺人关系图" })).not.toBeInTheDocument();
  });

  it("isolates an optional API error instead of destroying the overview", async () => {
    installFetch({ fail: "/playlists" });
    renderExperience();
    expect(await screen.findByText("120")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "歌单智能" })).toBeInTheDocument();
    expect(screen.getByText("这一部分暂时无法读取")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

test("Music Universe layout is stable for the same canonical nodes", () => {
  expect([...layoutUniverse(nodes)]).toEqual([...layoutUniverse([...nodes])]);
});
