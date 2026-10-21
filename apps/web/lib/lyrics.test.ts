import { currentLyricIndex, LYRIC_TRANSLATION_TOLERANCE_MS, parseLrc, parseLyrics } from "./lyrics";

test("parses real LRC timestamps, repeated chorus tags, metadata and offset without invented word timing", () => {
  const parsed = parseLrc("[ar:Artist]\n[offset:100]\n[00:02.5][01:02.500]Chorus\n[00:01.23]Earlier\n[00:03.000]\n[00:70]Invalid");
  expect(parsed.lines).toEqual([{ at: 1.33, text: "Earlier" }, { at: 2.6, text: "Chorus" }, { at: 3.1, text: "" }, { at: 62.6, text: "Chorus" }]);
  expect(parsed.plain).toEqual([]);
});
test("sorts and groups duplicate timestamps; translation only aligns at real matching timestamps", () => {
  const parsed = parseLyrics("[00:10]A\n[00:10]B\n[00:20]C", "[00:10]译文\n[00:15]Unmatched");
  expect(parsed.lines[0]).toEqual({ at: 10, text: "A\nB", translation: "译文" });
  expect(parsed.lines[1].translation).toBeUndefined();
});
test("plain lyrics stay untimed and empty metadata does not manufacture content", () => {
  expect(parseLrc("[ar:Artist]\nFirst plain line\nSecond plain line")).toEqual({ lines: [], plain: ["First plain line", "Second plain line"] });
  expect(parseLrc("[ar:Artist]\n")).toEqual({ lines: [], plain: [] });
  expect(parseLrc("[00:78]Malformed time stays readable")).toEqual({ lines: [], plain: ["Malformed time stays readable"] });
});
test("binary lookup handles intro, exact boundaries, seeks and late lyrics", () => {
  const { lines } = parseLrc("[00:10]First\n[00:20.50]Second\n[01:00]Last");
  expect(currentLyricIndex(lines, 0)).toBe(-1); expect(currentLyricIndex(lines, 10)).toBe(0);
  expect(currentLyricIndex(lines, 20.5)).toBe(1); expect(currentLyricIndex(lines, 90)).toBe(2);
  expect(currentLyricIndex(lines, 15)).toBe(0); expect(currentLyricIndex([], 90)).toBe(-1);
});

const stamp = (ms: number) => `[${Math.floor(ms / 60000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}.${(ms % 1000).toString().padStart(3, "0")}]`;
const pairs = (original: string, translated: string) => parseLyrics(original, translated).lines.map(line => line.translation);

test.each([-2, -1, 0, 1, 2])("integer milliseconds: offset %i includes the conservative boundary but never widens it", delta => {
  expect(LYRIC_TRANSLATION_TOLERANCE_MS).toBe(1);
  expect(pairs("[00:10.000]Original", `${stamp(10000 + delta)}译文`)).toEqual([Math.abs(delta) <= LYRIC_TRANSLATION_TOLERANCE_MS ? "译文" : undefined]);
});

test("all exact matches are reserved before any approximate match, independent of source order", () => {
  // 10.001 belongs exactly to B, even though A is examined first.
  expect(pairs("[00:10.000]A\n[00:10.001]B\n[00:20]C", "[00:10.001]B译文\n[00:20.001]C译文")).toEqual([undefined, "B译文", "C译文"]);
  expect(pairs("[00:20]C\n[00:10.001]B\n[00:10.000]A", "[00:20.001]C译文\n[00:10.001]B译文")).toEqual([undefined, "B译文", "C译文"]);
});

test("close neighboring originals narrow the window; midpoint and competing equal-distance translations stay unmatched", () => {
  expect(pairs("[00:10.000]A\n[00:10.002]B", "[00:10.001]Ambiguous")).toEqual([undefined, undefined]);
  expect(pairs("[00:10.000]A\n[00:10.003]B", "[00:10.001]Only A")).toEqual(["Only A", undefined]);
  expect(pairs("[00:10.000]A\n[00:10.001]B", "[00:09.999]Too crowded")).toEqual([undefined, undefined]);
  expect(pairs("[00:10.000]A", "[00:10.001]After\n[00:09.999]Before")).toEqual([undefined]);
  expect(pairs("[00:10.000]A", "[00:10.001]After\n[00:10.000]Exact\n[00:09.999]Before")).toEqual(["Exact"]);
});

test("one translation cannot be reused for different original times; missing translations never shift the following verse", () => {
  expect(pairs("[00:10.000]A\n[00:10.003]B\n[00:20]C\n[00:30]D", "[00:10.001]A译文\n[00:30.001]D译文")).toEqual(["A译文", undefined, undefined, "D译文"]);
});

test("unsorted duplicate tags and multiline groups preserve source order and de-duplicate repeated content", () => {
  const source = "[00:20]C\n[00:10]A\n[00:10.000]B\n[00:10]A\n[00:10]\n[00:30]";
  const parsed = parseLyrics(source, "[00:20.001]丙\n[00:10.001]甲\n[00:10.001]乙\n[00:10.001]甲\n[00:30]Not a lyric");
  expect(parsed.lines).toEqual([{ at: 10, text: "A\nB", translation: "甲\n乙" }, { at: 20, text: "C", translation: "丙" }, { at: 30, text: "" }]);
  expect(pairs("[00:10]A\n[00:10.002]", "[00:10.001]Ambiguous blank anchor")).toEqual([undefined, undefined]);
  expect(pairs("[00:10]A", "[00:10]\n[00:10.001]Don't borrow beyond an exact blank")).toEqual([undefined]);
});

test("document offsets and mixed 1/2/3-digit precision apply once, matching in milliseconds without changing seek times", () => {
  const source = "[offset:100]\n[00:01.2]A\n[00:02:34]B\n[00:48.279]C";
  const translated = "[offset:-100]\n[00:01.401]甲\n[00:02.541]乙\n[00:48.480]丙";
  const before = parseLrc(source), after = parseLyrics(source, translated);
  expect(after.lines.map(line => line.translation)).toEqual(["甲", "乙", "丙"]);
  expect(after.lines.map(({ at, text }) => ({ at, text }))).toEqual(before.lines);
  for (const line of before.lines) {
    expect(currentLyricIndex(after.lines, line.at)).toBe(currentLyricIndex(before.lines, line.at));
    expect(currentLyricIndex(after.lines, line.at - 0.000001)).toBe(currentLyricIndex(before.lines, line.at - 0.000001));
  }
  expect(pairs("[offset:-100]\n[00:00.050]A", "[00:00]甲")).toEqual(["甲"]);
  // Different precision doesn't imply permission to absorb a 9ms shift.
  expect(pairs("[00:10.009]A", "[00:10.00]Unreliable")).toEqual([undefined]);
});

test("no translation, untimed translation and plain text do not manufacture timing or index pairing", () => {
  expect(pairs("[00:10]A", "")).toEqual([undefined]);
  expect(pairs("[00:10]A", "Untimed translation")).toEqual([undefined]);
  expect(parseLyrics("Original plain text", "Translated plain text")).toEqual({ lines: [], plain: ["Original plain text"] });
  expect(parseLyrics("", "[00:10]Translation only")).toEqual({ lines: [], plain: [] });
});
