import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { PlayerProvider, usePlayer } from "./PlayerProvider";
import { playbackCoordinator, type PlaybackParticipant } from "@/lib/playback-ownership";

const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const json = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
const readable = () => ({ ok: true, type: "cors", body: { getReader: () => ({ read: async () => ({ value: new Uint8Array([1, 2, 3]), done: false }), cancel: jest.fn(async () => {}) }) } }) as unknown as Response;
class Media extends EventTarget {
  static all: Media[] = [];
  private address = ""; writes = 0; preload = ""; crossOrigin: string | null = null; volume = 1; currentTime = 0; duration = 120; paused = true; ended = false; readyState = 4; error: { code: number } | null = null;
  constructor() { super(); Media.all.push(this); }
  set src(v: string) { this.address = v; ++this.writes; } get src() { return this.address; }
  start() { this.paused = false; this.dispatchEvent(new Event("playing")); }
  play = jest.fn(async () => this.start());
  pause = jest.fn(() => { this.paused = true; this.dispatchEvent(new Event("pause")); });
  load = jest.fn(() => { this.dispatchEvent(new Event("loadedmetadata")); });
  removeAttribute() { this.address = ""; }
}
class AudioNodeMock {
  gain = { value: 1 }; fftSize = 8192; smoothingTimeConstant = 0; frequencyBinCount = 4096; signal = -25;
  connect = jest.fn(); disconnect = jest.fn();
  getFloatFrequencyData = jest.fn((data: Float32Array) => { data.fill(-Infinity); data[171] = this.signal; });
}
class Context extends EventTarget {
  static failAnalysis = false; static failBinding = false; static all: Context[] = []; static bound = new WeakSet<Media>();
  state = "suspended"; sampleRate = 48000; destination = new AudioNodeMock(); analyser = new AudioNodeMock(); gain = new AudioNodeMock(); source = new AudioNodeMock();
  constructor() { super(); Context.all.push(this); }
  createGain = jest.fn(() => this.gain); createAnalyser = jest.fn(() => { if (Context.failAnalysis) throw Error("allocation"); return this.analyser; });
  createMediaElementSource = jest.fn((audio: Media) => { if (Context.bound.has(audio)) throw Error("double bind"); Context.bound.add(audio); if (Context.failBinding) throw Error("binding"); return this.source; });
  async resume() { this.state = "running"; }
  close = jest.fn(async () => { this.state = "closed"; this.dispatchEvent(new Event("statechange")); });
}
const track = (id: string) => ({ id, title: `Song ${id}`, artists: [], sort_group: "S" });
function Harness() { const p = usePlayer(); return <><button onClick={() => void p.playTrack(track("A"))}>Start A</button><button onClick={() => void p.playTrack(track("B"))}>Start B</button><button onClick={() => void p.toggle()}>Toggle</button><output data-testid="state">{p.current?.id}:{p.status}</output></>; }
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
let participants: PlaybackParticipant[];
let permission: (input: string, init?: RequestInit) => Promise<Response>;
const apiCalls = () => jest.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/playback-source"));
beforeAll(() => { HTMLDialogElement.prototype.showModal ||= function () {}; HTMLDialogElement.prototype.close ||= function () {}; });
beforeEach(() => {
  jest.useFakeTimers(); Context.failAnalysis = false; Context.failBinding = false; Media.all = []; Context.all = []; Context.bound = new WeakSet(); participants = [];
  global.Audio = Media as unknown as typeof Audio; global.AudioContext = Context as unknown as typeof AudioContext;
  permission = async () => readable();
  global.fetch = jest.fn(async (input, init) => String(input).startsWith("http://localhost:8100") ? json({ url: `https://cdn.invalid/${String(input).includes('/B/') ? 'B' : 'A'}`, expires_at: null }) : permission(String(input), init));
  jest.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  jest.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect() {}, fillRect() {}, fillText() {}, setTransform() {} } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); participants.forEach(p => p.dispose()); jest.restoreAllMocks(); jest.useRealTimers(); });

test("readable source requires real FFT, one audible path and exactly one volume control", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Open full player");
  const graph = Context.all[0], audio = Media.all[0];
  expect(screen.getByRole("img", { name: /Live song spectrum/ })).toBeInTheDocument();
  expect(graph.source.connect).toHaveBeenCalledTimes(1); expect(graph.source.connect).toHaveBeenCalledWith(graph.gain);
  expect(graph.gain.connect.mock.calls).toEqual([[graph.destination], [graph.analyser]]); expect(graph.analyser.connect).not.toHaveBeenCalled();
  expect(audio.volume).toBe(1); expect(graph.gain.gain.value).toBe(0.75);
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.4" } });
  expect(audio.volume).toBe(1); expect(graph.gain.gain.value).toBe(0.4);
  await click("Collapse player"); await click("Open full player"); await click("Collapse player");
  expect(Media.all).toHaveLength(1); expect(Context.all).toHaveLength(1); expect(graph.createMediaElementSource).toHaveBeenCalledTimes(1);
  expect(audio.writes).toBe(1); expect(audio.load).toHaveBeenCalledTimes(1); expect(apiCalls()).toHaveLength(1);
});

test("silence stays unconfirmed instead of being classified as CORS failure; real signal confirms later", async () => {
  jest.spyOn(Context.prototype, "resume").mockImplementation(async function (this: Context) { this.state = "running"; this.analyser.signal = -Infinity; });
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Open full player");
  await act(async () => { jest.advanceTimersByTime(3000); });
  expect(screen.getByText(/Waiting for actual audio signal/)).toBeInTheDocument(); expect(Media.all[0].paused).toBe(false);
  Context.all[0].analyser.signal = -30; await act(async () => { jest.advanceTimersByTime(250); });
  expect(screen.getByRole("img", { name: /Live song spectrum/ })).toBeInTheDocument();
});

test("unconfirmed fetch keeps direct playback; a later different source can still analyse", async () => {
  permission = async () => { throw Error("CORS or network"); };
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  expect(Media.all[0].paused).toBe(false); expect(Media.all[0].crossOrigin).toBeNull(); expect(Media.all[0].volume).toBe(0.75);
  expect(Context.all[0].createMediaElementSource).not.toHaveBeenCalled(); await click("Open full player");
  expect(screen.getByText(/Analysis not confirmed/)).toBeInTheDocument(); await click("Collapse player");
  permission = async () => readable(); await click("Start B");
  expect(Media.all).toHaveLength(1); expect(Context.all[1].createMediaElementSource).toHaveBeenCalledTimes(1);
});

test.each(["pause", "studio", "switch", "unmount"])("late permission after %s cannot revive an obsolete request", async outcome => {
  const pending = deferred<Response>(); permission = () => pending.promise;
  const view = render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  if (outcome === "pause") await click("Toggle");
  if (outcome === "studio") { const studio = playbackCoordinator.register("studio", jest.fn()); participants.push(studio); act(() => { studio.claim(); }); }
  if (outcome === "switch") { permission = async () => readable(); await click("Start B"); }
  if (outcome === "unmount") view.unmount();
  await act(async () => { pending.resolve(readable()); });
  if (outcome === "switch") { expect(Media.all[0].src).toBe("https://cdn.invalid/B"); expect(Media.all[0].play).toHaveBeenCalledTimes(1); }
  else expect(Media.all[0].play).not.toHaveBeenCalled();
});

test("source capability change replaces bound media once, stops the old media and preserves UI volume", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.3" } });
  const old = Media.all[0]; permission = async () => { throw Error("unconfirmed"); }; await click("Start B");
  expect(Media.all).toHaveLength(2); expect(old.paused).toBe(true); expect(old.src).toBe(""); expect(Context.all[0].state).toBe("closed");
  expect(Media.all[1].paused).toBe(false); expect(Media.all[1].volume).toBe(0.3); expect(Media.all[1].crossOrigin).toBeNull();
});

test("supported source changes reuse the same graph without rebinding media", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Start B");
  expect(Media.all).toHaveLength(1); expect(Context.all).toHaveLength(1); expect(Context.all[0].createMediaElementSource).toHaveBeenCalledTimes(1);
  expect(Media.all[0].src).toBe("https://cdn.invalid/B"); expect(apiCalls()).toHaveLength(2);
});

test("output failure migrates position and intent once; old cleanup cannot stop its successor", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); const old = Media.all[0], graph = Context.all[0]; old.currentTime = 42;
  await act(async () => { graph.state = "suspended"; graph.dispatchEvent(new Event("statechange")); });
  expect(old.paused).toBe(true); expect(Media.all[1].paused).toBe(false); expect(Media.all[1].currentTime).toBe(42); expect(Media.all[1].volume).toBe(0.75);
  expect(apiCalls()).toHaveLength(1); expect(graph.state).toBe("closed");
  await act(async () => { graph.dispatchEvent(new Event("statechange")); }); expect(Media.all).toHaveLength(2);
  await click("Toggle"); expect(Media.all[1].paused).toBe(true);
});

test("paused bound media resumes using a fresh direct media if Context cannot resume", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Toggle");
  const graph = Context.all[0]; Media.all[0].currentTime = 33; graph.state = "suspended"; jest.spyOn(graph, "resume").mockRejectedValueOnce(Error("cannot resume"));
  await click("Toggle"); expect(Media.all[0].paused).toBe(true); expect(Media.all[1].currentTime).toBe(33); expect(Media.all[1].paused).toBe(false);
});

test.each(["analyser", "canvas"])("%s failure cannot interrupt playback", async kind => {
  Context.failAnalysis = kind === "analyser"; if (kind === "canvas") jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Open full player");
  await act(async () => { jest.runAllTicks(); });
  expect(Media.all[0].paused).toBe(false); expect(within(screen.getByRole("dialog")).getByText(/Spectrum unavailable|频谱暂不可用/)).toBeInTheDocument();
});

test("StrictMode and repeated cleanup leave no bound active media or open Context", async () => {
  const view = render(<StrictMode><PlayerProvider><Harness /></PlayerProvider></StrictMode>); await click("Start A");
  expect(Context.all).toHaveLength(1); expect(Context.all[0].createMediaElementSource).toHaveBeenCalledTimes(1);
  view.unmount(); expect(Media.all.every(a => a.paused && !a.src)).toBe(true); expect(Context.all.every(c => c.state === "closed")).toBe(true);
});

test("failed binding replaces the poisoned element before starting direct playback", async () => {
  Context.failBinding = true; render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  expect(Media.all).toHaveLength(2); expect(Media.all[0].play).not.toHaveBeenCalled(); expect(Media.all[0].paused).toBe(true);
  expect(Media.all[1].paused).toBe(false); expect(Media.all[1].crossOrigin).toBeNull(); expect(Context.all[0].state).toBe("closed");
});

test("late Context resume after pause cannot start audio", async () => {
  const pending = deferred<void>(); jest.spyOn(Context.prototype, "resume").mockImplementationOnce(function (this: Context) { return pending.promise.then(() => { this.state = "running"; }); });
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Toggle");
  await act(async () => { pending.resolve(); }); expect(Media.all[0].play).not.toHaveBeenCalled(); expect(screen.getByTestId("state")).toHaveTextContent("A:paused");
});

test("a queued old confirmation callback cannot clear the next source's monitor", async () => {
  const callbacks: (() => void)[] = []; const original = global.setInterval;
  jest.spyOn(global, "setInterval").mockImplementation(((callback: () => void, delay: number) => { if (delay === 250) callbacks.push(callback); return original(callback, delay); }) as typeof setInterval);
  jest.spyOn(Context.prototype, "resume").mockImplementation(async function (this: Context) { this.state = "running"; this.analyser.signal = -Infinity; });
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); const old = callbacks[0]; await click("Start B");
  await act(async () => { old(); Context.all[0].analyser.signal = -25; jest.advanceTimersByTime(250); });
  await click("Open full player"); expect(screen.getByRole("img", { name: /Live song spectrum/ })).toBeInTheDocument();
});

test("expired addresses recheck the exact refreshed URL and preserve the resume position", async () => {
  let version = 0; global.fetch = jest.fn(async (input, init) => String(input).startsWith("http://localhost:8100") ? json({ url: `https://cdn.invalid/version-${++version}`, expires_at: "2000-01-01T00:00:00Z" }) : permission(String(input), init));
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); Media.all[0].currentTime = 41; await click("Toggle"); await click("Toggle");
  expect(apiCalls()).toHaveLength(2); expect(Media.all).toHaveLength(1); expect(Media.all[0].currentTime).toBe(41);
  expect(Media.all[0].src).toBe("https://cdn.invalid/version-2"); expect(Context.all[0].createMediaElementSource).toHaveBeenCalledTimes(1);
  const checks = jest.mocked(fetch).mock.calls.filter(([, init]) => init?.mode === "cors"); expect(checks.map(([address]) => address)).toEqual(["https://cdn.invalid/version-1", "https://cdn.invalid/version-2"]);
});

test("media error after binding recovers even if the browser has already paused the failed element", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); const old = Media.all[0]; old.currentTime = 27;
  await act(async () => { old.paused = true; old.error = { code: 2 }; old.dispatchEvent(new Event("error")); });
  expect(Media.all[1].paused).toBe(false); expect(Media.all[1].currentTime).toBe(27); expect(old.src).toBe("");
});

test("bound startup rejection rolls back to one direct media without retrying the address", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); const old = Media.all[0]; old.play.mockRejectedValueOnce(Error("anonymous media failed"));
  await click("Start A"); expect(old.paused).toBe(true); expect(Media.all).toHaveLength(2); expect(Media.all[1].paused).toBe(false);
  expect(Media.all[1].volume).toBe(0.75); expect(Context.all[0].state).toBe("closed"); expect(apiCalls()).toHaveLength(1);
});

test("late bound play after Studio preemption cannot recover or replace the current player", async () => {
  const pending = deferred<void>(); render(<PlayerProvider><Harness /></PlayerProvider>); const old = Media.all[0];
  old.play.mockImplementationOnce(async () => { await pending.promise; old.start(); }); await click("Start A");
  const studio = playbackCoordinator.register("studio", jest.fn()); participants.push(studio); act(() => { studio.claim(); });
  await act(async () => { pending.resolve(); }); expect(old.paused).toBe(true); expect(Media.all).toHaveLength(1); expect(studio.isOwner()).toBe(true);
  expect(screen.getByTestId("state")).toHaveTextContent("A:paused");
});

test("an environment without Web Audio keeps the original direct element and playback controls", async () => {
  global.AudioContext = undefined as unknown as typeof AudioContext;
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Open full player");
  expect(Media.all).toHaveLength(1); expect(Media.all[0].paused).toBe(false); expect(Media.all[0].crossOrigin).toBeNull();
  expect(Context.all).toHaveLength(0); expect(apiCalls()).toHaveLength(1); expect(screen.getByText(/Spectrum unavailable/)).toBeInTheDocument();
});

test("waiting to resume a bound Context shows cancellable loading and late resume stays paused", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Toggle");
  const graph = Context.all[0], pending = deferred<void>(); graph.state = "suspended";
  jest.spyOn(graph, "resume").mockImplementationOnce(() => pending.promise.then(() => { graph.state = "running"; }));
  await click("Toggle"); expect(screen.getByTestId("state")).toHaveTextContent("A:loading");
  expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-busy", "true"); await click("Pause");
  await act(async () => { pending.resolve(); }); expect(Media.all[0].paused).toBe(true); expect(Media.all[0].play).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("state")).toHaveTextContent("A:paused");
});
