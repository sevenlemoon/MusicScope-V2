import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LibraryExperience } from "./LibraryExperience";
import { PlayerProvider } from "./PlayerProvider";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
const response = (payload: object) => Promise.resolve({ ok: true, json: async () => payload });
const base = { total: 60, next_cursor: "50", previous_cursor: null, range_start: 1, range_end: 50 };
const song = (id = "t1", title = "Real track") => ({ id, title, artists: ["Artist"], artist_items: [{ id: "a1", name: "Artist" }], album: "Album", album_id: "a1", sort_group: "R", playlist_position: 61 });
const page = (items = [song()]) => ({ ...base, items });
const request = (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/default-collection")) return response({ status: "resolved", playlist_id: "liked", account_name: "Listener" });
  if (url.pathname.includes("/library/playlists")) return response({ ...base, total: 25, next_cursor: url.searchParams.has("cursor") ? null : "24", items: [{ id: url.searchParams.has("cursor") ? "p25" : "p1", name: url.searchParams.has("cursor") ? "Last playlist" : "Other playlist", track_count: 4 }] });
  if (url.pathname.includes("/library/albums")) return response({ ...base, next_cursor: null, items: [{ id: "a1", title: "Saved album", artists: [] }] });
  if (url.pathname.includes("/library/search")) return response({ ...base, total: 1, playlists: [{ playlist: { id: "p25", name: "Last playlist", track_count: 4 } }], albums: [] });
  if (url.pathname.endsWith("/tracks")) return response(page(url.searchParams.has("q") ? url.searchParams.get("q") === "nothing" ? [] : [song("found", "夜 beyond page 1")] : undefined));
  if (url.pathname.includes("/albums/")) return response({ id: "a1", title: "Saved album", library_track_count: 0 });
  return response({ id: "liked", name: url.pathname.includes("/p25") ? "Last playlist" : url.pathname.includes("/p1") ? "Other playlist" : "My liked songs", synchronized_track_count: 2549, provider_track_count: 2548 });
};
const renderLibrary = () => render(<PlayerProvider><LibraryExperience /></PlayerProvider>);
const search = () => { fireEvent.click(screen.getByRole("button", { name: "Search current collection" })); return screen.getByRole("searchbox", { name: "Search current collection" }); };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, "", "/library"); jest.spyOn(window, "scrollTo").mockImplementation(() => {}); global.fetch = jest.fn(request) as jest.Mock; });
afterEach(() => jest.restoreAllMocks());

test("defaults to the identified account playlist and keeps local and provider counts distinct", async () => {
  sessionStorage.setItem("musicscope:library-view:v1", JSON.stringify({ search: "tab=albums" }));
  renderLibrary();
  await screen.findByRole("heading", { name: "My liked songs" });
  expect(screen.getByText(/2549 synced · 2548 reported/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Playlist order" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("cursor=50"), expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Z–A" }));
  expect(location.search).toContain("sort=desc"); expect(location.search).not.toContain("cursor=");
});

test("song title and artwork are play buttons and details remain in more actions", async () => {
  renderLibrary(); await screen.findByRole("button", { name: "Real track" });
  expect(screen.getByRole("button", { name: "Play and open Real track" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Real track" })).not.toBeInTheDocument();
  expect(screen.getByText("Artist")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Album" })).toHaveAttribute("href", "/album/a1");
  fireEvent.click(screen.getByLabelText("More actions for Real track"));
  expect(screen.getByRole("link", { name: "Track details" })).toHaveAttribute("href", "/track/t1");
});

test("searches only collection members and resets the cursor without adding typing history", async () => {
  renderLibrary(); await screen.findByText("Real track"); const length = history.length;
  fireEvent.change(search(), { target: { value: "夜" } });
  fireEvent.submit(screen.getByRole("search"));
  await screen.findByText("夜 beyond page 1");
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/playlists/liked/tracks?scope=personal&sort=original&limit=50&q=%E5%A4%9C"), expect.anything());
  expect(history.length).toBe(length); expect(location.search).not.toContain("cursor");
});

test("clears Unicode search and collapses only after query is clear", async () => {
  renderLibrary(); await screen.findByText("Real track"); const input = search();
  fireEvent.change(input, { target: { value: "nothing" } }); fireEvent.submit(screen.getByRole("search"));
  expect(await screen.findByText("No matching songs in this collection.")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Escape" }); await screen.findByText("Real track");
  expect(screen.getByRole("searchbox")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Escape" }); expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
});

test("waits for IME, debounces input, and rejects late search responses even when abort is ignored", async () => {
  let finish!: (value: unknown) => void;
  global.fetch = jest.fn((input) => String(input).includes("q=slow") ? new Promise((resolve) => { finish = resolve; }) : request(input)) as jest.Mock;
  renderLibrary(); await screen.findByText("Real track"); const input = search();
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: "夜" } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 330)); });
  expect(jest.mocked(fetch).mock.calls.some(([url]) => String(url).includes("q="))).toBe(false);
  fireEvent.compositionEnd(input); await screen.findByText("夜 beyond page 1");
  fireEvent.change(input, { target: { value: "slow" } }); fireEvent.submit(screen.getByRole("search"));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.change(input, { target: { value: "nothing" } }); fireEvent.submit(screen.getByRole("search"));
  await screen.findByText("No matching songs in this collection.");
  await act(async () => finish(await response(page([song("late", "Late response")]))));
  expect(screen.queryByText("Late response")).not.toBeInTheDocument();
});

test("selects one cover and closes immediately, loads page 25, and rejects the old collection response", async () => {
  let finish!: (value: unknown) => void;
  global.fetch = jest.fn((input) => String(input).includes("/p1/tracks") ? new Promise((resolve) => { finish = resolve; }) : request(input)) as jest.Mock;
  renderLibrary(); await screen.findByText("Real track");
  const switcher = screen.getByRole("button", { name: /Switch album/ }); switcher.focus(); fireEvent.click(switcher);
  await screen.findByRole("button", { name: /Other playlist/ });
  fireEvent.click(screen.getByRole("button", { name: /Other playlist/ }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(switcher).toHaveFocus();
  expect(screen.queryByText("Real track")).not.toBeInTheDocument();
  fireEvent.click(switcher); await screen.findByRole("button", { name: /Other playlist/ });
  fireEvent.click(screen.getByRole("button", { name: "Load more collections →" }));
  fireEvent.click(await screen.findByRole("button", { name: /Last playlist/ }));
  await screen.findByRole("heading", { name: "Last playlist" });
  await act(async () => finish(await response(page([song("late", "Wrong collection")]))));
  expect(screen.queryByText("Wrong collection")).not.toBeInTheDocument();
});

test.each(["missing", "ambiguous", "no_connection"])("shows an accurate %s default empty state and still offers switching", async (status) => {
  global.fetch = jest.fn((input) => String(input).includes("default-collection") ? response({ status }) : request(input)) as jest.Mock;
  renderLibrary(); await screen.findByText(status === "ambiguous" ? /Multiple liked playlists/ : status === "missing" ? /No liked-songs playlist/ : /Connect an account/);
  expect(screen.queryByText("Real track")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Switch album/ })).toBeEnabled();
});

test("searches names across all selector pages, handles Esc, and preserves current tracks on mere scroll", async () => {
  renderLibrary(); await screen.findByText("Real track"); const opener = screen.getByRole("button", { name: /Switch album/ }); opener.focus(); fireEvent.click(opener);
  await screen.findByRole("button", { name: /Other playlist/ });
  fireEvent.scroll(screen.getByLabelText("Collection covers"), { target: { scrollLeft: 400 } });
  expect(location.search).toBe("");
  const input = screen.getByRole("searchbox", { name: "Search collection names" });
  fireEvent.change(input, { target: { value: "Last" } }); fireEvent.submit(input.closest("form")!);
  expect(await screen.findByRole("button", { name: /Last playlist/ })).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("types=playlist"), expect.anything());
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(opener).toHaveFocus(); expect(document.body.style.overflow).not.toBe("hidden");
});

test("collection errors retry in place with the same sort and search", async () => {
  let failed = false;
  window.history.replaceState(null, "", "/library?sort=desc&q=夜");
  global.fetch = jest.fn((input) => {
    if (String(input).includes("/tracks?") && !failed) { failed = true; return Promise.resolve({ ok: false, status: 503, json: async () => ({ detail: "Unavailable" }) }); }
    return request(input);
  }) as jest.Mock;
  renderLibrary(); await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("夜 beyond page 1");
  expect(location.search).toContain("sort=desc"); expect(new URLSearchParams(location.search).get("q")).toBe("夜");
});
