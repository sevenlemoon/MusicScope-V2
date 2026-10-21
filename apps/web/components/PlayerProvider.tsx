"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { PlayerPresentation } from "./PlayerPresentation";
import type { StudioSpectrumSource } from "./StudioSpectrum";
import { ApiRequestError, apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { playbackCoordinator, type PlaybackParticipant, type PlaybackRequest } from "@/lib/playback-ownership";
import { bindPlayerGraph, checkSourcePermission, loadPlayerSource, preparePlayerGraph, type PlayerGraph } from "@/lib/player-analysis";
import { useText } from "./LocaleProvider";

type TrackItem = components["schemas"]["TrackItem"];
type PlaybackSource = components["schemas"]["PlaybackSourceResponse"];
type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";
export type PlayerAnalysis = { mode: "direct" | "checking" | "confirming" | "ready" | "unconfirmed" | "unavailable" | "recovered"; output: "direct" | "web-audio"; source: StudioSpectrumSource | null; replacements: number; replacementReason: string | null };
const initialAnalysis: PlayerAnalysis = { mode: "direct", output: "direct", source: null, replacements: 0, replacementReason: null };
type PlayerContextValue = { current: TrackItem | null; status: PlayerStatus; playTrack: (track: TrackItem) => Promise<void>; toggle: () => Promise<void>; playAndOpen: (track: TrackItem, origin?: HTMLElement) => Promise<void>; openPlayer: (origin?: HTMLElement) => void; closePlayer: () => void };
const PlayerContext = createContext<PlayerContextValue | null>(null);
type PlayerSession = {
  audio: HTMLAudioElement; participant: PlaybackParticipant; request: PlaybackRequest | null;
  abort: AbortController | null; starting: boolean; sourceReady: boolean; live: boolean;
  graph: PlayerGraph | null; source: PlaybackSource | null; epoch: number; pendingPosition: number | null;
  analysis: PlayerAnalysis; monitor: ReturnType<typeof setInterval> | null;
  detach: () => void; install: (audio: HTMLAudioElement) => void;
  contextCleanup: () => void;
  publish: (mode: PlayerAnalysis["mode"], source?: StudioSpectrumSource | null) => void;
  replace: (reason: string, position?: number) => HTMLAudioElement;
  observe: () => void;
  recover: (allowPaused?: boolean) => void;
  start: (request: PlaybackRequest, audio: HTMLAudioElement) => Promise<void>;
};

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const t = useText();
  const sessionRef = useRef<PlayerSession | null>(null);
  const volumeRef = useRef(0.75);
  const sourceExpiresAtRef = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const returnTarget = useRef<HTMLElement | null>(null);
  const selectedTrack = useRef<string | null>(null);
  const [current, setCurrent] = useState<TrackItem | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.75);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PlayerAnalysis>(initialAnalysis);

  useEffect(() => {
    const stopMonitor = () => { if (session.monitor !== null) clearInterval(session.monitor); session.monitor = null; };
    const participant = playbackCoordinator.register("player", () => {
      session.abort?.abort(); session.abort = null; session.starting = false; session.request = null;
      stopMonitor(); session.audio.pause();
      if (session.graph && !session.graph.bound) { const unused = session.graph; session.graph = null; unused.dispose(); }
      if (session.live) setStatus((value) => value === "idle" ? value : "paused");
    });
    const session: PlayerSession = {
      audio: new Audio(), participant, request: null, abort: null, starting: false, sourceReady: false, live: true,
      graph: null, source: null, epoch: 0, pendingPosition: null, analysis: initialAnalysis, monitor: null,
      detach: () => {}, install: () => {}, contextCleanup: () => {}, replace: () => session.audio, observe: () => {}, recover: () => {}, start: async () => {},
      publish(mode, source = null) {
        session.analysis = { ...session.analysis, mode, source, output: session.graph?.bound ? "web-audio" : "direct" };
        if (session.live) setAnalysis(session.analysis);
      },
    };
    session.install = (audio) => {
      session.audio = audio; audio.preload = "metadata"; audio.volume = volumeRef.current;
      const valid = () => session.live && session.audio === audio;
      const time = () => { if (valid() && session.sourceReady) setPosition(audio.currentTime); };
      const metadata = () => {
        if (!valid() || !session.sourceReady) return;
        if (session.pendingPosition !== null) {
          try { audio.currentTime = session.pendingPosition; session.pendingPosition = null; } catch { /* Retry at the next metadata event. */ }
        }
        setDuration(Number.isFinite(audio.duration) ? audio.duration : 0); time();
      };
      const playing = () => {
        if (!valid() || !participant.isCurrent(session.request) || !session.sourceReady) { audio.pause(); return; }
        setStatus("playing"); setError(null); session.observe();
      };
      const paused = () => { if (valid() && audio.paused && !session.starting && participant.isOwner()) { stopMonitor(); setStatus("paused"); } };
      const waiting = () => { if (valid() && participant.isCurrent(session.request)) setStatus("loading"); };
      const failed = () => {
        if (!valid() || !participant.isCurrent(session.request) || !session.sourceReady || !audio.error) return;
        if (session.graph?.bound && !session.starting) { session.recover(true); return; }
        if (session.starting) return; // play() rejection owns startup rollback.
        participant.pause(); setStatus("error"); setError("Playback stopped. This provider source may no longer be available.");
      };
      const ended = () => { if (valid() && participant.isCurrent(session.request) && session.sourceReady && audio.ended !== false) { participant.pause(); setPosition(0); } };
      const listeners = { timeupdate: time, loadedmetadata: metadata, durationchange: metadata, play: playing, playing, pause: paused, waiting, error: failed, ended };
      Object.entries(listeners).forEach(([event, listener]) => audio.addEventListener(event, listener));
      session.detach = () => {
        Object.entries(listeners).forEach(([event, listener]) => audio.removeEventListener(event, listener));
        audio.pause(); audio.removeAttribute("src"); audio.load();
      };
    };
    session.replace = (reason, at = 0) => {
      // A bound element cannot revert to direct output. Stop it BEFORE installing its successor.
      stopMonitor(); ++session.epoch; session.sourceReady = false;
      session.contextCleanup(); session.contextCleanup = () => {};
      session.detach(); const oldGraph = session.graph; session.graph = null; oldGraph?.dispose();
      session.pendingPosition = at;
      session.analysis = { ...session.analysis, replacements: session.analysis.replacements + 1, replacementReason: reason };
      session.publish("recovered");
      const audio = new Audio(); session.install(audio); return audio;
    };
    session.observe = () => {
      stopMonitor();
      const graph = session.graph, audio = session.audio, epoch = session.epoch;
      if (!graph?.analyser || session.analysis.mode === "ready" || session.analysis.mode === "unavailable") return;
      const bins = new Float32Array(graph.analyser.frequencyBinCount);
      let interval: ReturnType<typeof setInterval> | null = null;
      const stopThisMonitor = () => {
        if (interval !== null) clearInterval(interval);
        if (session.monitor === interval) session.monitor = null;
        interval = null;
      };
      const check = () => {
        if (session.monitor !== interval || !session.live || session.graph !== graph || session.epoch !== epoch || audio.paused || !participant.isCurrent(session.request)) { stopThisMonitor(); return; }
        if (document.hidden || graph.context.state !== "running" || audio.readyState < 2) return;
        try {
          graph.analyser!.getFloatFrequencyData(bins);
          // Silence and buffering NEVER prove CORS failure. Wait for an actual finite AC bin.
          if (bins.some((value, index) => index > 0 && Number.isFinite(value))) {
            session.publish("ready", { analyser: graph.analyser!, sampleRate: graph.context.sampleRate, isValid: () => session.live && session.epoch === epoch && session.graph === graph && session.audio === audio });
            stopThisMonitor();
          }
        } catch { session.publish("unavailable"); stopThisMonitor(); } // Output graph remains usable.
      };
      interval = setInterval(check, 250); session.monitor = interval; check();
    };
    session.start = async (request: PlaybackRequest, initial: HTMLAudioElement) => {
      let audio = initial;
      const valid = () => session.live && session.participant.isCurrent(request) && session.audio === audio;
      try {
        session.starting = true; setStatus("loading"); setError(null);
        await audio.play();
        if (!valid()) { if (session.audio !== audio || !session.participant.isOwner()) audio.pause(); return; }
        if (session.graph?.bound && session.graph.context.state !== "running") throw new Error("audio-output-unavailable");
        session.starting = false; setStatus("playing"); session.observe();
      } catch {
        if (!valid()) return;
        if (session.graph?.bound && session.source) {
          const at = session.pendingPosition ?? audio.currentTime;
          audio = session.replace("graph-start-failure", at);
          session.sourceReady = true; audio.src = session.source.url; audio.load();
          try {
            await audio.play();
            if (!valid()) { if (session.audio !== audio || !session.participant.isOwner()) audio.pause(); return; }
            session.starting = false; setStatus("playing"); return;
          } catch { if (!valid()) return; }
        }
        session.participant.pause(request); setStatus("error"); setError("Playback could not resume. Choose Play to resolve a fresh source.");
        session.sourceReady = false;
      } finally {
        if (session.audio !== audio || !session.participant.isOwner()) audio.pause();
        if (valid()) { session.starting = false; session.abort = null; }
      }
    };

    session.recover = (allowPaused = false) => {
      const request = session.request, old = session.audio, source = session.source;
      if (!source || (old.paused && !allowPaused) || session.starting || !session.sourceReady || !participant.isCurrent(request)) return;
      const audio = session.replace("graph-output-failure", old.currentTime);
      session.sourceReady = true; audio.src = source.url; audio.load();
      void session.start(request!, audio);
    };
    const onVisible = () => { if (!document.hidden && !session.audio.paused) session.observe(); };
    document.addEventListener("visibilitychange", onVisible);
    session.install(session.audio); sessionRef.current = session;
    return () => {
      session.live = false; ++session.epoch; participant.dispose(); stopMonitor();
      document.removeEventListener("visibilitychange", onVisible);
      session.contextCleanup(); session.detach(); session.graph?.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, []);


  const playTrack = useCallback(async (track: TrackItem, resumeAt = 0) => {
    const session = sessionRef.current;
    if (!session) return;
    const { participant } = session;
    const request = participant.claim(); if (!request) return;
    session.request = request; session.starting = true; session.sourceReady = false; ++session.epoch;
    session.pendingPosition = resumeAt;
    const abort = new AbortController(); session.abort = abort;
    sourceExpiresAtRef.current = null;
    selectedTrack.current = track.id;
    setCurrent(track); setStatus("loading"); setError(null); setPosition(resumeAt); setDuration(0);
    session.publish("checking");
    // Resume while the play gesture is still active. No media is routed until permission succeeds.
    if (!session.graph) session.graph = preparePlayerGraph();
    else session.graph.resumed = session.graph.resume();
    const graph = session.graph;
    try {
      const source = await apiRequest<PlaybackSource>(`/api/v1/tracks/${track.id}/playback-source`, { method: "POST", signal: abort.signal });
      if (!participant.isCurrent(request)) return;
      session.source = source;
      sourceExpiresAtRef.current = source.expires_at ? Date.parse(source.expires_at) : null;
      const permission = graph ? await checkSourcePermission(source.url, abort.signal) : "unconfirmed";
      if (!participant.isCurrent(request)) return;
      const resumed = permission === "readable" && graph ? await graph.resumed : false;
      if (!participant.isCurrent(request)) return;
      let audio = session.audio;
      if (permission === "readable" && graph && resumed && graph.context.state === "running") {
        try {
          // Configuration is chosen before src/load, never by opening the panel.
          audio.crossOrigin = "anonymous"; bindPlayerGraph(graph, audio, volumeRef.current);
          if (graph.gain) graph.gain.gain.value = volumeRef.current;
          session.publish("confirming");
          session.contextCleanup();
          const fault = () => { if (graph.context.state !== "running" && session.graph === graph) session.recover(); };
          graph.context.addEventListener?.("statechange", fault);
          session.contextCleanup = () => graph.context.removeEventListener?.("statechange", fault);
        } catch {
          if (graph.bound) audio = session.replace("graph-initialization-failure", session.pendingPosition ?? resumeAt);
          else { graph.dispose(); if (session.graph === graph) session.graph = null; audio.crossOrigin = null; }
          session.publish("unavailable");
        }
      } else {
        if (graph?.bound) audio = session.replace("source-not-confirmed", session.pendingPosition ?? resumeAt);
        else { graph?.dispose(); if (session.graph === graph) session.graph = null; audio.crossOrigin = null; }
        session.publish(graph ? "unconfirmed" : "unavailable");
      }
      session.sourceReady = true;
      loadPlayerSource(audio, source.url);
      await session.start(request, audio);
    } catch (reason) {
      if (!participant.isCurrent(request)) return;
      participant.pause(request); session.publish("unavailable"); setStatus("error");
      const statusCode = reason instanceof ApiRequestError ? reason.status : 0;
      setError(statusCode === 401 ? "Your NetEase session expired. Reconnect before playing music." : statusCode === 409 ? "Connect NetEase before playing music." : statusCode === 422 ? "This track cannot be played with the current account." : statusCode === 503 ? "NetEase playback is temporarily unavailable." : "NetEase could not provide a playable source for this track.");
    } finally { if (participant.isCurrent(request)) { session.starting = false; session.abort = null; } }
  }, []);

  const toggle = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !current) return;
    const { participant } = session;
    if (participant.isOwner() && (session.starting || !session.audio.paused)) { participant.pause(); return; }
    if (!session.sourceReady || (sourceExpiresAtRef.current && Date.now() >= sourceExpiresAtRef.current)) { await playTrack(current, session.sourceReady ? session.audio.currentTime : session.pendingPosition ?? 0); return; }
    const request = participant.claim(); if (!request) return;
    session.request = request; session.starting = true;
    setStatus("loading"); setError(null);
    const graph = session.graph;
    if (graph) {
      const resumed = await graph.resume();
      if (!participant.isCurrent(request)) return;
      if (!resumed) {
        const audio = session.replace("context-resume-failure", session.audio.currentTime);
        session.sourceReady = true; audio.src = session.source!.url; audio.load();
      }
    }
    if (!participant.isCurrent(request)) return;
    await session.start(request, session.audio);
  }, [current, playTrack]);

  const openPlayer = useCallback((origin?: HTMLElement) => {
    if (origin) returnTarget.current = origin;
    setExpanded(true);
  }, []);
  const closePlayer = useCallback(() => setExpanded(false), []);
  const playAndOpen = useCallback(async (track: TrackItem, origin?: HTMLElement) => {
    openPlayer(origin);
    const session = sessionRef.current;
    if (selectedTrack.current === track.id && session) {
      if (session.participant.isOwner() && (session.starting || !session.audio.paused)) return;
      await toggle();
    } else await playTrack(track);
  }, [openPlayer, playTrack, toggle]);

  const seek = (value: number) => {
    const session = sessionRef.current; if (!session) return;
    session.pendingPosition = value;
    if (session.sourceReady) {
      try { session.audio.currentTime = value; session.pendingPosition = null; } catch { /* Apply when metadata becomes available. */ }
    }
    setPosition(value);
  };
  const changeVolume = (value: number) => {
    volumeRef.current = value; setVolume(value);
    const session = sessionRef.current; if (!session) return;
    if (session.graph?.bound && session.graph.gain) { session.graph.gain.gain.value = value; session.audio.volume = 1; }
    else session.audio.volume = value;
  };
  return <PlayerContext.Provider value={{ current, status, playTrack, toggle, playAndOpen, openPlayer, closePlayer }}>
    {children}
    {current && <PlayerPresentation expanded={expanded} onOpen={openPlayer} onClose={closePlayer} returnTarget={returnTarget} current={current} status={status} position={position} duration={duration} volume={volume} analysis={analysis} error={error ? t(error, playerErrorZh(error)) : null} detailHref={`/track/${current.id}`} onToggle={toggle} onSeek={seek} onVolume={changeVolume} />}
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
