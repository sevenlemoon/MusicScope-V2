"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { LyricLine } from "@/lib/lyrics";

type Viewport = {
  live: boolean;
  update: (index: number, instant: boolean, force: boolean) => void;
  stop: () => void;
};

// Measurement notifications only invalidate geometry. Playback/seek decides
// the scroll intent; both use the same controller and latest committed index.
export function useLyricViewport(lines: LyricLine[] | undefined, index: number, seekRevision: number, trackId?: string) {
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const elements = useRef<(HTMLButtonElement | null)[]>([]);
  const viewport = useRef<Viewport | null>(null);
  const manualRef = useRef(false);
  const [manual, setManual] = useState(false);
  const [followRevision, setFollowRevision] = useState(0);
  const previous = useRef({ timeline: "", trackId, seekRevision, followRevision, initialized: false });
  const hasLines = Boolean(lines?.length);

  useLayoutEffect(() => {
    const wrap = container.current;
    if (!wrap || !hasLines) return;
    previous.current.initialized = false;
    let disposed = false;
    let frame = 0;
    let activeIndex = -1;
    let visible = false;
    let lastTarget: number | null = null;
    const observed = new Set<Element>();
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const cancel = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
    const align = (instant = false, force = false) => {
      if (disposed) return;
      if (!wrap.clientHeight || !wrap.clientWidth) { visible = false; return; }
      const restored = !visible;
      visible = true;
      if (manualRef.current) return;
      const row = elements.current[activeIndex];
      const target = row ? row.offsetTop + row.offsetHeight / 2 - wrap.clientHeight * 0.43 : 0;
      const top = Math.max(0, Math.min(target, Math.max(0, wrap.scrollHeight - wrap.clientHeight)));
      // Initial RO notifications and unrelated row changes must not restart a
      // native smooth scroll already heading to exactly this target.
      if (!force && !instant && !restored && lastTarget !== null && Math.abs(top - lastTarget) < 0.5) return;
      lastTarget = top;
      wrap.scrollTo?.({ top, behavior: instant || restored || motion?.matches ? "auto" : "smooth" });
    };
    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; align(); });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const refreshRows = () => {
      const next = new Set<Element>([wrap, ...elements.current.filter((row): row is HTMLButtonElement => Boolean(row?.isConnected))]);
      if (content.current) next.add(content.current);
      for (const row of observed) if (!next.has(row)) { observer?.unobserve(row); observed.delete(row); }
      for (const row of next) if (!observed.has(row)) { observer?.observe(row); observed.add(row); }
    };
    const controller: Viewport = {
      live: true,
      update(nextIndex, instant, force) { cancel(); activeIndex = nextIndex; refreshRows(); align(instant, force); },
      stop() { cancel(); wrap.scrollTo?.({ top: wrap.scrollTop, behavior: "auto" }); lastTarget = null; },
    };
    viewport.current = controller;
    const motionChanged = () => { cancel(); align(Boolean(motion?.matches), true); };
    const onVisible = () => { if (!document.hidden) schedule(); };
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", onVisible);
    motion?.addEventListener?.("change", motionChanged);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      disposed = true; controller.live = false; cancel(); observer?.disconnect(); observed.clear();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", onVisible);
      motion?.removeEventListener?.("change", motionChanged);
      document.fonts?.removeEventListener("loadingdone", schedule);
      if (viewport.current === controller) viewport.current = null;
    };
  }, [hasLines, trackId]);

  useLayoutEffect(() => {
    const controller = viewport.current;
    if (!controller || !hasLines) return;
    const timeline = lines!.map(line => line.at).join("|");
    const old = previous.current;
    // Replacing translation/text at the same timestamps is a layout update,
    // not a new playback intent, and must preserve manual reading.
    const jumped = !old.initialized || old.trackId !== trackId || old.timeline !== timeline || old.seekRevision !== seekRevision;
    const returning = old.followRevision !== followRevision;
    previous.current = { timeline, trackId, seekRevision, followRevision, initialized: true };
    if (jumped && manualRef.current) {
      manualRef.current = false;
      queueMicrotask(() => { if (controller.live && viewport.current === controller && !manualRef.current) setManual(false); });
    }
    controller.update(index, jumped, jumped || returning);
  }, [lines, index, seekRevision, followRevision, trackId, hasLines]);

  const browse = () => {
    if (!manualRef.current) { manualRef.current = true; viewport.current?.stop(); setManual(true); }
  };
  const follow = () => { manualRef.current = false; setManual(false); setFollowRevision(value => value + 1); };
  return { container, content, elements, manual, browse, follow };
}
