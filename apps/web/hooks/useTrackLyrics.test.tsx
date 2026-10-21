import { act, fireEvent, render, screen } from "@testing-library/react";
import { useTrackLyrics } from "./useTrackLyrics";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
const response = (text: string) => ({ ok: true, json: async () => ({ track_id: text, kind: "synced", provider: "netease", original: `[00:10]${text}`, translated: "", precision: "line" }) }) as Response;
function View({ id, enabled = true }: { id: string; enabled?: boolean }) { const { lyrics, retry } = useTrackLyrics(id, enabled); return <><output>{lyrics.status}:{lyrics.parsed?.lines[0]?.text}:{lyrics.parsed?.lines[0]?.translation}</output><button onClick={retry}>Retry</button></>; }
afterEach(() => jest.restoreAllMocks());
test("out-of-order lyrics cannot cover the new song, close cancels, reopening uses a successful cache", async () => {
  const a = deferred<Response>(), b = deferred<Response>();
  global.fetch = jest.fn(input => String(input).includes('/A/') ? a.promise : b.promise);
  const view = render(<View id="A" />); view.rerender(<View id="B" />);
  await act(async () => { b.resolve(response("B")); }); await act(async () => { a.resolve(response("A")); });
  expect(screen.getByRole("status")).toHaveTextContent("ready:B");
  view.rerender(<View id="B" enabled={false} />); view.rerender(<View id="B" />); await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(2); expect(screen.getByRole("status")).toHaveTextContent("ready:B");
});
test("late lyrics after closing or unmount never publish; errors can retry independently of audio", async () => {
  const pending = deferred<Response>(); global.fetch = jest.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(Error('network')).mockResolvedValueOnce(response('A'));
  const view = render(<View id="A" />); const signal = jest.mocked(fetch).mock.calls[0][1]?.signal;
  view.rerender(<View id="A" enabled={false} />); expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(response('Old')); }); expect(screen.getByRole('status')).not.toHaveTextContent('Old');
  view.rerender(<View id="A" />); await act(async () => {}); expect(screen.getByRole('status')).toHaveTextContent('error:');
  await act(async () => { fireEvent.click(screen.getByRole('button')); }); expect(screen.getByRole('status')).toHaveTextContent('ready:A');
  view.unmount();
});

test("late offset translations cannot replace the next track's aligned lyrics or timeline", async () => {
  const a = deferred<Response>(), b = deferred<Response>();
  global.fetch = jest.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const alignedResponse = (id: string, delta: string) => ({ ok: true, json: async () => ({ track_id: id, kind: "synced", original: `[00:10.000]${id}`, translated: `[00:${delta}]${id}译文`, precision: "line" }) }) as Response;
  const view = render(<View id="A" />); view.rerender(<View id="B" />);
  await act(async () => b.resolve(alignedResponse("B", "09.999")));
  expect(screen.getByRole("status")).toHaveTextContent("ready:B:B译文");
  await act(async () => a.resolve(alignedResponse("A", "10.001")));
  expect(screen.getByRole("status")).toHaveTextContent("ready:B:B译文");
  view.unmount();
});
