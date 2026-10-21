"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { parseLyrics, type ParsedLyrics } from "@/lib/lyrics";

type Document = components["schemas"]["TrackLyricsResponse"];
export type LyricsState = { status: "loading" | "error" | "ready"; document?: Document; parsed?: ParsedLyrics };

export function useTrackLyrics(trackId: string, enabled: boolean) {
  const cache = useRef(new Map<string, { at: number; value: LyricsState }>());
  const [result, setResult] = useState<{ id: string; value: LyricsState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const cached = cache.current.get(trackId);
    let live = true;
    const abort = new AbortController();
    const publish = (value: LyricsState) => { if (live) setResult({ id: trackId, value }); };
    const timer = setTimeout(() => abort.abort(), 12_000);
    if (cached && Date.now() - cached.at < 300_000) {
      queueMicrotask(() => publish(cached.value));
    } else {
      queueMicrotask(() => publish({ status: "loading" }));
      void apiRequest<Document>(`/api/v1/tracks/${trackId}/lyrics`, { signal: abort.signal }).then(document => {
        if (!live || abort.signal.aborted) return;
        const value: LyricsState = { status: "ready", document, parsed: parseLyrics(document.original, document.translated) };
        cache.current.set(trackId, { at: Date.now(), value });
        if (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
        publish(value);
      }).catch(() => publish({ status: "error" })).finally(() => clearTimeout(timer));
    }
    return () => { live = false; clearTimeout(timer); abort.abort(); };
  }, [trackId, enabled, attempt]);
  return {
    lyrics: result?.id === trackId ? result.value : { status: "loading" } as LyricsState,
    retry: () => { cache.current.delete(trackId); setAttempt(value => value + 1); },
  };
}
