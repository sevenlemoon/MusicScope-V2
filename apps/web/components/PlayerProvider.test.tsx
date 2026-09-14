import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePlayer, PlayerProvider } from "./PlayerProvider";

class FakeAudio extends EventTarget {
  src = ""; preload = ""; volume = 1; currentTime = 0; duration = 182; paused = true;
  load() { this.dispatchEvent(new Event("loadedmetadata")); }
  async play() { this.paused = false; this.dispatchEvent(new Event("playing")); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  removeAttribute() { this.src = ""; }
}

const track = { id: "t1", title: "Playable track", artwork_url: null, duration_ms: 182000, album_id: null, album: null, artists: ["Artist A"], artist_items: [], sort_group: "P", playlist_position: null };

function Harness() {
  const player = usePlayer();
  return <><button onClick={() => void player.playTrack(track)}>Start test track</button><button onClick={() => void player.toggle()}>Toggle test track</button></>;
}

describe("global player", () => {
  beforeEach(() => { global.Audio = FakeAudio as unknown as typeof Audio; });
  afterEach(() => jest.restoreAllMocks());

  it("loads a transient source and exposes play/pause, timeline, and volume controls", async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ track_id: "t1", source_type: "provider_stream", url: "https://temporary.invalid/audio", mime_type: "audio/mpeg", provider: "netease", resolution_ms: 20 }) })) as jest.Mock;
    render(<PlayerProvider><Harness /></PlayerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Start test track" }));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Playback position" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Volume" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("shows an honest playback error without leaking response material", async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 422, json: async () => ({ detail: "unavailable" }) })) as jest.Mock;
    render(<PlayerProvider><Harness /></PlayerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Start test track" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("current account");
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument());
  });
});
