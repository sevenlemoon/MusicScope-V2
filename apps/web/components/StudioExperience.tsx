"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiRequestError, apiRequest, apiUrl } from "@/lib/api-client";

type JobStatus = "QUEUED" | "PREPARING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
type StemType = "VOCALS" | "DRUMS" | "BASS" | "OTHER";
type StudioAsset = { id: string; original_filename: string; size_bytes: number; duration_ms: number; media_type: string; reused: boolean };
type StudioArtifact = { id: string; stem_type: StemType; stream_url: string; size_bytes: number; duration_ms: number | null };
type StudioJob = {
  id: string; status: JobStatus; stage: string; model_name: string; model_version: string | null;
  demucs_version: string | null; device: string | null; attempt_count: number; safe_error_code: string | null;
  safe_error_message: string | null; asset: StudioAsset; artifacts: StudioArtifact[]; waveform_url: string | null;
  cancellable: boolean; retryable: boolean; reused: boolean; created_at: string; completed_at: string | null;
};
type JobList = { items: StudioJob[] };
type WaveformStem = { bucket_count: number; peaks: [number, number][] };
type Waveform = { version: string; duration_ms: number; stems: Record<StemType, WaveformStem> };

const STEMS: StemType[] = ["VOCALS", "DRUMS", "BASS", "OTHER"];
const LABELS: Record<StemType, string> = { VOCALS: "人声", DRUMS: "鼓组", BASS: "贝斯", OTHER: "其他" };
const ACTIVE = new Set<JobStatus>(["QUEUED", "PREPARING", "RUNNING"]);

export function StudioExperience({ initialJobId }: { initialJobId?: string }) {
  const router = useRouter();
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [job, setJob] = useState<StudioJob | null>(null);
  const [selected, setSelected] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    load.catch(() => { if (live) setError("Studio 暂时无法读取，请确认本地服务已经启动。"); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [initialJobId]);

  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    const timer = window.setInterval(() => { void loadJob(job.id).catch(() => setError("处理状态更新中断。")); }, 1500);
    return () => window.clearInterval(timer);
  }, [job, loadJob]);

  const choose = (file?: File) => {
    if (!file) return;
    setSelected(file);
    setError(null);
  };

  const submit = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", selected);
      const asset = await apiRequest<StudioAsset>("/api/v1/studio/assets", { method: "POST", body: form });
      const next = await apiRequest<StudioJob>(`/api/v1/studio/assets/${asset.id}/jobs`, { method: "POST" });
      setJob(next);
      router.push(`/studio/jobs/${next.id}`);
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason.message : "上传或创建任务失败。");
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
    <header className="studio-hero"><div><p className="eyebrow">STUDIO / REAL FOUR-STEM SEPARATION</p><h1>走进声音的<br />每一层。</h1><p>上传你有权处理的本地音频，MusicScope 会在本机分离人声、鼓组、贝斯与其他声部。流媒体播放地址不会被用于处理。</p></div><div className="studio-orbit" aria-hidden="true"><span>4</span><i /><i /><i /><i /></div></header>
    {!initialJobId && <section className="studio-upload" onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
      <div><p className="eyebrow">LOCAL AUDIO / PROCESSING SOURCE</p><h2>上传本地音频</h2><p>支持 MP3、WAV、FLAC、M4A/AAC；最大 200 MiB，最长 15 分钟。</p></div>
      <input ref={inputRef} aria-label="选择本地音频文件" type="file" accept=".mp3,.wav,.flac,.m4a,.aac,audio/*" onChange={(event: ChangeEvent<HTMLInputElement>) => choose(event.target.files?.[0])} />
      <button className="button button-quiet" type="button" onClick={() => inputRef.current?.click()}>选择文件</button>
      <div className="studio-file"><strong>{selected?.name || "还没有选择音频"}</strong><span>{selected ? formatBytes(selected.size) : "拖放文件到这里也可以"}</span></div>
      <button className="button button-primary" type="button" disabled={!selected || busy} onClick={() => void submit()}>{busy ? "正在验证并上传…" : "开始四轨分离"}</button>
    </section>}
    {error && <p className="studio-error" role="alert">{error}</p>}
    {loading ? <div className="studio-loading" role="status">正在读取 Studio…</div> : job ? <JobPanel job={job} onCancel={() => void cancel()} onRetry={() => void retry()} /> : initialJobId ? <div className="studio-empty"><h2>没有找到这个任务</h2><Link className="button button-quiet" href="/studio">返回 Studio</Link></div> : <StudioEmpty jobs={jobs} />}
  </div>;
}

function StudioEmpty({ jobs }: { jobs: StudioJob[] }) {
  return <section className="studio-empty"><p className="eyebrow">FOUR STEMS / LOCAL ONLY</p><h2>上传本地音频，将它分成四个声部。</h2><div>{STEMS.map((stem, index) => <span key={stem}><b>0{index + 1}</b>{LABELS[stem]}<small>{titleCase(stem)}</small></span>)}</div>{jobs.length > 0 && <Link className="text-link" href={`/studio/jobs/${jobs[0].id}`}>打开最近任务 →</Link>}</section>;
}

function JobPanel({ job, onCancel, onRetry }: { job: StudioJob; onCancel: () => void; onRetry: () => void }) {
  if (job.status === "SUCCEEDED") return <StemMixer job={job} />;
  const stage = stageLabel(job.stage);
  return <section className={`studio-job studio-job-${job.status.toLowerCase()}`} aria-live="polite">
    <div><p className="eyebrow">JOB / {job.status}</p><h2>{job.asset.original_filename}</h2><p>{job.status === "FAILED" || job.status === "CANCELLED" ? job.safe_error_message : stage}</p></div>
    <div className="studio-stage"><span>{job.status}</span><strong>{stage}</strong><small>尝试 {job.attempt_count} · {formatDuration(job.asset.duration_ms / 1000)}</small></div>
    {job.cancellable && <button className="button button-quiet" type="button" onClick={onCancel}>取消任务</button>}
    {job.retryable && <button className="button button-primary" type="button" onClick={onRetry}>重试任务</button>}
    <p className="studio-first-run">首次处理可能需要准备约 80 MiB 的模型。进度按真实阶段显示，不会伪造百分比。</p>
  </section>;
}

function StemMixer({ job }: { job: StudioJob }) {
  const [waveform, setWaveform] = useState<Waveform | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [master, setMaster] = useState(0.85);
  const [gains, setGains] = useState<Record<StemType, number>>({ VOCALS: 1, DRUMS: 1, BASS: 1, OTHER: 1 });
  const [muted, setMuted] = useState<Set<StemType>>(new Set());
  const [soloed, setSoloed] = useState<Set<StemType>>(new Set());
  const [drift, setDrift] = useState(0);
  const media = useRef(new Map<StemType, HTMLAudioElement>());
  const context = useRef<AudioContext | null>(null);
  const nodes = useRef(new Map<StemType, GainNode>());
  const masterNode = useRef<GainNode | null>(null);
  const duration = job.asset.duration_ms / 1000;

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
  useEffect(() => {
    const anySolo = soloed.size > 0;
    STEMS.forEach((stem) => {
      const audible = !muted.has(stem) && (!anySolo || soloed.has(stem));
      const node = nodes.current.get(stem);
      if (node) node.gain.value = audible ? gains[stem] : 0;
    });
  }, [gains, muted, soloed]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const primary = media.current.get("VOCALS") || media.current.values().next().value;
      if (!primary || primary.paused) return;
      setPosition(primary.currentTime);
      let maximum = 0;
      media.current.forEach((audio) => { maximum = Math.max(maximum, Math.abs(audio.currentTime - primary.currentTime)); if (Math.abs(audio.currentTime - primary.currentTime) > 0.08) audio.currentTime = primary.currentTime; });
      setDrift((value) => Math.max(value, maximum));
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

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
    <header><div><p className="eyebrow">COMPLETE / {job.model_name} / {job.device?.toUpperCase()}</p><h2>{job.asset.original_filename}</h2><p>四条 FLAC 音轨已经保存在本机。刷新或稍后返回，不会重新处理。</p></div><span>{formatDuration(duration)}</span></header>
    <div className="studio-transport"><button type="button" className="studio-play" aria-label={playing ? "暂停四个声部" : "播放四个声部"} onClick={() => void togglePlay()}>{playing ? "Ⅱ" : "▶"}</button><span>{formatDuration(position)}</span><input aria-label="播放位置" type="range" min={0} max={duration || 1} step={0.01} value={position} onChange={(event) => seek(Number(event.target.value))} /><span>{formatDuration(duration)}</span></div>
    <div className="studio-stems">{STEMS.map((stem) => {
      const data = waveform?.stems[stem];
      return <article className="studio-stem" key={stem}>
        <div className="studio-stem-title"><span>{LABELS[stem]}</span><small>{titleCase(stem)}</small></div>
        <button className="studio-waveform" type="button" aria-label={`在${LABELS[stem]}波形中定位`} onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); seek(((event.clientX - box.left) / box.width) * duration); }}><WaveformPath data={data} /><i style={{ left: `${duration ? (position / duration) * 100 : 0}%` }} /></button>
        <label>增益 <input aria-label={`${LABELS[stem]}增益`} type="range" min={0} max={1.5} step={0.01} value={gains[stem]} onChange={(event) => setGains((current) => ({ ...current, [stem]: Number(event.target.value) }))} /><output>{Math.round(gains[stem] * 100)}%</output></label>
        <button type="button" aria-label={`${LABELS[stem]}静音`} aria-pressed={muted.has(stem)} onClick={() => setMuted(toggleSet(muted, stem))}>M</button>
        <button type="button" aria-label={`${LABELS[stem]}独奏`} aria-pressed={soloed.has(stem)} onClick={() => setSoloed(toggleSet(soloed, stem))}>S</button>
      </article>;
    })}</div>
    <footer><label>主音量 <input aria-label="主音量" type="range" min={0} max={1} step={0.01} value={master} onChange={(event) => setMaster(Number(event.target.value))} /><output>{Math.round(master * 100)}%</output></label><span>最大校正前漂移 {Math.round(drift * 1000)} ms</span><Link className="text-link" href="/studio">新建任务 →</Link></footer>
  </section>;
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
function stageLabel(stage: string) { return ({ QUEUED: "等待本地工作进程", PROBING: "验证音频", TRANSCODING: "准备标准输入", LOADING_MODEL: "准备分离模型", SEPARATING: "正在分离四个声部", VALIDATING: "验证 FLAC 音轨", GENERATING_WAVEFORM: "生成真实波形", FINALIZING: "安全发布结果", COMPLETE: "处理完成" } as Record<string, string>)[stage] || stage.replaceAll("_", " "); }
