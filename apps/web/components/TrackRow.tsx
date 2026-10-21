"use client";

import Link from "next/link";
import { useTrackSeparation } from "@/hooks/useTrackSeparation";
import styles from "./TrackRow.module.css";

import { Artwork } from "@/components/Artwork";
import { usePlayer } from "@/components/PlayerProvider";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

type TrackItem = components["schemas"]["TrackItem"];
function durationLabel(durationMs?: number | null) {
  if (!durationMs) return "—";
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export function TrackRow({ track, index }: { track: TrackItem; index?: number }) {
  const t = useText();
  const player = usePlayer();
  const { start: separate, pending, error } = useTrackSeparation(track.id, t("Could not start separation. Try again.", "分轨创建失败，请重试。"));
  const active = player.current?.id === track.id;
  const leadArtist = track.artist_items?.[0];
  return <article className={`${styles.row} track-row${active ? " track-row-active" : ""}`}>
    <span className="track-number">{track.playlist_position ?? index ?? "·"}</span>
    <button type="button" className={styles.cover} aria-label={t(`Play and open ${track.title}`, `播放并打开 ${track.title}`)} onClick={(event) => void player.playAndOpen(track, event.currentTarget)}><Artwork src={track.artwork_url} alt="" sizes="48px" className="track-artwork" eager={index === 1} /></button>
    <div className="track-primary"><button type="button" onClick={(event) => void player.playAndOpen(track, event.currentTarget)}>{track.title}</button><span>{leadArtist?.name || track.artists?.[0] || t("Unknown artist", "未知艺人")}</span></div>
    <div className="track-album">{track.album_id && track.album ? <Link href={`/album/${track.album_id}`}>{track.album}</Link> : track.album ?? "—"}</div>
    <span className="track-duration">{durationLabel(track.duration_ms)}</span>
    <div className="track-actions">
      <button type="button" onClick={() => void (active ? player.toggle() : player.playTrack(track))} aria-label={`${active && player.status === "playing" ? t("Pause", "暂停") : t("Play", "播放")} ${track.title}`}>{active && player.status === "playing" ? "Ⅱ" : "▶"}</button>
      <button type="button" onClick={() => void separate()} disabled={pending} aria-busy={pending} aria-label={t(`Separate stems for ${track.title}`, `分离 ${track.title} 的声部`)}>{pending ? t("Starting…", "创建中…") : t("Separate", "分轨")}</button>
      <details><summary aria-label={t(`More actions for ${track.title}`, `${track.title} 的更多操作`)}>•••</summary><div><Link href={`/track/${track.id}`}>{t("Track details", "曲目资料")}</Link>{track.album_id && <Link href={`/album/${track.album_id}`}>{t("Open album", "打开专辑")}</Link>}</div></details>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </article>;
}
