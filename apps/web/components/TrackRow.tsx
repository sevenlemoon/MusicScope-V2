"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
  const active = player.current?.id === track.id;
  const leadArtist = track.artist_items?.[0];
  const separate = () => router.push(`/studio?source=account&track=${track.id}`);
  return <article className={`track-row${active ? " track-row-active" : ""}`}>
    <span className="track-number">{track.playlist_position ?? index ?? "·"}</span>
    <Artwork src={track.artwork_url} alt="" sizes="48px" className="track-artwork" eager={index === 1} />
    <div className="track-primary"><Link href={`/track/${track.id}`}>{track.title}</Link><span>{leadArtist?.name || track.artists?.[0] || t("Unknown artist", "未知艺人")}</span></div>
    <div className="track-album">{track.album_id && track.album ? <Link href={`/album/${track.album_id}`}>{track.album}</Link> : track.album ?? "—"}</div>
    <span className="track-duration">{durationLabel(track.duration_ms)}</span>
    <div className="track-actions">
      <button type="button" onClick={() => void (active ? player.toggle() : player.playTrack(track))} aria-label={`${active && player.status === "playing" ? t("Pause", "暂停") : t("Play", "播放")} ${track.title}`}>{active && player.status === "playing" ? "Ⅱ" : "▶"}</button>
      <button type="button" onClick={separate} aria-label={t(`Separate stems for ${track.title}`, `分离 ${track.title} 的声部`)}>{t("STEMS", "声部")}</button>
      <details><summary aria-label={t(`More actions for ${track.title}`, `${track.title} 的更多操作`)}>•••</summary><div><Link href={`/track/${track.id}`}>{t("Open track", "打开曲目")}</Link>{track.album_id && <Link href={`/album/${track.album_id}`}>{t("Open album", "打开专辑")}</Link>}</div></details>
    </div>
  </article>;
}
