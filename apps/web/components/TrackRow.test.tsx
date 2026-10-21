import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrackRow } from "./TrackRow";
import { PlayerProvider } from "./PlayerProvider";
const pushMock = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
const track = { id: "one", title: "A song", artists: ["Artist"], sort_group: "A", artist_items: [] };
it("creates only once on repeated clicks and stays pending until navigation", async () => {
  let finish!: (value: unknown) => void;
  global.fetch = jest.fn(() => new Promise((resolve) => { finish = resolve; })) as jest.Mock;
  render(<PlayerProvider><TrackRow track={track} /></PlayerProvider>);
  expect(global.fetch).not.toHaveBeenCalled();
  const button = screen.getByRole("button", { name: "Separate stems for A song" });
  fireEvent.click(button); fireEvent.click(button);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/studio/tracks/one/jobs?model=htdemucs_6s"), expect.objectContaining({ method: "POST" }));
  await act(async () => finish({ ok: true, json: async () => ({ id: "saved" }) }));
  expect(pushMock).toHaveBeenCalledWith("/studio/jobs/saved?track=one");
  expect(button).toBeDisabled();
});
it("shows a recoverable error, then retries the same song", async () => {
  global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ detail: "Source unavailable" }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ id: "retry" }) });
  render(<PlayerProvider><TrackRow track={{ ...track, id: "two" }} /></PlayerProvider>);
  const button = screen.getByRole("button", { name: "Separate stems for A song" });
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Source unavailable");
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/studio/jobs/retry?track=two"));
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
it("does not navigate after leaving a pending song", async () => {
  pushMock.mockClear();
  let finish!: (value: unknown) => void;
  global.fetch = jest.fn(() => new Promise((resolve) => { finish = resolve; })) as jest.Mock;
  const view = render(<PlayerProvider><TrackRow track={{ ...track, id: "three" }} /></PlayerProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Separate stems for A song" }));
  view.unmount();
  await act(async () => finish({ ok: true, json: async () => ({ id: "late" }) }));
  expect(pushMock).not.toHaveBeenCalled();
});


it("title and cover use the same player without reloading, and more actions do not start playback", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
  global.fetch = jest.fn(async (input) => ({ ok: true, json: async () => String(input).endsWith("/playback-source") ? { url: "https://temporary.invalid/song" } : { status: "none", lines: [] } })) as jest.Mock;
  render(<PlayerProvider><TrackRow track={track} /></PlayerProvider>);
  fireEvent.click(screen.getByLabelText("More actions for A song"));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "A song" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Collapse player" }));
  fireEvent.click(screen.getByRole("button", { name: "Play and open A song" }));
  expect(screen.getByRole("dialog")).toHaveAccessibleName("A song");
  expect(jest.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("playback-source"))).toHaveLength(1);
  jest.restoreAllMocks();
});
