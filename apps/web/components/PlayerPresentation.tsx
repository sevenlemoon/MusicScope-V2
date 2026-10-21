"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { components } from "@/lib/api-schema.generated";
import { Artwork } from "./Artwork";
import { useText } from "./LocaleProvider";
import type { PlayerAnalysis } from "./PlayerProvider";
import { SpectrumCanvas } from "./StudioSpectrum";
import styles from "./PlayerPresentation.module.css";
import { useTrackLyrics } from "@/hooks/useTrackLyrics";
import { LyricsReader } from "./LyricsReader";
import { ANALYZER_MIN_DB, ANALYZER_MAX_DB } from "@/lib/spectrum";

type Props = {
  expanded: boolean;
  onOpen: (origin?: HTMLElement) => void;
  onClose: () => void;
  returnTarget: React.RefObject<HTMLElement | null>;
  current: components["schemas"]["TrackItem"];
  status: "idle" | "loading" | "playing" | "paused" | "error";
  position: number;
  duration: number;
  volume: number;
  analysis?: PlayerAnalysis;
  error: string | null;
  detailHref: string;
  onToggle: () => Promise<void>;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
};

function displayTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  return `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, "0")}`;
}

// Presentation only: all transport state and media resources belong to PlayerProvider.
export function PlayerPresentation({ expanded, onOpen, onClose, returnTarget, current, status, position, duration, volume, analysis, error, detailHref, onToggle, onSeek, onVolume }: Props) {
  const t = useText();
  const [mobileView, setMobileView] = useState("cover");
  const [seekRevision, setSeekRevision] = useState(0);
  const { lyrics, retry } = useTrackLyrics(current.id, expanded);
  const [viewUnavailable, setViewUnavailable] = useState(false);
  const dock = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const titleId = useId();
  const dialogId = useId();
  const total = duration || Math.max(0, (current.duration_ms ?? 0) / 1000);
  const artists = (current.artists ?? []).join(" / ");
  const active = status === "playing" || status === "loading";
  const stateText = status === "loading" ? t("Loading… press pause to cancel", "正在加载…可暂停取消") : status === "playing" ? t("Playing", "播放中") : status === "error" ? t("Playback unavailable", "播放暂不可用") : t("Paused", "已暂停");

  useEffect(() => {
    const element = dock.current;
    if (!element) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--player-clearance");
    let last = "";
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const clearance = Math.ceil(element.getBoundingClientRect().height + (parseFloat(getComputedStyle(element).bottom) || 0) + 16);
      const value = `${clearance}px`;
      if (value !== last) { root.style.setProperty("--player-clearance", value); last = value; }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      disposed = true; observer?.disconnect(); window.removeEventListener("resize", measure);
      if (root.style.getPropertyValue("--player-clearance") === last) {
        if (previous) root.style.setProperty("--player-clearance", previous); else root.style.removeProperty("--player-clearance");
      }
    };
  }, []);

  useEffect(() => {
    if (!expanded) { if (dialog.current?.open) dialog.current.close(); return; }
    scroll.current = { x: window.scrollX, y: window.scrollY };
    try { dialog.current?.showModal(); closeButton.current?.focus({ preventScroll: true }); }
    catch {
      // Native dialog failure is external state; keep mini controls available.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setViewUnavailable(true); onClose(); return;
    }
    const body = document.body;
    const root = document.documentElement;
    const returnFocus = returnTarget.current ?? opener.current;
    const savedScroll = scroll.current;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const gap = Math.max(0, window.innerWidth - root.clientWidth);
    if (gap) body.style.paddingRight = `${(parseFloat(getComputedStyle(body).paddingRight) || 0) + gap}px`;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previousOverflow; body.style.paddingRight = previousPadding;
      const behavior = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      window.scrollTo(savedScroll.x, savedScroll.y);
      root.style.scrollBehavior = behavior;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [expanded, onClose, returnTarget]);

  useEffect(() => {
    const element = dialog.current;
    return () => { if (element?.open) element.close(); };
  }, []);

  const open = (event: React.MouseEvent<HTMLButtonElement>) => onOpen(event.currentTarget);
  const close = () => onClose();

  const seekTo = (value: number) => { setSeekRevision(revision => revision + 1); onSeek(value); };

  const playButton = (full = false) => <button type="button" className={styles.play} aria-label={active ? t("Pause", "暂停") : t("Play", "播放")} aria-busy={status === "loading"} onClick={() => void onToggle()}>
    <svg viewBox="0 0 24 24" aria-hidden="true">{active ? <path d="M7 5h3v14H7zm7 0h3v14h-3z" /> : <path d="m8 4 12 8-12 8z" />}</svg>{full && <span>{active ? t("Pause", "暂停") : t("Play", "播放")}</span>}
  </button>;
  const timeline = () => <div className={styles.timeline}><span>{displayTime(position)}</span><input aria-label={t("Playback position", "播放进度")} type="range" min={0} max={total || 1} step={0.1} value={Math.min(position, total || position)} disabled={duration <= 0} onChange={(event) => seekTo(Number(event.target.value))} /><span>{displayTime(total)}</span></div>;
  const volumeControl = () => <label className={styles.volume}><span>{t("Volume", "音量")}</span><input aria-label={t("Volume", "音量")} type="range" min={0} max={1} step={0.05} value={volume} onChange={(event) => onVolume(Number(event.target.value))} /><output>{Math.round(volume * 100)}%</output></label>;

  return <>
    <aside ref={dock} className={`global-player ${styles.dock}`} aria-label={t("Now playing", "正在播放")} aria-hidden={expanded || undefined} inert={expanded}>
      <button type="button" className={styles.coverOpen} aria-label={t("Open full player from artwork", "从封面打开播放器")} aria-controls={dialogId} aria-expanded={expanded} onClick={open}><Artwork key={current.artwork_url || current.id} src={current.artwork_url} alt="" sizes="48px" className={styles.miniArtwork} /></button>
      <div className={styles.identity}><button type="button" className={styles.titleOpen} onClick={open} title={current.title}>{current.title}</button><span>{artists || t("Artist not provided", "未提供艺人信息")}</span><small role={expanded ? undefined : "status"}>{stateText}</small></div>
      {playButton()}
      {timeline()}
      <div className={styles.miniVolume}>{volumeControl()}</div>
      <button ref={opener} className={styles.expand} type="button" aria-label={t("Open full player", "展开播放器")} aria-controls={dialogId} aria-expanded={expanded} onClick={open}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" /></svg><span>{t("Expand", "展开")}</span></button>
      {error && <p className={styles.error} role={expanded ? undefined : "alert"}>{error}</p>}
      {viewUnavailable && <p className={styles.error} role="status">{t("Full view is unavailable. Mini player controls remain available.", "完整视图暂不可用，可继续使用迷你播放器。")}</p>}
    </aside>
    <dialog ref={dialog} id={dialogId} className={styles.dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className={styles.panel} data-mobile-view={mobileView}>
        <header className={styles.header}><span className={styles.brand}>MusicScope <small>LISTEN</small></span><span className={styles.headerTitle}>{current.title}</span><button ref={closeButton} type="button" className={styles.collapse} aria-label={t("Collapse player", "收起播放器")} onClick={close}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>{t("Back", "返回")}</button></header>
        <nav className={styles.mobileViews} aria-label={t("Player view", "播放视图")}><button type="button" aria-pressed={mobileView === "cover"} onClick={() => setMobileView("cover")}>{t("Artwork", "封面")}</button><button type="button" aria-pressed={mobileView === "lyrics"} onClick={() => setMobileView("lyrics")}>{t("Lyrics", "歌词")}</button></nav>
        <div className={styles.scene}>
          <section className={styles.coverSection} aria-label={t("Artwork and track", "封面与曲目信息")}>
            <div className={styles.fullIdentity}>
              <Artwork key={current.artwork_url || current.id} src={current.artwork_url} alt={t("Track artwork", "曲目封面")} sizes="(max-width: 700px) 70vw, 380px" className={styles.fullArtwork} eager />
              <div className={styles.trackText}><h2 id={titleId} title={current.title}>{current.title}</h2><p className={styles.artists}>{artists || t("Artist not provided", "未提供艺人信息")}</p>{current.album && <p className={styles.album}>{current.album}</p>}<Link href={detailHref} onClick={close}>{t("Track details", "查看曲目资料")} <span aria-hidden="true">↗</span></Link></div>
            </div>
            {expanded && <section className={styles.spectrum} aria-label={t("Song spectrum", "歌曲频谱")}>
              {analysis?.mode === "ready" && analysis.source ? <>
                <div className={styles.spectrumHeading}><span>{t("LIVE FFT", "实时 FFT")}</span><small>Hz · dB</small></div>
                <SpectrumCanvas source={analysis.source} playing={status === "playing"} appearance="analyzer" minDb={ANALYZER_MIN_DB} maxDb={ANALYZER_MAX_DB} className={styles.spectrumCanvas} label={t("Live song spectrum; FFT, 20 Hz to 20 kHz logarithmic bands, relative digital dB level", "歌曲实时 FFT 频谱，20 Hz 至 20 kHz 对数频带与相对数字 dB 电平")} />
                <details className={styles.spectrumDetails}><summary>{t("Spectrum details", "频谱详情")}</summary><p>{t("20 Hz → 20 kHz (limited by Nyquist) · FFT 8192 · coverage-weighted power · fixed −90 to −10 dB. Low analysis bands merge at the actual FFT resolution. Equally spaced display columns may share measured bands; they do not add frequency resolution. Relative digital levels, not calibrated sound pressure.", "20 Hz → 20 kHz（受奈奎斯特上限约束）· FFT 8192 · 覆盖加权功率 · 固定 −90 至 −10 dB。低频分析带按实际 FFT 分辨率合并。等距显示柱可共享已测频带，不增加频率分辨率。相对数字电平，非校准声压。")}</p></details>
              </> : <p>{analysis?.mode === "checking" ? t("Checking source analysis capability…", "正在核验当前音源的分析能力…") : analysis?.mode === "confirming" ? t("Waiting for actual audio signal.", "等待真实音频信号。") : analysis?.mode === "unconfirmed" ? t("Analysis not confirmed for this source. Direct playback remains available.", "此音源尚未确认可分析，继续直接播放。") : t("Spectrum unavailable. Playback controls remain available.", "频谱暂不可用，可继续使用播放控制。")}</p>}
            </section>}
          </section>
          <section className={styles.lyricsSection} aria-label={t("Lyric reading", "歌词阅读")}>
            {expanded && <LyricsReader key={current.id} lyrics={lyrics} position={position} seekRevision={seekRevision} onSeek={seekTo} onRetry={retry} />}
          </section>
        </div>
        <section className={styles.fullControls} aria-label={t("Playback controls", "歌曲播放控制")}>
          <div className={styles.fullPlay}>{playButton(true)}<span role="status">{stateText}</span></div>
          {timeline()}{volumeControl()}
          {expanded && error && <p className={styles.fullError} role="alert">{error}</p>}
        </section>
      </div>
    </dialog>
  </>;
}
