import { checkSourcePermission } from "./player-analysis";
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
test("uses the actual URL, anonymous bounded GET and cancels after the first chunk", async () => {
  const cancel = jest.fn(async () => {}), read = jest.fn(async () => ({ value: new Uint8Array(4096) }));
  global.fetch = jest.fn(async () => ({ ok: true, type: "cors", body: { getReader: () => ({ read, cancel }) } }) as unknown as Response);
  const abort = new AbortController(); expect(await checkSourcePermission("https://cdn.invalid/refreshed", abort.signal)).toBe("readable");
  expect(fetch).toHaveBeenCalledWith("https://cdn.invalid/refreshed", expect.objectContaining({ mode: "cors", credentials: "omit", headers: { Range: "bytes=0-4095" } }));
  expect(read).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1); expect(jest.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});
test.each(["opaque", "empty", "failure"])("%s is unconfirmed, not permanently unsupported", async kind => {
  global.fetch = jest.fn(async () => ({ ok: kind !== "failure", type: kind === "opaque" ? "opaque" : "cors", body: kind === "empty" ? null : undefined }) as Response);
  expect(await checkSourcePermission("https://cdn.invalid/a", new AbortController().signal)).toBe("unconfirmed");
});
test("abort during the streaming read never returns readable and does not retain the body", async () => {
  const body = deferred<{ value: Uint8Array }>(); const cancel = jest.fn(async () => {});
  global.fetch = jest.fn(async () => ({ ok: true, body: { getReader: () => ({ read: () => body.promise, cancel }) } }) as unknown as Response);
  const abort = new AbortController(), result = checkSourcePermission("https://cdn.invalid/a", abort.signal);
  await Promise.resolve(); abort.abort(); body.resolve({ value: new Uint8Array([1]) });
  expect(await result).toBe("unconfirmed"); expect(cancel).toHaveBeenCalled();
});
test("timeout aborts a native-style fetch and returns unconfirmed", async () => {
  jest.useFakeTimers(); global.fetch = jest.fn((_url, init) => new Promise((_yes, no) => init?.signal?.addEventListener("abort", () => no(Error("aborted")))));
  const result = checkSourcePermission("https://cdn.invalid/a", new AbortController().signal, 40); jest.advanceTimersByTime(40);
  expect(await result).toBe("unconfirmed");
});
