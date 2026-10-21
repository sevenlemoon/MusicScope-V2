"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useText } from "./LocaleProvider";
import type { CollectionQuery } from "@/hooks/useCollectionQuery";
import styles from "./CollectionBrowser.module.css";

export function CollectionToolbar({ query, onSearch, onSort }: { query: CollectionQuery; onSearch: (q: string) => void; onSort: (sort: CollectionQuery["sort"]) => void }) {
  const t = useText(), id = useId();
  const [open, setOpen] = useState(Boolean(query.q));
  const [draft, setDraft] = useState(query.q);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (pending.current) clearTimeout(pending.current); pending.current = null; };
  const [externalQuery, setExternalQuery] = useState(query.q);
  if (externalQuery !== query.q) { setExternalQuery(query.q); setDraft(query.q); }
  useEffect(() => {
    if (composing || draft.trim() === query.q) return;
    pending.current = setTimeout(() => onSearch(draft), 300);
    return cancel;
  }, [draft, composing, query.q, onSearch]);
  useEffect(() => () => cancel(), []);
  const clear = () => { cancel(); setDraft(""); onSearch(""); input.current?.focus(); };
  return <div className={styles.toolbar}>
    <form className={styles.search} role="search" onSubmit={(event) => { event.preventDefault(); if (!composingRef.current) { cancel(); onSearch(draft); } }}>
      {!open && !query.q ? <button ref={trigger} type="button" aria-label={t("Search current collection", "搜索当前集合")} aria-expanded={false} aria-controls={id} onClick={() => { setOpen(true); requestAnimationFrame(() => input.current?.focus()); }}>⌕<span>{t("Search", "搜索")}</span></button> : <div className={styles.searchField}>
        <input ref={input} id={id} type="search" maxLength={200} aria-label={t("Search current collection", "搜索当前集合")} placeholder={query.view === "album" ? t("Search this album", "搜索当前专辑…") : t("Search this playlist", "搜索当前歌单…")} value={draft} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composingRef.current = true; cancel(); setComposing(true); }} onCompositionEnd={(event) => { composingRef.current = false; setComposing(false); setDraft(event.currentTarget.value); }} onKeyDown={(event) => {
          if (event.key === "Escape" && !composingRef.current) { event.preventDefault(); if (draft || query.q) clear(); else { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); } }
        }} />
        <button type="button" aria-label={t("Clear or collapse search", "清空或收起搜索")} onClick={() => { if (draft || query.q) clear(); else { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); } }}>×</button>
      </div>}
    </form>
    <div className={styles.sort} aria-label={t("Track order", "曲目排序")}>
      {(query.view === "album" ? ["asc", "desc"] as const : ["original", "asc", "desc"] as const).map((sort) => <button type="button" key={sort} aria-pressed={query.sort === sort} onClick={() => onSort(sort)}>{sort === "original" ? t("Playlist order", "歌单顺序") : sort === "asc" ? "A–Z" : "Z–A"}</button>)}
    </div>
    {query.q && <span className={styles.filter}>{t("Filtering", "筛选中")}：“{query.q}”</span>}
  </div>;
}
