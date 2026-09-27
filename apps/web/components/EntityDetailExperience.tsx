"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { EmptyState } from "@/components/EmptyState";
import { TrackRow } from "@/components/TrackRow";
import { usePlayer } from "@/components/PlayerProvider";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

type EntityType = "artist" | "album" | "playlist" | "track";
type TrackItem = components["schemas"]["TrackItem"];
type TrackPage = components["schemas"]["TrackPage"];
type AlbumPage = components["schemas"]["AlbumPage"];

export function EntityDetailExperience({ type, id }: { type: EntityType; id: string }) {
  if (type === "artist") return <ArtistExperience id={id} />;
  if (type === "album") return <AlbumExperience id={id} />;
  if (type === "playlist") return <PlaylistExperience id={id} />;
  return <TrackExperience id={id} />;
}

function ArtistExperience({ id }: { id: string }) {
  const t = useText();
  const [detail, setDetail] = useState<components["schemas"]["ArtistDetail"] | null>(null);
  const [tracks, setTracks] = useState<TrackPage | null>(null);
  const [albums, setAlbums] = useState<AlbumPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { apiRequest<components["schemas"]["ArtistDetail"]>(`/api/v1/artists/${id}`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  useEffect(() => { const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""; Promise.all([apiRequest<TrackPage>(`/api/v1/artists/${id}/tracks${query}`), apiRequest<AlbumPage>(`/api/v1/artists/${id}/albums`)]).then(([nextTracks, nextAlbums]) => { setTracks(nextTracks); setAlbums(nextAlbums); }).catch(() => setFailed(true)); }, [cursor, id]);
  if (failed) return <MissingEntity type="artist" />;
  if (!detail || !tracks || !albums) return <DetailLoading />;
  return <div className="detail-view"><DetailHero eyebrow={t("ARTIST / LIKED SONGS", "艺人 / 我喜欢的音乐")} name={detail.name} artwork={detail.artwork_url} meta={t(`${detail.library_track_count} lead-credited liked tracks · ${detail.represented_album_count} related albums`, `首位署名的喜欢曲目 ${detail.library_track_count} 首 · 涉及专辑 ${detail.represented_album_count} 张`)} />
    <section className="detail-section"><div className="detail-section-heading"><h2>{t("Albums in your library", "资料库中的专辑")}</h2><span>{albums.total}</span></div><div className="detail-card-row">{albums.items.map((album) => <Link className="library-card" href={`/album/${album.id}`} key={album.id}><Artwork src={album.artwork_url} alt="" /><strong>{album.title}</strong><small>{(album.artists ?? []).map((artist) => artist.name).join(", ")}</small></Link>)}</div></section>
    <PagedTracks title={t("Lead-credited liked tracks", "首位署名的喜欢曲目")} page={tracks} setCursor={setCursor} />
  </div>;
}

function AlbumExperience({ id }: { id: string }) {
  const t = useText();
  const [detail, setDetail] = useState<components["schemas"]["AlbumDetail"] | null>(null);
  const [tracks, setTracks] = useState<TrackPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { apiRequest<components["schemas"]["AlbumDetail"]>(`/api/v1/albums/${id}?scope=all`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  useEffect(() => { const query = new URLSearchParams({ scope: "all" }); if (cursor) query.set("cursor", cursor); apiRequest<TrackPage>(`/api/v1/albums/${id}/tracks?${query}`).then(setTracks).catch(() => setFailed(true)); }, [cursor, id]);
  if (failed) return <MissingEntity type="album" />;
  if (!detail || !tracks) return <DetailLoading />;
  return <div className="detail-view"><DetailHero eyebrow={t("ALBUM / SYNCED TRACKS", "专辑 / 已同步曲目")} name={detail.title} artwork={detail.artwork_url} meta={t(`${detail.library_track_count} synchronized tracks on this album`, `此专辑中已同步曲目 ${detail.library_track_count} 首`)} relationships={(detail.artists ?? []).map((artist) => <span key={artist.id}>{artist.name}</span>)} />{tracks.total ? <PagedTracks title={t("Synchronized tracks on this album", "此专辑中已同步的曲目")} page={tracks} setCursor={setCursor} /> : <p className="detail-description">{t("This album is saved in your account, but none of its songs are in the synchronized library yet.", "这张专辑已在账号中收藏，但目前没有属于已同步资料库的曲目。")}</p>}</div>;
}

function PlaylistExperience({ id }: { id: string }) {
  const t = useText();
  const [detail, setDetail] = useState<components["schemas"]["PlaylistDetail"] | null>(null);
  const [tracks, setTracks] = useState<TrackPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSort] = useState<"original" | "asc" | "desc">("original");
  const [failed, setFailed] = useState(false);
  useEffect(() => { apiRequest<components["schemas"]["PlaylistDetail"]>(`/api/v1/playlists/${id}?scope=personal`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  useEffect(() => { const query = new URLSearchParams({ sort, scope: "personal" }); if (cursor) query.set("cursor", cursor); apiRequest<TrackPage>(`/api/v1/playlists/${id}/tracks?${query}`).then(setTracks).catch(() => setFailed(true)); }, [cursor, id, sort]);
  if (failed) return <MissingEntity type="playlist" />;
  if (!detail || !tracks) return <DetailLoading />;
  return <div className="detail-view"><DetailHero eyebrow={t("PLAYLIST / NETEASE", "歌单 / 网易云音乐")} name={detail.name} artwork={detail.artwork_url} meta={t(`${detail.synchronized_track_count} synchronized tracks${detail.provider_track_count !== null && detail.provider_track_count !== detail.synchronized_track_count ? ` · ${detail.provider_track_count} reported by provider` : ""}`, `${detail.synchronized_track_count} 首已同步曲目${detail.provider_track_count !== null && detail.provider_track_count !== detail.synchronized_track_count ? ` · 来源报告 ${detail.provider_track_count} 首` : ""}`)} description={detail.description} />
    <div className="detail-sort" aria-label={t("Playlist track order", "歌单曲目顺序")}>{(["original", "asc", "desc"] as const).map((value) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => { setSort(value); setCursor(null); }}>{value === "original" ? t("Playlist order", "歌单顺序") : value === "asc" ? "A–Z" : "Z–A"}</button>)}</div>
    <PagedTracks title={t("Playlist tracks", "歌单曲目")} page={tracks} setCursor={setCursor} />
  </div>;
}

function TrackExperience({ id }: { id: string }) {
  const t = useText();
  const [detail, setDetail] = useState<components["schemas"]["TrackDetail"] | null>(null);
  const [failed, setFailed] = useState(false);
  const player = usePlayer();
  const router = useRouter();
  useEffect(() => { apiRequest<components["schemas"]["TrackDetail"]>(`/api/v1/tracks/${id}`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  if (failed) return <MissingEntity type="track" />;
  if (!detail) return <DetailLoading />;
  const track: TrackItem = { id: detail.id, title: detail.title, artwork_url: detail.artwork_url, duration_ms: detail.duration_ms, album_id: detail.album?.id ?? null, album: detail.album?.name ?? null, artists: (detail.artists ?? []).map((artist) => artist.name), artist_items: detail.artists ?? [], sort_group: "#", playlist_position: null };
  const active = player.current?.id === id;
  const separate = () => router.push(`/studio?source=account&track=${id}`);
  return <div className="detail-view"><DetailHero eyebrow={t("TRACK / CANONICAL", "曲目 / 规范化资料")} name={detail.title} artwork={detail.artwork_url} meta={durationText(detail.duration_ms, t("en", "zh"))} relationships={<>{(detail.artists ?? []).map((artist, index) => <span key={artist.id}>{index > 0 && ", "}{artist.name}</span>)}{detail.album && <> · <Link href={`/album/${detail.album.id}`}>{detail.album.name}</Link></>}</>} />
    <div className="detail-actions"><button className="button button-primary" type="button" onClick={() => void (active ? player.toggle() : player.playTrack(track))}>{active && player.status === "playing" ? t("Pause", "暂停") : t("Play from NetEase", "从网易云音乐播放")}</button><button className="button button-quiet" type="button" onClick={separate}>{t("Separate stems", "分离声部")}</button></div>
    <section className="detail-section"><div className="detail-section-heading"><h2>{t("Liked playlist", "我喜欢的音乐")}</h2><span>{(detail.playlists ?? []).length}</span></div>{(detail.playlists ?? []).length ? <div className="relationship-list">{(detail.playlists ?? []).map((playlist) => <Link key={playlist.id} href={`/playlist/${playlist.id}`}>{playlist.name}<span>{t("Open playlist →", "打开歌单 →")}</span></Link>)}</div> : <p>{t("This track is not currently in your synchronized liked-songs playlist.", "此曲目目前不在已同步的“我喜欢的音乐”歌单中。")}</p>}</section>
  </div>;
}

function DetailHero({ eyebrow, name, artwork, meta, description, relationships }: { eyebrow: string; name: string; artwork?: string | null; meta: string; description?: string | null; relationships?: React.ReactNode }) {
  const t = useText();
  return <header className="detail-hero"><Artwork src={artwork} alt="" sizes="(max-width: 767px) 180px, 280px" className="detail-artwork" eager /><div><p className="eyebrow">{eyebrow}</p><h1>{name}</h1>{relationships && <div className="detail-relationships">{relationships}</div>}<p className="detail-meta">{meta}</p>{description && <p className="detail-description">{description}</p>}<Link className="text-link" href="/library">{t("← Back to library", "← 返回资料库")}</Link></div></header>;
}

function PagedTracks({ title, page, setCursor }: { title: string; page: TrackPage; setCursor: (cursor: string | null) => void }) {
  const t = useText();
  return <section className="detail-section"><div className="detail-section-heading"><h2>{title}</h2><span>{page.range_start}–{page.range_end} {t("of", "/")} {page.total}</span></div><div className="track-list">{page.items.map((track, index) => <TrackRow track={track} key={track.id} index={(page.range_start || 1) + index} />)}</div><div className="pagination-controls"><button className="button button-quiet" type="button" disabled={!page.previous_cursor} onClick={() => setCursor(page.previous_cursor ?? null)}>{t("Previous", "上一页")}</button><button className="button button-quiet" type="button" disabled={!page.next_cursor} onClick={() => setCursor(page.next_cursor ?? null)}>{t("Next", "下一页")}</button></div></section>;
}

function DetailLoading() { const t = useText(); return <div className="library-loading">{t("Loading canonical details…", "正在读取曲目资料…")}</div>; }
function MissingEntity({ type }: { type: EntityType }) { const t = useText(); const label = ({ artist: "艺人", album: "专辑", playlist: "歌单", track: "曲目" } as Record<EntityType, string>)[type]; return <EmptyState eyebrow={t(`${type.toUpperCase()} / UNAVAILABLE`, `${label} / 暂不可用`)} title={t(`${type[0].toUpperCase()}${type.slice(1)} could not be loaded.`, `无法读取此${label}。`)} body={t("The canonical entity may no longer be present in the synchronized library.", "此项目可能已不在已同步的资料库中。")} action={{ href: "/library", label: t("Back to library", "返回资料库") }} marker="!" />; }
function durationText(milliseconds?: number | null, locale = "en") { if (!milliseconds) return locale === "zh" ? "时长未知" : "Duration unavailable"; const seconds = Math.round(milliseconds / 1000); return locale === "zh" ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 60)} min ${seconds % 60} sec`; }
