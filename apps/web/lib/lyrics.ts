export type LyricLine = { at: number; text: string; translation?: string };
export type ParsedLyrics = { lines: LyricLine[]; plain: string[] };

// Only the demonstrated millisecond discrepancy is tolerated. This is not a
// correction for globally shifted translations or centisecond truncation.
export const LYRIC_TRANSLATION_TOLERANCE_MS = 1;
const timeMs = (line: LyricLine) => Math.round(line.at * 1000);

// LRC line timing only. No inferred word durations, song-length division or karaoke fill.
export function parseLrc(text: string): ParsedLyrics {
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [], plain: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)].filter(match => Number(match[2]) < 60);
    const content = raw.replace(/\[[^\]]*\]/g, "").replace(/<\d+:\d+(?:\.\d+)?>/g, "").trim();
    if (!times.length) {
      if (content && !raw.trim().startsWith("{")) plain.push(content);
      continue;
    }
    for (const match of times) {
      const at = Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? 0}`) + offset;
      if (Number.isFinite(at)) lines.push({ at: Math.max(0, at), text: content });
    }
  }
  lines.sort((a, b) => a.at - b.at);
  const grouped: LyricLine[] = [];
  for (const line of lines) {
    const previous = grouped.at(-1);
    if (previous?.at === line.at) { if (line.text && !previous.text.split("\n").includes(line.text)) previous.text = [previous.text, line.text].filter(Boolean).join("\n"); }
    else grouped.push({ ...line });
  }
  return { lines: grouped, plain: grouped.length ? [] : plain };
}

export function parseLyrics(original: string, translated = ""): ParsedLyrics {
  const parsed = parseLrc(original);
  const translations = parseLrc(translated).lines;
  // Matching uses integer milliseconds, after each document's own offset.
  // Public `at` values and the original timeline remain completely untouched.
  const sourceTimes = parsed.lines.map(timeMs);
  const translatedTimes = translations.map(timeMs);
  const exact = new Map(translatedTimes.map((at, i) => [at, i]));
  const used = new Set<number>();
  const assigned = new Set<number>();
  for (let i = 0; i < parsed.lines.length; i++) {
    const candidate = exact.get(sourceTimes[i]);
    if (candidate === undefined) continue;
    // Blank timed lines are anchors too: don't borrow their translation for a
    // neighboring lyric, and don't attach words to an instrumental blank.
    used.add(candidate); assigned.add(i);
    if (parsed.lines[i].text && translations[candidate].text) parsed.lines[i].translation = translations[candidate].text;
  }

  let start = 0;
  for (let i = 0; i < parsed.lines.length; i++) {
    if (assigned.has(i) || !parsed.lines[i].text) continue;
    const at = sourceTimes[i];
    const neighborGap = Math.min(at - (sourceTimes[i - 1] ?? -Infinity), (sourceTimes[i + 1] ?? Infinity) - at);
    while (start < translatedTimes.length && translatedTimes[start] < at - LYRIC_TRANSLATION_TOLERANCE_MS) start++;
    let best: number | undefined, distance = Infinity, tied = false;
    for (let j = start; j < translatedTimes.length && translatedTimes[j] <= at + LYRIC_TRANSLATION_TOLERANCE_MS; j++) {
      if (used.has(j) || !translations[j].text) continue;
      const delta = Math.abs(translatedTimes[j] - at);
      // A strict half-neighbor gap makes candidate windows disjoint. Midpoint
      // ties and crowded timelines stay unmatched rather than crossing lines.
      if (delta * 2 >= neighborGap) continue;
      if (delta < distance) { best = j; distance = delta; tied = false; }
      else if (delta === distance) tied = true;
    }
    if (best !== undefined && !tied) {
      parsed.lines[i].translation = translations[best].text;
      used.add(best);
    }
  }
  return parsed;
}

export function currentLyricIndex(lines: LyricLine[], position: number) {
  let low = 0, high = lines.length;
  while (low < high) { const middle = (low + high) >>> 1; if (lines[middle].at <= position) low = middle + 1; else high = middle; }
  return low - 1;
}
