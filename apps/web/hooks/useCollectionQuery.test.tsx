import { act, renderHook } from "@testing-library/react";
import { collectionQueryString, parseCollectionQuery, useCollectionQuery } from "./useCollectionQuery";

describe("collection navigation state", () => {
  beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, "", "/library"); jest.useFakeTimers(); jest.spyOn(window, "scrollTo").mockImplementation(() => {}); Object.defineProperty(window, "scrollY", { configurable: true, value: 0 }); Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 2000 }); });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  it.each(["null", "[]", '{"liked:default":null}', '{"liked:default":{"query":null,"y":0}}'])("ignores invalid persisted snapshots: %s", (value) => {
    sessionStorage.setItem("musicscope:collection-view:v2", value);
    const { result } = renderHook(() => useCollectionQuery());
    act(() => { result.current.restoreScroll(); jest.advanceTimersByTime(20); });
    act(() => result.current.choose({ view: "album", id: "album" }));
    expect(result.current.query).toMatchObject({ view: "album", id: "album", sort: "asc" });
  });
  it("round trips explicit collection URLs and refuses old category restoration for bare library", () => {
    const state = parseCollectionQuery("view=album&id=a&sort=desc&cursor=50&q=夜");
    expect(parseCollectionQuery(collectionQueryString(state))).toEqual(state);
    sessionStorage.setItem("musicscope:library-view:v1", JSON.stringify({ search: "tab=albums", y: 620 }));
    const { result } = renderHook(() => useCollectionQuery());
    expect(result.current.query).toMatchObject({ view: "liked", id: null, cursor: null });
    expect(sessionStorage.getItem("musicscope:library-view:v1")).toBeNull();
  });
  it("uses one history entry per selection and replace for searching and sorting", () => {
    const { result } = renderHook(() => useCollectionQuery()); const length = history.length;
    act(() => result.current.choose({ view: "playlist", id: "p" }));
    expect(history.length).toBe(length + 1);
    act(() => result.current.commit("夜")); act(() => result.current.update({ sort: "desc" }));
    expect(history.length).toBe(length + 1);
    expect(result.current.query).toMatchObject({ view: "playlist", id: "p", q: "夜", sort: "desc", cursor: null });
  });
  it("restores browsing cursor, sort and scroll after clearing a search", () => {
    const { result } = renderHook(() => useCollectionQuery());
    act(() => { result.current.restoreScroll(); jest.advanceTimersByTime(20); });
    act(() => result.current.update({ sort: "desc" })); act(() => result.current.update({ cursor: "50" }));
    act(() => { result.current.restoreScroll(); jest.advanceTimersByTime(20); });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 620 });
    act(() => result.current.commit("match"));
    act(() => result.current.update({ sort: "asc" })); act(() => result.current.commit(""));
    expect(result.current.query).toMatchObject({ q: "", sort: "desc", cursor: "50" });
    act(() => { result.current.restoreScroll(); jest.advanceTimersByTime(20); });
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 620, behavior: "instant" });
  });
  it("keeps each collection cursor separate and restores history URLs with saved scroll", () => {
    const { result } = renderHook(() => useCollectionQuery());
    act(() => result.current.choose({ view: "playlist", id: "p" }));
    act(() => result.current.update({ cursor: "50" })); act(() => { result.current.restoreScroll(); jest.advanceTimersByTime(20); });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 900 });
    act(() => window.dispatchEvent(new Event("scroll")));
    act(() => result.current.choose({ view: "album", id: "a" }));
    expect(result.current.query).toMatchObject({ view: "album", cursor: null, sort: "asc" });
    act(() => { history.replaceState(null, "", "/library?view=playlist&id=p&cursor=50"); window.dispatchEvent(new Event("popstate")); });
    expect(result.current.query).toMatchObject({ view: "playlist", id: "p", cursor: "50" });
    act(() => { result.current.restoreScroll(); jest.advanceTimersByTime(20); });
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: "instant" });
  });
  it("freezes a leaving snapshot and resets to liked on explicit main navigation", () => {
    const { result, unmount } = renderHook(() => useCollectionQuery());
    act(() => result.current.choose({ view: "album", id: "a" })); act(() => { result.current.restoreScroll(); jest.advanceTimersByTime(20); });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 900 });
    const link = document.createElement("a"); link.href = "/track/song"; document.body.append(link); link.addEventListener("click", (event) => event.preventDefault());
    act(() => link.click()); Object.defineProperty(window, "scrollY", { configurable: true, value: 0 }); act(() => window.dispatchEvent(new Event("scroll")));
    expect(JSON.parse(sessionStorage.getItem("musicscope:collection-view:v2")!)["album:a"].y).toBe(900);
    act(() => window.dispatchEvent(new Event("musicscope:library-default")));
    expect(result.current.query.view).toBe("liked");
    unmount(); link.remove();
  });
  it("freezes programmatic one-click separation navigation before router scroll reset", () => {
    const { result, unmount } = renderHook(() => useCollectionQuery());
    act(() => result.current.update({ cursor: "50" }));
    act(() => { result.current.restoreScroll(); jest.advanceTimersByTime(20); });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 900 });
    act(() => window.dispatchEvent(new Event("musicscope:leaving-library")));
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    act(() => { history.replaceState(null, "", "/studio/jobs/existing"); window.dispatchEvent(new Event("scroll")); });
    unmount();
    expect(JSON.parse(sessionStorage.getItem("musicscope:collection-view:v2")!)["liked:default"]).toMatchObject({ y: 900, query: { cursor: "50" } });
  });

});
