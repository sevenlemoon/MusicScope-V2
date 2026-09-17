import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DiscoverExperience } from "./DiscoverExperience";
import { HomeExperience } from "./HomeExperience";
import { PlayerProvider } from "./PlayerProvider";

const track = {
  entity_type: "track",
  canonical_entity_id: "track-1",
  title: "Real recommendation",
  subtitle: "Artist One",
  artwork_url: null,
  score: 0.81,
  confidence: 0.77,
  confidence_label: "strong",
  strategy: "REDISCOVER",
  evidence: [{ code: "REDISCOVERY_SIGNAL", label: "Playlist appearances", value: 1 }],
  explanation: "Saved in your library; an underrepresented track connected to Artist One.",
  is_in_library: true,
  source: "musicscope_library",
  generated_at: "2026-09-15T00:00:00Z",
  track: {
    id: "track-1",
    title: "Real recommendation",
    artwork_url: null,
    duration_ms: 180000,
    album_id: "album-1",
    album: "Album One",
    artists: ["Artist One"],
    artist_items: [{ id: "artist-1", name: "Artist One" }],
    sort_group: "R",
  },
};

const artist = {
  ...track,
  entity_type: "artist",
  canonical_entity_id: "artist-2",
  title: "Adjacent Artist",
  subtitle: null,
  strategy: "ADJACENT_ARTIST",
  explanation: "Appears alongside Artist One across 3 of your playlists.",
  track: null,
};

const externalTrack = {
  entity_type: "track",
  canonical_entity_id: null,
  provider_identity: { provider: "netease", entity_type: "track", provider_id: "provider-track-901" },
  title: "Outside the library",
  subtitle: "Artist One · Collaborator",
  artwork_url: "https://example.invalid/external.jpg",
  score: 0.86,
  confidence: 0.8,
  confidence_label: "strong",
  strategy: "EXTERNAL_COLLABORATION",
  evidence: [{ code: "AFFINITY_SEED", label: "Profile seed", value: "Artist One" }],
  explanation: "An unsaved collaboration from Artist One, an artist strongly represented in your collection.",
  is_in_library: false,
  source: "netease_external",
  generated_at: "2026-09-17T00:00:00Z",
  track: null,
  external_track: {
    provider: "netease",
    provider_id: "provider-track-901",
    title: "Outside the library",
    artwork_url: "https://example.invalid/external.jpg",
    duration_ms: 200000,
    artists: [
      { provider_id: "provider-artist-1", name: "Artist One", artwork_url: null },
      { provider_id: "provider-artist-2", name: "Collaborator", artwork_url: null },
    ],
    album: { provider_id: "provider-album-1", title: "External album", artwork_url: null },
  },
  discovery_distance: 1,
};

const profile = {
  profile_id: "profile-1",
  version: 2,
  stale: false,
  exploration_level: 50,
  artist_count: 120,
  album_count: 180,
  relationship_count: 420,
  playlist_count: 12,
  track_count: 600,
  largest_playlist: 2513,
  largest_playlist_weight: 0.141055,
  generated_at: "2026-09-15T00:00:00Z",
  timings_ms: {},
  top_artists: [],
  top_albums: [],
  relationships: [],
};

function response(payload: object, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

describe("R2 recommendation experiences", () => {
  beforeEach(() => {
    global.fetch = jest.fn((input, init) => {
      const url = String(input);
      if (url.includes("/profile/rebuild")) return response({ status: "rebuilt" }) as never;
      if (url.endsWith("/profile")) return response(profile) as never;
      if (url.includes("/recommendations/home")) return response({
        generated_at: "2026-09-15T00:00:00Z",
        exploration_level: 50,
        made_for_you: [track, artist],
        rediscover: [track],
        strong_artists: [artist],
        explore_next: [artist],
        candidate_counts: { rediscover: 1, adjacent_artist: 1, external_discovery: 0 },
        timings_ms: {},
        external_state: "fresh",
        cache_generated_at: "2026-09-17T00:00:00Z",
      }) as never;
      if (url.includes("/recommendations/discover")) return response({
        generated_at: "2026-09-15T00:00:00Z",
        category: url.includes("category=external") ? "external" : url.includes("rediscover") ? "rediscover" : "for-you",
        exploration_level: 50,
        items: url.includes("category=external") ? [externalTrack] : [track, artist],
        candidate_counts: { rediscover: 1, adjacent_artist: 1, external_discovery: 1 },
        timings_ms: {},
        external_state: "fresh",
        cache_generated_at: "2026-09-17T00:00:00Z",
      }) as never;
      if (url.includes("/recommendations/settings")) return response(profile) as never;
      if (url.includes("/recommendations/feedback")) return response({ status: "saved" }) as never;
      if (url.includes("/playback-source")) return response({
        track_id: "track-1",
        source_type: "provider_stream",
        url: "https://temporary.invalid/audio",
        mime_type: "audio/mpeg",
        provider: "netease",
        resolution_ms: 18,
      }) as never;
      throw new Error(`Unexpected request ${url} ${init?.method ?? "GET"}`);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it("renders real Home recommendations with playback, evidence, and canonical navigation", async () => {
    render(<PlayerProvider><HomeExperience /></PlayerProvider>);
    expect(await screen.findAllByText("Real recommendation")).not.toHaveLength(0);
    expect(screen.getAllByText(/Saved in your library/)[0]).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Open Real recommendation" })[0]).toHaveAttribute("href", "/track/track-1");
    fireEvent.click(screen.getAllByRole("button", { name: "Play Real recommendation" })[0]);
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("switches Discover strategies, persists exploration, and removes feedback", async () => {
    render(<PlayerProvider><DiscoverExperience /></PlayerProvider>);
    expect(await screen.findByText("Real recommendation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Rediscover/ }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("category=rediscover"), expect.anything()));
    const slider = screen.getByRole("slider", { name: "Familiar to Exploratory" });
    fireEvent.change(slider, { target: { value: "90" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/settings"), expect.objectContaining({ method: "PATCH" })));
    fireEvent.click(screen.getByRole("button", { name: "Not interested in Real recommendation" }));
    await waitFor(() => expect(screen.queryByText("Real recommendation")).not.toBeInTheDocument());
  });

  it("offers an explicit build without rebuilding during rendering", async () => {
    global.fetch = jest.fn(() => response({}, 409) as never);
    render(<PlayerProvider><HomeExperience /></PlayerProvider>);
    expect(await screen.findByRole("button", { name: "Build my taste profile" })).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/profile/rebuild"), expect.anything());
  });

  it("renders explicit external identity, navigation, playback, and feedback without a canonical ID", async () => {
    render(<PlayerProvider><DiscoverExperience /></PlayerProvider>);
    await screen.findByText("Real recommendation");
    fireEvent.click(screen.getByRole("button", { name: /^New/ }));
    expect(await screen.findByText("Outside the library")).toBeInTheDocument();
    expect(screen.getByText("New to your library")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Outside the library" })).toHaveAttribute("href", "/discover/track/netease/provider-track-901");
    fireEvent.click(screen.getByRole("button", { name: "Play Outside the library" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/external/netease/tracks/provider-track-901/playback-source"),
      expect.objectContaining({ method: "POST" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Not interested in Outside the library" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/feedback"),
      expect.objectContaining({ body: expect.stringContaining('"provider_id":"provider-track-901"') }),
    ));
  });
});
