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
    asset, artifacts: [], waveform_url: null, cancellable: ["QUEUED", "PREPARING", "RUNNING"].includes(status),
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
      if (url.endsWith("/studio/assets/asset-1/jobs")) return response(job("QUEUED"), 201) as never;
      throw new Error(`Unexpected request ${url}`);
    });
    render(<StudioExperience />);
    await screen.findByText("上传本地音频");
    fireEvent.change(screen.getByLabelText("选择本地音频文件"), {
      target: { files: [new File(["audio"], "owned.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始四轨分离" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/studio/jobs/job-1"));
    expect(screen.getAllByText("等待本地工作进程")).toHaveLength(2);
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
    expect(screen.getAllByRole("button", { name: /波形中定位/ })).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("人声增益"), { target: { value: "0.42" } });
    fireEvent.click(screen.getByRole("button", { name: "人声静音" }));
    expect(screen.getByRole("button", { name: "人声静音" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "鼓组独奏" }));
    expect(screen.getByRole("button", { name: "鼓组独奏" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("主音量"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("播放位置"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "播放四个声部" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "暂停四个声部" })).toBeInTheDocument());
    expect(AudioContextMock.nodes[0].gain.value).toBe(0.5);
    expect(AudioContextMock.nodes).toHaveLength(5);
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
