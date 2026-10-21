"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CollectionView } from "@/hooks/useCollectionQuery";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { Artwork } from "./Artwork";
import { useText } from "./LocaleProvider";
import styles from "./CollectionBrowser.module.css";

type Card = { id: string; name: string; artwork?: string | null; meta: string };
export function CollectionPicker({ open, selected, onChoose, onClose }: { open: boolean; selected: CollectionView; onChoose: (view: CollectionView) => void; onClose: () => void }) {
  const t = useText(), titleId = useId();
  const [tab, setTab] = useState<"album" | "playlist">(selected.view === "album" ? "album" : "playlist");
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [composing, setComposing] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [data, setData] = useState<{ key: string; cards: Card[]; pageKey: string; next: string | null; total: number } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null), rail = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; scroll: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const requestKey = `${tab}:${q}`;
  const fetchKey = `${requestKey}:${cursor}:${revision}`;
  const error = failure?.key === fetchKey ? failure.message : "";
  const busyKey = data?.pageKey !== fetchKey && !error;
  useEffect(() => {
    if (!open) return;
    const element = dialog.current, origin = document.activeElement as HTMLElement | null;
    const previous = document.body.style.overflow, x = window.scrollX, y = window.scrollY;
    element?.showModal(); closeButton.current?.focus({ preventScroll: true }); document.body.style.overflow = "hidden";
    return () => { element?.close(); document.body.style.overflow = previous; window.scrollTo(x, y); if (origin?.isConnected) origin.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => { if (!open || composing || draft.trim() === q) return; const timer = setTimeout(() => { setQ(draft.trim()); setCursor(null); }, 300); return () => clearTimeout(timer); }, [draft, composing, open, q]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController(); let live = true;
    const query = new URLSearchParams({ scope: "personal", limit: "24", sort: "asc" });
    if (cursor) query.set("cursor", cursor);
    if (q) { query.set("q", q); query.set("types", tab); }
    const request = q ? apiRequest<components["schemas"]["LibrarySearchResponse"]>(`/api/v1/library/search?${query}`, { signal: abort.signal }).then((result) => ({ items: tab === "album" ? (result.albums ?? []).map((hit) => hit.album) : (result.playlists ?? []).map((hit) => hit.playlist), total: result.total, next_cursor: result.next_cursor })) : apiRequest<components["schemas"]["AlbumPage"] | components["schemas"]["PlaylistPage"]>(`/api/v1/library/${tab === "album" ? "albums" : "playlists"}?${query}`, { signal: abort.signal });
    request.then((result) => {
      if (!live) return;
      const cards = result.items.map((item) => "title" in item ? { id: item.id, name: item.title, artwork: item.artwork_url, meta: item.artists?.map((artist) => artist.name).join(" / ") || "—" } : { id: item.id, name: item.name, artwork: item.artwork_url, meta: `${item.track_count ?? "—"} ${t("provider-reported tracks", "首（来源报告）")}` });
      setData((previous) => ({ key: requestKey, pageKey: fetchKey, cards: cursor && previous?.key === requestKey ? [...previous.cards, ...cards.filter((card) => !previous.cards.some((old) => old.id === card.id))] : cards, next: result.next_cursor ?? null, total: result.total }));
    }).catch(() => { if (live) { setFailure({ key: fetchKey, message: t("Collections could not be loaded.", "集合读取失败。") }); } });
    return () => { live = false; abort.abort(); };
    // Text is read at request time; locale does not change the collection identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, cursor, requestKey, revision, fetchKey, open]);
  const choose = (view: CollectionView) => { onChoose(view); onClose(); };
  const visible = data?.key === requestKey ? data : null;
  return <dialog ref={dialog} className={styles.picker} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <header className={styles.pickerHeader}><h2 id={titleId}>{t("Switch library", "切换资料库")}</h2><button ref={closeButton} type="button" aria-label={t("Close collection picker", "关闭集合选择器")} onClick={onClose}>×</button></header>
    <div className={styles.pickerTools}>
      <button type="button" className={styles.liked} aria-pressed={selected.view === "liked"} onClick={() => choose({ view: "liked", id: null })}>♥ {t("Liked songs", "我喜欢的音乐")}</button>
      <div role="tablist" aria-label={t("Collection type", "集合类型")}>{(["album", "playlist"] as const).map((view) => <button key={view} type="button" role="tab" tabIndex={tab === view ? 0 : -1} aria-selected={tab === view} onClick={() => { setTab(view); setCursor(null); rail.current?.scrollTo({ left: 0 }); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = tab === "album" ? "playlist" : "album"; setTab(next); setCursor(null); (event.currentTarget.parentElement?.querySelector(`[data-view="${next}"]`) as HTMLButtonElement)?.focus(); } }} data-view={view}>{view === "album" ? t("Saved albums", "收藏专辑") : t("My playlists", "我的歌单")}</button>)}</div>
    </div>
    <form className={styles.pickerSearch} role="search" onSubmit={(event) => { event.preventDefault(); if (!composing) { setQ(draft.trim()); setCursor(null); } }}><input type="search" maxLength={200} aria-label={t("Search collection names", "搜索集合名称")} placeholder={t("Search collection names…", "搜索专辑或歌单名称…")} value={draft} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setDraft(event.currentTarget.value); }} />{draft && <button type="button" aria-label={t("Clear collection search", "清除集合名称搜索")} onClick={() => { setDraft(""); setQ(""); setCursor(null); }}>×</button>}</form>
    <div className={styles.railControls}><span>{visible ? t(`${visible.total} collections`, `${visible.total} 个集合`) : t("Loading…", "加载中…")}</span><div><button type="button" aria-label={t("Previous covers", "向前浏览封面")} onClick={() => rail.current?.scrollBy({ left: -(rail.current?.clientWidth || 400) * .8, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}>←</button><button type="button" aria-label={t("Next covers", "向后浏览封面")} onClick={() => rail.current?.scrollBy({ left: (rail.current?.clientWidth || 400) * .8, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}>→</button></div></div>
    <div ref={rail} className={styles.rail} aria-label={t("Collection covers", "集合封面")} aria-busy={Boolean(busyKey)} onPointerDown={(event) => { suppressClick.current = false; if (event.pointerType === "mouse") drag.current = { x: event.clientX, scroll: event.currentTarget.scrollLeft, moved: false }; }} onPointerMove={(event) => { const start = drag.current; if (!start || !event.buttons) return; if (Math.abs(event.clientX - start.x) > 8) { start.moved = true; suppressClick.current = true; event.currentTarget.scrollLeft = start.scroll - (event.clientX - start.x); } }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; suppressClick.current = false; }} onPointerLeave={() => { drag.current = null; }} onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}>
      {visible?.cards.map((card) => <button type="button" key={card.id} className={styles.card} aria-pressed={selected.view === tab && selected.id === card.id} onClick={() => choose({ view: tab, id: card.id })} onDragStart={(event) => event.preventDefault()}><Artwork src={card.artwork} alt="" sizes="(max-width: 600px) 40vw, 160px" /><strong>{card.name}</strong><small>{card.meta}</small>{selected.view === tab && selected.id === card.id && <span>{t("Current collection", "当前集合")} ✓</span>}</button>)}
      {visible?.next && <button className={styles.loadMore} type="button" disabled={Boolean(busyKey)} onClick={() => setCursor(visible.next)}>{t("Load more collections", "继续加载集合")} →</button>}
      {!visible?.cards.length && !busyKey && !error && <p>{t("No collections found.", "没有找到集合。")}</p>}
      {!visible && busyKey && <p role="status">{t("Loading…", "加载中…")}</p>}
    </div>
    {error && <p role="alert">{error} <button type="button" onClick={() => setRevision((value) => value + 1)}>{t("Retry", "重试")}</button></p>}
    <p className={styles.hint}>{t("Scroll to browse. Select a cover to switch; playback continues.", "滑动浏览封面，点击即切换；当前音乐继续播放。")}</p>
  </dialog>;
}
