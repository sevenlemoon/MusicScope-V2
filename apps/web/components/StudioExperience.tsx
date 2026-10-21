"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiRequestError, apiRequest, apiUrl } from "@/lib/api-client";
import { playbackCoordinator, type PlaybackParticipant, type PlaybackRequest } from "@/lib/playback-ownership";
import { StudioSpectrum, type StudioAnalysis } from "./StudioSpectrum";
import { SPECTRUM_FFT_SIZE } from "@/lib/spectrum";
import { useLocale } from "./LocaleProvider";
import { Artwork } from "./Artwork";
import styles from "./StudioWorkbench.module.css";
import entry from "./StudioEntry.module.css";

type JobStatus = "QUEUED" | "PREPARING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
type StemType = "VOCALS" | "DRUMS" | "BASS" | "GUITAR" | "PIANO" | "OTHER";
type SourceMode = "account" | "file";
type SourceTrack = { id: string; title: string; artists: { id: string; name: string }[]; album: { id: string; name: string } | null; artwork_url?: string | null };
type StudioAsset = { id: string; original_filename: string; size_bytes: number; duration_ms: number; media_type: string; reused: boolean };
type StudioArtifact = { id: string; stem_type: StemType; stream_url: string; size_bytes: number; duration_ms: number | null };
type StudioJob = {
  id: string; status: JobStatus; stage: string; model_name: string; model_version: string | null;
  demucs_version: string | null; device: string | null; attempt_count: number; safe_error_code: string | null;
  safe_error_message: string | null; asset: StudioAsset; artifacts: StudioArtifact[]; waveform_url: string | null;
  source_track_ids: string[];
  cancellable: boolean; retryable: boolean; reused: boolean; created_at: string; completed_at: string | null;
};
type JobList = { items: StudioJob[] };
type WaveformStem = { bucket_count: number; peaks: [number, number][] };
type BeatGrid = { bpm: number; beats_ms: number[]; source: "drums"; method: string };
type Waveform = { version: string; duration_ms: number; stems: Record<StemType, WaveformStem>; beat_grid?: BeatGrid | null };

const STEMS: StemType[] = ["VOCALS", "DRUMS", "BASS", "OTHER"];
const SIX_STEMS: StemType[] = ["VOCALS", "DRUMS", "BASS", "GUITAR", "PIANO", "OTHER"];
const LABELS: Record<StemType, string> = { VOCALS: "人声", DRUMS: "鼓组", BASS: "贝斯", GUITAR: "吉他", PIANO: "钢琴", OTHER: "其他乐器/声音" };
const ACTIVE = new Set<JobStatus>(["QUEUED", "PREPARING", "RUNNING"]);

function useStudioText() {
  const { locale, provided } = useLocale();
  const zh = !provided || locale === "zh";
  return useCallback((english: string, chinese: string) => zh ? chinese : english, [zh]);
}

export function StudioExperience({ initialJobId, sourceTrackId }: { initialJobId?: string; sourceTrackId?: string }) {
  const { locale, provided } = useLocale();
  const zh = !provided || locale === "zh";
  const t = useStudioText();
  const router = useRouter();
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [job, setJob] = useState<StudioJob | null>(null);
  const [selected, setSelected] = useState<File | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>(sourceTrackId ? "account" : "file");
  const [sourceTrack, setSourceTrack] = useState<SourceTrack | null>(null);
  const [sourceTrackError, setSourceTrackError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState(initialJobId);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const viewSession = useRef<{ live: boolean } | null>(null);
  const effectiveTrackId = sourceTrackId || job?.source_track_ids?.[0];

  useEffect(() => {
    if (!effectiveTrackId || !/^[0-9a-f-]{36}$/i.test(effectiveTrackId)) return;
    let live = true;
    apiRequest<SourceTrack>(`/api/v1/tracks/${effectiveTrackId}`)
      .then((track) => { if (live) { setSourceTrack(track); setSourceTrackError(false); } })
      .catch(() => { if (live) { setSourceTrack(null); setSourceTrackError(true); } });
    return () => { live = false; };
  }, [effectiveTrackId]);

  useEffect(() => {
    const scope = { live: true };
    viewSession.current = scope;
    const load = initialJobId
      ? apiRequest<StudioJob>(`/api/v1/studio/jobs/${initialJobId}`).then((item) => { if (scope.live) { setJob(item); setJobs([item]); } })
      : apiRequest<JobList>("/api/v1/studio/jobs").then((result) => { if (scope.live) { setJobs(result.items); setJob(null); } });
    load.catch(() => { if (scope.live) setError(t("Studio is temporarily unavailable. Check that local services are running.", "Studio 暂时无法读取，请确认本地服务已经启动。")); }).finally(() => { if (scope.live) { setLoading(false); setLoadedFor(initialJobId); } });
    return () => { scope.live = false; };
  }, [initialJobId, t]);

  useEffect(() => {
    if (!job || (initialJobId && job.id !== initialJobId) || !ACTIVE.has(job.status)) return;
    let live = true;
    const timer = window.setInterval(() => {
      void apiRequest<StudioJob>(`/api/v1/studio/jobs/${job.id}`)
        .then((next) => { if (live) setJob(next); })
        .catch(() => { if (live) setError(t("Processing status updates stopped.", "处理状态更新中断。")); });
    }, 1500);
    return () => { live = false; window.clearInterval(timer); };
  }, [job, initialJobId, t]);

  const choose = (file?: File) => {
    if (!file) return;
    setSelected(file);
    setError(null);
  };

  const submitFile = async () => {
    if (submitLock.current) return;
    if (!selected) { inputRef.current?.click(); return; }
    submitLock.current = true;
    const scope = viewSession.current;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", selected);
      const asset = await apiRequest<StudioAsset>("/api/v1/studio/assets", { method: "POST", body: form });
      if (!scope?.live) return;
      const next = await apiRequest<StudioJob>(`/api/v1/studio/assets/${asset.id}/jobs?model=htdemucs_6s`, { method: "POST" });
      if (!scope?.live) return;
      setJob(next);
      router.push(`/studio/jobs/${next.id}`);
    } catch (reason) {
      if (scope?.live) setError(reason instanceof ApiRequestError ? reason.message : t("Upload or job creation failed.", "上传或创建任务失败。"));
    } finally {
      submitLock.current = false;
      if (scope?.live) setBusy(false);
    }
  };

  const submitAccount = async () => {
    if (!sourceTrack || submitLock.current) return;
    submitLock.current = true;
    const scope = viewSession.current;
    setBusy(true);
    setError(null);
    try {
      const next = await apiRequest<StudioJob>(`/api/v1/studio/tracks/${sourceTrack.id}/jobs?model=htdemucs_6s`, { method: "POST" });
      if (!scope?.live) return;
      setJob(next);
      router.push(`/studio/jobs/${next.id}?track=${sourceTrack.id}`);
    } catch (reason) {
      if (scope?.live) setError(reason instanceof ApiRequestError ? reason.message : t("This account song could not be separated. Check playback availability and try again.", "这首账号歌曲暂时无法分轨，请确认当前账号可以播放后重试。"));
    } finally {
      submitLock.current = false;
      if (scope?.live) setBusy(false);
    }
  };

  const updateJob = async (action: "cancel" | "retry") => {
    if (!job || submitLock.current) return;
    const scope = viewSession.current;
    submitLock.current = true; setBusy(true); setError(null);
    try {
      const next = await apiRequest<StudioJob>(`/api/v1/studio/jobs/${job.id}/${action}`, { method: "POST" });
      if (scope?.live) setJob(next);
    } catch (reason) {
      if (scope?.live) setError(reason instanceof ApiRequestError ? reason.message : t("The job could not be updated. Try again.", "任务操作失败，请重试。"));
    } finally {
      submitLock.current = false;
      if (scope?.live) setBusy(false);
    }
  };

  const result = loadedFor === initialJobId && job?.status === "SUCCEEDED" && (!initialJobId || job.id === initialJobId);
  const resultTrack = sourceTrack && job?.source_track_ids.includes(sourceTrack.id) ? sourceTrack : null;

  return <div className={`studio-page ${result ? styles.resultPage : ""}`}>
    {result ? <header className={styles.pageHeading}><div><span>STUDIO</span><h1>{t("Stem workbench", "分轨工作台")}</h1></div><Link href="/studio">{t("New project", "新建任务")} <span aria-hidden="true">↗</span></Link></header> : <header className={entry.heading}><p className="eyebrow">STEM STUDIO</p><h1>{initialJobId ? t("Stem separation", "音轨分离") : t("Make room for every part.", "听见每一个声部。")}</h1><p>{t("Vocals, drums, bass, guitar, piano and other sounds · Six stems", "人声、鼓组、贝斯、吉他、钢琴与其他声音 · 六轨分离")}</p></header>}
    {!result && initialJobId && sourceTrack && <div className={entry.selectedTrack}><Artwork src={sourceTrack.artwork_url} alt="" sizes="64px" /><div><h2>{sourceTrack.title}</h2><p>{sourceTrack.artists.map((artist) => artist.name).join(" / ")}</p></div></div>}
    {!initialJobId && <section className={entry.importArea} onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent) => { event.preventDefault(); if (!busy) { setSourceMode("file"); choose(event.dataTransfer.files[0]); } }}>
      {sourceMode === "account" && sourceTrack ? <div className={entry.selectedTrack}><Artwork src={sourceTrack.artwork_url} alt="" sizes="64px" /><div><h2>{sourceTrack.title}</h2><p>{sourceTrack.artists.map((artist) => artist.name).join(" / ")}</p></div></div> : <div className={entry.fileInfo}><span className={entry.importIcon} aria-hidden="true">↥</span><h2>{selected?.name || t("Import a local audio file", "导入本地音频")}</h2><p>{selected ? formatBytes(selected.size) : t("Drop audio here, or choose a file", "拖放音频到这里，或选择文件")}</p></div>}
      <input className="sr-only" ref={inputRef} aria-label={zh ? "选择本地音频文件" : "Choose a local audio file"} type="file" disabled={busy} accept=".mp3,.wav,.flac,.m4a,.aac,audio/*" onChange={(event: ChangeEvent<HTMLInputElement>) => { setSourceMode("file"); choose(event.target.files?.[0]); }} />
      <div className={entry.actions}><button className="button button-quiet" type="button" disabled={busy} onClick={() => { if (sourceMode === "account") setSourceMode("file"); inputRef.current?.click(); }}>{selected ? t("Replace file", "替换文件") : sourceMode === "account" ? t("Import a local file", "独立导入文件") : t("Choose audio", "选择音频")}</button><Link className="text-link" href="/library">{t("Choose from library", "从资料库选歌")} ↗</Link>
      {(sourceMode === "file" && selected || sourceMode === "account" && sourceTrack) && <button className="button button-primary" type="button" disabled={busy} onClick={() => void (sourceMode === "account" ? submitAccount() : submitFile())}>{busy ? t("Creating separation…", "正在创建分轨…") : sourceMode === "account" ? t("Separate this song into six stems", "直接分离这首歌（六轨）") : t("Start six-stem separation", "开始六轨分离")}</button>}</div>
      <p className={entry.hint}>{t("MP3, WAV, FLAC, M4A/AAC · Up to 200 MiB / 15 min", "MP3、WAV、FLAC、M4A/AAC · 最大 200 MiB / 15 分钟")}</p>
      {sourceTrackError && <p className="studio-error" role="alert">{t("The selected track could not be loaded. Choose it again from your library.", "所选歌曲无法读取，请返回资料库重新选择。")}</p>}
    </section>}
    {error && <p className="studio-error" role="alert">{error}</p>}
    {loading || loadedFor !== initialJobId ? <div className="studio-loading" role="status">{t("Loading Studio…", "正在读取 Studio…")}</div> : job && (!initialJobId || job.id === initialJobId) ? <JobPanel job={job} sourceTrack={resultTrack} actionPending={busy} onCancel={() => void updateJob("cancel")} onRetry={() => void updateJob("retry")} /> : initialJobId ? <div className="studio-empty"><h2>{t("This job was not found", "没有找到这个任务")}</h2><Link className="button button-quiet" href="/studio">{t("Back to Studio", "返回 Studio")}</Link></div> : <StudioEmpty jobs={jobs} />}
  </div>;
}

function StudioEmpty({ jobs }: { jobs: StudioJob[] }) {
  const t = useStudioText();
  if (!jobs.length) return null;
  return <section className={entry.recent}><p className="eyebrow">{t("RECENT PROJECTS", "最近任务")}</p>{jobs.slice(0, 4).map((item) => <Link key={item.id} href={`/studio/jobs/${item.id}`}><strong>{item.asset.original_filename}</strong><span>{item.model_name === "htdemucs_6s" ? t("Six stems", "六轨") : t("Four stems", "四轨")} · {stageLabel(item.status === "SUCCEEDED" ? "COMPLETE" : item.stage, t("en", "zh"), item.model_name === "htdemucs_6s" ? 6 : 4)}</span></Link>)}</section>;
}

function JobPanel({ job, sourceTrack, onCancel, onRetry, actionPending }: { job: StudioJob; sourceTrack: SourceTrack | null; actionPending: boolean; onCancel: () => void; onRetry: () => void }) {
  const t = useStudioText();
  if (job.status === "SUCCEEDED") return <StemMixer key={JSON.stringify([job.id, job.model_name, job.asset.id, job.asset.duration_ms, mixerSourcesKey(job)])} job={job} sourceTrack={sourceTrack} />;
  const stage = stageLabel(job.stage, t("en", "zh"), job.model_name === "htdemucs_6s" ? 6 : 4);
  return <section className={`studio-job studio-job-${job.status.toLowerCase()}`} aria-live="polite">
    <div><p className="eyebrow">JOB / {job.status}</p><h2>{job.asset.original_filename}</h2><p>{job.status === "FAILED" || job.status === "CANCELLED" ? job.safe_error_message : stage}</p></div>
    <div className="studio-stage"><span>{job.status}</span><strong>{stage}</strong><small>{t("Attempt", "尝试")} {job.attempt_count} · {formatDuration(job.asset.duration_ms / 1000)}</small></div>
    {job.cancellable && <button className="button button-quiet" type="button" disabled={actionPending} onClick={onCancel}>{t("Cancel job", "取消任务")}</button>}
    {job.retryable && <button className="button button-primary" type="button" disabled={actionPending} onClick={onRetry}>{t("Retry job", "重试任务")}</button>}
    <p className="studio-first-run">{t("The first run may download a separation model. Progress shows real stages, not invented percentages.", "首次处理可能需要下载分离模型。进度按真实阶段显示，不会伪造百分比。")}</p>
  </section>;
}

function mixerSourcesKey(job: StudioJob) {
  return JSON.stringify(job.artifacts.map(({ id, stem_type, stream_url }) => ({ id, stem_type, stream_url }))
    .sort((a, b) => a.stem_type.localeCompare(b.stem_type)));
}

type MixerSession = {
  media: Map<StemType, HTMLAudioElement>;
  context: AudioContext | null;
  nodes: Map<StemType, GainNode>;
  sources: Map<StemType, MediaElementAudioSourceNode>;
  master: GainNode | null;
  analyser: AnalyserNode | null;
  analysisAttempted: boolean;
  participant: PlaybackParticipant;
  request: PlaybackRequest | null;
  starting: boolean;
  running: boolean;
  disposed: boolean;
};

// Each play promise is guarded separately: Promise.all can reject while another
// track is still starting. Native play/playing events also enforce ownership.
async function playMixerMedia(session: MixerSession, request: PlaybackRequest) {
  await Promise.all(Array.from(session.media.values(), async (audio) => {
    if (!session.participant.isCurrent(request)) return;
    try { await audio.play(); }
    finally { if (!session.participant.isOwner()) audio.pause(); }
  }));
}

export function StemMixer({ job, sourceTrack }: { job: StudioJob; sourceTrack?: SourceTrack | null }) {
  const t = useStudioText();
  const stems = job.model_name === "htdemucs_6s" ? SIX_STEMS : STEMS;
  const [waveform, setWaveform] = useState<Waveform | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const [starting, setStarting] = useState(false);
  const [position, setPosition] = useState(0);
  const [master, setMaster] = useState(0.85);
  const [speed, setSpeed] = useState(1);
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  const [gains, setGains] = useState<Record<StemType, number>>({ VOCALS: 1, DRUMS: 1, BASS: 1, GUITAR: 1, PIANO: 1, OTHER: 1 });
  const [muted, setMuted] = useState<Set<StemType>>(new Set());
  const [soloed, setSoloed] = useState<Set<StemType>>(new Set());
  const [drift, setDrift] = useState(0);
  const [analysis, setAnalysis] = useState<StudioAnalysis>(null);
  const sessionRef = useRef<MixerSession | null>(null);
  const sourcesKey = mixerSourcesKey(job);
  const playbackSources = useMemo(() => JSON.parse(sourcesKey) as Pick<StudioArtifact, "id" | "stem_type" | "stream_url">[], [sourcesKey]);
  const duration = job.asset.duration_ms / 1000;
  const beatGrid = waveform?.beat_grid;

  useEffect(() => {
    if (!job.waveform_url) return;
    let live = true;
    const abort = new AbortController();
    apiRequest<Waveform>(job.waveform_url, { signal: abort.signal })
      .then((next) => { if (live) setWaveform(next); })
      .catch(() => { if (live) setWaveform(null); });
    return () => { live = false; abort.abort(); };
  }, [job.waveform_url]);

  useEffect(() => {
    const next = new Map<StemType, HTMLAudioElement>();
    const participant = playbackCoordinator.register("studio", () => {
      session.request = null;
      session.starting = false;
      session.running = false;
      next.forEach((audio) => audio.pause());
      if (!session.disposed) { setPlaying(false); setStarting(false); }
    });
    const session: MixerSession = { media: next, participant, context: null, nodes: new Map(), sources: new Map(), master: null, analyser: null, analysisAttempted: false, request: null, starting: false, running: false, disposed: false };
    const guard = (event: Event) => {
      if (!participant.isCurrent(session.request)) (event.currentTarget as HTMLAudioElement).pause();
    };
    playbackSources.forEach((artifact) => {
      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.preload = "metadata";
      audio.src = apiUrl(artifact.stream_url);
      audio.addEventListener("play", guard);
      audio.addEventListener("playing", guard);
      next.set(artifact.stem_type, audio);
    });
    sessionRef.current = session;
    return () => {
      session.disposed = true;
      participant.dispose();
      next.forEach((audio) => {
        audio.removeEventListener("play", guard);
        audio.removeEventListener("playing", guard);
        audio.removeAttribute("src"); audio.load();
      });
      session.sources.forEach((node) => node.disconnect());
      session.nodes.forEach((node) => node.disconnect());
      session.master?.disconnect();
      session.analyser?.disconnect();
      if (session.context && session.context.state !== "closed") void session.context.close().catch(() => {});
      session.sources.clear(); session.nodes.clear(); next.clear();
      session.context = null; session.master = null; session.analyser = null;
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [playbackSources]);

  const ensureAudioGraph = useCallback(async (session: MixerSession) => {
    // Save each allocation immediately, including a partially built graph.
    const audioContext = session.context ?? (session.context = new AudioContext());
    const output = session.master ?? (session.master = audioContext.createGain());
    output.gain.value = master;
    session.media.forEach((audio, stem) => {
      let source = session.sources.get(stem);
      if (!source) { source = audioContext.createMediaElementSource(audio); session.sources.set(stem, source); }
      let gain = session.nodes.get(stem);
      if (!gain) { gain = audioContext.createGain(); session.nodes.set(stem, gain); }
      gain.gain.value = !muted.has(stem) && (soloed.size === 0 || soloed.has(stem)) ? gains[stem] : 0;
      // Reconnecting the same nodes is idempotent in Web Audio.
      source.connect(gain).connect(output);
    });
    if (!session.analysisAttempted) {
      session.analysisAttempted = true;
      try {
        const analyser = audioContext.createAnalyser();
        session.analyser = analyser;
        analyser.fftSize = SPECTRUM_FFT_SIZE;
        analyser.smoothingTimeConstant = 0; // One time-based visual smoother, not two cascaded smoothers.
        output.connect(analyser);
        analyser.connect(audioContext.destination); // The only audible route, after master gain.
        setAnalysis({ analyser, sampleRate: audioContext.sampleRate, isValid: () => !session.disposed });
      } catch {
        // Analysis is optional: detach any partially connected serial branch
        // before restoring the sole direct route to the destination.
        if (session.analyser) {
          try { output.disconnect(session.analyser); } catch { /* The branch may not have connected. */ }
          try { session.analyser.disconnect(); } catch { /* Already disconnected. */ }
        }
        session.analyser = null;
        setAnalysis("unavailable");
      }
    }
    if (!session.analyser) output.connect(audioContext.destination);
    await audioContext.resume();
  }, [master, gains, muted, soloed]);

  const startPlayback = useCallback(async (at: number) => {
    const session = sessionRef.current;
    if (!session) return;
    const { participant } = session;
    const request = participant.claim();
    if (!request) return;
    session.request = request;
    session.starting = true;
    setStarting(true);
    setPlaybackError(false);
    try {
      await ensureAudioGraph(session);
      if (!participant.isCurrent(request)) return;
      session.media.forEach((audio) => { audio.currentTime = at; });
      setPosition(at);
      await playMixerMedia(session, request);
      if (!participant.isCurrent(request)) return;
      session.running = true;
      setPlaying(true);
    } catch {
      if (!participant.isCurrent(request)) return;
      participant.pause(request);
      setPlaybackError(true);
    } finally {
      if (participant.isCurrent(request)) { session.starting = false; setStarting(false); }
    }
  }, [ensureAudioGraph]);

  useEffect(() => { if (sessionRef.current?.master) sessionRef.current.master.gain.value = master; }, [master]);
  useEffect(() => { sessionRef.current?.media.forEach((audio) => { audio.playbackRate = speed; }); }, [speed, playbackSources]);
  useEffect(() => {
    const anySolo = soloed.size > 0;
    stems.forEach((stem) => {
      const audible = !muted.has(stem) && (!anySolo || soloed.has(stem));
      const node = sessionRef.current?.nodes.get(stem);
      if (node) node.gain.value = audible ? gains[stem] : 0;
    });
  }, [gains, muted, soloed, stems]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    const primary = session.media.get("VOCALS") || session.media.values().next().value;
    if (!primary) return;
    const ended = () => {
      if (!session.running || session.starting || !session.participant.isCurrent(session.request) || primary.ended === false) return;
      if (loopStart !== null && loopEnd !== null) {
        void startPlayback(loopStart);
      } else {
        session.participant.pause();
        setPosition(duration);
      }
    };
    primary.addEventListener("ended", ended);
    return () => primary.removeEventListener("ended", ended);
  }, [playbackSources, duration, loopStart, loopEnd, startPlayback]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const session = sessionRef.current;
      if (!session || !session.running || !session.participant.isCurrent(session.request)) return;
      const primary = session.media.get("VOCALS") || session.media.values().next().value;
      if (!primary || primary.paused) return;
      if (loopStart !== null && loopEnd !== null && primary.currentTime >= loopEnd) {
        session.media.forEach((audio) => { audio.currentTime = loopStart; });
        setPosition(loopStart);
        return;
      }
      setPosition(primary.currentTime);
      let maximum = 0;
      session.media.forEach((audio) => { maximum = Math.max(maximum, Math.abs(audio.currentTime - primary.currentTime)); if (Math.abs(audio.currentTime - primary.currentTime) > 0.08) audio.currentTime = primary.currentTime; });
      setDrift((value) => Math.max(value, maximum));
    }, 250);
    return () => window.clearInterval(timer);
  }, [loopStart, loopEnd]);

  const togglePlay = async () => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.starting || session.running) {
      session.participant.pause();
      return;
    }
    await startPlayback(position >= duration ? (loopStart ?? 0) : position);
  };

  const seek = (value: number) => {
    const bounded = Math.min(duration, Math.max(0, value));
    sessionRef.current?.media.forEach((audio) => { audio.currentTime = bounded; });
    setPosition(bounded);
  };

  const title = sourceTrack?.title || job.asset.original_filename;
  const librarySource = job.source_track_ids.length > 0;

  return <section className={styles.workbench} aria-label={t("Studio mixer", "Studio 混音器")}>
    <div className={styles.stage}>
      <header className={styles.identity}>
        <Artwork key={sourceTrack?.artwork_url || "placeholder"} className={styles.cover} src={sourceTrack?.artwork_url} alt={t("Track artwork", "曲目封面")} sizes="(max-width: 600px) 84px, 128px" />
        <div className={styles.trackInfo}>
          <p className={styles.trackStatus}><span />{t("COMPLETE", "已完成")} · {stems.length} {t("STEMS", "音轨")}</p>
          <h2 title={title}>{title}</h2>
          {sourceTrack?.artists.length ? <p className={styles.artists}>{sourceTrack.artists.map((artist) => artist.name).join(" / ")}</p> : null}
          {sourceTrack?.album && <p className={styles.album}>{sourceTrack.album.name}</p>}
          <p className={styles.source}>{librarySource ? t("Library source", "资料库来源") : t("Local audio file", "本地音频文件")}</p>
        </div>
      </header>
      <StudioSpectrum source={analysis} playing={playing} />
    </div>

    <section className={styles.transport} aria-label={t("Playback controls", "主播放控制")}>
      <div className={styles.playControl}>
        <button type="button" className={styles.play} aria-busy={starting} aria-label={playing || starting ? t(`Pause ${stems.length} stems`, `暂停${stems.length === 4 ? "四" : "六"}个声部`) : t(`Play ${stems.length} stems`, `播放${stems.length === 4 ? "四" : "六"}个声部`)} onClick={() => void togglePlay()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">{playing || starting ? <path d="M7 5h3v14H7zm7 0h3v14h-3z" /> : <path d="m8 4 12 8-12 8z" />}</svg>
        </button>
        <span className={styles.playState} role="status">{starting ? t("Starting… press to cancel", "正在启动…可再次点击取消") : playing ? t("Playing", "播放中") : t("Paused", "已暂停")}</span>
      </div>
      <div className={styles.timeline}>
        <span>{formatDuration(position)}</span>
        <div className={styles.timelineTrack}><BeatTicks grid={beatGrid} durationMs={job.asset.duration_ms} /><input aria-label={t("Playback position", "播放位置")} type="range" min={0} max={duration || 1} step={0.01} value={position} onChange={(event) => seek(Number(event.target.value))} /></div>
        <span>{formatDuration(duration)}</span>
      </div>
      <label className={styles.master}>{t("Master volume", "主音量")}<input aria-label={t("Master volume", "主音量")} type="range" min={0} max={1} step={0.01} value={master} onChange={(event) => setMaster(Number(event.target.value))} /><output>{Math.round(master * 100)}%</output></label>
    </section>
    {playbackError && <p className={styles.playbackError} role="alert">{t("Playback could not start. Check your audio output and try again.", "播放未能启动，请检查音频输出后重试。")}</p>}

    <section className={styles.practice} aria-label={t("Practice controls", "练习控制")}>
      <div className={styles.practiceControls}>
        <label className={styles.speed}>{t("Playback speed", "播放速度")} <select aria-label={t("Playback speed", "播放速度")} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option></select></label>
        <div className={styles.loop} role="group" aria-label={t("AB loop", "AB 循环")}>
          <button type="button" onClick={() => { setLoopStart(position); setLoopEnd(null); }}>{t("Set loop start", "设为循环起点")}</button>
          <button type="button" disabled={loopStart === null || position <= loopStart + 0.25} onClick={() => setLoopEnd(position)}>{t("Set loop end", "设为循环终点")}</button>
          <button type="button" disabled={loopStart === null} onClick={() => { setLoopStart(null); setLoopEnd(null); }}>{t("Clear loop", "清除循环")}</button>
        </div>
        <span className={styles.loopState} role="status">{loopStart === null ? t("No loop", "未设置循环") : loopEnd === null ? `A ${formatDuration(loopStart)} · ${t("Choose an end point", "待设置终点")}` : `${formatDuration(loopStart)} → ${formatDuration(loopEnd)}`}</span>
      </div>
      <div className={styles.beatSummary}><span>{t("BEAT GRID", "节拍刻度")}</span>{beatGrid ? <><strong>{beatGrid.bpm} BPM</strong><small>{t("Estimated from drums · beat positions are approximate, not a time signature.", "根据鼓组估算 · 节拍位置仅供参考，不代表拍号。")}</small></> : <small>{waveform?.beat_grid === null ? t("No steady beat detected in the drums.", "鼓组中未检测到稳定节拍。") : t("Beat analysis is unavailable for this project.", "此任务暂无节拍分析数据。")}</small>}</div>
    </section>

    <section className={styles.stems} aria-label={t("Stem workspace", "分轨工作区")}>
      <header className={styles.stemsHeading}><div><h3>{t("Stem mix", "分轨混音")}</h3><span>{stems.length} {t("stems", "音轨")} · FLAC</span></div><p>{t("Time waveforms · click to seek", "时间波形 · 点击定位")}</p></header>
      {stems.map((stem) => {
        const data = waveform?.stems[stem];
        const artifact = job.artifacts.find((item) => item.stem_type === stem);
        return <article className={`${styles.stem} ${muted.has(stem) || (soloed.size > 0 && !soloed.has(stem)) ? styles.muted : ""}`} data-stem={stem} key={stem}>
          <div className={styles.stemTitle}><span>{t(titleCase(stem), LABELS[stem])}</span><small>{t(LABELS[stem], titleCase(stem))}</small></div>
          <button className={styles.waveform} type="button" aria-label={t(`Seek in ${titleCase(stem)} waveform`, `在${LABELS[stem]}波形中定位`)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); seek(event.key === "Home" ? 0 : event.key === "End" ? duration : position + (event.key === "ArrowRight" ? 5 : -5)); } }} onClick={(event) => { if (event.detail === 0) { seek(position); return; } const box = event.currentTarget.getBoundingClientRect(); seek(((event.clientX - box.left) / box.width) * duration); }}><WaveformPath data={data} />{!data?.peaks.length && <span>{t("Waveform unavailable · seek still available", "波形暂不可用 · 仍可定位")}</span>}<i style={{ left: `${duration ? (position / duration) * 100 : 0}%` }} /></button>
          <label className={styles.gain}>{t("Gain", "增益")} <input aria-label={t(`${titleCase(stem)} gain`, `${LABELS[stem]}增益`)} type="range" min={0} max={1.5} step={0.01} value={gains[stem]} onChange={(event) => setGains((current) => ({ ...current, [stem]: Number(event.target.value) }))} /><output>{Math.round(gains[stem] * 100)}%</output></label>
          <button className={styles.mixToggle} type="button" aria-label={t(`Mute ${titleCase(stem)}`, `${LABELS[stem]}静音`)} title={t(`Mute ${titleCase(stem)}`, `${LABELS[stem]}静音`)} aria-pressed={muted.has(stem)} onClick={() => setMuted(toggleSet(muted, stem))}>M</button>
          <button className={styles.mixToggle} type="button" aria-label={t(`Solo ${titleCase(stem)}`, `${LABELS[stem]}独奏`)} title={t(`Solo ${titleCase(stem)}`, `${LABELS[stem]}独奏`)} aria-pressed={soloed.has(stem)} onClick={() => setSoloed(toggleSet(soloed, stem))}>S</button>
          {artifact && <a className={styles.download} href={apiUrl(`${artifact.stream_url}?download=true`)} aria-label={t(`Download ${titleCase(stem)} FLAC`, `下载${LABELS[stem]} FLAC`)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></svg><span>FLAC</span></a>}
        </article>;
      })}
    </section>
    <footer className={styles.footer}><p>{stems.length === 4 ? t("Four FLAC stems are saved locally. Reloading or returning later will not process the audio again.", "四条 FLAC 音轨已经保存在本机。刷新或稍后返回，不会重新处理。") : t("Six FLAC stems are saved locally. Guitar and piano isolation may contain bleed or artifacts.", "六条 FLAC 音轨已保存在本机。吉他和钢琴可能有串音或伪影。")}</p><span>{t("Maximum drift before correction", "最大校正前漂移")} {Math.round(drift * 1000)} ms</span></footer>
  </section>;
}

function BeatTicks({ grid, durationMs }: { grid?: BeatGrid | null; durationMs: number }) {
  const t = useStudioText();
  const path = useMemo(() => grid && durationMs > 0
    ? grid.beats_ms.filter((value) => Number.isFinite(value) && value >= 0 && value <= durationMs)
      .map((value) => `M${((value / durationMs) * 1000).toFixed(2)} 0V10`).join("")
    : "", [grid, durationMs]);
  return path ? <svg className={styles.beatTicks} viewBox="0 0 1000 10" preserveAspectRatio="none" aria-label={t("Estimated beat positions", "估算节拍位置")}><path d={path} /></svg> : null;
}

function WaveformPath({ data }: { data?: WaveformStem }) {
  const path = useMemo(() => {
    if (!data?.peaks.length) return "";
    return data.peaks.map(([minimum, maximum], index) => { const x = (index / Math.max(1, data.peaks.length - 1)) * 1000; return `M${x.toFixed(2)} ${(50 - maximum * 45).toFixed(2)}V${(50 - minimum * 45).toFixed(2)}`; }).join("");
  }, [data]);
  return <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">{path ? <path d={path} /> : <line x1="0" y1="50" x2="1000" y2="50" />}</svg>;
}

function toggleSet<T>(source: Set<T>, value: T) { const next = new Set(source); if (next.has(value)) next.delete(value); else next.add(value); return next; }
function titleCase(value: string) { return value.charAt(0) + value.slice(1).toLowerCase(); }
function formatBytes(value: number) { return `${(value / 1024 / 1024).toFixed(value > 10 * 1024 * 1024 ? 1 : 2)} MiB`; }
function formatDuration(value: number) { if (!Number.isFinite(value)) return "0:00"; const minutes = Math.floor(value / 60); return `${minutes}:${Math.floor(value % 60).toString().padStart(2, "0")}`; }
function stageLabel(stage: string, locale: string, count: number) { const zh = ({ FAILED: "处理失败", CANCELLED: "已取消", QUEUED: "等待处理", PROBING: "验证音频", TRANSCODING: "准备音频", LOADING_MODEL: "准备分离模型", SEPARATING: `正在分离${count === 4 ? "四" : "六"}个声部`, VALIDATING: "验证音轨", GENERATING_WAVEFORM: "生成真实波形", FINALIZING: "保存结果", COMPLETE: "处理完成" } as Record<string, string>)[stage]; const en = ({ FAILED: "Failed", CANCELLED: "Cancelled", QUEUED: "Waiting", PROBING: "Validating audio", TRANSCODING: "Preparing audio", LOADING_MODEL: "Preparing separation model", SEPARATING: `Separating ${count} stems`, VALIDATING: "Validating stems", GENERATING_WAVEFORM: "Generating waveform", FINALIZING: "Saving result", COMPLETE: "Complete" } as Record<string, string>)[stage]; return (locale === "zh" ? zh : en) || stage.replaceAll("_", " "); }
