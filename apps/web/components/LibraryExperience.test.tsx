import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LibraryExperience } from "./LibraryExperience";
import { PlayerProvider } from "./PlayerProvider";

jest.setTimeout(30000);

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

function response(payload: object) { return Promise.resolve({ ok: true, json: async () => payload }); }
const pageBase = { total: 1, next_cursor: null, previous_cursor: null, range_start: 1, range_end: 1, groups: [{ key: "R", count: 1 }], sort: "asc", group: null };

describe("LibraryExperience", () => {
  beforeEach(() => {
    pushMock.mockReset();
    global.fetch = jest.fn((input) => {
      const url = String(input);
      if (url.includes("/summary")) return response({ connection_state: "connected", sync_state: "complete", counts: { playlists: 1, albums: 1, artists: 1, tracks: 1 }, items: [] }) as never;
      if (url.includes("/search")) {
        if (url.includes("no-match")) return response({ query: "no-match", tracks: [], artists: [], albums: [], playlists: [], total: 0, next_cursor: null, previous_cursor: null, range_start: 0, range_end: 0 }) as never;
        const unicode = url.includes("%E5%A4%9C");
        return response({
          query: unicode ? "夜" : "MILET",
          tracks: [{ entity_type: "track", match: "prefix", track: { id: "st1", title: unicode ? "夜に駆ける" : "Search track", artwork_url: null, duration_ms: 180000, album_id: "sal1", album: "Search album", artists: ["Search artist"], artist_items: [{ id: "sa1", name: "Search artist" }], sort_group: "S" } }],
          artists: [{ entity_type: "artist", match: "exact", artist: { id: "sa1", name: "Search artist", artwork_url: null, sort_group: "S" }, library_track_count: 8 }],
          albums: [{ entity_type: "album", match: "prefix", album: { id: "sal1", title: "Search album", artwork_url: null, artists: [{ id: "sa1", name: "Search artist" }], sort_group: "S" } }],
          playlists: [{ entity_type: "playlist", match: "substring", playlist: { id: "sp1", name: "Search playlist", artwork_url: null, track_count: 12, sort_group: "S" } }],
          total: 30,
          next_cursor: url.includes("cursor=24") ? null : "24",
          previous_cursor: url.includes("cursor=24") ? "0" : null,
          range_start: url.includes("cursor=24") ? 25 : 1,
          range_end: url.includes("cursor=24") ? 30 : 24,
        }) as never;
      }
      if (url.includes("/playback-source")) return response({ track_id: "st1", source_type: "provider_stream", url: "https://temporary.invalid/audio", mime_type: "audio/mpeg", provider: "netease", resolution_ms: 20 }) as never;
      if (url.includes("/stem-jobs")) return response({ status: "LOCAL_UPLOAD_REQUIRED", studio_url: "/studio?source=local-upload&track=st1" }) as never;
      if (url.includes("/playlists")) return response({ ...pageBase, next_cursor: "24", items: [{ id: "p1", name: "Real playlist", artwork_url: null, track_count: 120, sort_group: "R" }] }) as never;
      if (url.includes("/albums")) return response({ ...pageBase, items: [{ id: "al1", title: "Real album", artwork_url: null, artists: [{ id: "a1", name: "Artist A" }], sort_group: "R" }] }) as never;
      if (url.includes("/artists")) return response({ ...pageBase, items: [{ id: "a1", name: "Real artist", artwork_url: null, sort_group: "R" }] }) as never;
      return response({ ...pageBase, items: [{ id: "t1", title: "Real track", artwork_url: null, album_id: "al1", album: "Real album", artists: ["Artist A", "Artist B"], artist_items: [{ id: "a1", name: "Artist A" }, { id: "a2", name: "Artist B" }], sort_group: "R" }] }) as never;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it("provides global pagination and an accessible A–Z index with empty groups disabled", async () => {
    render(<PlayerProvider><LibraryExperience /></PlayerProvider>);
    expect(await screen.findByText("Real playlist")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Real playlist/ })).toHaveAttribute("href", "/playlist/p1");
    expect(screen.getByRole("button", { name: "A" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "R" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("cursor=24"), expect.anything()));
  });

  it("links every canonical card and displays all artists on a track", async () => {
    render(<PlayerProvider><LibraryExperience /></PlayerProvider>);
    await screen.findByText("Real playlist");
    fireEvent.click(screen.getByRole("tab", { name: /albums/i }));
    expect(await screen.findByRole("link", { name: /Real album/ })).toHaveAttribute("href", "/album/al1");
    fireEvent.click(screen.getByRole("tab", { name: /artists/i }));
    expect(await screen.findByRole("link", { name: /Real artist/ })).toHaveAttribute("href", "/artist/a1");
    fireEvent.click(screen.getByRole("tab", { name: /tracks/i }));
    expect(await screen.findByRole("link", { name: "Real track" })).toHaveAttribute("href", "/track/t1");
    expect(screen.getByText("Artist A")).toBeInTheDocument();
    expect(screen.getByText("Artist B")).toBeInTheDocument();
  });

  it("searches all entity types, preserves actions and pagination, and clears with Escape", async () => {
    render(<PlayerProvider><LibraryExperience /></PlayerProvider>);
    await screen.findByText("Real playlist");
    const input = screen.getByPlaceholderText("Search tracks, artists, albums, playlists");
    fireEvent.change(input, { target: { value: "  MILET  " } });
    fireEvent.submit(screen.getByRole("search"));

    expect(await screen.findByRole("link", { name: "Search track" })).toHaveAttribute("href", "/track/st1");
    expect(screen.getByRole("link", { name: "Search artist 8 library tracks · exact match" })).toHaveAttribute("href", "/artist/sa1");
    expect(screen.getByRole("link", { name: "Search album Search artist · prefix match" })).toHaveAttribute("href", "/album/sal1");
    expect(screen.getByRole("link", { name: "Search playlist 12 tracks · substring match" })).toHaveAttribute("href", "/playlist/sp1");
    expect(screen.queryByRole("navigation", { name: "Filter by first character" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Play Search track" }));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Separate stems for Search track" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/studio?source=local-upload&track=st1"));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("cursor=24"), expect.anything()));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(await screen.findByRole("navigation", { name: "Filter by first character" })).toBeInTheDocument();
  });

  it("renders Unicode and honest no-result searches", async () => {
    render(<PlayerProvider><LibraryExperience /></PlayerProvider>);
    await screen.findByText("Real playlist");
    const input = screen.getByPlaceholderText("Search tracks, artists, albums, playlists");
    fireEvent.change(input, { target: { value: "夜" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByRole("link", { name: "夜に駆ける" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "no-match" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByText(/No tracks, artists, albums, or playlists match/)).toBeInTheDocument();
  });
});
