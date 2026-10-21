"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "./LocaleProvider";
import styles from "./StudioSpectrum.module.css";
import { analyzerBandCount, createSpectrumDisplayGrid, createSpectrumMapping, decaySpectrumPeaks, frequencyPosition, readSpectrumBands, readSpectrumDisplay, smoothSpectrum, spectrumBandCount, SPECTRUM_MIN_DB, SPECTRUM_MAX_DB, type SpectrumDisplayGrid } from "@/lib/spectrum";

export type StudioSpectrumSource = { analyser: AnalyserNode; sampleRate: number; isValid: () => boolean };
export type StudioAnalysis = StudioSpectrumSource | "unavailable" | null;

export function StudioSpectrum({ source, playing }: { source: StudioAnalysis; playing: boolean }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [shown, setShown] = useState(true);
  return <section className={styles.panel} aria-label={zh ? "主混音频谱" : "Master mix spectrum"}>
    <div className={styles.heading}><h3>{zh ? "混音频谱" : "Mix spectrum"} · Hz / kHz</h3><button type="button" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? (zh ? "隐藏频谱" : "Hide spectrum") : (zh ? "显示频谱" : "Show spectrum")}</button></div>
    {shown && <>
      {source && source !== "unavailable" ? <SpectrumCanvas source={source} playing={playing} /> : <p className={styles.placeholder}>{source === "unavailable" ? (zh ? "频谱暂不可用，播放不受影响。" : "Spectrum unavailable. Playback remains available.") : (zh ? "播放后显示真实混音频谱。" : "Play to analyse the live mix.")}</p>}
      <p className={styles.note}>{zh ? "数字音频相对强度 · 固定 −85 至 −15 dB · 非校准声压" : "Relative digital level · fixed −85 to −15 dB · not calibrated SPL"}</p>
    </>}
  </section>;
}

export function SpectrumCanvas({ source, playing, minDb = SPECTRUM_MIN_DB, maxDb = SPECTRUM_MAX_DB, label, className, appearance = "bars", showScale = true }: { source: StudioSpectrumSource; playing: boolean; minDb?: number; maxDb?: number; label?: string; className?: string; appearance?: "bars" | "contour" | "analyzer"; showScale?: boolean }) {
  const { locale } = useLocale();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playback = useRef(playing);
  const wake = useRef<(() => void) | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let broken = false;
    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let lastFrame = 0;
    let decayDeadline = 0;
    let visible = !document.hidden;
    let inView = true;
    let ro: ResizeObserver | undefined;
    let io: IntersectionObserver | undefined;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let reduced = motion?.matches ?? false;
    const instrument = appearance === "analyzer";
    const chooseBands = instrument ? analyzerBandCount : spectrumBandCount;
    const makeMapping = (count: number) => createSpectrumMapping(source.sampleRate, source.analyser.fftSize, count, instrument ? 20 : 32, instrument ? 20000 : 16000);
    let bandCount = chooseBands(0);
    let mapping = makeMapping(bandCount);
    let bins = new Float32Array(source.analyser.frequencyBinCount);
    let db = new Float32Array(mapping.bands.length);
    let measuredLevels = new Float32Array(mapping.bands.length);
    let target = new Float32Array(mapping.bands.length);
    let levels = new Float32Array(mapping.bands.length);
    let peaks = new Float32Array(mapping.bands.length);
    let bars: { x: number; width: number }[] = [];
    let display: SpectrumDisplayGrid = { columns: [] };
    let ticks: { x: number; text: string }[] = [];
    let grid: { y: number; text: string }[] = [];
    let ctx: CanvasRenderingContext2D | null = null;
    let gradient: CanvasGradient | null = null;

    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    const schedule = () => {
      if (!disposed && !broken && visible && inView && width > 0 && height > 0 && !raf) raf = requestAnimationFrame(frame);
    };
    const geometry = () => {
      const left = instrument ? 30 : 12;
      const plotWidth = Math.max(0, width - left - (instrument ? 6 : 12));
      if (instrument) {
        display = createSpectrumDisplayGrid(mapping, left, plotWidth, dpr);
        bars = display.columns;
        if (target.length !== bars.length) {
          target = new Float32Array(bars.length); levels = new Float32Array(bars.length); peaks = new Float32Array(bars.length);
        }
      } else bars = mapping.bands.map((band) => {
        const x = left + frequencyPosition(band.lowHz, mapping.minHz, mapping.maxHz) * plotWidth;
        const end = left + frequencyPosition(band.highHz, mapping.minHz, mapping.maxHz) * plotWidth;
        const gap = 2;
        return { x: x + gap / 2, width: Math.max(0, end - x - gap) };
      });
      canvas.dataset.spectrumAnalysisBands = String(mapping.bands.length);
      canvas.dataset.spectrumDisplayColumns = String(bars.length);
      ticks = [];
      const frequencies = instrument ? [20, 200, 1000, 2000, 5000, 10000, 20000] : [32, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
      for (const hz of frequencies) {
        if (hz < mapping.minHz || hz > mapping.maxHz) continue;
        const x = left + frequencyPosition(hz, mapping.minHz, mapping.maxHz) * plotWidth;
        const text = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
        if (ticks.length && x - ticks[ticks.length - 1].x < (instrument ? 28 : 42)) {
          if (!instrument || hz !== mapping.maxHz) continue;
          ticks.pop(); // Keep the true upper edge without overlapping its neighbour.
        }
        ticks.push({ x, text });
      }
      const baseline = height - (showScale ? 24 : 2);
      grid = instrument ? [-80, -60, -40, -20].filter(db => db > minDb && db < maxDb)
        .map(db => ({ y: baseline - (db - minDb) / (maxDb - minDb) * Math.max(0, baseline - 12), text: `${db}` })) : [];
    };
    const paint = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      const baseline = height - (showScale ? 24 : 2);
      if (instrument) {
        ctx.strokeStyle = "#bdcfc510"; ctx.lineWidth = 0.5;
        ctx.font = "9px ui-monospace, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#91a69a";
        for (const line of grid) {
          ctx.beginPath(); ctx.moveTo(30, line.y); ctx.lineTo(width - 6, line.y); ctx.stroke();
          ctx.fillText(line.text, 2, line.y);
        }
      }
      if (appearance === "contour") {
        // Quadratic display interpolation between measured log bands; never
        // invents bins, normalises levels or supplies energy for silence.
        let maximum = 0;
        for (let i = 0; i < levels.length; ++i) maximum = Math.max(maximum, levels[i]);
        if (maximum > 0) {
          const plotHeight = Math.max(0, baseline - 4);
          ctx.beginPath(); ctx.moveTo(12, baseline);
          for (let i = 0; i < bars.length; ++i) {
            const x = bars[i].x + bars[i].width / 2, y = baseline - levels[i] * plotHeight;
            const nextX = i + 1 < bars.length ? bars[i + 1].x + bars[i + 1].width / 2 : width - 12;
            const nextY = i + 1 < bars.length ? baseline - levels[i + 1] * plotHeight : baseline;
            ctx.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
          }
          ctx.lineTo(width - 12, baseline); ctx.lineTo(12, baseline); ctx.closePath();
          ctx.fillStyle = gradient ?? "#c9ff6822"; ctx.fill();
          ctx.strokeStyle = "#c6e8ab80"; ctx.lineWidth = 1.2; ctx.stroke();
        }
      } else {
        ctx.fillStyle = instrument ? "#c0d5c5" : "#c9ff68";
        for (let i = 0; i < bars.length; ++i) {
          const h = levels[i] * Math.max(0, baseline - (instrument ? 12 : 8));
          if (h >= 0.5) ctx.fillRect(bars[i].x, baseline - h, bars[i].width, h);
        }
        if (!reduced && !instrument) {
          ctx.fillStyle = "#e7ffc2";
          for (let i = 0; i < bars.length; ++i) {
            const h = peaks[i] * Math.max(0, baseline - 8);
            if (h >= 0.5) ctx.fillRect(bars[i].x, baseline - h, bars[i].width, 1);
          }
        }
      }
      if (!showScale) return;
      ctx.fillStyle = "#a4a6b2";
      ctx.font = `${instrument ? 9 : 10}px ui-monospace, monospace`;
      ctx.textBaseline = "bottom";
      for (let i = 0; i < ticks.length; ++i) {
        ctx.textAlign = i === 0 ? "left" : i === ticks.length - 1 ? "right" : "center";
        ctx.fillText(ticks[i].text, ticks[i].x, height - 4);
      }
    };
    const updateMapping = () => {
      const count = chooseBands(width);
      if (count === bandCount && mapping.sampleRate === source.sampleRate && mapping.fftSize === source.analyser.fftSize) return false;
      bandCount = count;
      mapping = makeMapping(count);
      bins = new Float32Array(source.analyser.frequencyBinCount);
      db = new Float32Array(mapping.bands.length); measuredLevels = new Float32Array(mapping.bands.length); target = new Float32Array(mapping.bands.length);
      levels = new Float32Array(mapping.bands.length); peaks = new Float32Array(mapping.bands.length);
      geometry();
      return true;
    };
    const resize = () => {
      if (disposed || broken || !ctx || !source.isValid()) return;
      try {
        const rect = canvas.getBoundingClientRect();
        width = Math.max(0, rect.width); height = Math.max(0, rect.height);
        dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (appearance === "contour") {
          gradient = ctx.createLinearGradient(0, 0, 0, height);
          gradient.addColorStop(0, "#d8efb766"); gradient.addColorStop(1, "#7ccec604");
        }
        if (!updateMapping()) geometry();
        if (visible && inView && width && height) paint();
        if (!width || !height) stop(); else schedule();
      } catch { fail(); }
    };
    const onVisibility = () => {
      visible = !document.hidden;
      if (!visible) stop(); else { lastFrame = 0; schedule(); }
    };
    const onMotion = () => { reduced = motion?.matches ?? false; lastFrame = 0; schedule(); };
    const disposeDrawing = () => {
      stop(); ro?.disconnect(); io?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      motion?.removeEventListener("change", onMotion);
    };
    const fail = () => {
      broken = true; disposeDrawing();
      queueMicrotask(() => { if (!disposed) setFailed(true); });
    };
    function frame(now: number) {
      raf = 0;
      if (disposed || broken || !visible || !inView || !source.isValid()) return;
      const active = playback.current;
      const interval = reduced && active ? 200 : 1000 / 30;
      if (lastFrame && now - lastFrame < interval - 0.5) { schedule(); return; }
      const dt = lastFrame ? (now - lastFrame) / 1000 : 1 / 30;
      lastFrame = now;
      try {
        updateMapping();
        if (active) {
          source.analyser.getFloatFrequencyData(bins);
          readSpectrumBands(mapping, bins, db, instrument ? measuredLevels : target, minDb, maxDb);
          if (instrument) readSpectrumDisplay(display, db, target, minDb, maxDb);
          decayDeadline = 0;
        } else target.fill(0);
        const maximum = instrument ? smoothSpectrum(levels, target, dt, 0.015, 0.1) : smoothSpectrum(levels, target, dt);
        decaySpectrumPeaks(peaks, levels, dt);
        const settled = !active && (reduced || now >= decayDeadline || maximum === 0);
        if (settled) { levels.fill(0); peaks.fill(0); }
        paint();
        if (!settled) schedule();
      } catch { fail(); }
    }
    const resumeDrawing = () => {
      lastFrame = 0;
      decayDeadline = performance.now() + 600;
      schedule();
    };
    wake.current = resumeDrawing;
    try {
      ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D unavailable");
      window.addEventListener("resize", resize);
      document.addEventListener("visibilitychange", onVisibility);
      motion?.addEventListener("change", onMotion);
      if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(resize); ro.observe(canvas); }
      if (typeof IntersectionObserver !== "undefined") {
        io = new IntersectionObserver((entries) => {
          inView = entries.some((entry) => entry.target === canvas && entry.isIntersecting);
          if (!inView) stop(); else { lastFrame = 0; schedule(); }
        });
        io.observe(canvas);
      }
      resize(); resumeDrawing();
    } catch { fail(); }
    return () => { disposed = true; disposeDrawing(); if (wake.current === resumeDrawing) wake.current = null; };
  }, [source, minDb, maxDb, locale, appearance, showScale]);

  useEffect(() => { playback.current = playing; wake.current?.(); }, [playing]);

  return failed ? <p className={styles.placeholder}>{locale === "zh" ? "频谱暂不可用，播放不受影响。" : "Spectrum unavailable. Playback remains available."}</p> :
    <canvas ref={canvasRef} className={className ?? `studio-spectrum-canvas ${styles.canvas}`} role="img" aria-label={label ?? (locale === "zh" ? "主混音实时频谱，横轴为 Hz / kHz，柱高为相对数字强度" : "Live master mix spectrum; Hz / kHz axis and relative digital level")} />;
}
