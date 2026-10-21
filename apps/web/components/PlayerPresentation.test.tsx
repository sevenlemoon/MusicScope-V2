import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PlayerProvider, usePlayer } from "./PlayerProvider";
import { playbackCoordinator, type PlaybackParticipant } from "@/lib/playback-ownership";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (payload: object, status = 200) => ({ ok: status < 400, status, json: async () => payload }) as Response;
const source = (id: string) => response({ url: `https://temporary.invalid/${id}`, expires_at: null });
class Media extends EventTarget {
  static instances: Media[] = [];
  private address = "";
  srcWrites: string[] = [];
  set src(value: string) { this.address = value; this.srcWrites.push(value); }
  get src() { return this.address; }
  preload = ""; volume = 1; currentTime = 0; duration = 120; paused = true; ended = false;
  constructor() { super(); Media.instances.push(this); }
  load = jest.fn(() => { this.dispatchEvent(new Event("loadedmetadata")); });
  play = jest.fn(async () => { this.paused = false; this.dispatchEvent(new Event("playing")); });
  pause = jest.fn(() => { this.paused = true; this.dispatchEvent(new Event("pause")); });
  removeAttribute() { this.address = ""; }
}
const title = "深夜练习 A very long mixed title ".repeat(8);
const track = (id: string) => ({ id, title: id === "long" ? title : `Song ${id}`, artists: id === "long" ? [] : ["Artist"], artwork_url: null, album: id === "A" ? "Actual album" : null, duration_ms: 120000, sort_group: "S" });
function Harness() {
  const player = usePlayer();
  return <><button onClick={(event) => void player.playAndOpen(track("A"), event.currentTarget)}>Open A</button><button onClick={(event) => void player.playAndOpen(track("B"), event.currentTarget)}>Open B</button><button onClick={() => void player.playTrack(track("A"))}>Start A</button><button onClick={() => void player.playTrack(track("B"))}>Start B</button><button onClick={() => void player.playTrack(track("long"))}>Start long</button><output data-testid="status">{player.current?.id}:{player.status}</output></>;
}
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const sourceCalls = () => jest.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/playback-source"));
const mini = () => document.querySelector(".global-player") as HTMLElement;
let participants: PlaybackParticipant[];
let resizeCallbacks: ResizeObserverCallback[];
let height = 90;
const scrollYDescriptor = Object.getOwnPropertyDescriptor(window, "scrollY")!;

beforeEach(() => {
  participants = []; resizeCallbacks = []; height = 90; Media.instances = [];
  global.Audio = Media as unknown as typeof Audio;
  global.fetch = jest.fn(async (input) => source(String(input).includes("/B/") ? "B" : "A"));
  jest.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  jest.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); });
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
  jest.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ height } as DOMRect));
  global.ResizeObserver = class { constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); } observe() {} disconnect = jest.fn(); } as unknown as typeof ResizeObserver;
});
afterEach(() => { cleanup(); participants.forEach((p) => p.dispose()); jest.restoreAllMocks(); Object.defineProperty(window, "scrollY", scrollYDescriptor); document.documentElement.style.removeProperty("--player-clearance"); document.body.style.cssText = ""; });

// jsdom has dialog elements but does not implement the browser's top-layer methods.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function () {};
  if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function () {};
});

test("expand/collapse shares media, requests and both directions of transport state", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  const audio = Media.instances[0]; const requests = sourceCalls().length;
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.4" } });
  audio.currentTime = 22; act(() => { audio.dispatchEvent(new Event("timeupdate")); });
  await click("Open full player");
  const full = screen.getByRole("dialog");
  expect(within(full).getByRole("slider", { name: "Playback position" })).toHaveValue("22");
  expect(within(full).getByRole("slider", { name: "Volume" })).toHaveValue("0.4");
  fireEvent.change(within(full).getByRole("slider", { name: "Playback position" }), { target: { value: "45" } });
  fireEvent.change(within(full).getByRole("slider", { name: "Volume" }), { target: { value: "0.6" } });
  expect(audio.currentTime).toBe(45); expect(audio.volume).toBe(0.6);
  await click("Pause"); expect(audio.paused).toBe(true); await click("Play");
  expect(audio.paused).toBe(false); await click("Collapse player");
  expect(within(mini()).getByRole("slider", { name: "Playback position" })).toHaveValue("45");
  expect(within(mini()).getByRole("slider", { name: "Volume" })).toHaveValue("0.6");
  await click("Pause"); await click("Open full player"); expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Play" })).toBeInTheDocument();
  await click("Collapse player");
  expect(Media.instances).toEqual([audio]); expect(audio.srcWrites).toEqual(["https://temporary.invalid/A"]);
  expect(audio.load).toHaveBeenCalledTimes(1); expect(sourceCalls()).toHaveLength(requests);
});

test("modal uses native top layer, close focus, Esc, and restores exact scroll/styles on close or unmount", async () => {
  document.body.style.overflow = "auto"; document.body.style.paddingRight = "3px";
  Object.defineProperty(window, "scrollY", { configurable: true, value: 240 });
  const view = render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  const button = screen.getByRole("button", { name: "Open full player" }); button.focus(); await click("Open full player");
  const panel = screen.getByRole("dialog");
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
  expect(panel).toHaveAttribute("open"); expect(panel).toHaveAccessibleName("Song A");
  expect(screen.getByRole("button", { name: "Collapse player" })).toHaveFocus();
  expect(mini()).toHaveAttribute("inert"); expect(document.body.style.overflow).toBe("hidden");
  fireEvent(panel, new Event("cancel", { cancelable: true }));
  expect(button).toHaveFocus(); expect(document.body.style.overflow).toBe("auto"); expect(document.body.style.paddingRight).toBe("3px");
  expect(window.scrollTo).toHaveBeenLastCalledWith(0, 240);
  await click("Open full player"); view.unmount();
  expect(document.body.style.overflow).toBe("auto"); expect(panel).not.toHaveAttribute("open");
});

test("Studio preemption updates the expanded player; opening is passive while Studio owns playback", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Open full player");
  const stop = jest.fn(); const studio = playbackCoordinator.register("studio", stop); participants.push(studio);
  act(() => { studio.claim(); });
  expect(Media.instances[0].paused).toBe(true); expect(screen.getByTestId("status")).toHaveTextContent("A:paused");
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Play" })).toBeInTheDocument();
  await click("Collapse player"); expect(within(mini()).getByRole("button", { name: "Play" })).toBeInTheDocument();
  await click("Open full player"); expect(studio.isOwner()).toBe(true); expect(stop).not.toHaveBeenCalled();
  await click("Play"); expect(stop).toHaveBeenCalledTimes(1); expect(Media.instances[0].paused).toBe(false);
});

test("closing during address resolution does not cancel or restart the valid request", async () => {
  const address = deferred<Response>(); global.fetch = jest.fn(() => address.promise);
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Open full player");
  expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-busy", "true");
  await click("Collapse player"); await act(async () => { address.resolve(source("A")); });
  expect(sourceCalls()).toHaveLength(1); expect(Media.instances).toHaveLength(1);
  expect(Media.instances[0].play).toHaveBeenCalledTimes(1); expect(screen.getByTestId("status")).toHaveTextContent("A:playing");
});

test("closing and re-opening across A/B out-of-order addresses preserves the latest ticket", async () => {
  const a = deferred<Response>(); const b = deferred<Response>(); global.fetch = jest.fn((input) => String(input).includes("/A/") ? a.promise : b.promise);
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Open full player"); await click("Collapse player");
  await click("Start B"); await click("Open full player");
  await act(async () => { b.resolve(source("B")); }); await act(async () => { a.resolve(source("A")); });
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Song B");
  expect(Media.instances[0].srcWrites).toEqual(["https://temporary.invalid/B"]); expect(sourceCalls()).toHaveLength(2);
  expect(screen.getByTestId("status")).toHaveTextContent("B:playing");
});

test("pause during expanded loading invalidates late source even after collapse", async () => {
  const address = deferred<Response>(); global.fetch = jest.fn(() => address.promise);
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A"); await click("Open full player"); await click("Pause"); await click("Collapse player");
  await act(async () => { address.resolve(source("A")); });
  expect(Media.instances[0].srcWrites).toEqual([]); expect(Media.instances[0].play).not.toHaveBeenCalled();
  expect(screen.getByTestId("status")).toHaveTextContent("A:paused");
});

test("long title, missing metadata and safe errors remain usable in both views", async () => {
  global.fetch = jest.fn(async () => response({ detail: "SECRET must not appear" }, 422));
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start long");
  expect(screen.getByRole("alert")).toHaveTextContent("current account"); await click("Open full player");
  expect(screen.getByRole("dialog")).toHaveAccessibleName(title.trim());
  expect(within(screen.getByRole("dialog")).getByRole("heading", { name: title.trim() })).toHaveAttribute("title", title);
  expect(within(screen.getByRole("dialog")).getByText("Artist not provided")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("current account"); expect(document.body).not.toHaveTextContent("SECRET");
  expect(screen.queryByRole("img", { name: "Track artwork" })).not.toBeInTheDocument();
  await click("Collapse player"); expect(within(mini()).getByRole("alert")).toBeInTheDocument();
});

test("measured dock clearance follows height changes and old observer cleanup cannot overwrite a new dock", async () => {
  const first = render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  const initial = document.documentElement.style.getPropertyValue("--player-clearance");
  const old = resizeCallbacks[0]; height = 180;
  act(() => { old([], {} as ResizeObserver); }); const larger = document.documentElement.style.getPropertyValue("--player-clearance");
  expect(parseFloat(larger)).toBeGreaterThan(parseFloat(initial)); first.unmount();
  expect(document.documentElement.style.getPropertyValue("--player-clearance")).toBe("");
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start B"); const next = document.documentElement.style.getPropertyValue("--player-clearance");
  height = 300; act(() => { old([], {} as ResizeObserver); });
  expect(document.documentElement.style.getPropertyValue("--player-clearance")).toBe(next);
});

test("dialog initialization failure preserves the working mini player and media", async () => {
  jest.mocked(HTMLDialogElement.prototype.showModal).mockImplementation(() => { throw new Error("unavailable"); });
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  const audio = Media.instances[0]; await click("Open full player");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText("Full view is unavailable. Mini player controls remain available.")).toBeInTheDocument();
  expect(document.body.style.overflow).toBe(""); expect(audio.paused).toBe(false);
  await click("Pause"); expect(audio.paused).toBe(true);
  expect(Media.instances).toEqual([audio]); expect(audio.load).toHaveBeenCalledTimes(1); expect(sourceCalls()).toHaveLength(1);
});

test("artwork entry opens the same media and returns focus to artwork instead of track details", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  const audio = Media.instances[0]; const cover = screen.getByRole("button", { name: "Open full player from artwork" });
  cover.focus(); await click("Open full player from artwork");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Song A");
  expect(screen.getByRole("link", { name: /Track details/ })).toHaveAttribute("href", "/track/A");
  await click("Collapse player"); expect(cover).toHaveFocus();
  expect(Media.instances).toEqual([audio]); expect(audio.load).toHaveBeenCalledTimes(1); expect(sourceCalls()).toHaveLength(1);
});

test("real timestamp lyric seek controls the Provider media without play/load, and cached reopening only reads lyrics once", async () => {
  global.fetch = jest.fn(async input => String(input).endsWith('/lyrics')
    ? response({ track_id: 'A', provider: 'netease', kind: 'synced', original: '[00:10.250]Fixture first\n[00:45.123]Fixture second', translated: '', precision: 'line' })
    : source('A'));
  render(<PlayerProvider><Harness /></PlayerProvider>); await click('Start A'); await click('Open full player from artwork');
  const audio = Media.instances[0];
  await click('Seek to 0:45 · Fixture second');
  expect(audio.currentTime).toBe(45.123); expect(audio.play).toHaveBeenCalledTimes(1); expect(audio.load).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: /Fixture second/ })).toHaveAttribute('aria-current', 'true');
  await click('Collapse player'); await click('Open full player from artwork');
  expect(screen.getByRole('button', { name: /Fixture second/ })).toHaveAttribute('aria-current', 'true');
  expect(sourceCalls()).toHaveLength(1); expect(jest.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/lyrics'))).toHaveLength(1);
  expect(Media.instances).toEqual([audio]);
});

test("lyric seek while the playback address is still loading survives the later source load", async () => {
  const address = deferred<Response>();
  global.fetch = jest.fn(input => String(input).endsWith('/lyrics')
    ? Promise.resolve(response({ track_id: 'A', provider: 'netease', kind: 'synced', original: '[00:45.123]Pending seek', translated: '', precision: 'line' }))
    : address.promise);
  render(<PlayerProvider><Harness /></PlayerProvider>); await click('Start A'); await click('Open full player from artwork');
  await click('Seek to 0:45 · Pending seek');
  await act(async () => { address.resolve(source('A')); });
  expect(Media.instances[0].currentTime).toBe(45.123); expect(Media.instances[0].play).toHaveBeenCalledTimes(1);
  expect(sourceCalls()).toHaveLength(1); expect(screen.getByTestId('status')).toHaveTextContent('A:playing');
});


test("list open shows loading immediately, deduplicates same song, and stays closed on late success", async () => {
  const pending = deferred<Response>();
  global.fetch = jest.fn((input) => String(input).endsWith("/playback-source") ? pending.promise : Promise.resolve(response({ status: "none", lines: [] })));
  render(<PlayerProvider><Harness /></PlayerProvider>);
  await click("Open A");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Song A");
  expect(within(screen.getByRole("dialog")).getAllByRole("status").some((item) => item.textContent?.includes("Loading"))).toBe(true);
  await click("Open A"); expect(sourceCalls()).toHaveLength(1);
  await click("Collapse player");
  await act(async () => pending.resolve(source("A")));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(Media.instances[0].paused).toBe(false);
  expect(screen.getByRole("button", { name: "Open A" })).toHaveFocus();
});

test("title and cover opening preserves playing position, while paused same song resumes without reloading", async () => {
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Open A");
  const audio = Media.instances[0]; audio.currentTime = 24; act(() => audio.dispatchEvent(new Event("timeupdate")));
  await click("Collapse player"); const loads = audio.load.mock.calls.length;
  await click("Open A"); expect(audio.paused).toBe(false); expect(audio.currentTime).toBe(24);
  expect(sourceCalls()).toHaveLength(1); expect(audio.load).toHaveBeenCalledTimes(loads);
  await click("Pause"); await click("Collapse player"); await click("Open A");
  expect(audio.paused).toBe(false); expect(audio.currentTime).toBe(24);
  expect(audio.load).toHaveBeenCalledTimes(loads); expect(sourceCalls()).toHaveLength(1);
  await click("Collapse player"); await click("Song A");
  expect(screen.getByRole("dialog")).toBeInTheDocument(); expect(Media.instances).toEqual([audio]);
});

test("rapid list A then B keeps source, error, and presentation on B even after late A failure", async () => {
  const pending = deferred<Response>();
  global.fetch = jest.fn((input) => String(input).includes("/A/playback-source") ? pending.promise : Promise.resolve(String(input).endsWith("/playback-source") ? source("B") : response({ status: "none", lines: [] })));
  render(<PlayerProvider><Harness /></PlayerProvider>);
  await click("Open A"); await click("Open B");
  await act(async () => pending.resolve(response({ detail: "old error" }, 503)));
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Song B");
  expect(Media.instances[0].src).toBe("https://temporary.invalid/B");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByTestId("status")).toHaveTextContent("B:playing");
});

test("failed list playback retries in the same full player", async () => {
  let calls = 0;
  global.fetch = jest.fn(async (input) => String(input).endsWith("/playback-source") ? ++calls === 1 ? response({}, 503) : source("A") : response({ status: "none", lines: [] }));
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Open A");
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("temporarily unavailable");
  await click("Play"); expect(screen.getByTestId("status")).toHaveTextContent("A:playing");
  expect(sourceCalls()).toHaveLength(2); expect(screen.getByRole("dialog")).toBeInTheDocument();
});


test("opening from a list survives StrictMode presentation mount cleanup", async () => {
  render(<StrictMode><PlayerProvider><Harness /></PlayerProvider></StrictMode>);
  await click("Open A");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Song A");
  expect(screen.getByTestId("status")).toHaveTextContent("A:playing");
  expect(sourceCalls()).toHaveLength(1);
});


test("expired-address resume keeps progress after cancelling a pending refresh", async () => {
  const pending = deferred<Response>(); let calls = 0;
  global.fetch = jest.fn((input) => {
    if (!String(input).endsWith("/playback-source")) return Promise.resolve(response({ status: "none", lines: [] }));
    ++calls;
    return calls === 2 ? pending.promise : Promise.resolve(calls === 1 ? response({ url: "https://temporary.invalid/A", expires_at: "2000-01-01T00:00:00Z" }) : source("A"));
  });
  render(<PlayerProvider><Harness /></PlayerProvider>); await click("Start A");
  const audio = Media.instances[0]; audio.currentTime = 31; act(() => audio.dispatchEvent(new Event("timeupdate")));
  await click("Pause"); await click("Open A"); expect(sourceCalls()).toHaveLength(2);
  await click("Pause"); await click("Collapse player"); await click("Open A");
  expect(audio.currentTime).toBe(31); expect(sourceCalls()).toHaveLength(3);
  await act(async () => pending.resolve(source("old")));
  expect(audio.src).toBe("https://temporary.invalid/A"); expect(audio.currentTime).toBe(31);
});
