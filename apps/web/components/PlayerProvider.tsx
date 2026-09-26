"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { ApiRequestError, apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

type TrackItem = components["schemas"]["TrackItem"];
type ExternalTrackItem = components["schemas"]["ExternalTrackItem"];
type PlaybackSource = components["schemas"]["PlaybackSourceResponse"];
type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";

type PlayerContextValue = {
  current: TrackItem | null;
  status: PlayerStatus;
  playTrack: (track: TrackItem) => Promise<void>;
  playExternalTrack: (track: ExternalTrackItem) => Promise<void>;
  toggle: () => Promise<void>;
};

const PlayerContext = createContext<PlayerContextValue | null>(null);

function displayTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const t = useText();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sourceExpiresAtRef = useRef<number | null>(null);
  const externalTrackRef = useRef<ExternalTrackItem | null>(null);
  const [current, setCurrent] = useState<TrackItem | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.75);
  const [error, setError] = useState<string | null>(null);
  const [detailHref, setDetailHref] = useState<string | null>(null);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.volume = 0.75;
    audioRef.current = audio;
    const time = () => setPosition(audio.currentTime);
    const metadata = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const playing = () => { setStatus("playing"); setError(null); };
    const paused = () => setStatus((value) => value === "error" || value === "idle" ? value : "paused");
    const waiting = () => setStatus("loading");
    const failed = () => { setStatus("error"); setError("Playback stopped. This provider source may no longer be available."); };
    audio.addEventListener("timeupdate", time);
    audio.addEventListener("loadedmetadata", metadata);
    audio.addEventListener("durationchange", metadata);
    audio.addEventListener("playing", playing);
    audio.addEventListener("pause", paused);
    audio.addEventListener("waiting", waiting);
    audio.addEventListener("error", failed);
    audio.addEventListener("ended", () => { setStatus("paused"); setPosition(0); });
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
    };
  }, []); // The audio element intentionally lives for the root layout's lifetime.

  const playTrack = useCallback(async (track: TrackItem) => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrent(track);
    externalTrackRef.current = null;
    setStatus("loading");
    setError(null);
    setPosition(0);
    setDetailHref(`/track/${track.id}`);
    try {
      const source = await apiRequest<PlaybackSource>(`/api/v1/tracks/${track.id}/playback-source`, { method: "POST" });
      sourceExpiresAtRef.current = source.expires_at ? Date.parse(source.expires_at) : null;
      audio.src = source.url;
      audio.load();
      await audio.play();
    } catch (reason) {
      setStatus("error");
      const statusCode = reason instanceof ApiRequestError ? reason.status : 0;
      setError(statusCode === 401 ? "Your NetEase session expired. Reconnect before playing music." : statusCode === 409 ? "Connect NetEase before playing music." : statusCode === 422 ? "This track cannot be played with the current account." : statusCode === 503 ? "NetEase playback is temporarily unavailable." : "NetEase could not provide a playable source for this track.");
    }
  }, []);

  const playExternalTrack = useCallback(async (track: ExternalTrackItem) => {
    const audio = audioRef.current;
    if (!audio) return;
    const displayTrack: TrackItem = {
      id: `provider:${track.provider}:track:${track.provider_id}`,
      title: track.title,
      artwork_url: track.artwork_url,
      duration_ms: track.duration_ms,
      album_id: null,
      album: track.album?.title ?? null,
      artists: (track.artists ?? []).map((artist) => artist.name),
      artist_items: [],
      sort_group: "#",
      playlist_position: null,
    };
    setCurrent(displayTrack);
    externalTrackRef.current = track;
    setDetailHref(`/discover/track/${track.provider}/${track.provider_id}`);
    setStatus("loading");
    setError(null);
    setPosition(0);
    try {
      const source = await apiRequest<PlaybackSource>(`/api/v1/recommendations/external/${track.provider}/tracks/${track.provider_id}/playback-source`, { method: "POST" });
      sourceExpiresAtRef.current = source.expires_at ? Date.parse(source.expires_at) : null;
      audio.src = source.url;
      audio.load();
      await audio.play();
    } catch (reason) {
      setStatus("error");
      const statusCode = reason instanceof ApiRequestError ? reason.status : 0;
      setError(statusCode === 401 ? "Your NetEase session expired. Reconnect before playing music." : statusCode === 409 ? "Connect NetEase before playing music." : statusCode === 422 ? "This track cannot be played with the current account." : statusCode === 503 ? "NetEase playback is temporarily unavailable." : "NetEase could not provide a playable source for this track.");
    }
  }, []);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) {
      if (sourceExpiresAtRef.current && Date.now() >= sourceExpiresAtRef.current) {
        if (externalTrackRef.current) await playExternalTrack(externalTrackRef.current);
        else await playTrack(current);
        return;
      }
      try { setStatus("loading"); await audio.play(); } catch { setStatus("error"); setError("Playback could not resume. Choose Play to resolve a fresh source."); }
    } else audio.pause();
  }, [current, playExternalTrack, playTrack]);

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setPosition(value);
  };

  const changeVolume = (value: number) => {
    const audio = audioRef.current;
    setVolume(value);
    if (audio) audio.volume = value;
  };

  return <PlayerContext.Provider value={{ current, status, playTrack, playExternalTrack, toggle }}>
    {children}
    {current && <aside className="global-player" aria-label={t("Now playing", "正在播放")}>
      <Artwork src={current.artwork_url} alt="" sizes="56px" className="player-artwork" />
      <div className="player-identity"><Link href={detailHref ?? `/track/${current.id}`}>{current.title}</Link><span>{(current.artists ?? []).join(", ") || t("Unknown artist", "未知艺人")}</span></div>
      <button className="player-toggle" type="button" onClick={() => void toggle()} aria-label={status === "playing" ? t("Pause", "暂停") : t("Play", "播放")}>{status === "loading" ? "…" : status === "playing" ? "Ⅱ" : "▶"}</button>
      <div className="player-timeline"><span>{displayTime(position)}</span><input aria-label={t("Playback position", "播放进度")} type="range" min="0" max={duration || Math.max((current.duration_ms ?? 0) / 1000, 1)} step="0.1" value={Math.min(position, duration || position)} onChange={(event) => seek(Number(event.target.value))} /><span>{displayTime(duration || (current.duration_ms ?? 0) / 1000)}</span></div>
      <label className="player-volume"><span>{t("VOL", "音量")}</span><input aria-label={t("Volume", "音量")} type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} /></label>
      {error && <p role="alert" className="player-error">{t(error, playerErrorZh(error))}</p>}
    </aside>}
  </PlayerContext.Provider>;
}

function playerErrorZh(error: string) {
  return ({
    "Playback stopped. This provider source may no longer be available.": "播放已停止。此来源可能已不可用。",
    "Your NetEase session expired. Reconnect before playing music.": "网易云音乐会话已过期，请重新连接后播放。",
    "Connect NetEase before playing music.": "请先连接网易云音乐。",
    "This track cannot be played with the current account.": "当前账号无法播放此曲目。",
    "NetEase playback is temporarily unavailable.": "网易云音乐播放暂不可用。",
    "NetEase could not provide a playable source for this track.": "网易云音乐未能提供此曲目的可播放来源。",
    "Playback could not resume. Choose Play to resolve a fresh source.": "无法继续播放。请点击播放以获取新来源。",
  } as Record<string, string>)[error] || error;
}

export function usePlayer() {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used inside PlayerProvider");
  return value;
}
