import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { StudioExperience } from "./StudioExperience";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const asset = {
  id: "asset-1", original_filename: "owned-track.wav", size_bytes: 4096,
  duration_ms: 180000, media_type: "audio/wav", reused: false,
};

function job(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1", status, stage: status === "SUCCEEDED" ? "COMPLETE" : status,
    model_name: "htdemucs", model_version: "htdemucs-demucs-4.1.0", demucs_version: "4.1.0",
    device: "mps", attempt_count: 1, safe_error_code: null, safe_error_message: null,
    asset, artifacts: [], source_track_ids: [], waveform_url: null, cancellable: ["QUEUED", "PREPARING", "RUNNING"].includes(status),
    retryable: ["FAILED", "CANCELLED"].includes(status), reused: false,
    created_at: "2026-09-22T00:00:00Z", completed_at: null, ...overrides,
  };
}

function response(payload: object, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

const peaks = Object.fromEntries(["VOCALS", "DRUMS", "BASS", "OTHER"].map((stem) => [
  stem, { bucket_count: 2, peaks: [[-0.4, 0.5], [-0.2, 0.3]] },
]));

class Gain {
  gain = { value: 1 };
  connect() { return this; }
}

class AudioContextMock {
  static nodes: Gain[] = [];
  destination = new Gain();
  createGain() { const node = new Gain(); AudioContextMock.nodes.push(node); return node; }
  createMediaElementSource() { return { connect: (node: Gain) => node }; }
  async resume() {}
  async close() {}
}

describe("StudioExperience", () => {
  beforeEach(() => {
    pushMock.mockReset();
    AudioContextMock.nodes = [];
    global.AudioContext = AudioContextMock as unknown as typeof AudioContext;
  });

  afterEach(() => jest.restoreAllMocks());

  test("uploads a local file, creates a durable job, and navigates to it", async () => {
    global.fetch = jest.fn((input, init) => {
      const url = String(input);
      if (url.endsWith("/studio/jobs") && !init?.method) return response({ items: [] }) as never;
      if (url.endsWith("/studio/assets")) {
        expect(init?.body).toBeInstanceOf(FormData);
        expect(new Headers(init?.headers).has("content-type")).toBe(false);
        return response(asset, 201) as never;
      }
      if (url.endsWith("/studio/assets/asset-1/jobs?model=htdemucs_6s")) return response(job("QUEUED", { model_name: "htdemucs_6s" }), 201) as never;
      throw new Error(`Unexpected request ${url}`);
    });
    render(<StudioExperience />);
    await screen.findByText("导入本地音频");
    fireEvent.change(screen.getByLabelText("选择本地音频文件"), {
      target: { files: [new File(["audio"], "owned.wav", { type: "audio/wav" })] },
    });
    expect(screen.queryByLabelText(/四轨/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始六轨分离" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/studio/jobs/job-1"));
    expect(screen.getAllByText("等待处理")).toHaveLength(2);
  });

  test("selected account song starts six-stem separation without a file", async () => {
    global.fetch = jest.fn((input, init) => {
      const url = String(input);
      if (url.endsWith("/studio/jobs")) return response({ items: [] }) as never;
      if (url.endsWith("/tracks/12345678-1234-1234-1234-123456789abc")) return response({
        id: "12345678-1234-1234-1234-123456789abc", title: "Practice song",
        artists: [{ id: "artist-1", name: "The Band" }], album: null,
      }) as never;
      if (url.endsWith("/studio/tracks/12345678-1234-1234-1234-123456789abc/jobs?model=htdemucs_6s")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeUndefined();
        return response(job("QUEUED", { model_name: "htdemucs_6s", source_track_ids: ["12345678-1234-1234-1234-123456789abc"] }), 201) as never;
      }
      throw new Error(`Unexpected request ${url}`);
    });
    render(<StudioExperience sourceTrackId="12345678-1234-1234-1234-123456789abc" />);
    expect(await screen.findByText("Practice song")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "直接分离这首歌（六轨）" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/studio/jobs/job-1?track=12345678-1234-1234-1234-123456789abc"));
  });

  test("switching to independent file mode never binds the selected account song", async () => {
    const trackId = "12345678-1234-1234-1234-123456789abc";
    global.fetch = jest.fn((input) => {
      const url = String(input);
      if (url.endsWith("/studio/jobs")) return response({ items: [] }) as never;
      if (url.endsWith(`/tracks/${trackId}`)) return response({ id: trackId, title: "Account song", artists: [], album: null }) as never;
      if (url.endsWith("/studio/assets")) return response(asset, 201) as never;
      if (url.endsWith("/studio/assets/asset-1/jobs?model=htdemucs_6s")) return response(job("QUEUED", { model_name: "htdemucs_6s" }), 201) as never;
      throw new Error(`Unexpected request ${url}`);
    });
    render(<StudioExperience sourceTrackId={trackId} />);
    expect(await screen.findByText("Account song")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "独立导入文件" }));
    fireEvent.change(screen.getByLabelText("选择本地音频文件"), {
      target: { files: [new File(["audio"], "local.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始六轨分离" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/studio/jobs/job-1"));
  });

  test("polls active work and exposes cancellation", async () => {
    jest.useFakeTimers();
    const queued = job("QUEUED");
    const running = job("RUNNING", { stage: "SEPARATING" });
    global.fetch = jest.fn((input, init) => {
      const url = String(input);
      if (url.endsWith("/cancel")) return response(job("CANCELLED", { stage: "CANCELLED", safe_error_message: "Separation was cancelled." })) as never;
      if (url.endsWith("/studio/jobs/job-1")) return response(init ? running : queued) as never;
      return response(running) as never;
    });
    render(<StudioExperience initialJobId="job-1" />);
    expect(await screen.findByRole("button", { name: "取消任务" })).toBeInTheDocument();
    await act(async () => { jest.advanceTimersByTime(1600); });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    expect(await screen.findByText("Separation was cancelled.")).toBeInTheDocument();
    jest.useRealTimers();
  });

  test("reopens a completed job and coordinates mixer gain, mute, solo, master, seek, and play", async () => {
    const artifacts = ["VOCALS", "DRUMS", "BASS", "OTHER"].map((stem) => ({
      id: `artifact-${stem}`, stem_type: stem, stream_url: `/stream/${stem}`,
      size_bytes: 1024, duration_ms: 180000,
    }));
    const completed = job("SUCCEEDED", { artifacts, waveform_url: "/waveform", completed_at: "2026-09-22T00:01:00Z" });
    global.fetch = jest.fn((input) => String(input).endsWith("/waveform")
      ? response({ version: "peaks-json-v1", duration_ms: 180000, stems: peaks }) as never
      : response(completed) as never);
    render(<StudioExperience initialJobId="job-1" />);
    expect(await screen.findByText("四条 FLAC 音轨已经保存在本机。刷新或稍后返回，不会重新处理。")).toBeInTheDocument();
    expect(await screen.findByText("此任务暂无节拍分析数据。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /波形中定位/ })).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("人声增益"), { target: { value: "0.42" } });
    fireEvent.click(screen.getByRole("button", { name: "人声静音" }));
    expect(screen.getByRole("button", { name: "人声静音" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "鼓组独奏" }));
    expect(screen.getByRole("button", { name: "鼓组独奏" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("主音量"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("播放位置"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("播放速度"), { target: { value: "0.75" } });
    fireEvent.click(screen.getByRole("button", { name: "设为循环起点" }));
    fireEvent.change(screen.getByLabelText("播放位置"), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "设为循环终点" }));
    expect(screen.getByText("1:00 → 1:15")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载人声 FLAC" })).toHaveAttribute("href", "http://localhost:8100/stream/VOCALS?download=true");
    fireEvent.click(screen.getByRole("button", { name: "播放四个声部" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "暂停四个声部" })).toBeInTheDocument());
    expect(AudioContextMock.nodes[0].gain.value).toBe(0.5);
    expect(AudioContextMock.nodes).toHaveLength(5);
  });

  test("six-stem results expose guitar and piano mixer rows", async () => {
    const artifacts = ["VOCALS", "DRUMS", "BASS", "GUITAR", "PIANO", "OTHER"].map((stem) => ({
      id: `artifact-${stem}`, stem_type: stem, stream_url: `/stream/${stem}`,
      size_bytes: 1024, duration_ms: 180000,
    }));
    global.fetch = jest.fn((input) => String(input).endsWith("/waveform")
      ? response({ version: "peaks-json-v1", duration_ms: 180000, stems: peaks, beat_grid: {
        bpm: 120, beats_ms: [250, 750, 1250], source: "drums", method: "onset-autocorrelation-v1",
      } }) as never
      : response(job("SUCCEEDED", { model_name: "htdemucs_6s", artifacts, waveform_url: "/waveform" })) as never);
    render(<StudioExperience initialJobId="job-1" />);
    expect(await screen.findByText("六条 FLAC 音轨已保存在本机。吉他和钢琴可能有串音或伪影。")).toBeInTheDocument();
    expect(await screen.findByText("120 BPM")).toBeInTheDocument();
    expect(screen.getByLabelText("估算节拍位置").querySelector("path")).toHaveAttribute("d", expect.stringContaining("M1.39"));
    expect(screen.getAllByRole("button", { name: /波形中定位/ })).toHaveLength(6);
    expect(screen.getByRole("button", { name: "吉他独奏" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载钢琴 FLAC" })).toBeInTheDocument();
  });

  test("does not claim a tempo when the drums have no stable beat", async () => {
    global.fetch = jest.fn((input) => String(input).endsWith("/waveform")
      ? response({ version: "peaks-json-v1", duration_ms: 180000, stems: peaks, beat_grid: null }) as never
      : response(job("SUCCEEDED", { waveform_url: "/waveform" })) as never);
    render(<StudioExperience initialJobId="job-1" />);
    expect(await screen.findByText("鼓组中未检测到稳定节拍。")).toBeInTheDocument();
    expect(screen.queryByText(/BPM/)).not.toBeInTheDocument();
  });

  test("reopened projects recover their library track from the saved association", async () => {
    const trackId = "12345678-1234-1234-1234-123456789abc";
    global.fetch = jest.fn((input) => String(input).endsWith(`/tracks/${trackId}`)
      ? response({ id: trackId, title: "Saved library song", artists: [], album: null }) as never
      : response(job("FAILED", { source_track_ids: [trackId], safe_error_message: "Processing failed." })) as never);
    render(<StudioExperience initialJobId="job-1" />);
    expect(await screen.findByText("Saved library song")).toBeInTheDocument();
  });

  test("renders safe failure and API errors without fake progress", async () => {
    global.fetch = jest.fn(() => response(job("FAILED", {
      stage: "FAILED", safe_error_code: "OUT_OF_MEMORY", safe_error_message: "Audio separation ran out of memory.",
    })) as never);
    const { unmount } = render(<StudioExperience initialJobId="job-1" />);
    expect(await screen.findByText("Audio separation ran out of memory.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试任务" })).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    unmount();
    global.fetch = jest.fn(() => response({ detail: { code: "STUDIO_DOWN", message: "Studio unavailable." } }, 503)) as never;
    render(<StudioExperience />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Studio 暂时无法读取");
  });
});
