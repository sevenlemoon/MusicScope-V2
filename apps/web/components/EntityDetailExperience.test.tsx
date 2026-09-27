import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EntityDetailExperience } from "./EntityDetailExperience";
import { PlayerProvider } from "./PlayerProvider";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function response(payload: object) { return Promise.resolve({ ok: true, json: async () => payload }); }
const trackPage = { items: [{ id: "t1", title: "Canonical song", artwork_url: null, duration_ms: 200000, album_id: "al1", album: "Canonical album", artists: ["Artist One", "Artist Two"], artist_items: [{ id: "a1", name: "Artist One" }, { id: "a2", name: "Artist Two" }], sort_group: "C", playlist_position: 1 }], total: 1, range_start: 1, range_end: 1, next_cursor: null, previous_cursor: null, groups: [], sort: "asc", group: null };

function renderDetail(type: "artist" | "album" | "playlist" | "track", id: string) {
  return render(<PlayerProvider><EntityDetailExperience type={type} id={id} /></PlayerProvider>);
}

describe("canonical detail pages", () => {
  beforeEach(() => {
    push.mockReset();
    global.fetch = jest.fn((input) => {
      const url = String(input);
      if (url.includes("/stem-jobs")) return response({ status: "ACCOUNT_SONG_SELECTED", message: "Choose a model in Studio.", studio_url: "/studio?source=account&track=t1" }) as never;
      if (url.endsWith("/artists/a1")) return response({ id: "a1", name: "Artist One", artwork_url: "https://image.invalid/artist.jpg", library_track_count: 1, represented_album_count: 1 }) as never;
      if (url.includes("/artists/a1/tracks")) return response(trackPage) as never;
      if (url.includes("/artists/a1/albums")) return response({ items: [{ id: "al1", title: "Canonical album", artwork_url: null, artists: [{ id: "a1", name: "Artist One" }], sort_group: "C" }], total: 1, range_start: 1, range_end: 1, groups: [], sort: "asc" }) as never;
      if (url.includes("/albums/al1?")) return response({ id: "al1", title: "Canonical album", artwork_url: null, artists: [{ id: "a1", name: "Artist One" }], library_track_count: 1 }) as never;
      if (url.includes("/albums/al1/tracks")) return response(trackPage) as never;
      if (url.includes("/playlists/p1?")) return response({ id: "p1", name: "Canonical playlist", artwork_url: null, provider_track_count: 1, synchronized_track_count: 1 }) as never;
      if (url.includes("/playlists/p1/tracks")) return response({ ...trackPage, sort: "original" }) as never;
      if (url.endsWith("/tracks/t1")) return response({ id: "t1", title: "Canonical song", artwork_url: null, duration_ms: 200000, artists: [{ id: "a1", name: "Artist One" }], album: { id: "al1", name: "Canonical album" }, playlists: [{ id: "p1", name: "Canonical playlist" }] }) as never;
      return response({}) as never;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it("renders an artist with saved tracks while keeping the list focused on the lead credit", async () => {
    renderDetail("artist", "a1");
    expect(await screen.findByRole("heading", { name: "Artist One", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Albums in your library" })).toBeInTheDocument();
    expect(screen.queryByText("Artist Two")).not.toBeInTheDocument();
  });

  it("renders an album and its canonical track list", async () => {
    renderDetail("album", "al1");
    expect(await screen.findByRole("heading", { name: "Canonical album", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Synchronized tracks on this album" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Canonical song" })).toHaveAttribute("href", "/track/t1");
  });

  it("renders playlist order controls and its paged real tracks", async () => {
    renderDetail("playlist", "p1");
    expect(await screen.findByRole("heading", { name: "Canonical playlist", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Playlist order" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1–1 of 1")).toBeInTheDocument();
  });

  it("renders track relationships and routes Separate Stems to account-song mode", async () => {
    renderDetail("track", "t1");
    expect(await screen.findByRole("heading", { name: "Canonical song", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Artist One")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Artist One" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Artist Two" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Separate stems" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/studio?source=account&track=t1"));
  });
});
