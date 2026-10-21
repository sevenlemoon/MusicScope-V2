import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PlayerProvider, usePlayer } from "./PlayerProvider";
import { StemMixer, StudioExperience } from "./StudioExperience";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
// Keep the existing direct-player/Studio race and Studio-only node counters scoped
// to their original paths. The real player graph is covered in PlayerAnalysis.test.
jest.mock("../lib/player-analysis", () => ({ ...jest.requireActual("../lib/player-analysis"), preparePlayerGraph: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(payload: object, status = 200) {
  return { ok: status < 400, status, json: async () => payload } as Response;
}

class Media extends EventTarget {
  static instances: Media[] = [];
  src = ""; preload = ""; crossOrigin = ""; volume = 1;
  currentTime = 0; duration = 180; playbackRate = 1; paused = true; ended = false;
  constructor() { super(); Media.instances.push(this); }
  start() {
    this.paused = false; this.ended = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
  }
  play = jest.fn(async () => { this.start(); });
  pause = jest.fn(() => { this.paused = true; this.dispatchEvent(new Event("pause")); });
  load = jest.fn(() => { this.dispatchEvent(new Event("loadedmetadata")); });
  removeAttribute = jest.fn(() => { this.src = ""; });
}

class Node {
  gain = { value: 1 };
  connect = jest.fn((target: Node) => target);
  disconnect = jest.fn();
}

class AnalysisNode extends Node {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  get frequencyBinCount() { return this.fftSize / 2; }
  getFloatFrequencyData = jest.fn((data: Float32Array) => data.fill(-Infinity));
}

class Context {
  static instances: Context[] = [];
  static bound: WeakSet<HTMLAudioElement>;
  state = "suspended";
  destination = new Node();
  sampleRate = 48000;
  nodes: Node[] = [];
  sources: Node[] = [];
  bindings = new Map<HTMLAudioElement, Node>();
  analysers: AnalysisNode[] = [];
  constructor() { Context.instances.push(this); }
  createGain() { const node = new Node(); this.nodes.push(node); return node; }
  createMediaElementSource(audio: HTMLAudioElement) {
    if (Context.bound.has(audio)) throw new Error("media element already bound");
    Context.bound.add(audio);
    const source = new Node(); this.sources.push(source); this.bindings.set(audio, source); return source;
  }
  createAnalyser() { const node = new AnalysisNode(); this.analysers.push(node); return node; }
  async resume() { this.state = "running"; }
  close = jest.fn(async () => { this.state = "closed"; });
}

const track = (id: string) => ({ id, title: `Song ${id}`, artists: ["Artist"], sort_group: "S", artwork_url: null });
const source = (id: string, expires_at?: string) => response({ url: `https://audio.invalid/${id}`, expires_at });
function job(id = "job-1", six = false): Parameters<typeof StemMixer>[0]["job"] {
  return {
    id, status: "SUCCEEDED", stage: "COMPLETE", model_name: six ? "htdemucs_6s" : "htdemucs",
    model_version: null, demucs_version: null, device: null, attempt_count: 1,
    safe_error_code: null, safe_error_message: null, source_track_ids: [],
    cancellable: false, retryable: false, reused: false, created_at: "2026-10-19", completed_at: null,
    waveform_url: null,
    asset: { id: `asset-${id}`, original_filename: `${id}.wav`, duration_ms: 180000, size_bytes: 4096, media_type: "audio/wav", reused: false },
    artifacts: (six ? ["VOCALS", "DRUMS", "BASS", "GUITAR", "PIANO", "OTHER"] : ["VOCALS", "DRUMS", "BASS", "OTHER"]).map((stem_type) => ({
      id: `${id}-${stem_type}`, stem_type: stem_type as Parameters<typeof StemMixer>[0]["job"]["artifacts"][number]["stem_type"], stream_url: `/stream/${id}/${stem_type}`, size_bytes: 1024, duration_ms: 180000,
    })),
  };
}

function Controls() {
  const player = usePlayer();
  return <>
    <button onClick={() => void player.playTrack(track("A"))}>Start A</button>
    <button onClick={() => void player.playTrack(track("B"))}>Start B</button>
    <button onClick={() => void player.toggle()}>Toggle song</button>
    <output data-testid="song-state">{player.current?.id}:{player.status}</output>
  </>;
}

const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const songAudio = () => Media.instances.find((audio) => audio.crossOrigin !== "anonymous")!;
const stems = (id = "job-1") => Media.instances.filter((audio) => audio.src.includes(`/stream/${id}/`));
const expectSong = (state: string) => expect(screen.getByTestId("song-state")).toHaveTextContent(state);
function both(studioJob = job()) { return <PlayerProvider><Controls /><StemMixer job={studioJob} /></PlayerProvider>; }

beforeEach(() => {
  Media.instances = []; Context.instances = []; Context.bound = new WeakSet();
  global.Audio = Media as unknown as typeof Audio;
  global.AudioContext = Context as unknown as typeof AudioContext;
  global.fetch = jest.fn(async () => source("A"));
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); jest.useRealTimers(); });

test("page loading is passive and playback is mutually exclusive in both directions", async () => {
  const view = render(<PlayerProvider><Controls /></PlayerProvider>);
  await click("Start A");
  view.rerender(both());
  expect(songAudio().paused).toBe(false);
  expect(stems().every((audio) => audio.paused)).toBe(true);
  await click("播放四个声部");
  expect(songAudio().paused).toBe(true); expectSong("A:paused");
  expect(stems().every((audio) => !audio.paused)).toBe(true);
  await click("Toggle song");
  expect(songAudio().paused).toBe(false);
  expect(stems().every((audio) => audio.paused)).toBe(true);
  await click("Toggle song");
  expect(stems().every((audio) => audio.paused)).toBe(true);
});

test.each(["resolve", "reject"])("A/B address race ignores A's late %s", async (outcome) => {
  const a = deferred<Response>(); const b = deferred<Response>();
  global.fetch = jest.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  render(both());
  await click("Start A"); await click("Start B");
  await act(async () => { b.resolve(source("B")); });
  await act(async () => { if (outcome === "resolve") a.resolve(source("A")); else a.reject(new Error("old failure")); });
  expectSong("B:playing"); expect(songAudio().src).toBe("https://audio.invalid/B");
  expect(songAudio().play).toHaveBeenCalledTimes(1);
});

test("a late address after Studio takes ownership never starts the ordinary player", async () => {
  const address = deferred<Response>();
  const fetchMock = jest.fn().mockReturnValue(address.promise); global.fetch = fetchMock;
  render(both()); await click("Start A"); await click("播放四个声部");
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => { address.resolve(source("A")); });
  expect(songAudio().play).not.toHaveBeenCalled(); expectSong("A:paused");
  expect(stems().every((audio) => !audio.paused)).toBe(true);
});

test("queued old media events cannot cancel the next track's address request", async () => {
  const next = deferred<Response>();
  global.fetch = jest.fn().mockResolvedValueOnce(source("A")).mockReturnValueOnce(next.promise);
  render(both()); await click("Start A"); await click("Start B");
  const audio = songAudio();
  await act(async () => {
    audio.ended = true; audio.currentTime = 180;
    audio.dispatchEvent(new Event("ended"));
    audio.dispatchEvent(new Event("timeupdate"));
  });
  expectSong("B:loading"); expect(screen.getByRole("slider", { name: "Playback position" })).toHaveValue("0");
  await act(async () => { next.resolve(source("B")); });
  await act(async () => { audio.dispatchEvent(new Event("ended")); });
  expectSong("B:playing"); expect(audio.paused).toBe(false);
});

test("Studio resume finishing after ordinary playback cannot start any stems", async () => {
  const resume = deferred<void>(); jest.spyOn(Context.prototype, "resume").mockReturnValueOnce(resume.promise);
  render(both()); await click("播放四个声部"); await click("Start A");
  await act(async () => { resume.resolve(); });
  expect(stems().every((audio) => audio.play.mock.calls.length === 0)).toBe(true);
  expectSong("A:playing");
});

test("a track that starts late after ownership transfer is immediately paused", async () => {
  const pending = deferred<void>(); render(both());
  const late = stems()[1];
  late.play.mockImplementationOnce(async () => { await pending.promise; late.start(); });
  await click("播放四个声部"); await click("Start A");
  await act(async () => { pending.resolve(); });
  expect(stems().every((audio) => audio.paused)).toBe(true); expectSong("A:playing");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("pause during address resolution invalidates the startup; resume resolves a fresh source", async () => {
  const address = deferred<Response>();
  global.fetch = jest.fn().mockReturnValueOnce(address.promise).mockResolvedValueOnce(source("A-fresh"));
  render(both()); await click("Start A"); await click("Pause");
  await act(async () => { address.resolve(source("A-old")); });
  expectSong("A:paused"); expect(songAudio().play).not.toHaveBeenCalled();
  await click("Toggle song");
  expectSong("A:playing"); expect(songAudio().src).toBe("https://audio.invalid/A-fresh");
});

test("pause during Context.resume cancels startup", async () => {
  const resume = deferred<void>(); jest.spyOn(Context.prototype, "resume").mockReturnValueOnce(resume.promise);
  render(both()); await click("播放四个声部"); await click("暂停四个声部");
  await act(async () => { resume.resolve(); });
  expect(stems().every((audio) => audio.play.mock.calls.length === 0 && audio.paused)).toBe(true);
  expect(screen.getByRole("button", { name: "播放四个声部" })).toBeEnabled();
});

test("pause during an ordinary play promise stays paused even if playing arrives late", async () => {
  const pending = deferred<void>(); render(both()); const audio = songAudio();
  audio.play.mockImplementationOnce(async () => { await pending.promise; audio.start(); });
  await click("Start A"); await click("Pause");
  await act(async () => { pending.resolve(); });
  expect(audio.paused).toBe(true); expectSong("A:paused");
});

test("pause during per-track play stays paused after the last track starts late", async () => {
  const pending = deferred<void>(); render(both()); const late = stems()[0];
  late.play.mockImplementationOnce(async () => { await pending.promise; late.start(); });
  await click("播放四个声部"); await click("暂停四个声部");
  await act(async () => { pending.resolve(); });
  expect(stems().every((audio) => audio.paused)).toBe(true);
  expect(screen.getByRole("button", { name: "播放四个声部" })).toBeEnabled();
});

test("ordinary resume's pending play cannot restart after Studio takes over", async () => {
  render(both()); await click("Start A"); await click("Toggle song");
  const pending = deferred<void>(); const audio = songAudio();
  audio.play.mockImplementationOnce(async () => { await pending.promise; audio.start(); });
  await click("Toggle song"); await click("播放四个声部");
  await act(async () => { pending.resolve(); });
  expect(audio.paused).toBe(true); expect(stems().every((stem) => !stem.paused)).toBe(true);
});

test.each(["resolve", "reject"])("an old ordinary play %s cannot disturb a newer request", async (outcome) => {
  const oldPlay = deferred<void>(); render(both());
  songAudio().play.mockReturnValueOnce(oldPlay.promise);
  await click("Start A"); await click("Toggle song"); await click("Start B");
  await act(async () => { if (outcome === "resolve") oldPlay.resolve(); else oldPlay.reject(new Error("old play failed")); });
  expectSong("B:playing"); expect(songAudio().paused).toBe(false);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("an old Studio catch/finally cannot stop a newer start or reset its pending state", async () => {
  const old = deferred<void>(); const next = deferred<void>();
  jest.spyOn(Context.prototype, "resume").mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  render(both()); await click("播放四个声部"); await click("暂停四个声部"); await click("播放四个声部");
  await act(async () => { old.reject(new Error("old resume failed")); });
  expect(screen.getByRole("button", { name: "暂停四个声部" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => { next.resolve(); });
  expect(stems().every((audio) => !audio.paused)).toBe(true);
  await click("暂停四个声部"); expect(stems().every((audio) => audio.paused)).toBe(true);
});

test("any track failure stops the mix, including another track whose play resolves later", async () => {
  const fail = deferred<void>(); const late = deferred<void>(); render(both());
  const media = stems();
  media[1].play.mockReturnValueOnce(fail.promise);
  media[2].play.mockImplementationOnce(async () => { await late.promise; media[2].start(); });
  await click("播放四个声部"); expect(media[0].paused).toBe(false);
  await act(async () => { fail.reject(new Error("decode failed")); });
  expect(media.every((audio) => audio.paused)).toBe(true);
  expect(screen.getByRole("alert")).toHaveTextContent("播放未能启动");
  await act(async () => { late.resolve(); });
  expect(media.every((audio) => audio.paused)).toBe(true);
  await click("播放四个声部"); expect(media.every((audio) => !audio.paused)).toBe(true);
  expect(Context.instances).toHaveLength(1);
});

test("a superseded track rejection cannot pause the new Studio mix", async () => {
  const old = deferred<void>(); render(both()); stems()[1].play.mockReturnValueOnce(old.promise);
  await click("播放四个声部"); await click("暂停四个声部"); await click("播放四个声部");
  await act(async () => { old.reject(new Error("superseded track")); });
  expect(stems().every((audio) => !audio.paused)).toBe(true);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("unmount closes only the old context and late resume cannot affect a new instance", async () => {
  const old = deferred<void>(); jest.spyOn(Context.prototype, "resume").mockReturnValueOnce(old.promise);
  const view = render(<StemMixer job={job()} />); await click("播放四个声部");
  const oldMedia = [...Media.instances]; const oldContext = Context.instances[0];
  view.unmount(); render(<StemMixer job={job("job-2", true)} />); await click("播放六个声部");
  await act(async () => { old.resolve(); });
  expect(oldMedia.every((audio) => audio.src === "" && audio.paused && audio.play.mock.calls.length === 0)).toBe(true);
  expect(oldContext.close).toHaveBeenCalledTimes(1);
  expect(oldContext.sources.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
  expect(Context.instances[1].close).not.toHaveBeenCalled();
  expect(stems("job-2").every((audio) => !audio.paused)).toBe(true);
});

test("unmounted media that finishes play late is stopped without touching the replacement", async () => {
  const old = deferred<void>(); const view = render(<StemMixer job={job()} />);
  const media = stems(); media[0].play.mockImplementationOnce(async () => { await old.promise; media[0].start(); });
  await click("播放四个声部"); view.unmount();
  render(<StemMixer job={job("job-2")} />); await click("播放四个声部");
  await act(async () => { old.resolve(); });
  expect(media.every((audio) => audio.paused && audio.src === "")).toBe(true);
  expect(stems("job-2").every((audio) => !audio.paused)).toBe(true);
});

test("ordinary unmount ignores its late address while a new player owns playback", async () => {
  const old = deferred<Response>();
  global.fetch = jest.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(source("B"));
  const view = render(<PlayerProvider><Controls /></PlayerProvider>); await click("Start A");
  const oldAudio = songAudio(); view.unmount();
  render(<PlayerProvider><Controls /></PlayerProvider>); await click("Start B");
  await act(async () => { old.resolve(source("A")); });
  expect(oldAudio.src).toBe(""); expect(oldAudio.play).not.toHaveBeenCalled(); expectSong("B:playing");
});

test("expired-source refresh is guarded when Studio takes ownership", async () => {
  const refresh = deferred<Response>();
  global.fetch = jest.fn().mockResolvedValueOnce(source("A", "2000-01-01T00:00:00Z")).mockReturnValueOnce(refresh.promise);
  render(both()); await click("Start A"); await click("Toggle song"); await click("Toggle song");
  await click("播放四个声部"); await act(async () => { refresh.resolve(source("A-refreshed")); });
  expect(songAudio().play).toHaveBeenCalledTimes(1); expect(songAudio().paused).toBe(true);
  expect(stems().every((audio) => !audio.paused)).toBe(true);
});

test("equivalent artifact arrays do not rebuild audio, reset speed, or change gains", async () => {
  const completed = job(); const view = render(<StemMixer job={completed} />);
  fireEvent.change(screen.getByLabelText("播放速度"), { target: { value: "1.25" } });
  fireEvent.change(screen.getByLabelText("人声增益"), { target: { value: "0.4" } });
  await click("播放四个声部"); const media = [...Media.instances]; const context = Context.instances[0];
  view.rerender(<StemMixer job={{ ...completed, artifacts: completed.artifacts.map((artifact) => ({ ...artifact })).reverse() }} />);
  expect(Media.instances).toEqual(media); expect(Context.instances).toHaveLength(1);
  expect(media.every((audio) => !audio.paused && audio.playbackRate === 1.25)).toBe(true);
  expect(context.close).not.toHaveBeenCalled();
  expect(context.nodes.some((node) => node.gain.value === 0.4)).toBe(true);
});

test("task switching stops the old mixer immediately and ignores old waveform/resume results", async () => {
  const wave = deferred<Response>(); const detail = deferred<Response>(); const resume = deferred<void>();
  const first = { ...job(), waveform_url: "/wave-old" }; const second = job("job-2", true);
  global.fetch = jest.fn((input) => {
    const url = String(input);
    return url.endsWith("/wave-old") ? wave.promise : url.endsWith("/jobs/job-2") ? detail.promise : Promise.resolve(response(first));
  });
  jest.spyOn(Context.prototype, "resume").mockReturnValueOnce(resume.promise);
  const view = render(<StudioExperience initialJobId="job-1" />);
  await screen.findByRole("button", { name: "播放四个声部" }); await click("播放四个声部");
  const oldMedia = [...Media.instances]; view.rerender(<StudioExperience initialJobId="job-2" />);
  expect(oldMedia.every((audio) => audio.paused && audio.src === "")).toBe(true);
  await act(async () => { detail.resolve(response(second)); }); await click("播放六个声部");
  await act(async () => {
    wave.resolve(response({ version: "v1", stems: {}, beat_grid: { bpm: 999, beats_ms: [], source: "drums", method: "test" } }));
    resume.resolve();
  });
  expect(screen.queryByText("999 BPM")).not.toBeInTheDocument();
  expect(stems("job-2").every((audio) => !audio.paused)).toBe(true);
  expect(Context.instances[1].close).not.toHaveBeenCalled();
});

test("StrictMode effect replay cleans old resources and preserves later ownership", async () => {
  jest.useFakeTimers();
  const view = render(<StrictMode>{both()}</StrictMode>);
  const abandoned = Media.instances.filter((audio) => audio.src === "" && audio.crossOrigin === "anonymous");
  expect(abandoned).toHaveLength(4);
  await click("Start A"); await click("播放四个声部");
  expect(stems().every((audio) => !audio.paused)).toBe(true);
  expect(abandoned.every((audio) => audio.paused)).toBe(true);
  view.unmount();
  expect(Media.instances.every((audio) => audio.paused && audio.src === "")).toBe(true);
  expect(Context.instances[0].close).toHaveBeenCalledTimes(1);
  jest.runAllTicks();
  expect(jest.getTimerCount()).toBe(0);
});

test("late polling and retry responses cannot replace the next task", async () => {
  jest.useFakeTimers();
  const poll = deferred<Response>(); const retry = deferred<Response>();
  const pending = { ...job(), status: "RUNNING", stage: "SEPARATING" };
  const failed = { ...job(), status: "FAILED", retryable: true };
  const second = job("job-2", true);
  global.fetch = jest.fn()
    .mockResolvedValueOnce(response(pending)).mockReturnValueOnce(poll.promise)
    .mockResolvedValueOnce(response(second)).mockResolvedValueOnce(response(failed))
    .mockReturnValueOnce(retry.promise).mockResolvedValueOnce(response(second));
  const view = render(<StudioExperience initialJobId="job-1" />);
  await act(async () => {});
  await act(async () => { jest.advanceTimersByTime(1500); });
  view.rerender(<StudioExperience initialJobId="job-2" />);
  await act(async () => {}); await click("播放六个声部");
  await act(async () => { poll.resolve(response(failed)); });
  expect(stems("job-2").every((audio) => !audio.paused)).toBe(true);
  view.rerender(<StudioExperience initialJobId="job-1" />);
  await act(async () => {}); await click("重试任务");
  view.rerender(<StudioExperience initialJobId="job-2" />);
  await act(async () => {}); await click("播放六个声部");
  await act(async () => { retry.resolve(response(pending)); });
  expect(stems("job-2").every((audio) => !audio.paused)).toBe(true);
  expect(screen.getByRole("button", { name: "暂停六个声部" })).toBeEnabled();
});

test("AB end restart obeys ownership and cannot revive a stopped mixer", async () => {
  render(both());
  fireEvent.change(screen.getByLabelText("播放位置"), { target: { value: "10" } });
  await click("设为循环起点");
  fireEvent.change(screen.getByLabelText("播放位置"), { target: { value: "20" } });
  await click("设为循环终点"); await click("播放四个声部");
  const primary = stems().find((audio) => audio.src.endsWith("VOCALS"))!;
  await act(async () => { primary.ended = true; primary.dispatchEvent(new Event("ended")); });
  expect(stems().every((audio) => audio.currentTime === 10 && !audio.paused)).toBe(true);
  await click("Start A");
  await act(async () => { primary.ended = true; primary.dispatchEvent(new Event("ended")); });
  expect(stems().every((audio) => audio.paused)).toBe(true); expectSong("A:playing");
});

test("a partially constructed graph can retry without rebinding media and is cleaned on unmount", async () => {
  const createGain = Context.prototype.createGain;
  let calls = 0;
  jest.spyOn(Context.prototype, "createGain").mockImplementation(function (this: Context) {
    if (++calls === 3) throw new Error("graph allocation failed");
    return createGain.call(this);
  });
  const view = render(<StemMixer job={job()} />); await click("播放四个声部");
  expect(screen.getByRole("alert")).toBeInTheDocument();
  await click("播放四个声部"); expect(stems().every((audio) => !audio.paused)).toBe(true);
  const context = Context.instances[0]; expect(context.sources).toHaveLength(4);
  view.unmount(); expect(context.close).toHaveBeenCalledTimes(1);
  expect(context.sources.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
});

test("post-master serial analysis preserves a single audible route and initial mix settings", async () => {
  const view = render(both());
  fireEvent.change(screen.getByLabelText("鼓组增益"), { target: { value: "0.3" } });
  fireEvent.change(screen.getByLabelText("主音量"), { target: { value: "0.5" } });
  await click("人声静音"); await click("鼓组独奏"); await click("播放四个声部");
  const context = Context.instances[0]; const analyser = context.analysers[0];
  const master = context.nodes.find(node => node.connect.mock.calls.some(([target]) => target === analyser))!;
  expect(context.analysers).toHaveLength(1); expect(analyser.fftSize).toBe(8192);
  expect(analyser.smoothingTimeConstant).toBe(0); expect(master.gain.value).toBe(0.5);
  context.bindings.forEach((source, audio) => {
    expect(source.connect.mock.calls[0][0].gain.value).toBe(audio.src.endsWith("DRUMS") ? 0.3 : 0);
  });
  expect(master.connect.mock.calls.map(([target]) => target)).toEqual([analyser]);
  expect(analyser.connect).toHaveBeenCalledWith(context.destination);
  expect(context.nodes.flatMap(node => node.connect.mock.calls).filter(([target]) => target === context.destination)).toHaveLength(0);
  await click("暂停四个声部"); await click("播放四个声部");
  expect(context.analysers).toHaveLength(1); expect(context.sources).toHaveLength(4);
  await click("隐藏频谱"); await click("显示频谱");
  expect(context.close).not.toHaveBeenCalled(); expect(context.analysers).toHaveLength(1);
  view.unmount(); expect(analyser.disconnect).toHaveBeenCalled();
});

test("analyser allocation failure is sticky per session and leaves normal playback usable", async () => {
  const allocation = jest.spyOn(Context.prototype, "createAnalyser").mockImplementation(() => { throw new Error("analyser unavailable"); });
  render(both()); await click("播放四个声部");
  expect(stems().every((audio) => !audio.paused)).toBe(true);
  expect(screen.getByText("频谱暂不可用，播放不受影响。")).toBeInTheDocument();
  const context = Context.instances[0];
  expect(context.nodes.filter(node => node.connect.mock.calls.some(([target]) => target === context.destination))).toHaveLength(1);
  await click("暂停四个声部"); await click("播放四个声部");
  expect(allocation).toHaveBeenCalledTimes(1); expect(stems().every((audio) => !audio.paused)).toBe(true);
});

test("late result metadata, practice controls and resize preserve the live media and spectrum", async () => {
  const metadata = deferred<Response>();
  const trackId = "12345678-1234-1234-1234-123456789abc";
  const completed = { ...job(), source_track_ids: [trackId] };
  global.fetch = jest.fn(async (input) => String(input).endsWith(`/tracks/${trackId}`) ? metadata.promise : response(completed));
  jest.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ setTransform: jest.fn(), clearRect: jest.fn(), fillRect: jest.fn(), fillText: jest.fn() } as unknown as CanvasRenderingContext2D);
  const view = render(<StudioExperience initialJobId="job-1" />);
  await act(async () => {});
  await click("播放四个声部");
  const media = [...stems()]; const context = Context.instances[0];
  const canvas = screen.getByRole("img", { name: /主混音实时频谱/ });
  fireEvent.change(screen.getByLabelText("播放位置"), { target: { value: "45" } });
  fireEvent.change(screen.getByLabelText("播放速度"), { target: { value: "0.75" } });
  fireEvent.change(screen.getByLabelText("人声增益"), { target: { value: "0.4" } });
  await click("人声静音"); await click("设为循环起点");
  expect(screen.getByText("A 0:45 · 待设置终点")).toBeInTheDocument();
  await act(async () => { metadata.resolve(response({ id: trackId, title: "迟到的真实标题", artists: [{ id: "artist", name: "真实艺人" }], album: null, artwork_url: null })); });
  fireEvent(window, new Event("resize"));
  expect(screen.getByRole("heading", { name: "迟到的真实标题" })).toBeInTheDocument();
  expect(screen.getAllByText("迟到的真实标题")).toHaveLength(1);
  expect(screen.getByText("真实艺人")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /主混音实时频谱/ })).toBe(canvas);
  expect(Context.instances).toEqual([context]); expect(context.analysers).toHaveLength(1);
  expect(stems()).toEqual(media);
  expect(media.every((audio) => audio.play.mock.calls.length === 1 && audio.load.mock.calls.length === 0 && !audio.paused && audio.playbackRate === 0.75 && audio.currentTime === 45)).toBe(true);
  expect(screen.getByRole("button", { name: "人声静音" })).toHaveAttribute("aria-pressed", "true");
  view.unmount(); expect(context.close).toHaveBeenCalledTimes(1);
});

test("local result has one honest filename, no invented artist, and each control acts once", async () => {
  const completed = job(); const view = render(<StemMixer job={completed} />);
  expect(screen.getAllByText(completed.asset.original_filename)).toHaveLength(1);
  expect(screen.getByText("本地音频文件")).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "曲目封面" })).not.toBeInTheDocument();
  expect(screen.getAllByText("波形暂不可用 · 仍可定位")).toHaveLength(4);
  const writes = stems().map((audio) => {
    let value = audio.currentTime; const write = jest.fn((next: number) => { value = next; });
    Object.defineProperty(audio, "currentTime", { configurable: true, get: () => value, set: write }); return write;
  });
  fireEvent.change(screen.getByLabelText("播放位置"), { target: { value: "30" } });
  writes.forEach((write) => expect(write).toHaveBeenCalledTimes(1));
  await click("人声静音"); expect(screen.getByRole("button", { name: "人声静音" })).toHaveAttribute("aria-pressed", "true");
  await click("播放四个声部"); stems().forEach((audio) => expect(audio.play).toHaveBeenCalledTimes(1));
  view.unmount();
});

test("serial analyser connection failure detaches its branch before falling back to direct output", async () => {
  const original = Context.prototype.createAnalyser;
  jest.spyOn(Context.prototype, "createAnalyser").mockImplementation(function (this: Context) {
    const node = original.call(this);
    node.connect.mockImplementation(() => { throw new Error("analysis connection failed"); });
    return node;
  });
  render(both()); await click("播放四个声部");
  const context = Context.instances[0]; const analyser = context.analysers[0];
  const master = context.nodes.find(node => node.connect.mock.calls.some(([target]) => target === analyser))!;
  expect(master.disconnect).toHaveBeenCalledWith(analyser); expect(analyser.disconnect).toHaveBeenCalled();
  expect(master.connect).toHaveBeenCalledWith(context.destination);
  expect(stems().every(audio => !audio.paused)).toBe(true);
  expect(screen.getByText("频谱暂不可用，播放不受影响。")).toBeInTheDocument();
});
