"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiRequestError, apiRequest, apiUrl } from "@/lib/api-client";
import { useLocale } from "./LocaleProvider";

type JobStatus = "QUEUED" | "PREPARING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
type StemType = "VOCALS" | "DRUMS" | "BASS" | "GUITAR" | "PIANO" | "OTHER";
type SourceMode = "account" | "file";
type SourceTrack = { id: string; title: string; artists: { id: string; name: string }[]; album: { id: string; name: string } | null };
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
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const effectiveTrackId = sourceTrackId || job?.source_track_ids?.[0];

  useEffect(() => {
    if (!effectiveTrackId || !/^[0-9a-f-]{36}$/i.test(effectiveTrackId)) return;
    let live = true;
    apiRequest<SourceTrack>(`/api/v1/tracks/${effectiveTrackId}`)
      .then((track) => { if (live) { setSourceTrack(track); setSourceTrackError(false); } })
      .catch(() => { if (live) { setSourceTrack(null); setSourceTrackError(true); } });
    return () => { live = false; };
  }, [effectiveTrackId]);

  const loadJob = useCallback(async (id: string) => {
    const next = await apiRequest<StudioJob>(`/api/v1/studio/jobs/${id}`);
    setJob(next);
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    const load = initialJobId
      ? apiRequest<StudioJob>(`/api/v1/studio/jobs/${initialJobId}`).then((item) => { if (live) { setJob(item); setJobs([item]); } })
      : apiRequest<JobList>("/api/v1/studio/jobs").then((result) => { if (live) setJobs(result.items); });
    load.catch(() => { if (live) setError(t("Studio is temporarily unavailable. Check that local services are running.", "Studio 暂时无法读取，请确认本地服务已经启动。")); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [initialJobId, t]);

  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    const timer = window.setInterval(() => { void loadJob(job.id).catch(() => setError(t("Processing status updates stopped.", "处理状态更新中断。"))); }, 1500);
    return () => window.clearInterval(timer);
  }, [job, loadJob, t]);

  const choose = (file?: File) => {
    if (!file) return;
    setSelected(file);
    setError(null);
  };

  const submitFile = async () => {
    if (busy) return;
    if (!selected) { inputRef.current?.click(); return; }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", selected);
      const asset = await apiRequest<StudioAsset>("/api/v1/studio/assets", { method: "POST", body: form });
      const next = await apiRequest<StudioJob>(`/api/v1/studio/assets/${asset.id}/jobs?model=htdemucs_6s`, { method: "POST" });
      setJob(next);
      router.push(`/studio/jobs/${next.id}`);
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason.message : t("Upload or job creation failed.", "上传或创建任务失败。"));
    } finally {
      setBusy(false);
    }
  };

  const submitAccount = async () => {
    if (!sourceTrack || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await apiRequest<StudioJob>(`/api/v1/studio/tracks/${sourceTrack.id}/jobs?model=htdemucs_6s`, { method: "POST" });
      setJob(next);
      router.push(`/studio/jobs/${next.id}?track=${sourceTrack.id}`);
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason.message : t("This account song could not be separated. Check playback availability and try again.", "这首账号歌曲暂时无法分轨，请确认当前账号可以播放后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    setJob(await apiRequest<StudioJob>(`/api/v1/studio/jobs/${job.id}/cancel`, { method: "POST" }));
  };

  const retry = async () => {
    if (!job) return;
    setJob(await apiRequest<StudioJob>(`/api/v1/studio/jobs/${job.id}/retry`, { method: "POST" }));
  };

  return <div className="studio-page">
    <header className="studio-hero"><div><p className="eyebrow">{t("LOCAL AUDIO TOOL", "本地音频工具")}</p><h1>{t("Stem separation", "音轨分离")}</h1><p>{t("New projects separate vocals, drums, bass, guitar, piano and other sounds. Use a local file or choose a song from your connected library.", "新任务分离人声、鼓组、贝斯、吉他、钢琴与其他声音。导入本地文件，或从已登录资料库选歌。")}</p></div></header>
    {sourceTrack && (sourceMode === "account" || initialJobId) && <section className="studio-source"><div><p className="eyebrow">{t("SELECTED FROM LIBRARY", "从资料库选中")}</p><h2>{sourceTrack.title}</h2><p>{sourceTrack.artists.map((artist) => artist.name).join(" / ")}{sourceTrack.album ? ` · ${sourceTrack.album.name}` : ""}</p></div><Link className="text-link" href="/library">{t("Choose another track", "换一首歌")}</Link></section>}
    {!initialJobId && <>
      <div className="studio-mode-switch" role="group" aria-label={t("Audio source", "分轨音源")}><button type="button" aria-pressed={sourceMode === "account"} onClick={() => { setSourceMode("account"); setError(null); }}>{t("Connected account song", "账号歌曲直接分轨")}</button><button type="button" aria-pressed={sourceMode === "file"} onClick={() => { setSourceMode("file"); setError(null); }}>{t("Import a local file", "独立导入文件")}</button></div>
      {sourceMode === "account" ? <section className="studio-account"><div><p className="eyebrow">{t("CONNECTED LIBRARY / DIRECT SEPARATION", "登录资料库 / 直接分轨")}</p><h2>{sourceTrack ? t("Separate the selected song", "直接分轨这首歌") : t("Choose a song from your library", "先从资料库选择歌曲")}</h2><p>{t("MusicScope uses a currently playable source from your connected account, saves the audio and stems locally, and never stores the signed playback URL. Some songs may be unavailable. Only process music you are allowed to use.", "MusicScope 会通过当前账号获取可播放音频，并在本机保存处理所需音频和分轨结果；不会保存短时播放地址。部分歌曲可能无法获取。请仅处理你有权使用的音乐。")}</p></div>
        <SixStemSummary />
        {sourceTrack ? <button className="button button-primary" type="button" disabled={busy} onClick={() => void submitAccount()}>{busy ? t("Fetching playable audio and creating a job…", "正在获取可播放音频并创建任务…") : t("Separate this song into six stems", "直接分离这首歌（六轨）")}</button> : <Link className="button button-primary" href="/library">{t("Choose from library", "去资料库选歌")}</Link>}
        {sourceTrackError && <p className="studio-error" role="alert">{t("The selected track could not be loaded. Choose it again from your library.", "所选歌曲无法读取，请返回资料库重新选择。")}</p>}
      </section> : <section className="studio-upload" onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
        <div><p className="eyebrow">{t("YOUR FILE / INDEPENDENT SOURCE", "你的文件 / 独立音源")}</p><h2>{t("Import a local audio file", "导入本地音频")}</h2><p>{t("MP3, WAV, FLAC, M4A/AAC; maximum 200 MiB and 15 minutes. This mode does not require a connected account.", "支持 MP3、WAV、FLAC、M4A/AAC；最大 200 MiB、最长 15 分钟。此模式不需要登录账号。")}</p></div>
        <SixStemSummary />
        <input ref={inputRef} aria-label={zh ? "选择本地音频文件" : "Choose a local audio file"} type="file" accept=".mp3,.wav,.flac,.m4a,.aac,audio/*" onChange={(event: ChangeEvent<HTMLInputElement>) => choose(event.target.files?.[0])} />
        <button className="button button-quiet" type="button" onClick={() => inputRef.current?.click()}>{zh ? "选择文件" : "Choose file"}</button>
        <div className="studio-file"><strong>{selected?.name || (zh ? "还没有选择音频" : "No audio selected")}</strong><span>{selected ? formatBytes(selected.size) : (zh ? "拖放文件到这里也可以" : "You can also drop a file here")}</span></div>
        <button className="button button-primary" type="button" disabled={busy} onClick={() => void submitFile()}>{busy ? t("Validating and uploading…", "正在验证并上传…") : !selected ? t("Choose audio to continue", "选择音频以继续") : t("Start six-stem separation", "开始六轨分离")}</button>
      </section>}
    </>}
    {error && <p className="studio-error" role="alert">{error}</p>}
    {loading ? <div className="studio-loading" role="status">{t("Loading Studio…", "正在读取 Studio…")}</div> : job ? <JobPanel job={job} onCancel={() => void cancel()} onRetry={() => void retry()} /> : initialJobId ? <div className="studio-empty"><h2>{t("This job was not found", "没有找到这个任务")}</h2><Link className="button button-quiet" href="/studio">{t("Back to Studio", "返回 Studio")}</Link></div> : <StudioEmpty jobs={jobs} />}
  </div>;
}

function SixStemSummary() {
  const t = useStudioText();
  return <div className="studio-six-stems"><span>{t("SIX STEMS", "六条音轨")}</span><div>{SIX_STEMS.map((stem) => <small key={stem}>{t(stem.toLowerCase(), LABELS[stem])}</small>)}</div><p>{t("Guitar and piano may contain bleed or artifacts; full isolation is not guaranteed.", "吉他和钢琴可能有串音或伪影，不保证完全独立。")}</p></div>;
}

function StudioEmpty({ jobs }: { jobs: StudioJob[] }) {
  const t = useStudioText();
  if (!jobs.length) return null;
  return <section className="studio-recent"><p className="eyebrow">{t("RECENT PROJECTS", "最近任务")}</p>{jobs.slice(0, 4).map((item) => <Link key={item.id} href={`/studio/jobs/${item.id}`}><strong>{item.asset.original_filename}</strong><span>{item.model_name === "htdemucs_6s" ? t("Six stems", "六轨") : t("Four stems", "四轨")} · {item.status}</span></Link>)}</section>;
}

function JobPanel({ job, onCancel, onRetry }: { job: StudioJob; onCancel: () => void; onRetry: () => void }) {
  const t = useStudioText();
  if (job.status === "SUCCEEDED") return <StemMixer job={job} />;
  const stage = stageLabel(job.stage, t("en", "zh"), job.model_name === "htdemucs_6s" ? 6 : 4);
  return <section className={`studio-job studio-job-${job.status.toLowerCase()}`} aria-live="polite">
    <div><p className="eyebrow">JOB / {job.status}</p><h2>{job.asset.original_filename}</h2><p>{job.status === "FAILED" || job.status === "CANCELLED" ? job.safe_error_message : stage}</p></div>
    <div className="studio-stage"><span>{job.status}</span><strong>{stage}</strong><small>{t("Attempt", "尝试")} {job.attempt_count} · {formatDuration(job.asset.duration_ms / 1000)}</small></div>
    {job.cancellable && <button className="button button-quiet" type="button" onClick={onCancel}>{t("Cancel job", "取消任务")}</button>}
    {job.retryable && <button className="button button-primary" type="button" onClick={onRetry}>{t("Retry job", "重试任务")}</button>}
    <p className="studio-first-run">{t("The first run may download a separation model. Progress shows real stages, not invented percentages.", "首次处理可能需要下载分离模型。进度按真实阶段显示，不会伪造百分比。")}</p>
  </section>;
}

function StemMixer({ job }: { job: StudioJob }) {
  const t = useStudioText();
  const stems = job.model_name === "htdemucs_6s" ? SIX_STEMS : STEMS;
  const [waveform, setWaveform] = useState<Waveform | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [master, setMaster] = useState(0.85);
  const [speed, setSpeed] = useState(1);
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  const [gains, setGains] = useState<Record<StemType, number>>({ VOCALS: 1, DRUMS: 1, BASS: 1, GUITAR: 1, PIANO: 1, OTHER: 1 });
  const [muted, setMuted] = useState<Set<StemType>>(new Set());
  const [soloed, setSoloed] = useState<Set<StemType>>(new Set());
  const [drift, setDrift] = useState(0);
  const media = useRef(new Map<StemType, HTMLAudioElement>());
  const context = useRef<AudioContext | null>(null);
  const nodes = useRef(new Map<StemType, GainNode>());
  const masterNode = useRef<GainNode | null>(null);
  const duration = job.asset.duration_ms / 1000;
  const beatGrid = waveform?.beat_grid;

  useEffect(() => {
    if (!job.waveform_url) return;
    apiRequest<Waveform>(job.waveform_url).then(setWaveform).catch(() => setWaveform(null));
  }, [job.waveform_url]);

  useEffect(() => {
    const next = new Map<StemType, HTMLAudioElement>();
    job.artifacts.forEach((artifact) => {
      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.preload = "metadata";
      audio.src = apiUrl(artifact.stream_url);
      next.set(artifact.stem_type, audio);
    });
    media.current = next;
    return () => { next.forEach((audio) => { audio.pause(); audio.removeAttribute("src"); audio.load(); }); context.current?.close(); context.current = null; };
  }, [job.artifacts]);

  const ensureAudioGraph = async () => {
    if (!context.current) {
      const audioContext = new AudioContext();
      const output = audioContext.createGain();
      output.gain.value = master;
      output.connect(audioContext.destination);
      media.current.forEach((audio, stem) => {
        const gain = audioContext.createGain();
        audioContext.createMediaElementSource(audio).connect(gain).connect(output);
        nodes.current.set(stem, gain);
      });
      context.current = audioContext;
      masterNode.current = output;
    }
    await context.current.resume();
  };

  useEffect(() => { if (masterNode.current) masterNode.current.gain.value = master; }, [master]);
  useEffect(() => { media.current.forEach((audio) => { audio.playbackRate = speed; }); }, [speed, job.artifacts]);
  useEffect(() => {
    const anySolo = soloed.size > 0;
    stems.forEach((stem) => {
      const audible = !muted.has(stem) && (!anySolo || soloed.has(stem));
      const node = nodes.current.get(stem);
      if (node) node.gain.value = audible ? gains[stem] : 0;
    });
  }, [gains, muted, soloed, stems]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const primary = media.current.get("VOCALS") || media.current.values().next().value;
      if (!primary || primary.paused) return;
      if (loopStart !== null && loopEnd !== null && primary.currentTime >= loopEnd) {
        media.current.forEach((audio) => { audio.currentTime = loopStart; });
        setPosition(loopStart);
        return;
      }
      setPosition(primary.currentTime);
      let maximum = 0;
      media.current.forEach((audio) => { maximum = Math.max(maximum, Math.abs(audio.currentTime - primary.currentTime)); if (Math.abs(audio.currentTime - primary.currentTime) > 0.08) audio.currentTime = primary.currentTime; });
      setDrift((value) => Math.max(value, maximum));
    }, 250);
    return () => window.clearInterval(timer);
  }, [loopStart, loopEnd]);

  const togglePlay = async () => {
    await ensureAudioGraph();
    if (playing) {
      media.current.forEach((audio) => audio.pause());
      setPlaying(false);
      return;
    }
    media.current.forEach((audio) => { audio.currentTime = position; });
    await Promise.all(Array.from(media.current.values(), (audio) => audio.play()));
    setPlaying(true);
  };

  const seek = (value: number) => {
    const bounded = Math.min(duration, Math.max(0, value));
    media.current.forEach((audio) => { audio.currentTime = bounded; });
    setPosition(bounded);
  };

  return <section className="studio-mixer">
    <header><div><p className="eyebrow">{t("COMPLETE", "已完成")} · {stems.length} {t("STEMS", "音轨")}</p><h2>{job.asset.original_filename}</h2><p>{stems.length === 4 ? t("Four FLAC stems are saved locally. Reloading or returning later will not process the audio again.", "四条 FLAC 音轨已经保存在本机。刷新或稍后返回，不会重新处理。") : t("Six FLAC stems are saved locally. Guitar and piano isolation may contain bleed or artifacts.", "六条 FLAC 音轨已保存在本机。吉他和钢琴可能有串音或伪影。")}</p></div><span>{formatDuration(duration)}</span></header>
    <div className="studio-beat-summary" aria-live="polite"><span>{t("BEAT GRID", "节拍刻度")}</span>{beatGrid ? <><strong>{beatGrid.bpm} BPM</strong><small>{t("Estimated from drums · beat positions are approximate, not a time signature.", "根据鼓组估算 · 节拍位置仅供参考，不代表拍号。")}</small></> : <small>{waveform?.beat_grid === null ? t("No steady beat detected in the drums.", "鼓组中未检测到稳定节拍。") : t("Beat analysis is unavailable for this project.", "此任务暂无节拍分析数据。")}</small>}</div>
    <div className="studio-transport"><button type="button" className="studio-play" aria-label={playing ? t(`Pause ${stems.length} stems`, `暂停${stems.length === 4 ? "四" : "六"}个声部`) : t(`Play ${stems.length} stems`, `播放${stems.length === 4 ? "四" : "六"}个声部`)} onClick={() => void togglePlay()}>{playing ? "Ⅱ" : "▶"}</button><span>{formatDuration(position)}</span><div className="studio-transport-timeline"><BeatTicks grid={beatGrid} durationMs={job.asset.duration_ms} /><input aria-label={t("Playback position", "播放位置")} type="range" min={0} max={duration || 1} step={0.01} value={position} onChange={(event) => seek(Number(event.target.value))} /></div><span>{formatDuration(duration)}</span></div>
    <div className="studio-practice"><label>{t("Playback speed", "播放速度")} <select aria-label={t("Playback speed", "播放速度")} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option></select></label><div><button type="button" onClick={() => { setLoopStart(position); setLoopEnd(null); }}>{t("Set loop start", "设为循环起点")}</button><button type="button" disabled={loopStart === null || position <= loopStart + 0.25} onClick={() => setLoopEnd(position)}>{t("Set loop end", "设为循环终点")}</button><button type="button" disabled={loopStart === null} onClick={() => { setLoopStart(null); setLoopEnd(null); }}>{t("Clear loop", "清除循环")}</button></div><span>{loopStart === null ? t("No loop", "未设置循环") : `${formatDuration(loopStart)} → ${loopEnd === null ? "…" : formatDuration(loopEnd)}`}</span></div>
    <div className="studio-stems">{stems.map((stem) => {
      const data = waveform?.stems[stem];
      const artifact = job.artifacts.find((item) => item.stem_type === stem);
      return <article className="studio-stem" key={stem}>
        <div className="studio-stem-title"><span>{t(titleCase(stem), LABELS[stem])}</span><small>{t(LABELS[stem], titleCase(stem))}</small></div>
        <button className="studio-waveform" type="button" aria-label={t(`Seek in ${titleCase(stem)} waveform`, `在${LABELS[stem]}波形中定位`)} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); seek(((event.clientX - box.left) / box.width) * duration); }}><WaveformPath data={data} /><i style={{ left: `${duration ? (position / duration) * 100 : 0}%` }} /></button>
        <label>{t("Gain", "增益")} <input aria-label={t(`${titleCase(stem)} gain`, `${LABELS[stem]}增益`)} type="range" min={0} max={1.5} step={0.01} value={gains[stem]} onChange={(event) => setGains((current) => ({ ...current, [stem]: Number(event.target.value) }))} /><output>{Math.round(gains[stem] * 100)}%</output></label>
        <button type="button" aria-label={t(`Mute ${titleCase(stem)}`, `${LABELS[stem]}静音`)} aria-pressed={muted.has(stem)} onClick={() => setMuted(toggleSet(muted, stem))}>M</button>
        <button type="button" aria-label={t(`Solo ${titleCase(stem)}`, `${LABELS[stem]}独奏`)} aria-pressed={soloed.has(stem)} onClick={() => setSoloed(toggleSet(soloed, stem))}>S</button>
        {artifact && <a className="studio-export" href={apiUrl(`${artifact.stream_url}?download=true`)} aria-label={t(`Download ${titleCase(stem)} FLAC`, `下载${LABELS[stem]} FLAC`)}>{t("Save", "下载")}</a>}
      </article>;
    })}</div>
    <footer><label>{t("Master volume", "主音量")} <input aria-label={t("Master volume", "主音量")} type="range" min={0} max={1} step={0.01} value={master} onChange={(event) => setMaster(Number(event.target.value))} /><output>{Math.round(master * 100)}%</output></label><span>{t("Maximum drift before correction", "最大校正前漂移")} {Math.round(drift * 1000)} ms</span><Link className="text-link" href="/studio">{t("New job →", "新建任务 →")}</Link></footer>
  </section>;
}

function BeatTicks({ grid, durationMs }: { grid?: BeatGrid | null; durationMs: number }) {
  const t = useStudioText();
  const path = useMemo(() => grid && durationMs > 0
    ? grid.beats_ms.filter((value) => Number.isFinite(value) && value >= 0 && value <= durationMs)
      .map((value) => `M${((value / durationMs) * 1000).toFixed(2)} 0V10`).join("")
    : "", [grid, durationMs]);
  return path ? <svg className="studio-beat-ticks" viewBox="0 0 1000 10" preserveAspectRatio="none" aria-label={t("Estimated beat positions", "估算节拍位置")}><path d={path} /></svg> : null;
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
function stageLabel(stage: string, locale: string, count: number) { const zh = ({ QUEUED: "等待处理", PROBING: "验证音频", TRANSCODING: "准备音频", LOADING_MODEL: "准备分离模型", SEPARATING: `正在分离${count === 4 ? "四" : "六"}个声部`, VALIDATING: "验证音轨", GENERATING_WAVEFORM: "生成真实波形", FINALIZING: "保存结果", COMPLETE: "处理完成" } as Record<string, string>)[stage]; const en = ({ QUEUED: "Waiting", PROBING: "Validating audio", TRANSCODING: "Preparing audio", LOADING_MODEL: "Preparing separation model", SEPARATING: `Separating ${count} stems`, VALIDATING: "Validating stems", GENERATING_WAVEFORM: "Generating waveform", FINALIZING: "Saving result", COMPLETE: "Complete" } as Record<string, string>)[stage]; return (locale === "zh" ? zh : en) || stage.replaceAll("_", " "); }
