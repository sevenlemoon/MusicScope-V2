"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Artwork } from "@/components/Artwork";
import { usePlayer } from "@/components/PlayerProvider";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

type TrackItem = components["schemas"]["TrackItem"];
type StemEntry = components["schemas"]["StemEntryResponse"];

function durationLabel(durationMs?: number | null) {
  if (!durationMs) return "—";
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export function TrackRow({ track, index }: { track: TrackItem; index?: number }) {
  const t = useText();
  const player = usePlayer();
  const router = useRouter();
  const [routing, setRouting] = useState(false);
  const active = player.current?.id === track.id;
  const separate = async () => {
    setRouting(true);
    try {
      const result = await apiRequest<StemEntry>(`/api/v1/tracks/${track.id}/stem-jobs`, { method: "POST" });
      router.push(result.studio_url);
    } finally { setRouting(false); }
  };
  return <article className={`track-row${active ? " track-row-active" : ""}`}>
    <span className="track-number">{track.playlist_position ?? index ?? "·"}</span>
    <Artwork src={track.artwork_url} alt="" sizes="48px" className="track-artwork" eager={index === 1} />
    <div className="track-primary"><Link href={`/track/${track.id}`}>{track.title}</Link><span>{(track.artist_items ?? []).length ? (track.artist_items ?? []).map((artist, artistIndex) => <span key={artist.id}>{artistIndex > 0 && ", "}<Link href={`/artist/${artist.id}`}>{artist.name}</Link></span>) : (track.artists ?? []).join(", ") || t("Unknown artist", "未知艺人")}</span></div>
    <div className="track-album">{track.album_id && track.album ? <Link href={`/album/${track.album_id}`}>{track.album}</Link> : track.album ?? "—"}</div>
    <span className="track-duration">{durationLabel(track.duration_ms)}</span>
    <div className="track-actions">
      <button type="button" onClick={() => void (active ? player.toggle() : player.playTrack(track))} aria-label={`${active && player.status === "playing" ? t("Pause", "暂停") : t("Play", "播放")} ${track.title}`}>{active && player.status === "playing" ? "Ⅱ" : "▶"}</button>
      <button type="button" onClick={() => void separate()} disabled={routing} aria-label={t(`Separate stems for ${track.title}`, `分离 ${track.title} 的声部`)}>{t("STEMS", "声部")}</button>
      <details><summary aria-label={t(`More actions for ${track.title}`, `${track.title} 的更多操作`)}>•••</summary><div><Link href={`/track/${track.id}`}>{t("Open track", "打开曲目")}</Link>{track.album_id && <Link href={`/album/${track.album_id}`}>{t("Open album", "打开专辑")}</Link>}</div></details>
    </div>
  </article>;
}
