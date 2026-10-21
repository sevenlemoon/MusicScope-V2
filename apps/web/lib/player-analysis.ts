// A readable CORS response is permission to TRY the graph, not proof of FFT.
// Only real frequency samples from the playing media confirm analysis. No URL cache.
export type SourcePermission = "readable" | "unconfirmed";

export async function checkSourcePermission(url: string, signal: AbortSignal, timeoutMs = 1800): Promise<SourcePermission> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (signal.aborted) return "unconfirmed";
    const address = new URL(url, location.href);
    if (location.protocol === "https:" && address.protocol === "http:") return "unconfirmed";
    const response = await fetch(address.href, { mode: "cors", credentials: "omit", cache: "no-store", headers: { Range: "bytes=0-4095" }, signal: controller.signal });
    if (!response.ok || response.type === "opaque" || !response.body) return "unconfirmed";
    reader = response.body.getReader();
    // Consume only one streaming chunk; immediately cancel even if Range was ignored.
    const chunk = await reader.read();
    return !controller.signal.aborted && (chunk.value?.byteLength ?? 0) > 0 ? "readable" : "unconfirmed";
  } catch { return "unconfirmed"; }
  finally {
    controller.abort(); clearTimeout(timer); signal.removeEventListener("abort", cancel);
    void reader?.cancel().catch(() => {});
  }
}

export type PlayerGraph = {
  context: AudioContext;
  source: MediaElementAudioSourceNode | null;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  bound: boolean;
  resumed: Promise<boolean>;
  resume: () => Promise<boolean>;
  dispose: () => void;
};

// Call synchronously from a play gesture, before resolving any network request.
export function preparePlayerGraph(): PlayerGraph | null {
  if (typeof AudioContext === "undefined") return null;
  let context: AudioContext;
  try { context = new AudioContext(); } catch { return null; }
  let disposed = false;
  const lifetime = new AbortController();
  const graph: PlayerGraph = {
    context, source: null, gain: null, analyser: null, bound: false,
    resumed: resumePlayerGraph(context, 1500, lifetime.signal),
    resume: () => resumePlayerGraph(context, 1500, lifetime.signal),
    dispose() {
      if (disposed) return; disposed = true; lifetime.abort();
      for (const node of [graph.source, graph.gain, graph.analyser]) { try { node?.disconnect(); } catch { /* Already disconnected. */ } }
      try { if (context.state !== "closed") void context.close().catch(() => {}); } catch { /* Output has already been detached. */ }
    },
  };
  return graph;
}

export function resumePlayerGraph(context: AudioContext, timeoutMs = 1500, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (context.state === "running") return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value); };
    const abort = () => finish(false);
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try { void context.resume().then(() => finish(!signal?.aborted && context.state === "running"), () => finish(false)); }
    catch { finish(false); }
  });
}

export function bindPlayerGraph(graph: PlayerGraph, audio: HTMLAudioElement, volume: number) {
  if (graph.bound) return;
  // Allocate optional analysis before irreversibly binding the media element.
  graph.analyser = graph.context.createAnalyser(); graph.analyser.fftSize = 8192; graph.analyser.smoothingTimeConstant = 0.65;
  graph.gain = graph.context.createGain(); graph.gain.gain.value = volume;
  graph.bound = true; // Even an exception during binding requires a fresh direct element.
  graph.source = graph.context.createMediaElementSource(audio);
  graph.source.connect(graph.gain); graph.gain.connect(graph.context.destination);
  graph.gain.connect(graph.analyser); // Output deliberately unconnected: one audible path.
  audio.volume = 1;
}

export function loadPlayerSource(audio: HTMLAudioElement, url: string) {
  audio.src = url;
  audio.load();
}
