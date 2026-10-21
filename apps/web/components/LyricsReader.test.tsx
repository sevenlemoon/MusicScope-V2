import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { LyricsReader } from "./LyricsReader";
import type { LyricsState } from "@/hooks/useTrackLyrics";
import { parseLyrics } from "@/lib/lyrics";

const original = "[00:10]First real line\n[00:20]Second real line\n[00:30]Third real line";
const lyrics: LyricsState = { status: "ready", document: { track_id: "A", provider: "netease", kind: "synced", original, translated: "", precision: "line" }, parsed: parseLyrics(original) };
const scroll = jest.fn();
const observers: TestResizeObserver[] = [];
class TestResizeObserver {
  observed = new Set<Element>();
  disconnect = jest.fn(() => this.observed.clear());
  constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
  observe = (node: Element) => this.observed.add(node);
  unobserve = (node: Element) => this.observed.delete(node);
  notify() { this.callback([], this as unknown as ResizeObserver); }
}
let frames: Map<number, FrameRequestCallback>;
let height: number, width: number;
let rowHeights: Map<number, number>;
let fonts: EventTarget;
let fontsReady: () => void;
let motion: EventTarget & { matches: boolean };
const originalRO = global.ResizeObserver;
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
function flushMeasurements() {
  act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(100)); });
}
function notify() { act(() => observers.at(-1)!.notify()); flushMeasurements(); }
beforeEach(() => {
  observers.length = 0; frames = new Map(); height = 400; width = 500; rowHeights = new Map();
  scroll.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scroll });
  jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return rowHeights.get(Number(this.dataset.lyricTime)) ?? 100; });
  jest.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return Number(this.dataset.lyricTime || 0) * 20; });
  let id = 0;
  jest.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++id, callback); return id; });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  global.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  fonts = new EventTarget();
  Object.defineProperty(fonts, "ready", { value: new Promise<void>(resolve => { fontsReady = resolve; }) });
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  motion = Object.assign(new EventTarget(), { matches: false });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => motion });
});
afterEach(() => {
  jest.restoreAllMocks(); global.ResizeObserver = originalRO;
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts); else Reflect.deleteProperty(document, "fonts");
});

test("time, line clicks and seek revisions identify the correct line without starting playback", async () => {
  const seek = jest.fn(); const view = render(<LyricsReader lyrics={lyrics} position={25} seekRevision={0} onSeek={seek} onRetry={() => {}} />);
  expect(screen.getByRole("button", { name: /Second real line/ })).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: /First real line/ })); expect(seek).toHaveBeenCalledWith(10);
  view.rerender(<LyricsReader lyrics={lyrics} position={11} seekRevision={1} onSeek={seek} onRetry={() => {}} />);
  expect(screen.getByRole("button", { name: /First real line/ })).toHaveAttribute("aria-current", "true");
  expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));
  await act(async () => {});
});
test("manual reading suspends follow until the user returns; programmatic scroll does not count as intent", () => {
  const view = render(<LyricsReader lyrics={lyrics} position={11} seekRevision={0} onSeek={() => {}} onRetry={() => {}} />);
  fireEvent.wheel(screen.getByLabelText("Lyrics")); scroll.mockClear();
  view.rerender(<LyricsReader lyrics={lyrics} position={25} seekRevision={0} onSeek={() => {}} onRetry={() => {}} />);
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Back to current line/ })); expect(scroll).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Back to current line/ })).not.toBeInTheDocument();
});
test("late arrival aligns immediately and plain lyrics offer no fake seek buttons", () => {
  const props = { position: 25, seekRevision: 0, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<LyricsReader {...props} lyrics={{ status: "loading" }} />);
  view.rerender(<LyricsReader {...props} lyrics={lyrics} />);
  expect(screen.getByRole("button", { name: /Second real line/ })).toHaveAttribute("aria-current", "true");
  expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));
  view.rerender(<LyricsReader {...props} lyrics={{ status: "ready", parsed: parseLyrics("Untimed words") }} />);
  expect(screen.getByText("Untimed words")).toBeInTheDocument(); expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
test("manual reading during the intro is preserved when the first lyric starts", () => {
  const props = { lyrics, seekRevision: 0, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<LyricsReader {...props} position={0} />);
  fireEvent.wheel(screen.getByLabelText("Lyrics"));
  scroll.mockClear();
  view.rerender(<LyricsReader {...props} position={11} />);
  expect(screen.getByRole("button", { name: /First real line/ })).toHaveAttribute("aria-current", "true");
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Back to current line/ }));
  expect(scroll).toHaveBeenCalledTimes(1);
  scroll.mockClear();
  view.rerender(<LyricsReader {...props} position={12} />);
  expect(scroll).not.toHaveBeenCalled();
});
test.each(["instrumental", "none", "error"])("%s has an honest non-blocking state", kind => {
  const retry = jest.fn(); render(<LyricsReader lyrics={kind === "error" ? { status: "error" } : { status: "ready", document: { ...lyrics.document!, kind: kind as "none" | "instrumental" } }} position={0} seekRevision={0} onSeek={() => {}} onRetry={retry} />);
  if (kind === "error") { fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(retry).toHaveBeenCalled(); }
  else expect(screen.getByText(kind === "none" ? "No lyrics available" : "Just the music.")).toBeInTheDocument();
});

test("line changes keep one observer and initial/duplicate measurements never override smooth follow", () => {
  const props = { lyrics, seekRevision: 0, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<LyricsReader {...props} position={11} />);
  notify(); scroll.mockClear();
  view.rerender(<LyricsReader {...props} position={21} />);
  expect(scroll.mock.calls.map(([command]) => command.behavior)).toEqual(["smooth"]);
  notify(); notify();
  expect(scroll.mock.calls.map(([command]) => command.behavior)).toEqual(["smooth"]);
  view.rerender(<LyricsReader {...props} position={22} />);
  expect(scroll).toHaveBeenCalledTimes(1); expect(observers).toHaveLength(1);
});

test("row/translation height updates retarget smoothly, observing every row and the content", () => {
  const props = { position: 21, seekRevision: 0, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<LyricsReader {...props} lyrics={lyrics} />);
  const row = screen.getByRole("button", { name: /Second real line/ });
  expect(observers[0].observed.has(row)).toBe(true);
  expect(observers[0].observed.size).toBe(5); // Viewport + content + three actual line boxes.
  scroll.mockClear(); rowHeights.set(20, 220); notify();
  expect(scroll).toHaveBeenLastCalledWith({ top: 338, behavior: "smooth" });
  const translated = { ...lyrics, parsed: parseLyrics(original, "[00:20.001]迟到的中文翻译") };
  rowHeights.set(20, 260);
  view.rerender(<LyricsReader {...props} lyrics={translated} />);
  expect(screen.getByText("迟到的中文翻译")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Second real line/ })).toBe(row);
  expect(scroll).toHaveBeenLastCalledWith({ top: 358, behavior: "smooth" });
  expect(observers).toHaveLength(1);
});

test("font completion and narrow-width reflow measure current geometry, coalesced per frame", async () => {
  render(<LyricsReader lyrics={lyrics} position={21} seekRevision={0} onSeek={() => {}} onRetry={() => {}} />);
  scroll.mockClear(); rowHeights.set(20, 180);
  act(() => { fonts.dispatchEvent(new Event("loadingdone")); window.dispatchEvent(new Event("resize")); observers[0].notify(); });
  expect(frames.size).toBe(1); flushMeasurements();
  expect(scroll).toHaveBeenLastCalledWith({ top: 318, behavior: "smooth" });
  width = 280; rowHeights.set(20, 300); notify();
  expect(scroll).toHaveBeenLastCalledWith({ top: 378, behavior: "smooth" });
  rowHeights.set(20, 320); await act(async () => fontsReady()); flushMeasurements();
  expect(scroll).toHaveBeenLastCalledWith({ top: 388, behavior: "smooth" });
});

test("manual reading survives layout/content changes, then returns to the latest line", () => {
  const props = { seekRevision: 0, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<LyricsReader {...props} lyrics={lyrics} position={11} />);
  fireEvent.wheel(screen.getByLabelText("Lyrics")); scroll.mockClear();
  rowHeights.set(20, 260); height = 300; notify();
  const translated = { ...lyrics, parsed: parseLyrics(original, "[00:19.999]新译文") };
  view.rerender(<LyricsReader {...props} lyrics={translated} position={21} />);
  expect(screen.getByText("新译文")).toBeInTheDocument();
  expect(scroll).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /Back to current line/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Back to current line/ }));
  expect(scroll).toHaveBeenLastCalledWith({ top: 401, behavior: "smooth" });
});

test("hidden-to-visible restores latest position immediately without taking manual reading", () => {
  const props = { lyrics, seekRevision: 0, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<LyricsReader {...props} position={11} />);
  height = 0; notify(); view.rerender(<LyricsReader {...props} position={31} />); scroll.mockClear();
  height = 400; notify(); expect(scroll).toHaveBeenLastCalledWith({ top: 478, behavior: "auto" });
  fireEvent.wheel(screen.getByLabelText("Lyrics")); scroll.mockClear();
  height = 0; notify(); height = 400; notify(); expect(scroll).not.toHaveBeenCalled();
});

test("lyrics returning after loading start a fresh viewport even when timestamps are unchanged", async () => {
  const props = { position: 21, seekRevision: 0, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<LyricsReader {...props} lyrics={lyrics} />);
  fireEvent.wheel(screen.getByLabelText("Lyrics"));
  view.rerender(<LyricsReader {...props} lyrics={{ status: "loading" }} />);
  scroll.mockClear(); view.rerender(<LyricsReader {...props} lyrics={lyrics} />);
  expect(scroll).toHaveBeenLastCalledWith({ top: 278, behavior: "auto" });
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /Back to current line/ })).not.toBeInTheDocument();
});

test("rapid seek supersedes queued layout work; stale callbacks after track replacement/unmount do nothing", async () => {
  const props = { lyrics, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<LyricsReader {...props} position={11} seekRevision={0} />);
  act(() => observers[0].notify()); const staleFrame = [...frames.values()][0]; const old = observers[0];
  view.rerender(<LyricsReader {...props} position={31} seekRevision={1} />);
  view.rerender(<LyricsReader {...props} position={21} seekRevision={2} />);
  expect(scroll).toHaveBeenLastCalledWith({ top: 278, behavior: "auto" });
  scroll.mockClear(); act(() => staleFrame(100)); expect(scroll).not.toHaveBeenCalled();
  view.rerender(<LyricsReader {...props} lyrics={{ ...lyrics, document: { ...lyrics.document!, track_id: "B" } }} position={31} seekRevision={2} />);
  expect(old.disconnect).toHaveBeenCalledTimes(1); scroll.mockClear();
  act(() => old.notify()); expect(frames.size).toBe(0);
  const current = observers.at(-1)!; view.unmount();
  act(() => current.notify()); await act(async () => fontsReady()); flushMeasurements();
  expect(scroll).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
});

test("StrictMode releases its old observer and runtime reduced-motion cancels animated follow", () => {
  const props = { lyrics, seekRevision: 0, onSeek: jest.fn(), onRetry: jest.fn() };
  const view = render(<StrictMode><LyricsReader {...props} position={11} /></StrictMode>);
  expect(observers).toHaveLength(2); expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  view.rerender(<StrictMode><LyricsReader {...props} position={21} /></StrictMode>);
  expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
  act(() => { motion.matches = true; motion.dispatchEvent(new Event("change")); });
  expect(scroll).toHaveBeenLastCalledWith({ top: 278, behavior: "auto" });
  scroll.mockClear(); notify(); expect(scroll).not.toHaveBeenCalled();
});
