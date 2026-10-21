"use client";

import { useEffect, useState } from "react";
import { useCollectionQuery, type CollectionView } from "@/hooks/useCollectionQuery";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { Artwork } from "./Artwork";
import { TrackRow } from "./TrackRow";
import { CollectionToolbar } from "./CollectionToolbar";
import { CollectionPicker } from "./CollectionPicker";
import { useText } from "./LocaleProvider";
import styles from "./CollectionBrowser.module.css";

type DefaultCollection = components["schemas"]["DefaultCollectionResponse"];
type Detail = components["schemas"]["AlbumDetail"] | components["schemas"]["PlaylistDetail"];
type TrackPage = components["schemas"]["TrackPage"];
export function CollectionBrowser({ fixed }: { fixed?: CollectionView }) {
  const t = useText();
  const { query, ready, choose, update, commit, restoreScroll } = useCollectionQuery(fixed);
  const [resolved, setResolved] = useState<DefaultCollection | null>(null);
  const [resolveError, setResolveError] = useState(false);
  const [picker, setPicker] = useState(false);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; collectionKey: string; detail: Detail | null; page: TrackPage | null; error: boolean } | null>(null);
  useEffect(() => {
    const abort = new AbortController(); let live = true;
    apiRequest<DefaultCollection>("/api/v1/library/default-collection", { signal: abort.signal }).then((value) => { if (live) { setResolved(value); setResolveError(false); } }).catch(() => { if (live) setResolveError(true); });
    return () => { live = false; abort.abort(); };
  }, [revision]);
  const id = query.view === "liked" ? resolved?.playlist_id : query.id;
  const kind = query.view === "album" ? "albums" : "playlists";
  const collectionKey = JSON.stringify([kind, id]);
  const key = JSON.stringify([kind, id, query.sort, query.q, query.cursor, revision]);
  useEffect(() => {
    if (!ready || !id) return;
    const abort = new AbortController(); let live = true;
    const params = new URLSearchParams({ scope: "personal", sort: query.sort, limit: "50" });
    if (query.q) params.set("q", query.q);
    if (query.cursor) params.set("cursor", query.cursor);
    Promise.all([apiRequest<Detail>(`/api/v1/${kind}/${encodeURIComponent(id)}?scope=personal`, { signal: abort.signal }), apiRequest<TrackPage>(`/api/v1/${kind}/${encodeURIComponent(id)}/tracks?${params}`, { signal: abort.signal })]).then(([detail, page]) => { if (live) setResult({ key, collectionKey, detail, page, error: false }); }).catch(() => { if (live) setResult({ key, collectionKey, detail: null, page: null, error: true }); });
    return () => { live = false; abort.abort(); };
  }, [ready, id, kind, query.sort, query.q, query.cursor, key, collectionKey]);
  const visible = result?.key === key ? result : null;
  useEffect(() => { if (visible) return restoreScroll(); }, [visible, restoreScroll]);
  const detail = result?.collectionKey === collectionKey ? result.detail : null, page = visible?.page;
  const title = detail ? "title" in detail ? detail.title : detail.name : query.view === "liked" ? t("Liked songs", "我喜欢的音乐") : query.view === "album" ? t("Saved album", "收藏专辑") : t("My playlist", "我的歌单");
  const empty = query.view === "liked" && resolved && !id;
  const failed = (ready && query.view !== "liked" && !id) || visible?.error || (query.view === "liked" && resolveError);
  return <section className={styles.browser} aria-label={t("Music library collection", "资料库集合")}>
    <header className={styles.hero}><Artwork key={collectionKey} src={detail?.artwork_url} alt="" sizes="80px" className={styles.cover} eager /><div className={styles.identity}><span className="eyebrow">{query.view === "album" ? t("SAVED ALBUM / SYNCED TRACKS", "收藏专辑 / 已同步曲目") : "LIBRARY"}</span><h1>{title}</h1><p>{query.view === "liked" && resolved?.account_name && <>{resolved.account_name} · </>}{detail ? "synchronized_track_count" in detail ? t(`${detail.synchronized_track_count} synced · ${detail.provider_track_count ?? "—"} reported by provider`, `已同步 ${detail.synchronized_track_count} 首 · 来源报告 ${detail.provider_track_count ?? "—"} 首`) : t(`${detail.library_track_count} synchronized tracks on this album`, `此专辑中已同步曲目 ${detail.library_track_count} 首`) : t("Synchronized library", "已同步资料库")}</p></div>{!fixed && <button type="button" className={styles.switcher} aria-haspopup="dialog" aria-expanded={picker} onClick={() => setPicker(true)}>{t("Switch album / playlist", "切换专辑/歌单")} ▾</button>}</header>
    {!empty && !failed && id && <CollectionToolbar key={`${query.view}:${query.id}`} query={query} onSearch={commit} onSort={(sort) => update({ sort })} />}
    <div className={styles.results} aria-live="polite" aria-busy={!empty && !failed && !visible}>
      {failed ? <p role="alert">{t("Collection could not be loaded.", "集合读取失败。")} <button type="button" onClick={() => setRevision((value) => value + 1)}>{t("Retry", "重试")}</button></p> : empty ? <p>{resolved.status === "ambiguous" ? t("Multiple liked playlists belong to this account. Choose a collection.", "此账号存在多个喜欢歌单，无法唯一确定。请切换选择集合。") : resolved.status === "no_connection" ? t("Connect an account to open its liked songs. Other synchronized collections remain available.", "请连接账号以读取该账号的喜欢歌单，也可切换查看其他已同步集合。") : t("No liked-songs playlist could be identified for this account. Choose another collection.", "未能识别当前账号的喜欢歌单，请切换查看其他集合。")}</p> : !visible ? <p role="status">{t("Loading…", "加载中…")}</p> : page && <>
        <div className={styles.range}><h2>{query.view === "album" ? t("Synchronized tracks on this album", "此专辑中已同步的曲目") : t("Playlist tracks", "歌单曲目")}</h2><span>{page.range_start}–{page.range_end} {t("of", "/")} {page.total}</span></div>
        {page.items.length ? <div className="track-list">{page.items.map((track, index) => <TrackRow key={track.id} track={track} index={page.range_start + index} />)}</div> : <p>{query.q ? t("No matching songs in this collection.", "此集合中没有匹配歌曲。") : query.view === "album" ? t("This album is saved, but no songs have been synchronized. This is not a complete album.", "这张专辑已收藏，但尚无已同步歌曲；此处不代表完整专辑。") : t("No synchronized songs in this playlist.", "此歌单暂无已同步歌曲。")}</p>}
        <div className="pagination-controls"><button className="button button-quiet" type="button" disabled={!page.previous_cursor} onClick={() => update({ cursor: page.previous_cursor ?? null })}>{t("Previous", "上一页")}</button><button className="button button-quiet" type="button" disabled={!page.next_cursor} onClick={() => update({ cursor: page.next_cursor ?? null })}>{t("Next", "下一页")}</button></div>
      </>}
    </div>
    {!fixed && <CollectionPicker open={picker} selected={query} onChoose={choose} onClose={() => setPicker(false)} />}
  </section>;
}
