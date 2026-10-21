"use client";

import Link from "next/link";
import { useTrackSeparation } from "@/hooks/useTrackSeparation";
import { useEffect, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { EmptyState } from "@/components/EmptyState";
import { CollectionBrowser } from "./CollectionBrowser";
import { usePlayer } from "@/components/PlayerProvider";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

type EntityType = "album" | "playlist" | "track";
type TrackItem = components["schemas"]["TrackItem"];

export function EntityDetailExperience({ type, id }: { type: EntityType; id: string }) {
  if (type === "album") return <CollectionBrowser fixed={{ view: "album", id }} />;
  if (type === "playlist") return <CollectionBrowser fixed={{ view: "playlist", id }} />;
  return <TrackExperience id={id} />;
}

function TrackExperience({ id }: { id: string }) {
  const t = useText();
  const [detail, setDetail] = useState<components["schemas"]["TrackDetail"] | null>(null);
  const [failed, setFailed] = useState(false);
  const player = usePlayer();
  const { start: separate, pending, error } = useTrackSeparation(id, t("Could not start separation. Try again.", "分轨创建失败，请重试。"));
  useEffect(() => { apiRequest<components["schemas"]["TrackDetail"]>(`/api/v1/tracks/${id}`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  if (failed) return <MissingEntity type="track" />;
  if (!detail) return <DetailLoading />;
  const track: TrackItem = { id: detail.id, title: detail.title, artwork_url: detail.artwork_url, duration_ms: detail.duration_ms, album_id: detail.album?.id ?? null, album: detail.album?.name ?? null, artists: (detail.artists ?? []).map((artist) => artist.name), artist_items: detail.artists ?? [], sort_group: "#", playlist_position: null };
  const active = player.current?.id === id;
  return <div className="detail-view"><DetailHero eyebrow={t("TRACK / CANONICAL", "曲目 / 规范化资料")} name={detail.title} artwork={detail.artwork_url} meta={durationText(detail.duration_ms, t("en", "zh"))} relationships={<>{(detail.artists ?? []).map((artist, index) => <span key={artist.id}>{index > 0 && ", "}{artist.name}</span>)}{detail.album && <> · <Link href={`/album/${detail.album.id}`}>{detail.album.name}</Link></>}</>} />
    <div className="detail-actions"><button className="button button-primary" type="button" onClick={() => void (active ? player.toggle() : player.playTrack(track))}>{active && player.status === "playing" ? t("Pause", "暂停") : t("Play from NetEase", "从网易云音乐播放")}</button><button className="button button-quiet" type="button" onClick={() => void separate()} disabled={pending} aria-busy={pending}>{pending ? t("Starting…", "创建中…") : t("Separate stems", "分离声部")}</button></div>{error && <p className="studio-error" role="alert">{error}</p>}
    <section className="detail-section"><div className="detail-section-heading"><h2>{t("Liked playlist", "我喜欢的音乐")}</h2><span>{(detail.playlists ?? []).length}</span></div>{(detail.playlists ?? []).length ? <div className="relationship-list">{(detail.playlists ?? []).map((playlist) => <Link key={playlist.id} href={`/playlist/${playlist.id}`}>{playlist.name}<span>{t("Open playlist →", "打开歌单 →")}</span></Link>)}</div> : <p>{t("This track is not currently in your synchronized liked-songs playlist.", "此曲目目前不在已同步的“我喜欢的音乐”歌单中。")}</p>}</section>
  </div>;
}

function DetailHero({ eyebrow, name, artwork, meta, description, relationships }: { eyebrow: string; name: string; artwork?: string | null; meta: string; description?: string | null; relationships?: React.ReactNode }) {
  const t = useText();
  return <header className="detail-hero"><Artwork src={artwork} alt="" sizes="(max-width: 767px) 180px, 280px" className="detail-artwork" eager /><div><p className="eyebrow">{eyebrow}</p><h1>{name}</h1>{relationships && <div className="detail-relationships">{relationships}</div>}<p className="detail-meta">{meta}</p>{description && <p className="detail-description">{description}</p>}<Link className="text-link" href="/library">{t("← Back to library", "← 返回资料库")}</Link></div></header>;
}

function DetailLoading() { const t = useText(); return <div className="library-loading">{t("Loading canonical details…", "正在读取曲目资料…")}</div>; }
function MissingEntity({ type }: { type: EntityType }) { const t = useText(); const label = ({ album: "专辑", playlist: "歌单", track: "曲目" } as Record<EntityType, string>)[type]; return <EmptyState eyebrow={t(`${type.toUpperCase()} / UNAVAILABLE`, `${label} / 暂不可用`)} title={t(`${type[0].toUpperCase()}${type.slice(1)} could not be loaded.`, `无法读取此${label}。`)} body={t("The canonical entity may no longer be present in the synchronized library.", "此项目可能已不在已同步的资料库中。")} action={{ href: "/library", label: t("Back to library", "返回资料库") }} marker="!" />; }
function durationText(milliseconds?: number | null, locale = "en") { if (!milliseconds) return locale === "zh" ? "时长未知" : "Duration unavailable"; const seconds = Math.round(milliseconds / 1000); return locale === "zh" ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 60)} min ${seconds % 60} sec`; }
