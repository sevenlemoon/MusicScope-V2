"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CollectionView = { view: "liked" | "playlist" | "album"; id: string | null };
export type CollectionQuery = CollectionView & { sort: "original" | "asc" | "desc"; q: string; cursor: string | null };
const defaults: CollectionQuery = { view: "liked", id: null, sort: "original", q: "", cursor: null };
const storageKey = "musicscope:collection-view:v2";
type Snapshot = { query: CollectionQuery; y: number; browse?: { sort: CollectionQuery["sort"]; cursor: string | null; y: number } };

function readSnapshots(): Record<string, Snapshot> {
  const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
  const valid: Record<string, Snapshot> = Object.create(null);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return valid;
  const position = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const sort = (value: unknown) => value === "original" || value === "asc" || value === "desc";
  const cursor = (value: unknown) => value === null || typeof value === "string";
  for (const [key, value] of Object.entries(stored)) {
    if (!value || typeof value !== "object" || !position(value.y)) continue;
    const q = value.query;
    if (!q || !["liked", "playlist", "album"].includes(q.view) || !cursor(q.id) ||
        !sort(q.sort) || typeof q.q !== "string" || q.q.length > 200 || !cursor(q.cursor)) continue;
    const browse = value.browse;
    valid[key] = { query: q, y: value.y, ...(browse && sort(browse.sort) && cursor(browse.cursor) && position(browse.y) ? { browse } : {}) };
  }
  return valid;
}
export function parseCollectionQuery(search: string): CollectionQuery {
  const p = new URLSearchParams(search);
  const view = p.get("view") === "album" ? "album" : p.get("view") === "playlist" ? "playlist" : "liked";
  const sort = p.get("sort");
  return { view, id: view === "liked" ? null : p.get("id"), sort: sort === "desc" ? "desc" : sort === "asc" || view === "album" ? "asc" : "original", q: (p.get("q") || "").trim().slice(0, 200), cursor: p.get("cursor") };
}
export function collectionQueryString(query: CollectionQuery) {
  const p = new URLSearchParams();
  if (query.view !== "liked") { p.set("view", query.view); if (query.id) p.set("id", query.id); }
  if (query.sort !== (query.view === "album" ? "asc" : "original")) p.set("sort", query.sort);
  if (query.q) p.set("q", query.q);
  if (query.cursor) p.set("cursor", query.cursor);
  return p.toString();
}
const keyFor = (query: CollectionView) => `${query.view}:${query.id || "default"}`;

export function useCollectionQuery(fixed?: CollectionView) {
  const [query, setQuery] = useState<CollectionQuery>({ ...defaults, ...fixed, sort: fixed?.view === "album" ? "asc" : "original" });
  const [ready, setReady] = useState(false);
  const current = useRef(query);
  const snapshots = useRef<Record<string, Snapshot>>({});
  const restoring = useRef<number | null>(null);
  const departing = useRef(false);
  const fixedView = fixed?.view, fixedId = fixed?.id;
  const save = useCallback(() => {
    if (departing.current || restoring.current !== null) return;
    const q = current.current, key = keyFor(q), previous = snapshots.current[key];
    const snapshot = { query: q, y: window.scrollY, browse: previous?.browse };
    snapshots.current[key] = snapshot;
    snapshots.current[`url:${window.location.pathname}?${collectionQueryString(q)}`] = snapshot;
    try { sessionStorage.setItem(storageKey, JSON.stringify(snapshots.current)); } catch { /* Optional storage. */ }
  }, []);
  useEffect(() => {
    try { snapshots.current = readSnapshots(); sessionStorage.removeItem("musicscope:library-view:v1"); } catch { snapshots.current = Object.create(null); }
    const restore = () => {
      departing.current = false;
      const parsed = parseCollectionQuery(window.location.search);
      const next = fixedView ? { ...parsed, view: fixedView, id: fixedId || null, sort: fixedView === "album" && parsed.sort === "original" ? "asc" as const : parsed.sort } : parsed;
      current.current = next; setQuery(next);
      restoring.current = snapshots.current[`url:${window.location.pathname}?${collectionQueryString(next)}`]?.y ?? 0;
      setReady(true);
    };
    restore();
    const leave = (event: MouseEvent) => { const anchor = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null; if (anchor && !event.metaKey && !event.ctrlKey && !event.shiftKey && new URL(anchor.href).pathname !== window.location.pathname) { save(); departing.current = true; } };
    const freeze = () => { save(); departing.current = true; };
    window.addEventListener("musicscope:leaving-library", freeze);
    window.addEventListener("popstate", restore);
    window.addEventListener("scroll", save, { passive: true });
    window.addEventListener("pagehide", save);
    document.addEventListener("click", leave, true);
    return () => { save(); window.removeEventListener("musicscope:leaving-library", freeze); window.removeEventListener("popstate", restore); window.removeEventListener("scroll", save); window.removeEventListener("pagehide", save); document.removeEventListener("click", leave, true); };
  }, [fixedView, fixedId, save]);
  const apply = useCallback((next: CollectionQuery, push = false, y: number | null = null) => {
    save(); departing.current = false; restoring.current = y;
    current.current = next; setQuery(next);
    const search = collectionQueryString(next);
    window.history[push ? "pushState" : "replaceState"](window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }, [save]);
  const choose = useCallback((view: CollectionView) => {
    if (current.current.view === view.view && current.current.id === view.id) return;
    const saved = snapshots.current[keyFor(view)];
    apply(saved?.query || { ...defaults, ...view, sort: view.view === "album" ? "asc" : "original" }, true, saved?.y ?? 0);
  }, [apply]);
  useEffect(() => {
    if (fixedView) return;
    const reset = () => apply(defaults, Boolean(window.location.search), 0);
    window.addEventListener("musicscope:library-default", reset);
    return () => window.removeEventListener("musicscope:library-default", reset);
  }, [apply, fixedView]);
  const commit = useCallback((value: string) => {
    const q = value.trim().slice(0, 200), old = current.current;
    if (q === old.q) return;
    save(); const key = keyFor(old);
    if (!old.q && q) {
      snapshots.current[key] = { query: old, y: window.scrollY, browse: { sort: old.sort, cursor: old.cursor, y: window.scrollY } };
    }
    const browse = snapshots.current[key]?.browse;
    apply({ ...old, q, cursor: !q && browse ? browse.cursor : null, sort: !q && browse ? browse.sort : old.sort }, false, !q && browse ? browse.y : 0);
  }, [apply, save]);
  const update = useCallback((patch: Partial<Pick<CollectionQuery, "sort" | "cursor">>) => {
    apply({ ...current.current, ...patch, ...(patch.sort ? { cursor: null } : {}) }, false, 0);
  }, [apply]);
  const restoreScroll = useCallback(() => {
    if (restoring.current === null) return;
    let frame = 0, attempts = 0;
    const cancel = () => { restoring.current = null; cancelAnimationFrame(frame); };
    const run = () => {
      if (restoring.current === null) return;
      const y = restoring.current; window.scrollTo({ top: y, behavior: "instant" });
      if (document.documentElement.scrollHeight - innerHeight >= y || ++attempts > 40) restoring.current = null;
      else frame = requestAnimationFrame(run);
    };
    frame = requestAnimationFrame(run);
    window.addEventListener("wheel", cancel, { passive: true }); window.addEventListener("touchstart", cancel, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("wheel", cancel); window.removeEventListener("touchstart", cancel); };
  }, []);
  return { query, ready, choose, update, commit, restoreScroll };
}
