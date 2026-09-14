"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { ApiRequestError, apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";

type TrackItem = components["schemas"]["TrackItem"];
type PlaybackSource = components["schemas"]["PlaybackSourceResponse"];
type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";

type PlayerContextValue = {
  current: TrackItem | null;
  status: PlayerStatus;
  playTrack: (track: TrackItem) => Promise<void>;
  toggle: () => Promise<void>;
};

const PlayerContext = createContext<PlayerContextValue | null>(null);

function displayTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sourceExpiresAtRef = useRef<number | null>(null);
  const [current, setCurrent] = useState<TrackItem | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.75);
  const [error, setError] = useState<string | null>(null);

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
    setStatus("loading");
    setError(null);
    setPosition(0);
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

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) {
      if (sourceExpiresAtRef.current && Date.now() >= sourceExpiresAtRef.current) {
        await playTrack(current);
        return;
      }
      try { setStatus("loading"); await audio.play(); } catch { setStatus("error"); setError("Playback could not resume. Choose Play to resolve a fresh source."); }
    } else audio.pause();
  }, [current, playTrack]);

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

  return <PlayerContext.Provider value={{ current, status, playTrack, toggle }}>
    {children}
    {current && <aside className="global-player" aria-label="Now playing">
      <Artwork src={current.artwork_url} alt="" sizes="56px" className="player-artwork" />
      <div className="player-identity"><Link href={`/track/${current.id}`}>{current.title}</Link><span>{(current.artists ?? []).join(", ") || "Unknown artist"}</span></div>
      <button className="player-toggle" type="button" onClick={() => void toggle()} aria-label={status === "playing" ? "Pause" : "Play"}>{status === "loading" ? "…" : status === "playing" ? "Ⅱ" : "▶"}</button>
      <div className="player-timeline"><span>{displayTime(position)}</span><input aria-label="Playback position" type="range" min="0" max={duration || Math.max((current.duration_ms ?? 0) / 1000, 1)} step="0.1" value={Math.min(position, duration || position)} onChange={(event) => seek(Number(event.target.value))} /><span>{displayTime(duration || (current.duration_ms ?? 0) / 1000)}</span></div>
      <label className="player-volume"><span>VOL</span><input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} /></label>
      {error && <p role="alert" className="player-error">{error}</p>}
    </aside>}
  </PlayerContext.Provider>;
}

export function usePlayer() {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used inside PlayerProvider");
  return value;
}
