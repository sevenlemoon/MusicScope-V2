import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SpectrumCanvas, StudioSpectrum, type StudioSpectrumSource } from "./StudioSpectrum";

let now = 0;
let nextId = 0;
let frames: Map<number, FrameRequestCallback>;
let hidden = false;
let reduced = false;
let motionListener: (() => void) | undefined;
let intersection: IntersectionObserverCallback;
let resize: ResizeObserverCallback;
let rectWidth = 600;
let sourceValid = true;
let ctx: Record<"clearRect" | "fillRect" | "fillText" | "setTransform" | "beginPath" | "moveTo" | "quadraticCurveTo" | "lineTo" | "closePath" | "fill" | "stroke" | "createLinearGradient", jest.Mock>;

async function frame(at: number) {
  now = at;
  await act(async () => {
    const callbacks = Array.from(frames.values()); frames.clear();
    callbacks.forEach((callback) => callback(at));
  });
}
function source(): StudioSpectrumSource {
  return { sampleRate: 48000, isValid: () => sourceValid, analyser: {
    fftSize: 8192, frequencyBinCount: 4096,
    getFloatFrequencyData: jest.fn((data: Float32Array) => { data.fill(-Infinity); data[171] = -25; }),
  } as unknown as AnalyserNode };
}

beforeEach(() => {
  now = 0; nextId = 0; frames = new Map(); hidden = false; reduced = false; rectWidth = 600; sourceValid = true;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  jest.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++nextId, callback); return nextId; });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ get matches() { return reduced; }, addEventListener: (_: string, cb: () => void) => { motionListener = cb; }, removeEventListener: jest.fn() }) });
  global.ResizeObserver = class { constructor(cb: ResizeObserverCallback) { resize = cb; } observe() {} disconnect = jest.fn(); } as unknown as typeof ResizeObserver;
  global.IntersectionObserver = class { constructor(cb: IntersectionObserverCallback) { intersection = cb; } observe() {} disconnect = jest.fn(); } as unknown as typeof IntersectionObserver;
  jest.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: rectWidth, height: 164 } as DOMRect));
  ctx = { clearRect: jest.fn(), fillRect: jest.fn(), fillText: jest.fn(), setTransform: jest.fn(), beginPath: jest.fn(), moveTo: jest.fn(), quadraticCurveTo: jest.fn(), lineTo: jest.fn(), closePath: jest.fn(), fill: jest.fn(), stroke: jest.fn(), createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })) };
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

test.each(["bars", "analyzer"] as const)("%s: 30 fps reads reuse arrays; pause decays within 0.7s and stops the loop", async appearance => {
  const input = source(); const view = render(<SpectrumCanvas source={input} playing appearance={appearance} />);
  for (let ms = 1; ms < 1000; ms += 1000 / 60) await frame(ms);
  const reader = input.analyser.getFloatFrequencyData as jest.Mock;
  expect(reader.mock.calls.length).toBeGreaterThanOrEqual(28); expect(reader.mock.calls.length).toBeLessThanOrEqual(31);
  expect(reader.mock.calls.every(([buffer]) => buffer === reader.mock.calls[0][0])).toBe(true);
  expect(ctx.fillRect).toHaveBeenCalled();
  view.rerender(<SpectrumCanvas source={input} playing={false} appearance={appearance} />);
  const reads = reader.mock.calls.length;
  for (let ms = 1001; ms <= 1701; ms += 35) await frame(ms);
  expect(reader).toHaveBeenCalledTimes(reads); expect(frames.size).toBe(0);
  ctx.fillRect.mockClear(); await frame(1800); expect(ctx.fillRect).not.toHaveBeenCalled();
  view.rerender(<SpectrumCanvas source={input} playing appearance={appearance} />); await frame(1900);
  expect(reader.mock.calls.length).toBeGreaterThan(reads);
});

test("analyzer uses equal pixel-aligned display columns independently of merged analysis bands", async () => {
  const input = source(); jest.mocked(input.analyser.getFloatFrequencyData).mockImplementation(data => data.fill(-40));
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.25 });
  const view = render(<SpectrumCanvas source={input} playing appearance="analyzer" minDb={-90} maxDb={-10} />);
  const check = (count: number) => {
    const bars = ctx.fillRect.mock.calls;
    expect(bars).toHaveLength(count);
    const widths = bars.map(([, , width]) => width * 1.25);
    const gaps = bars.slice(1).map(([x], i) => (x - bars[i][0] - bars[i][2]) * 1.25);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1 + 1e-8);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-8);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1 - 1e-8);
    expect(screen.getByRole("img")).toHaveAttribute("data-spectrum-display-columns", String(count));
    expect(Number(screen.getByRole("img").getAttribute("data-spectrum-analysis-bands"))).toBeLessThan(count);
  };
  await frame(1); check(120);
  ctx.fillRect.mockClear(); rectWidth = 330;
  await act(async () => resize([], {} as ResizeObserver)); ctx.fillRect.mockClear(); await frame(100); check(98);
  const buffer = jest.mocked(input.analyser.getFloatFrequencyData).mock.calls.at(-1)![0];
  await frame(150); expect(jest.mocked(input.analyser.getFloatFrequencyData).mock.calls.at(-1)![0]).toBe(buffer);
  expect(input.analyser.fftSize).toBe(8192);
  view.unmount(); expect(frames.size).toBe(0);
});

test("visibility, offscreen, zero width and panel toggle stop reads, not the session", async () => {
  const input = source(); render(<StudioSpectrum source={input} playing />); await frame(1);
  const reads = input.analyser.getFloatFrequencyData as jest.Mock;
  await act(async () => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  expect(frames.size).toBe(0); const count = reads.mock.calls.length;
  ctx.clearRect.mockClear();
  await act(async () => { rectWidth = 375; resize([], {} as ResizeObserver); });
  await frame(300); expect(reads).toHaveBeenCalledTimes(count); expect(ctx.clearRect).not.toHaveBeenCalled();
  await act(async () => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); }); await frame(400);
  expect(reads.mock.calls.length).toBeGreaterThan(count);
  const canvas = screen.getByRole("img");
  await act(async () => { intersection([{ target: canvas, isIntersecting: false }] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver); });
  expect(frames.size).toBe(0);
  await act(async () => { intersection([{ target: canvas, isIntersecting: true }] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver); }); await frame(500);
  await act(async () => { rectWidth = 0; resize([], {} as ResizeObserver); }); expect(frames.size).toBe(0);
  await act(async () => { rectWidth = 320; resize([], {} as ResizeObserver); }); await frame(600);
  fireEvent.click(screen.getByRole("button", { name: "隐藏频谱" })); expect(frames.size).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "显示频谱" })); await frame(700); expect(frames.size).toBe(1);
  expect(sourceValid).toBe(true);
});

test("reduced motion lowers active reads, StrictMode and unmount leave no duplicate loop", async () => {
  reduced = true; const input = source(); const view = render(<StrictMode><SpectrumCanvas source={input} playing /></StrictMode>);
  for (let ms = 1; ms < 1000; ms += 20) await frame(ms);
  expect((input.analyser.getFloatFrequencyData as jest.Mock).mock.calls.length).toBeLessThanOrEqual(5);
  expect(frames.size).toBe(1);
  await act(async () => { reduced = false; motionListener?.(); }); await frame(1100);
  view.unmount(); expect(frames.size).toBe(0);
});

test("source invalidation or task replacement stops old-session reads", async () => {
  const old = source(); const next = source(); const view = render(<SpectrumCanvas source={old} playing />); await frame(1);
  view.rerender(<SpectrumCanvas source={next} playing />); await frame(100);
  expect(old.analyser.getFloatFrequencyData).toHaveBeenCalledTimes(1);
  expect(next.analyser.getFloatFrequencyData).toHaveBeenCalledTimes(1);
  sourceValid = false; await frame(200); expect(frames.size).toBe(0);
});

test.each(["canvas", "read", "resize"])("%s failure shows unavailable without touching audio", async (failure) => {
  const input = source();
  if (failure === "canvas") jest.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  else if (failure === "read") jest.mocked(input.analyser.getFloatFrequencyData).mockImplementation(() => { throw new Error("reader failed"); });
  render(<SpectrumCanvas source={input} playing />);
  if (failure === "resize") await act(async () => { ctx.setTransform.mockImplementation(() => { throw new Error("resize failed"); }); resize([], {} as ResizeObserver); });
  await frame(1);
  expect(screen.getByText("频谱暂不可用，播放不受影响。")).toBeInTheDocument(); expect(frames.size).toBe(0);
});

test("sampleRate/fftSize changes rebuild mapping and DPR is capped", async () => {
  const input = source(); Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
  render(<SpectrumCanvas source={input} playing />); await frame(1);
  const first = (input.analyser.getFloatFrequencyData as jest.Mock).mock.calls[0][0];
  input.sampleRate = 44100; input.analyser.fftSize = 4096;
  Object.defineProperty(input.analyser, "frequencyBinCount", { value: 2048 }); await frame(100);
  const second = (input.analyser.getFloatFrequencyData as jest.Mock).mock.calls[1][0];
  expect(second).not.toBe(first); expect(second.length).toBe(2048);
  expect(screen.getByRole("img")).toHaveAttribute("width", "1200");
});

test("responsive bands rebuild only geometry and reuse buffers between subsequent frames", async () => {
  const input = source();
  jest.mocked(input.analyser.getFloatFrequencyData).mockImplementation(data => { data.fill(-40); });
  render(<SpectrumCanvas source={input} playing />); await frame(1);
  const barWidths = () => ctx.fillRect.mock.calls.filter(([, , , height]) => height > 1).map(([, , width]) => width);
  const desktop = barWidths(); expect(desktop.length).toBeGreaterThanOrEqual(44);
  ctx.fillRect.mockClear();
  await act(async () => { rectWidth = 375; resize([], {} as ResizeObserver); }); await frame(100);
  expect(barWidths()).toHaveLength(24);
  const reads = jest.mocked(input.analyser.getFloatFrequencyData);
  const buffer = reads.mock.calls.at(-1)![0]; await frame(150);
  expect(reads.mock.calls.at(-1)![0]).toBe(buffer);
  expect(frames.size).toBe(1);
});

test("contour uses the same FFT with a gradient path, no bars or scale, and silence draws no contour", async () => {
  const input = source(); render(<SpectrumCanvas source={input} playing appearance="contour" showScale={false} />);
  await frame(1); expect(ctx.quadraticCurveTo).toHaveBeenCalled(); expect(ctx.fill).toHaveBeenCalled();
  expect(ctx.fillRect).not.toHaveBeenCalled(); expect(ctx.fillText).not.toHaveBeenCalled();
  expect(input.analyser.getFloatFrequencyData).toHaveBeenCalledTimes(1);
  jest.mocked(input.analyser.getFloatFrequencyData).mockImplementation(data => { data.fill(-Infinity); });
  for (let ms = 50; ms < 1100; ms += 35) await frame(ms);
  ctx.fill.mockClear(); ctx.stroke.mockClear(); await frame(1200);
  expect(ctx.fill).not.toHaveBeenCalled(); expect(ctx.stroke).not.toHaveBeenCalled();
});

test("analyzer draws dense measured bars, dB grid and correctly placed log ticks with no contour", async () => {
  const input = source(); jest.mocked(input.analyser.getFloatFrequencyData).mockImplementation(data => data.fill(-40));
  render(<SpectrumCanvas source={input} playing appearance="analyzer" minDb={-90} maxDb={-10} />); await frame(1);
  const bars = ctx.fillRect.mock.calls; expect(bars.length).toBeGreaterThanOrEqual(80); expect(bars.length).toBeLessThanOrEqual(120);
  expect(bars.every(([, y, width, height]) => width > 0 && height > 0 && y + height === 140)).toBe(true);
  expect(ctx.quadraticCurveTo).not.toHaveBeenCalled(); expect(ctx.fillText).toHaveBeenCalledWith("-40", 2, expect.any(Number));
  const first = ctx.fillText.mock.calls.find(([text]) => text === "20")!, mid = ctx.fillText.mock.calls.find(([text]) => text === "1k")!, last = ctx.fillText.mock.calls.find(([text]) => text === "20k")!;
  expect(first[1]).toBe(30); expect(last[1]).toBe(594);
  expect(mid[1]).toBeCloseTo(30 + Math.log(1000 / 20) / Math.log(1000) * 564);
  ctx.fillRect.mockClear(); await act(async () => { rectWidth = 280; resize([], {} as ResizeObserver); }); await frame(100);
  expect(ctx.fillRect.mock.calls.length).toBeLessThan(bars.length);
  jest.mocked(input.analyser.getFloatFrequencyData).mockImplementation(data => data.fill(-Infinity));
  for (let ms = 150; ms < 1100; ms += 35) await frame(ms);
  ctx.fillRect.mockClear(); await frame(1200); expect(ctx.fillRect).not.toHaveBeenCalled();
  expect(input.analyser.fftSize).toBe(8192); // Canvas never configures the audio graph.
});
